import {
  checkConnection,
  getEnv,
  isSourceDue,
  loadActiveFilter,
  loadAppSettings,
  loadSources,
  log,
  recordPoll,
  type AppSettingsRow,
  type FilterSet,
  type NormalizedListing,
  type SourceName,
  sleep,
  type SourceRow,
} from '@intern-finder/core';
import { adzunaAdapter } from './sources/adzuna';
import { joobleAdapter } from './sources/jooble';
import { adzunaFixtureAdapter, joobleFixtureAdapter } from './sources/fixtures';
import type { SourceAdapter } from './sources/types';
import { ingest, type IngestStats } from './ingest';
import { flagValue, hasFlag } from './cli';
import { runScoring, spendAllowance } from './scoring-run';
import { runDedupePass } from './dedupe-pass';
import { runNotifier } from './notifier';
import { runBot } from './telegram-bot';

/**
 * Worker entrypoint.
 *
 * Two modes:
 *   --once    run a single cycle and exit (what a cron job or a manual
 *             "re-scan" from the dashboard would call)
 *   default   loop forever on WORKER_TICK_SECONDS, which is what runs under
 *             systemd on the Oracle VM
 *
 * The loop tick is intentionally NOT the poll cadence. Each source decides for
 * itself whether it is due, based on poll_interval_minutes and its remaining
 * daily quota — both of which live in the database. That way the tick can be
 * short and responsive to a /resume without any source being polled harder.
 */

interface Cli {
  once: boolean;
  dryRun: boolean;
  fixtures: boolean;
  sources: SourceName[] | null;
  force: boolean;
}

function parseArgs(argv: string[]): Cli {
  // Via hasFlag, because `npm run worker -- --dry-run` never reaches argv —
  // npm swallows --dry-run as its own option. See cli.ts.
  const has = (flag: string) => hasFlag(flag, argv);

  const raw = flagValue('source', argv);
  return {
    once: has('once'),
    // --dry-run implies fixtures are safe to use but does NOT force them; you
    // can dry-run against live APIs to see what would be stored.
    dryRun: has('dry-run'),
    fixtures: has('fixtures'),
    // Ignore poll_interval and quota gating. For manual runs and testing only.
    force: has('force'),
    sources: raw ? (raw.split(',').map((s) => s.trim()) as SourceName[]) : null,
  };
}

function adapterFor(name: SourceName, useFixtures: boolean): SourceAdapter | null {
  if (useFixtures) {
    if (name === 'adzuna') return adzunaFixtureAdapter;
    if (name === 'jooble') return joobleFixtureAdapter;
    return null;
  }
  if (name === 'adzuna') return adzunaAdapter;
  if (name === 'jooble') return joobleAdapter;
  // careers_page is Phase 4.
  return null;
}

/** Requests this source may still spend today. */
function remainingCalls(source: SourceRow, now: Date): number {
  const quotaExpired = now >= new Date(source.quota_reset_at);
  const used = quotaExpired ? 0 : source.calls_today;
  return Math.max(0, source.max_calls_per_day - used);
}

async function runCycle(cli: Cli): Promise<void> {
  const now = new Date();

  const settings = await loadAppSettings();
  if (settings.is_paused && !cli.force) {
    log.info('paused (app_settings.is_paused) — skipping cycle');
    return;
  }

  const filterSet: FilterSet = await loadActiveFilter();
  log.info(
    `filter "${filterSet.filter.name}": ${filterSet.filter.radius_km}km of ${filterSet.filter.center_label}, ` +
      `${filterSet.keywords.filter((k) => k.kind === 'include').length} include / ` +
      `${filterSet.keywords.filter((k) => k.kind !== 'include').length} exclude keywords`,
  );

  const sources = await loadSources();
  const wanted = cli.sources ?? sources.map((s) => s.name);

  for (const source of sources) {
    if (!wanted.includes(source.name)) continue;

    const adapter = adapterFor(source.name, cli.fixtures);
    if (!adapter) {
      log.debug(`${source.name}: no adapter (Phase 4 or fixtures unavailable), skipping`);
      continue;
    }

    if (!cli.force) {
      const { due, reason } = isSourceDue(source, now);
      if (!due) {
        log.info(`${source.name}: ${reason}`);
        continue;
      }
    }

    if (!adapter.isConfigured()) {
      log.warn(
        `${source.name}: credentials missing — set them in .env, or run with --fixtures to exercise the pipeline offline`,
      );
      continue;
    }

    const budget = cli.fixtures ? 1 : remainingCalls(source, now);
    log.info(`${source.name}: polling (budget ${budget} calls)`);

    let listings: NormalizedListing[] = [];
    let calls = 0;
    try {
      const result = await adapter.fetch({ filterSet, maxCalls: budget });
      listings = result.listings;
      calls = result.calls;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${source.name}: poll failed — ${message}`);
      // Still record the attempt: consecutive_failures is how a persistently
      // broken source becomes visible instead of just going quiet.
      await recordPoll(source.name, { calls, ok: false, error: message });
      continue;
    }

    const stats = await ingest(listings, filterSet, { dryRun: cli.dryRun, now });
    logStats(source.name, stats);

    // Recorded even on a dry run. --dry-run suppresses WRITES, but the HTTP
    // requests were really issued and really counted against the provider's
    // daily allowance. Skipping this made repeated dry runs invisible to the
    // quota guard while quietly spending the real budget.
    await recordPoll(source.name, { calls, ok: true });
  }

  // --- Mark near-duplicates -----------------------------------------------
  // Before scoring, so a duplicate is recognised as one before we pay to score
  // it. Never fatal: a failure here costs a duplicate notification, which is
  // far cheaper than losing the cycle's ingest.
  if (!cli.dryRun) {
    try {
      const dedupe = await runDedupePass();
      if (dedupe.changed > 0) {
        log.info(
          `dedupe: ${dedupe.duplicates} of ${dedupe.examined} listings are near-duplicates ` +
            `(${dedupe.changed} newly marked)`,
        );
      }
    } catch (err) {
      log.error(`dedupe: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Phase 2: score whatever the pre-filter let through -----------------
  // Deliberately after every source, so one scoring pass covers the whole
  // cycle rather than one pass per source paying the cached-prefix cost twice.
  await scoreCycle(cli, settings);

  // --- Phase 3: tell the human about anything worth seeing ----------------
  await notifyCycle(cli);
}

/**
 * Send the matches that cleared the threshold.
 *
 * Non-fatal, like scoring. The send queue is "scored at or above threshold and
 * still `new`", so a failed send is retried next cycle rather than lost — and
 * a Telegram outage must not stop the pipeline finding jobs.
 */
async function notifyCycle(cli: Cli): Promise<void> {
  try {
    const stats = await runNotifier({ dryRun: cli.dryRun });
    if (stats.reason && stats.sent === 0 && stats.candidates === 0) {
      log.debug(`notify: ${stats.reason}`);
      return;
    }
    if (stats.candidates === 0) return;
    log.info(
      `notify: ${stats.sent}/${stats.candidates} sent` +
        (stats.failed ? `, ${stats.failed} failed` : '') +
        (stats.deferred ? `, ${stats.deferred} held for tomorrow` : '') +
        (stats.reason ? ` (${stats.reason})` : ''),
    );
  } catch (err) {
    log.error(`notify: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Score this cycle's backlog, inside the configured spend ceiling.
 *
 * Never throws into the poll loop. Scoring costs real money and talks to a
 * third service; if it breaks, ingestion must keep running, because the queue
 * is derived from listings that have no match row and therefore survives
 * indefinitely until scoring works again.
 */
async function scoreCycle(cli: Cli, settings: AppSettingsRow): Promise<void> {
  if (!settings.scoring_enabled) {
    log.debug('scoring: disabled in app_settings, skipping');
    return;
  }

  const { allowed, spentToday, reason } = spendAllowance(settings);
  if (allowed <= 0) {
    log.info(`scoring: ${reason}`);
    return;
  }
  log.info(`scoring: ${reason} ($${spentToday.toFixed(4)} spent today)`);

  try {
    const stats = await runScoring({
      budgetUsd: allowed,
      batchSize: settings.scoring_batch_size,
      dryRun: cli.dryRun,
    });

    if (stats.queued === 0) {
      log.info('scoring: nothing new to score');
      return;
    }
    const notifiable =
      (stats.distribution['80-100'] ?? 0) + (stats.distribution['70-79'] ?? 0);
    log.info(
      `scoring: ${stats.scored}/${stats.queued} scored for $${stats.costUsd.toFixed(4)}, ` +
        `${notifiable} at or above the notify threshold` +
        (stats.retries ? `, ${stats.retries} retries` : '') +
        (stats.failedBatches ? `, ${stats.failedBatches} failed` : '') +
        (stats.stoppedOnBudget ? ' (stopped on budget)' : ''),
    );
  } catch (err) {
    log.error(`scoring: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function logStats(name: string, s: IngestStats): void {
  log.info(
    `${name}: fetched ${s.fetched}, ${s.duplicatesInBatch} in-batch dupes, ` +
      `${s.passed} passed, ${s.rejected} rejected, ${s.written} written` +
      (s.crossSourceCandidates ? `, ${s.crossSourceCandidates} probable cross-source dupes` : ''),
  );
  const kms = Object.entries(s.keywordMatchSource).sort((a, b) => b[1] - a[1]);
  if (kms.length) {
    log.info(`${name}: keyword gate — ${kms.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const reasons = Object.entries(s.rejectionReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length) {
    log.info(`${name}: rejections — ${reasons.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const env = getEnv();

  log.info(
    `intern-finder worker starting (${cli.once ? 'once' : 'loop'}` +
      `${cli.fixtures ? ', fixtures' : ''}${cli.dryRun ? ', dry-run' : ''}${cli.force ? ', forced' : ''})`,
  );

  const conn = await checkConnection();
  if (!conn.ok) {
    log.error(`Supabase: ${conn.detail}`);
    process.exit(1);
  }
  log.info(`Supabase: ${conn.detail}`);

  if (cli.once) {
    await runCycle(cli);
    return;
  }

  let stopping = false;
  // Cancels the tick sleep and any in-flight Telegram long poll. Without it,
  // SIGTERM sets the flag and the process then sits inside a 300-second timer
  // until systemd gives up and SIGKILLs — which is what "Failed with result
  // 'timeout'" in the journal means.
  const shutdown = new AbortController();
  const stop = (signal: string) => {
    log.info(`${signal} received, finishing current cycle then exiting`);
    stopping = true;
    shutdown.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // The bot listens CONCURRENTLY with the poll loop, deliberately not awaited.
  // A cycle can take minutes; a bot that only listened between cycles would
  // leave /pause unanswered for exactly as long as the thing you are trying to
  // stop keeps running. It also has to keep answering while is_paused is true,
  // or /resume could never be delivered.
  const bot = runBot(() => stopping, shutdown.signal);

  while (!stopping) {
    try {
      await runCycle(cli);
    } catch (err) {
      // A bad cycle must never kill the loop — systemd would restart us into
      // the same failure. Log it and wait for the next tick.
      log.error(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stopping) break;
    await sleep(env.WORKER_TICK_SECONDS * 1000, shutdown.signal);
  }

  // The bot is mid-long-poll and can take up to 25s to notice; wait for it so
  // systemd sees a clean exit rather than killing us on its stop timeout.
  await bot;
  log.info('worker stopped');
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

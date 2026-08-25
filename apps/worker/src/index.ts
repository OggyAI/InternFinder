import {
  checkConnection,
  getEnv,
  isSourceDue,
  loadActiveFilter,
  loadAppSettings,
  loadSources,
  log,
  recordPoll,
  type FilterSet,
  type NormalizedListing,
  type SourceName,
  type SourceRow,
} from '@intern-finder/core';
import { adzunaAdapter } from './sources/adzuna';
import { joobleAdapter } from './sources/jooble';
import { adzunaFixtureAdapter, joobleFixtureAdapter } from './sources/fixtures';
import type { SourceAdapter } from './sources/types';
import { ingest, type IngestStats } from './ingest';

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
  const has = (flag: string) => argv.includes(flag);
  const value = (flag: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : null;
  };

  const raw = value('--source');
  return {
    once: has('--once'),
    // --dry-run implies fixtures are safe to use but does NOT force them; you
    // can dry-run against live APIs to see what would be stored.
    dryRun: has('--dry-run'),
    fixtures: has('--fixtures'),
    // Ignore poll_interval and quota gating. For manual runs and testing only.
    force: has('--force'),
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
      if (!cli.dryRun) await recordPoll(source.name, { calls, ok: false, error: message });
      continue;
    }

    const stats = await ingest(listings, filterSet, { dryRun: cli.dryRun, now });
    logStats(source.name, stats);

    if (!cli.dryRun) await recordPoll(source.name, { calls, ok: true });
  }
}

function logStats(name: string, s: IngestStats): void {
  log.info(
    `${name}: fetched ${s.fetched}, ${s.duplicatesInBatch} in-batch dupes, ` +
      `${s.passed} passed, ${s.rejected} rejected, ${s.written} written` +
      (s.crossSourceCandidates ? `, ${s.crossSourceCandidates} probable cross-source dupes` : ''),
  );
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
  const stop = (signal: string) => {
    log.info(`${signal} received, finishing current cycle then exiting`);
    stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    try {
      await runCycle(cli);
    } catch (err) {
      // A bad cycle must never kill the loop — systemd would restart us into
      // the same failure. Log it and wait for the next tick.
      log.error(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, env.WORKER_TICK_SECONDS * 1000));
  }

  log.info('worker stopped');
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

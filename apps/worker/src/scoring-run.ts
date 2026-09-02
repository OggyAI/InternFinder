import Anthropic from '@anthropic-ai/sdk';
import {
  buildBatchMessage,
  buildRubric,
  finalFitScore,
  getEnv,
  getServiceClient,
  log,
  requestCostUsd,
  ScoreBatchResult,
  SCORE_TOOL,
  type AppSettingsRow,
  type ScorableListing,
  type ScoredListing,
} from '@intern-finder/core';

/**
 * The scoring engine, shared by the `npm run score` CLI and the worker loop.
 *
 * One implementation on purpose. A scorer that behaves differently when run by
 * hand than when run unattended is a scorer whose output you cannot reason
 * about, and the unattended path is the one nobody watches.
 */

export interface ScoringOptions {
  /** Stop once this much has been spent. Checked between batches, so the
   *  overshoot is bounded by one batch. */
  budgetUsd: number;
  batchSize: number;
  /** Cap on listings considered this run, applied after ranking. */
  limit?: number | null;
  dryRun?: boolean;
  /** Re-score listings that already have a match row. */
  rescore?: boolean;
  /**
   * Aborted on SIGTERM. Checked between batches, which is the only safe place
   * to stop: a batch that has been paid for but not written would be re-scored
   * and paid for twice. Without this a restart during a long backlog run sat
   * inside an Anthropic request until systemd's stop timeout expired and
   * SIGKILLed the worker.
   */
  signal?: AbortSignal;
  /**
   * Called after each batch. Exists because moving the engine out of the CLI
   * silently removed its per-batch logging, leaving a forty-batch run with no
   * output for ten minutes — indistinguishable from a hang.
   */
  onBatch?: (progress: { done: number; total: number; costUsd: number }) => void;
}

export interface ScoringStats {
  queued: number;
  scored: number;
  costUsd: number;
  failedBatches: number;
  retries: number;
  stoppedOnBudget: boolean;
  distribution: Record<string, number>;
}

interface Row {
  id: string;
  title: string;
  company: string | null;
  location_suburb: string | null;
  distance_km: number | null;
  description: string | null;
  compensation: string;
  work_mode: string;
  commitment: string;
  role_type: string;
  duration_weeks: number | null;
  preference_multiplier: number;
}

const toScorable = (r: Row): ScorableListing => ({
  id: r.id,
  title: r.title,
  company: r.company,
  locationSuburb: r.location_suburb,
  distanceKm: r.distance_km,
  description: r.description,
  compensation: r.compensation,
  workMode: r.work_mode,
  commitment: r.commitment,
  roleType: r.role_type,
  durationWeeks: r.duration_weeks,
  preferenceMultiplier: Number(r.preference_multiplier),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Structurally valid but incomplete. Retryable — a generation glitch, not a
 *  bad request. See the comment where it is thrown. */
export class IncompleteBatchError extends Error {
  override readonly name = 'IncompleteBatchError';
}

export function scoreBucket(score: number): string {
  if (score >= 80) return '80-100';
  if (score >= 70) return '70-79';
  if (score >= 50) return '50-69';
  if (score >= 25) return '25-49';
  return '0-24';
}

/**
 * Read the spend guards, rolling the daily total over if the day has turned.
 * Returns how much may be spent right now — the smaller of what is left today
 * and the per-cycle ceiling.
 */
export function spendAllowance(settings: AppSettingsRow, now = new Date()): {
  allowed: number;
  spentToday: number;
  reason: string;
} {
  const expired = now >= new Date(settings.scoring_spend_reset_at);
  const spentToday = expired ? 0 : Number(settings.scoring_spend_today);
  const remainingToday = Math.max(0, Number(settings.max_scoring_spend_usd_per_day) - spentToday);
  const allowed = Math.min(remainingToday, Number(settings.max_scoring_spend_usd_per_cycle));

  if (remainingToday <= 0) {
    return { allowed: 0, spentToday, reason: `daily scoring budget spent ($${spentToday.toFixed(2)})` };
  }
  return { allowed, spentToday, reason: `$${allowed.toFixed(2)} available this cycle` };
}

/** Add this run's spend to the daily total, rolling the window if needed. */
export async function recordSpend(usd: number, now = new Date()): Promise<void> {
  if (usd <= 0) return;
  const db = getServiceClient();
  const { data, error } = await db
    .from('app_settings')
    .select('scoring_spend_today, scoring_spend_reset_at')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`spend read failed: ${error.message}`);

  const row = data as { scoring_spend_today: number; scoring_spend_reset_at: string };
  const resetAt = new Date(row.scoring_spend_reset_at);
  const expired = now >= resetAt;
  const nextReset = expired
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : resetAt;

  const { error: writeError } = await db
    .from('app_settings')
    .update({
      scoring_spend_today: Number(((expired ? 0 : Number(row.scoring_spend_today)) + usd).toFixed(6)),
      scoring_spend_reset_at: nextReset.toISOString(),
    })
    .eq('id', 1);
  if (writeError) throw new Error(`spend write failed: ${writeError.message}`);
}

/**
 * Read an entire table through PostgREST, which will not return more than 1000
 * rows in a single response no matter what `.limit()` says. Pages with
 * `.range()` until a short page arrives.
 *
 * The caller must apply a deterministic ordering, or rows can repeat or be
 * skipped between pages.
 */
async function fetchAllRows<T>(
  table: 'job_listings' | 'matches',
  build: (query: any) => any,
): Promise<T[]> {
  const db = getServiceClient();
  const PAGE = 1000;
  const rows: T[] = [];

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(db.from(table)).range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${table} load failed: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export async function runScoring(options: ScoringOptions): Promise<ScoringStats> {
  const env = getEnv();
  const db = getServiceClient();
  const stats: ScoringStats = {
    queued: 0, scored: 0, costUsd: 0, failedBatches: 0,
    retries: 0, stoppedOnBudget: false, distribution: {},
  };

  if (!env.ANTHROPIC_API_KEY) {
    log.warn('scoring: ANTHROPIC_API_KEY not set, skipping');
    return stats;
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // --- Resume -------------------------------------------------------------
  const { data: resumeRow, error: resumeError } = await db
    .from('resume_versions').select('id, label, content').eq('is_active', true).maybeSingle();
  if (resumeError) throw new Error(`resume load failed: ${resumeError.message}`);
  if (!resumeRow) {
    log.warn('scoring: no active resume, skipping');
    return stats;
  }
  const resume = resumeRow as { id: string; label: string; content: string };

  // --- Work queue ---------------------------------------------------------
  // PostgREST has no NOT EXISTS, so the anti-join happens here. Deriving the
  // queue from the ABSENCE of a match row (rather than a cursor) is what makes
  // a failed batch self-healing: those listings simply reappear next run.
  //
  // Both halves MUST paginate. PostgREST caps a response at 1000 rows whatever
  // `.limit()` asks for, and with `.limit(5000)` / `.limit(10000)` this failed
  // in two expensive ways at once: only the top 1000 listings by preference
  // were ever candidates (736 passing listings were invisible to scoring and
  // the backlog could never drain), and only 1000 of the 1501 existing match
  // rows were recognised, so listings that had already been scored looked
  // unscored and were paid for a second time.
  const passed = await fetchAllRows<Row>('job_listings', (query) =>
    query
      .select('id,title,company,location_suburb,distance_km,description,compensation,work_mode,commitment,role_type,duration_weeks,preference_multiplier')
      .eq('prefilter_status', 'passed')
      // Never score a near-duplicate. It is the same job as its canonical, so
      // the score would be the same answer bought twice — about 9% of passing
      // listings, and 9% of the bill.
      .is('duplicate_of', null)
      .order('preference_multiplier', { ascending: false })
      // A stable tiebreak, or rows can repeat or vanish across pages when many
      // share a multiplier.
      .order('id', { ascending: true }),
  );

  const scoredRows = await fetchAllRows<{ listing_id: string }>('matches', (query) =>
    query.select('listing_id').order('listing_id', { ascending: true }),
  );

  const alreadyScored = new Set(scoredRows.map((m) => m.listing_id));
  let queue = options.rescore ? passed : passed.filter((r) => !alreadyScored.has(r.id));
  if (options.limit != null && queue.length > options.limit) queue = queue.slice(0, options.limit);
  stats.queued = queue.length;
  if (queue.length === 0) return stats;

  // --- Score --------------------------------------------------------------
  const rubric = buildRubric(resume.content);

  for (let i = 0; i < queue.length; i += options.batchSize) {
    // Stop cleanly on shutdown. The queue is derived from listings that have
    // no match row, so whatever is left is simply picked up next start —
    // nothing is lost by stopping here.
    if (options.signal?.aborted) {
      log.info(
        `scoring: shutdown requested after ${stats.scored} listings; ` +
          `${queue.length - i} left for the next run`,
      );
      break;
    }

    // Checked BEFORE each batch, so the ceiling is honoured with an overshoot
    // of at most one batch rather than being discovered after the fact.
    if (stats.costUsd >= options.budgetUsd) {
      stats.stoppedOnBudget = true;
      log.warn(
        `scoring: budget of $${options.budgetUsd.toFixed(2)} reached after ${stats.scored} listings; ` +
          `${queue.length - i} left for the next run`,
      );
      break;
    }

    const scorable = queue.slice(i, i + options.batchSize).map(toScorable);
    let parsed: ScoredListing[];
    try {
      parsed = await scoreBatch(client, env.ANTHROPIC_MODEL, rubric, scorable, stats);
    } catch (err) {
      stats.failedBatches++;
      log.error(`scoring: batch failed — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const rows = [];
    for (const s of parsed) {
      // Map the model's ref back by position. It never sees a database id, so
      // it cannot invent a plausible one and attach a score to the wrong row.
      const listing = scorable[s.ref - 1];
      if (!listing) continue;
      const fit = finalFitScore(s.base_score, listing.preferenceMultiplier);
      const b = scoreBucket(fit);
      stats.distribution[b] = (stats.distribution[b] ?? 0) + 1;
      rows.push({
        listing_id: listing.id,
        resume_version_id: resume.id,
        base_score: s.base_score,
        fit_score: fit,
        preference_multiplier: listing.preferenceMultiplier,
        reasoning: s.reasoning.trim(),
        category: s.category,
        compensation: listing.compensation,
        work_mode: listing.workMode,
        commitment: listing.commitment,
        duration_weeks: listing.durationWeeks,
        model: env.ANTHROPIC_MODEL,
        scored_at: new Date().toISOString(),
      });
    }

    if (!options.dryRun && rows.length > 0) {
      const { error } = await db.from('matches').upsert(rows, { onConflict: 'listing_id' });
      if (error) throw new Error(`match upsert failed: ${error.message}`);
    }
    stats.scored += rows.length;
    options.onBatch?.({ done: stats.scored, total: queue.length, costUsd: stats.costUsd });
  }

  if (!options.dryRun) await recordSpend(stats.costUsd);
  return stats;
}

async function scoreBatch(
  client: Anthropic,
  model: string,
  rubric: string,
  listings: ScorableListing[],
  stats: ScoringStats,
): Promise<ScoredListing[]> {
  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 8000,
        // The rubric and resume are one stable cached prefix. Anything volatile
        // here would invalidate it on every call and quadruple the input cost.
        system: [{ type: 'text', text: rubric, cache_control: { type: 'ephemeral' } }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        tools: [SCORE_TOOL],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: buildBatchMessage(listings) }],
      });

      stats.costUsd += requestCostUsd(res.usage);

      if (res.stop_reason === 'refusal') {
        throw new Error(`model refused: ${res.stop_details?.explanation ?? 'no explanation'}`);
      }
      const toolUse = res.content.find((b) => b.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error(`no tool_use block (stop_reason=${res.stop_reason})`);
      }

      const scores = ScoreBatchResult.parse(toolUse.input).scores;

      // Neither strict mode nor zod covers CONTENT, and content is where this
      // went wrong in testing: a batch came back with one entry whose reasoning
      // ended `...limit fit somewhat.}, {` — the model had run the remaining
      // array entries into the string. Schema-valid, and it silently lost two
      // listings. Both checks make that a retry rather than a quiet data loss.
      if (scores.length !== listings.length) {
        throw new IncompleteBatchError(`expected ${listings.length} scores, got ${scores.length}`);
      }
      const leaked = scores.find((s) => /\}\s*,\s*\{|"ref"\s*:/.test(s.reasoning));
      if (leaked) {
        throw new IncompleteBatchError(`reasoning for ref ${leaked.ref} contains JSON`);
      }
      return scores;
    } catch (err) {
      const last = attempt === MAX_ATTEMPTS;
      // Most specific first. A 400 or a schema error will never succeed on a
      // retry, so retrying it only burns time and money.
      if (err instanceof IncompleteBatchError) {
        if (last) throw err;
        stats.retries++;
        await sleep(500);
        continue;
      }
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError) {
        if (last) throw err;
        stats.retries++;
        await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      if (err instanceof Anthropic.APIError && err.status && err.status >= 500) {
        if (last) throw err;
        stats.retries++;
        await sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

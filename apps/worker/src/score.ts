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
  type ScorableListing,
  type ScoredListing,
} from '@intern-finder/core';
import { flagValue, hasFlag } from './cli';

/**
 * Phase 2 — score pre-filtered listings against the active resume.
 *
 *   npm run score                 score everything unscored
 *   npm run score -- --limit=50   cap the run (and the spend)
 *   npm run score -- --dry-run    call the API, print scores, write nothing
 *   npm run score -- --rescore    re-score listings that already have a score
 *
 * Cost control, in order of how much it saves:
 *  1. The rule-based pre-filter, which keeps most listings away from here.
 *  2. Batching several listings per request, so the cached prefix amortises.
 *  3. Prompt caching the rubric + resume — a tenth of the input price.
 *  4. --limit, for when you want a hard ceiling on one run.
 */

const BATCH_SIZE = Number(flagValue('batch') ?? 8);
const LIMIT = flagValue('limit') ? Number(flagValue('limit')) : null;
const DRY_RUN = hasFlag('dry-run');
const RESCORE = hasFlag('rescore');

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

/** Sleep, for backing off after a 429. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The model returned a structurally valid but incomplete answer. Retryable:
 *  it is a generation glitch rather than a bad request, and re-asking works. */
class IncompleteBatchError extends Error {
  override readonly name = 'IncompleteBatchError';
}

async function main(): Promise<void> {
  const env = getEnv();
  if (!env.ANTHROPIC_API_KEY) {
    log.error('ANTHROPIC_API_KEY is not set — nothing to score with.');
    process.exit(1);
  }

  const db = getServiceClient();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // --- Resume -------------------------------------------------------------
  const { data: resumeRow, error: resumeError } = await db
    .from('resume_versions')
    .select('id, label, content')
    .eq('is_active', true)
    .maybeSingle();
  if (resumeError) throw new Error(`resume load failed: ${resumeError.message}`);
  if (!resumeRow) {
    log.error('No active resume in resume_versions. Nothing to score against.');
    process.exit(1);
  }
  const resume = resumeRow as { id: string; label: string; content: string };
  log.info(`resume: "${resume.label}" (${resume.content.length} chars)`);

  // --- What needs scoring -------------------------------------------------
  // PostgREST has no NOT EXISTS, so the anti-join happens here. At this scale
  // (hundreds of rows, two id-only queries) that is cheaper and clearer than
  // adding a database view for it.
  const { data: passedData, error: passedError } = await db
    .from('job_listings')
    .select(
      'id,title,company,location_suburb,distance_km,description,compensation,work_mode,commitment,role_type,duration_weeks,preference_multiplier',
    )
    .eq('prefilter_status', 'passed')
    .order('preference_multiplier', { ascending: false })
    .limit(5000);
  if (passedError) throw new Error(`listing load failed: ${passedError.message}`);

  const { data: scoredData, error: scoredError } = await db
    .from('matches')
    .select('listing_id')
    .limit(10000);
  if (scoredError) throw new Error(`matches load failed: ${scoredError.message}`);

  const alreadyScored = new Set((scoredData ?? []).map((m) => (m as { listing_id: string }).listing_id));
  const passed = (passedData ?? []) as unknown as Row[];
  let queue = RESCORE ? passed : passed.filter((r) => !alreadyScored.has(r.id));

  log.info(
    `${passed.length} listings passed the pre-filter, ${alreadyScored.size} already scored, ` +
      `${queue.length} to score${RESCORE ? ' (rescoring everything)' : ''}`,
  );
  if (LIMIT !== null && queue.length > LIMIT) {
    // Highest preference multiplier first, so a capped run spends the budget
    // on the most promising listings rather than an arbitrary slice.
    queue = queue.slice(0, LIMIT);
    log.info(`--limit=${LIMIT}: scoring the ${LIMIT} highest-ranked of them`);
  }
  if (queue.length === 0) {
    log.info('nothing to do');
    return;
  }

  // --- Score in batches ---------------------------------------------------
  const rubric = buildRubric(resume.content);
  let totalCost = 0;
  let scoredCount = 0;
  let failedBatches = 0;
  const distribution = new Map<string, number>();

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    const scorable = batch.map(toScorable);
    const label = `batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(queue.length / BATCH_SIZE)}`;

    let parsed: ScoredListing[];
    try {
      parsed = await scoreBatch(client, env, rubric, scorable, (cost) => {
        totalCost += cost;
      });
    } catch (err) {
      failedBatches++;
      // One bad batch must not lose the rest of the run. The listings stay
      // unscored and are picked up next time, because the work queue is
      // derived from the absence of a match row rather than from a cursor.
      log.error(`${label}: failed — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // The model returns refs, not ids. Map back by position, and drop anything
    // out of range rather than trusting an invented ref onto the wrong listing.
    const rows = [];
    for (const s of parsed) {
      const listing = scorable[s.ref - 1];
      if (!listing) {
        log.warn(`${label}: ignoring out-of-range ref ${s.ref}`);
        continue;
      }
      const fit = finalFitScore(s.base_score, listing.preferenceMultiplier);
      distribution.set(bucket(fit), (distribution.get(bucket(fit)) ?? 0) + 1);
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

    if (DRY_RUN) {
      for (const r of rows) {
        const l = scorable.find((s) => s.id === r.listing_id)!;
        log.info(`  ${String(r.fit_score).padStart(3)} (base ${String(r.base_score).padStart(3)} x${r.preference_multiplier.toFixed(2)})  ${l.title}`);
        log.info(`       ${r.reasoning}`);
      }
    } else if (rows.length > 0) {
      const { error } = await db.from('matches').upsert(rows, { onConflict: 'listing_id' });
      if (error) throw new Error(`match upsert failed: ${error.message}`);
    }

    scoredCount += rows.length;
    log.info(`${label}: ${rows.length} scored, running cost $${totalCost.toFixed(4)}`);
  }

  // --- Summary ------------------------------------------------------------
  const { data: settings } = await db
    .from('app_settings').select('notify_score_threshold').eq('id', 1).maybeSingle();
  const threshold = (settings as { notify_score_threshold: number } | null)?.notify_score_threshold ?? 70;

  log.info('');
  log.info(`scored ${scoredCount} listings for $${totalCost.toFixed(4)}` +
    (scoredCount ? ` ($${(totalCost / scoredCount).toFixed(5)} each)` : '') +
    (failedBatches ? `, ${failedBatches} batch(es) failed` : ''));
  for (const b of ['80-100', '70-79', '50-69', '25-49', '0-24']) {
    const n = distribution.get(b) ?? 0;
    log.info(`  ${b.padEnd(7)} ${'#'.repeat(Math.min(40, n))} ${n}`);
  }
  const notifiable = [...distribution.entries()]
    .filter(([b]) => b === '80-100' || b === '70-79')
    .reduce((sum, [, n]) => sum + n, 0);
  log.info(`${notifiable} at or above the notify threshold of ${threshold}`);
  if (DRY_RUN) log.info('(dry run — nothing was written)');
}

function bucket(score: number): string {
  if (score >= 80) return '80-100';
  if (score >= 70) return '70-79';
  if (score >= 50) return '50-69';
  if (score >= 25) return '25-49';
  return '0-24';
}

/** One request, with retry on the failures that are worth retrying. */
async function scoreBatch(
  client: Anthropic,
  env: ReturnType<typeof getEnv>,
  rubric: string,
  listings: ScorableListing[],
  onCost: (usd: number) => void,
): Promise<ScoredListing[]> {
  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await client.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 8000,
        // The rubric and resume are one stable cached prefix. Anything volatile
        // in here would invalidate it on every call — see scoring.ts.
        system: [{ type: 'text', text: rubric, cache_control: { type: 'ephemeral' } }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        tools: [SCORE_TOOL],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: buildBatchMessage(listings) }],
      });

      onCost(requestCostUsd(res.usage));

      if (res.stop_reason === 'refusal') {
        throw new Error(`model refused: ${res.stop_details?.explanation ?? 'no explanation'}`);
      }

      const toolUse = res.content.find((b) => b.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error(`no tool_use block (stop_reason=${res.stop_reason})`);
      }

      // Parse the JSON rather than trusting it: strict mode guarantees the
      // shape the API validated, zod guarantees the shape we rely on.
      const scores = ScoreBatchResult.parse(toolUse.input).scores;

      // Neither guarantee covers CONTENT, and content is where this went
      // wrong in testing: one batch came back with a single entry whose
      // reasoning ended `...limit fit somewhat.}, {` — the model had run the
      // remaining array entries into the string. Schema-valid, and it silently
      // lost two listings. Both checks below make that a retry, not a warning.
      if (scores.length !== listings.length) {
        throw new IncompleteBatchError(
          `expected ${listings.length} scores, got ${scores.length}`,
        );
      }
      const leaked = scores.find((s) => /\}\s*,\s*\{|"ref"\s*:/.test(s.reasoning));
      if (leaked) {
        throw new IncompleteBatchError(
          `reasoning for ref ${leaked.ref} contains JSON — the response ran entries together`,
        );
      }
      return scores;
    } catch (err) {
      const last = attempt === MAX_ATTEMPTS;
      // Most specific first. A 400 or a schema error will never succeed on
      // retry, so retrying it just burns time and money.
      if (err instanceof IncompleteBatchError) {
        if (last) throw err;
        log.warn(`  ${err.message}; re-asking (attempt ${attempt}/${MAX_ATTEMPTS})`);
        await sleep(500);
        continue;
      }
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError) {
        if (last) throw err;
        const backoff = 2000 * 2 ** (attempt - 1);
        log.warn(`  ${err.constructor.name}, retrying in ${backoff}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
        await sleep(backoff);
        continue;
      }
      if (err instanceof Anthropic.APIError && err.status && err.status >= 500) {
        if (last) throw err;
        await sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

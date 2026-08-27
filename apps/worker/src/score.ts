import { getServiceClient, log, AppSettingsRow } from '@intern-finder/core';
import { flagValue, hasFlag } from './cli';
import { runScoring, spendAllowance } from './scoring-run';

/**
 * `npm run score` — the manual scoring entry point.
 *
 * A thin wrapper. All the behaviour lives in scoring-run.ts, shared with the
 * worker loop, so scoring by hand and scoring unattended cannot drift apart.
 *
 *   npm run score                    score everything unscored
 *   npm run score -- --limit=50      cap how many listings
 *   npm run score -- --budget=0.25   cap the spend in USD
 *   npm run score -- --dry-run       call the API, print nothing to the database
 *   npm run score -- --rescore       re-score listings that already have a score
 *   npm run score -- --batch=8       listings per request
 *
 * Unlike the worker loop, this defaults to NO budget ceiling — you are sitting
 * here watching it. Pass --budget to impose one.
 */

async function main(): Promise<void> {
  const db = getServiceClient();
  const { data, error } = await db.from('app_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`app_settings load failed: ${error.message}`);
  const settings = AppSettingsRow.parse(data);

  const budgetFlag = flagValue('budget');
  const budgetUsd = budgetFlag ? Number(budgetFlag) : Number.POSITIVE_INFINITY;
  const batchSize = Number(flagValue('batch') ?? settings.scoring_batch_size);
  const limitFlag = flagValue('limit');
  const dryRun = hasFlag('dry-run');

  const { spentToday } = spendAllowance(settings);
  log.info(
    `scoring manually — batch ${batchSize}, ` +
      `budget ${budgetFlag ? `$${Number(budgetFlag).toFixed(2)}` : 'uncapped'}, ` +
      `$${spentToday.toFixed(4)} already spent today`,
  );

  const stats = await runScoring({
    budgetUsd,
    batchSize,
    limit: limitFlag ? Number(limitFlag) : null,
    dryRun,
    rescore: hasFlag('rescore'),
    onBatch: ({ done, total, costUsd }) =>
      log.info(`  ${String(done).padStart(4)}/${total} scored, $${costUsd.toFixed(4)}`),
  });

  log.info('');
  log.info(
    `${stats.queued} queued, ${stats.scored} scored for $${stats.costUsd.toFixed(4)}` +
      (stats.scored ? ` ($${(stats.costUsd / stats.scored).toFixed(5)} each)` : '') +
      (stats.retries ? `, ${stats.retries} retries` : '') +
      (stats.failedBatches ? `, ${stats.failedBatches} batch(es) failed` : ''),
  );
  for (const b of ['80-100', '70-79', '50-69', '25-49', '0-24']) {
    const n = stats.distribution[b] ?? 0;
    log.info(`  ${b.padEnd(7)} ${'#'.repeat(Math.min(40, n))} ${n}`);
  }
  const notifiable = (stats.distribution['80-100'] ?? 0) + (stats.distribution['70-79'] ?? 0);
  log.info(`${notifiable} at or above the notify threshold of ${settings.notify_score_threshold}`);
  if (stats.stoppedOnBudget) log.info('stopped early on the budget ceiling — run again to continue');
  if (dryRun) log.info('(dry run — nothing was written)');
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

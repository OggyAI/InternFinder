import { log } from '@intern-finder/core';
import { hasFlag } from './cli';
import { runDedupePass } from './dedupe-pass';

/**
 * `npm run dedupe` — re-derive duplicate_of across every stored listing.
 *
 *   npm run dedupe              apply
 *   npm run dedupe -- --dry-run report what would change, write nothing
 *
 * The worker runs this itself each cycle; this is for after changing the
 * radius, or for checking what it would do before letting it.
 */
async function main(): Promise<void> {
  const dryRun = hasFlag('dry-run');
  const stats = await runDedupePass(dryRun);
  log.info(
    `${stats.examined} listings examined, ${stats.duplicates} are near-duplicates, ` +
      `${stats.changed} ${dryRun ? 'would change' : 'updated'}`,
  );
  if (dryRun) log.info('(dry run — nothing was written)');
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

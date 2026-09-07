import { log, preferIPv4 } from '@intern-finder/core';
import { hasFlag } from './cli';
import { runNotifier } from './notifier';

// Must run before any network call. See packages/core/src/net.ts — Node's
// Happy Eyeballs hangs on this VM's dead IPv6 route instead of falling back.
preferIPv4();

/**
 * `npm run notify` — send pending notifications now.
 *
 *   npm run notify -- --dry-run   count what would be sent, send nothing
 *
 * The worker does this every cycle. This exists so the queue can be inspected
 * and the formatting checked on a real phone without waiting for one.
 */

const dryRun = hasFlag('dry-run', process.argv.slice(2));

const stats = await runNotifier({ dryRun });

log.info(
  `${stats.candidates} candidate${stats.candidates === 1 ? '' : 's'}, ` +
    `${stats.sent} sent, ${stats.failed} failed, ${stats.deferred} held` +
    (stats.reason ? ` — ${stats.reason}` : ''),
);

if (stats.candidates === 0 && !stats.reason) {
  log.info('Nothing at or above the notify threshold is still marked `new`.');
}

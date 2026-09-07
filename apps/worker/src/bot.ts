import { log, preferIPv4 } from '@intern-finder/core';
import { runBot } from './telegram-bot';

// Must run before any network call. See packages/core/src/net.ts — Node's
// Happy Eyeballs hangs on this VM's dead IPv6 route instead of falling back.
preferIPv4();

/**
 * `npm run bot` — the Telegram bot on its own, with no polling or scoring.
 *
 * The deployed worker runs this loop itself, concurrently with its cycles, so
 * this is not how it runs in production. It exists to answer commands and
 * button taps while testing, without a cycle spending money in the background.
 */

let stopping = false;
// Cancels the in-flight long poll so Ctrl-C is immediate rather than waiting
// out the remaining 25 seconds.
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, stopping`);
    stopping = true;
    shutdown.abort();
  });
}

await runBot(() => stopping, shutdown.signal);

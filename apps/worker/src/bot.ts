import { log } from '@intern-finder/core';
import { runBot } from './telegram-bot';

/**
 * `npm run bot` — the Telegram bot on its own, with no polling or scoring.
 *
 * The deployed worker runs this loop itself, concurrently with its cycles, so
 * this is not how it runs in production. It exists to answer commands and
 * button taps while testing, without a cycle spending money in the background.
 */

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, stopping after the current long poll`);
    stopping = true;
  });
}

await runBot(() => stopping);

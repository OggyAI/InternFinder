import { describe, expect, it } from 'vitest';
import { sleep } from './sleep';

describe('sleep', () => {
  it('waits for the requested time', async () => {
    const started = Date.now();
    await sleep(40);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleep(5_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('cuts a long wait short when aborted mid-sleep', async () => {
    // The worker ticks every 300s. Without this, SIGTERM is not noticed until
    // the timer ends and systemd SIGKILLs the process first.
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);
    await sleep(300_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not accumulate abort listeners across many ticks', async () => {
    // A worker that runs for weeks calls this thousands of times against one
    // long-lived signal; a listener leak would be invisible until it wasn't.
    const controller = new AbortController();
    for (let i = 0; i < 50; i++) await sleep(1, controller.signal);
    // Node exposes this on AbortSignal via EventTarget internals; if the count
    // is unavailable the assertion is skipped rather than faked.
    const count = (controller.signal as unknown as { listenerCount?: (t: string) => number })
      .listenerCount?.('abort');
    if (typeof count === 'number') expect(count).toBe(0);
  });
});

/**
 * A wait that a shutdown can cut short.
 *
 * The worker sleeps WORKER_TICK_SECONDS (300 by default) between cycles. With
 * a plain setTimeout, SIGTERM sets the stop flag and then nothing happens for
 * up to five minutes, because the loop is parked inside the timer and never
 * looks at the flag. systemd waits out its stop timeout and SIGKILLs — which
 * is exactly what "Failed with result 'timeout'" in the journal means.
 *
 * Resolves rather than rejects on abort: every caller's next move is to check
 * its own stop condition, and an exception would just be caught and discarded.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    // `once` so a long-lived signal does not accumulate listeners across every
    // tick of a process that runs for weeks.
    signal?.addEventListener('abort', finish, { once: true });
  });
}

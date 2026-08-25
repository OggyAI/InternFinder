/**
 * Dead-simple levelled logger. The worker runs under systemd, so everything
 * goes to stdout/stderr and journald handles rotation and timestamps.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info;

function emit(level: LogLevel, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) sink(line);
  else sink(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};

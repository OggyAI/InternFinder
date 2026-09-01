#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run a command with the workspace-root .env loaded.
 *
 * Next reads .env from its own directory, but this repo deliberately keeps one
 * .env at the workspace root so the worker and the dashboard share exactly one
 * copy of every credential — two copies drift, and the stale one is always
 * discovered at the worst moment.
 *
 * Loading it inside next.config.mjs does NOT work: Next renders in separate
 * worker processes and compiles middleware for the Edge runtime, and neither
 * inherits a process.env mutated during config evaluation. Every page reported
 * DASHBOARD_PASSWORD as unset and the site correctly refused itself with a
 * 503. Setting the variables BEFORE Next starts means every child process
 * inherits them, which is the one place that works for all three runtimes.
 *
 * Local development only. On Vercel there is no .env file and the platform
 * injects the variables; this then does nothing but exec the command.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../../.env');

/**
 * Deliberately a tiny parser rather than a dotenv dependency in this package.
 * It has to agree with packages/core/src/env.ts on one specific quirk: dotenv
 * strips only BALANCED surrounding quotes, so a value pasted with a single
 * trailing quote survives — which once turned an API key into a Cloudflare
 * challenge page rather than an auth error. Strip wrapping quotes either way.
 */
function parseEnvFile(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '').trim();
    if (value !== '') out[key] = value;
  }
  return out;
}

const fileEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: with-env.mjs <command> [args...]');
  process.exit(1);
}

/**
 * Resolve a workspace binary explicitly instead of relying on PATH.
 *
 * npm puts node_modules/.bin on PATH when it runs a script, but this file is
 * also run directly, and `shell: true` (which Windows needs for a .cmd
 * shim) both concatenates arguments unescaped and emits DEP0190. Finding the
 * real executable avoids the shell entirely.
 */
function resolveBin(name) {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  let dir = here;
  for (let depth = 0; depth < 6; depth++) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, 'node_modules', '.bin', `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const executable = resolveBin(command) ?? command;

const child = spawn(executable, args, {
  stdio: 'inherit',
  // A real environment variable always wins over the file, so Vercel's
  // injected values are never overwritten by a stray local .env.
  env: { ...fileEnv, ...process.env },
  // Node >=20 refuses to spawn a Windows .cmd/.bat shim without a shell, so
  // those need shell: true. A resolved POSIX binary does not, which keeps the
  // argument-escaping caveat (DEP0190) off the common path.
  shell: executable === command || /\.(cmd|bat)$/i.test(executable),
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

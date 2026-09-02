import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment loading and validation.
 *
 * Every credential in this project lives here and nowhere else — there are no
 * fallback literals, so a missing key fails loudly at startup rather than
 * silently producing an unauthenticated request at 3am.
 *
 * Phase-2/3 keys (Anthropic, Telegram) are optional at this stage: the Phase 1
 * worker must be able to boot and poll without them.
 */

// One .env at the repo root serves the worker and the dashboard alike.
const repoEnv = process.env.DOTENV_PATH ?? findRepoEnv();
loadDotenv(repoEnv ? { path: repoEnv } : {});

/**
 * Locate the repo-root .env by walking up from the working directory.
 *
 * Deliberately NOT `new URL('../../../.env', import.meta.url)`. Webpack treats
 * that exact form as an ASSET REFERENCE and tries to resolve the target at
 * BUILD time, so the Next build died with "Module not found: Can't resolve
 * '../../../.env'" on Vercel, where no .env file exists. It passed locally
 * only because the file happened to be there — the bug was invisible on every
 * machine that had one.
 *
 * Returns undefined when there is no file, which is the normal case on Vercel:
 * the platform injects real environment variables and dotenv has nothing to do.
 */
function findRepoEnv(): string | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const EnvSchema = z.object({
  // --- Phase 1: required ---
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a full https:// URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY looks empty'),
  // Not used by the worker. Present so `npm run doctor` can prove that an
  // anon-key client reaches nothing, and for the Phase 3 dashboard.
  SUPABASE_ANON_KEY: z.string().optional(),

  // --- Phase 1: required only for live pulls (fixture mode runs without) ---
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  ADZUNA_COUNTRY: z.string().length(2).default('au'),
  JOOBLE_API_KEY: z.string().optional(),

  // --- Phase 2 ---
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

  // --- Phase 3 ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WORKER_TICK_SECONDS: z.coerce.number().int().min(30).default(300),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Treat a blank value as absent.
 *
 * A .env filled in from a template is full of lines like `JOOBLE_API_KEY=`,
 * which arrive as the empty string rather than as undefined. Without this,
 * `.default()` never fires and `LOG_LEVEL=` fails enum validation — an
 * alarming startup error for what is really just an unfilled line.
 */
function presentOnly(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    // Strip wrapping quotes as well as whitespace. dotenv removes *balanced*
    // quotes, so a value pasted with only a trailing one survives intact — and
    // a single stray `"` on an API key that goes into a URL path produced a
    // Cloudflare challenge page rather than any recognisable auth error.
    const cleaned = value.trim().replace(/^["']|["']$/g, '').trim();
    if (cleaned !== '') out[key] = cleaned;
  }
  return out;
}

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(presentOnly(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment — fill these in in .env at the repo root:\n${issues}\n` +
        `(No .env yet? Copy .env.example. To run with no credentials at all: npm run demo)`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** True when Adzuna can actually be called. */
export function hasAdzunaCreds(env: Env): boolean {
  return Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY);
}

/** True when Jooble can actually be called. */
export function hasJoobleCreds(env: Env): boolean {
  return Boolean(env.JOOBLE_API_KEY);
}

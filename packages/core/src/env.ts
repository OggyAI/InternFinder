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

// Walk up from the worker's cwd so a single .env at the repo root serves both
// the worker and (later) the Next.js app.
loadDotenv({ path: process.env.DOTENV_PATH ?? findRepoEnv() });

function findRepoEnv(): string {
  return new URL('../../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const EnvSchema = z.object({
  // --- Phase 1: required ---
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a full https:// URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY looks empty'),

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
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
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

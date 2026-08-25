import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from './env';

/**
 * Supabase access for the worker.
 *
 * This uses the service_role key, which bypasses RLS entirely. That is correct
 * for a trusted background process and catastrophic anywhere else — this
 * module must never be imported by the Next.js client bundle. The Phase 3
 * dashboard gets its own anon-key client under apps/web.
 */

let cached: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cached) return cached;
  const env = getEnv();
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'intern-finder-worker' } },
  });
  return cached;
}

/**
 * Cheap round-trip to prove the URL, the key, and the schema are all real.
 *
 * Uses a real GET rather than `head: true`. PostgREST answers a HEAD request
 * for a table that does not exist with a bodiless 404, so supabase-js reports
 * no error and a null count — indistinguishable from an empty table. That made
 * this function claim "connected, 0 filter row(s)" against a database with no
 * schema at all. Ask for a row and check the status code.
 */
export async function checkConnection(): Promise<{ ok: boolean; detail: string }> {
  const db = getServiceClient();
  const { error, count, status } = await db
    .from('filters')
    .select('id', { count: 'exact' })
    .limit(1);

  if (error || status >= 400) {
    const message = error?.message ?? `HTTP ${status}`;
    const hint = /relation .* does not exist|schema cache/i.test(message)
      ? ' — schema not applied yet? apply supabase/migrations/*.sql, then `npm run doctor`'
      : '';
    return { ok: false, detail: `${message}${hint}` };
  }
  return { ok: true, detail: `connected, ${count ?? 0} filter row(s)` };
}

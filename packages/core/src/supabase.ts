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

/** Cheap round-trip to prove the URL, the key, and the schema are all real. */
export async function checkConnection(): Promise<{ ok: boolean; detail: string }> {
  const db = getServiceClient();
  const { error, count } = await db
    .from('filters')
    .select('id', { count: 'exact', head: true });

  if (error) {
    const hint = /relation .* does not exist|schema cache/i.test(error.message)
      ? ' — schema not applied yet? run `supabase db push`'
      : '';
    return { ok: false, detail: `${error.message}${hint}` };
  }
  return { ok: true, detail: `connected, ${count ?? 0} filter row(s)` };
}

import { getServiceClient } from './supabase';
import {
  AppSettingsRow,
  FilterKeywordRow,
  FilterPreferenceRow,
  FilterRow,
  SourceRow,
  type FilterSet,
  type SourceName,
} from './types';

/**
 * Loading the criteria set.
 *
 * The whole point of the `filters` / `filter_keywords` / `filter_preferences`
 * tables is that this is read fresh from the database on every poll. Change a
 * keyword from the dashboard or a Telegram command and the next cycle picks it
 * up — no redeploy, no restart, no constant to edit.
 *
 * Rows are parsed through zod on the way in. Postgres returns numeric columns
 * as strings over PostgREST, so `weight` needs the coercion the schemas apply;
 * without it every multiplier would silently become NaN.
 */

export async function loadActiveFilter(): Promise<FilterSet> {
  const db = getServiceClient();

  const { data: filterData, error: filterError } = await db
    .from('filters')
    .select('*')
    .eq('is_active', true)
    .maybeSingle();

  if (filterError) throw new Error(`Failed to load filters: ${filterError.message}`);
  if (!filterData) {
    throw new Error(
      'No active filter row. Apply the seed migration (supabase db push) or set is_active on a row.',
    );
  }

  const filter = FilterRow.parse(filterData);

  const [{ data: kwData, error: kwError }, { data: prefData, error: prefError }] =
    await Promise.all([
      db.from('filter_keywords').select('*').eq('filter_id', filter.id).eq('is_active', true),
      db.from('filter_preferences').select('*').eq('filter_id', filter.id).eq('is_active', true),
    ]);

  if (kwError) throw new Error(`Failed to load filter_keywords: ${kwError.message}`);
  if (prefError) throw new Error(`Failed to load filter_preferences: ${prefError.message}`);

  return {
    filter,
    keywords: (kwData ?? []).map((r) => FilterKeywordRow.parse(r)),
    preferences: (prefData ?? []).map((r) => FilterPreferenceRow.parse(r)),
  };
}

export async function loadAppSettings(): Promise<AppSettingsRow> {
  const db = getServiceClient();
  const { data, error } = await db.from('app_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(`Failed to load app_settings: ${error.message}`);
  if (!data) throw new Error('No app_settings row. Apply the seed migration.');
  return AppSettingsRow.parse(data);
}

export async function loadSources(): Promise<SourceRow[]> {
  const db = getServiceClient();
  const { data, error } = await db.from('sources').select('*');
  if (error) throw new Error(`Failed to load sources: ${error.message}`);
  return (data ?? []).map((r) => SourceRow.parse(r));
}

/**
 * Whether a source is allowed to run right now.
 *
 * Three independent gates, all of which live in the database rather than in
 * env or code, so any of them can be flipped at runtime:
 *   - `enabled`, the manual off switch
 *   - `poll_interval_minutes` since `last_polled_at`, the cadence
 *   - `calls_today` against `max_calls_per_day`, the free-tier budget guard
 */
export function isSourceDue(source: SourceRow, now = new Date()): { due: boolean; reason: string } {
  if (!source.enabled) return { due: false, reason: 'disabled' };

  const quotaReset = new Date(source.quota_reset_at);
  const quotaStillCurrent = now < quotaReset;
  if (quotaStillCurrent && source.calls_today >= source.max_calls_per_day) {
    return {
      due: false,
      reason: `daily quota spent (${source.calls_today}/${source.max_calls_per_day}), resets ${quotaReset.toISOString()}`,
    };
  }

  if (source.last_polled_at) {
    const elapsedMin = (now.getTime() - new Date(source.last_polled_at).getTime()) / 60_000;
    if (elapsedMin < source.poll_interval_minutes) {
      const waitMin = Math.ceil(source.poll_interval_minutes - elapsedMin);
      return { due: false, reason: `not due for ${waitMin}m` };
    }
  }

  return { due: true, reason: 'due' };
}

/** Record the outcome of a poll, rolling the daily quota over when it expires. */
export async function recordPoll(
  name: SourceName,
  outcome: { calls: number; ok: boolean; error?: string },
): Promise<void> {
  const db = getServiceClient();
  const now = new Date();

  const { data, error: readError } = await db
    .from('sources')
    .select('calls_today, quota_reset_at, consecutive_failures')
    .eq('name', name)
    .single();

  if (readError) throw new Error(`Failed to read source ${name}: ${readError.message}`);

  const resetAt = new Date(data.quota_reset_at);
  const expired = now >= resetAt;
  const nextReset = expired
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : resetAt;

  const { error } = await db
    .from('sources')
    .update({
      calls_today: (expired ? 0 : data.calls_today) + outcome.calls,
      quota_reset_at: nextReset.toISOString(),
      last_polled_at: now.toISOString(),
      ...(outcome.ok
        ? { last_success_at: now.toISOString(), last_error: null, consecutive_failures: 0 }
        : {
            last_error: outcome.error ?? 'unknown error',
            consecutive_failures: data.consecutive_failures + 1,
          }),
    })
    .eq('name', name);

  if (error) throw new Error(`Failed to record poll for ${name}: ${error.message}`);
}

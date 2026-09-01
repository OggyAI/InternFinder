import 'server-only';
import { getServiceClient, type FilterSet } from '@intern-finder/core';
import { loadActiveFilter } from '@intern-finder/core';

/**
 * Every database read the dashboard makes.
 *
 * `import 'server-only'` at the top is load-bearing: it turns an accidental
 * import from a Client Component into a BUILD ERROR rather than a bundle that
 * ships the service-role key to the browser. That key bypasses RLS entirely,
 * so this is the one mistake in this app that would actually matter.
 *
 * Nothing here takes a Supabase client from the caller — it always asks core
 * for the service client, so there is no path where a differently-privileged
 * client could be threaded in by accident.
 */

/** PostgREST caps any response at 1000 rows regardless of `.limit()`. */
export const PAGE_CAP = 1000;

export interface MatchListItem {
  id: string;
  listingId: string;
  fitScore: number;
  baseScore: number;
  preferenceMultiplier: number;
  category: string;
  compensation: string;
  workMode: string;
  commitment: string;
  durationWeeks: number | null;
  reasoning: string;
  status: string;
  scoredAt: string;
  title: string;
  company: string | null;
  locationSuburb: string | null;
  distanceKm: number | null;
  url: string;
  postedDate: string | null;
  source: string;
}

export interface MatchQuery {
  status?: string;
  minScore?: number;
  search?: string;
  page?: number;
  perPage?: number;
}

const SELECT_MATCH =
  'id,listing_id,fit_score,base_score,preference_multiplier,category,compensation,' +
  'work_mode,commitment,duration_weeks,reasoning,status,scored_at,' +
  'job_listings!inner(title,company,location_suburb,distance_km,url,posted_date,source)';

interface RawMatch {
  id: string;
  listing_id: string;
  fit_score: number;
  base_score: number;
  preference_multiplier: number;
  category: string;
  compensation: string;
  work_mode: string;
  commitment: string;
  duration_weeks: number | null;
  reasoning: string;
  status: string;
  scored_at: string;
  job_listings: {
    title: string;
    company: string | null;
    location_suburb: string | null;
    distance_km: number | null;
    url: string;
    posted_date: string | null;
    source: string;
  } | null;
}

function toItem(row: RawMatch): MatchListItem | null {
  const listing = row.job_listings;
  if (!listing) return null;
  return {
    id: row.id,
    listingId: row.listing_id,
    fitScore: row.fit_score,
    baseScore: row.base_score,
    preferenceMultiplier: Number(row.preference_multiplier),
    category: row.category,
    compensation: row.compensation,
    workMode: row.work_mode,
    commitment: row.commitment,
    durationWeeks: row.duration_weeks,
    reasoning: row.reasoning,
    status: row.status,
    scoredAt: row.scored_at,
    title: listing.title,
    company: listing.company,
    locationSuburb: listing.location_suburb,
    distanceKm: listing.distance_km === null ? null : Number(listing.distance_km),
    url: listing.url,
    postedDate: listing.posted_date,
    source: listing.source,
  };
}

export async function listMatches(
  query: MatchQuery = {},
): Promise<{ items: MatchListItem[]; total: number; page: number; perPage: number }> {
  const db = getServiceClient();
  const perPage = Math.min(Math.max(query.perPage ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const from = (page - 1) * perPage;

  let builder = db
    .from('matches')
    .select(SELECT_MATCH, { count: 'exact' })
    // Near-duplicates keep their row and their score but must never appear in
    // a list a human reads, or the same job shows up twice at the top.
    .is('job_listings.duplicate_of', null);

  if (query.status && query.status !== 'all') {
    if (query.status === 'undecided') builder = builder.in('status', ['new', 'notified']);
    else builder = builder.eq('status', query.status);
  }
  if (typeof query.minScore === 'number') builder = builder.gte('fit_score', query.minScore);
  if (query.search) {
    // Escaping matters: a comma or a parenthesis in the search box would
    // otherwise be read as PostgREST filter syntax rather than as text.
    const term = query.search.replace(/[(),*"\\]/g, ' ').trim();
    if (term) {
      builder = builder.or(
        `title.ilike.%${term}%,company.ilike.%${term}%`,
        { referencedTable: 'job_listings' },
      );
    }
  }

  const { data, error, count } = await builder
    .order('fit_score', { ascending: false })
    // fit_score saturates at 100, so many rows tie there. base_score is the
    // unclamped judgement and breaks the tie in an order that means something.
    .order('base_score', { ascending: false })
    .range(from, from + perPage - 1);

  if (error) throw new Error(`match list failed: ${error.message}`);

  const items = ((data ?? []) as unknown as RawMatch[])
    .map(toItem)
    .filter((item): item is MatchListItem => item !== null);

  return { items, total: count ?? items.length, page, perPage };
}

export interface RejectionSample {
  totalRejected: number;
  sampleSize: number;
  reasons: { reason: string; count: number }[];
  recent: {
    title: string;
    company: string | null;
    locationSuburb: string | null;
    distanceKm: number | null;
    reasons: string[];
    url: string;
    firstSeenAt: string;
  }[];
}

/**
 * Why listings were dropped.
 *
 * Rejections are stored rather than deleted precisely so an over-aggressive
 * filter is diagnosable, and until now nothing ever read them. The reason
 * tally is computed over a SAMPLE — PostgREST will not return more than 1000
 * rows and there is no group-by over an array column through PostgREST — so
 * the sample size is reported alongside it rather than implying it is exact.
 */
export async function rejectionSample(limit = PAGE_CAP): Promise<RejectionSample> {
  const db = getServiceClient();

  const { count: totalRejected } = await db
    .from('job_listings')
    .select('*', { count: 'exact', head: true })
    .neq('prefilter_status', 'passed');

  const { data, error } = await db
    .from('job_listings')
    .select('title,company,location_suburb,distance_km,prefilter_reasons,url,first_seen_at')
    .neq('prefilter_status', 'passed')
    .order('first_seen_at', { ascending: false })
    .limit(Math.min(limit, PAGE_CAP));

  if (error) throw new Error(`rejection read failed: ${error.message}`);

  const rows = (data ?? []) as unknown as {
    title: string;
    company: string | null;
    location_suburb: string | null;
    distance_km: number | null;
    prefilter_reasons: string[] | null;
    url: string;
    first_seen_at: string;
  }[];

  const tally = new Map<string, number>();
  for (const row of rows) {
    for (const reason of row.prefilter_reasons ?? []) {
      // Reasons carry specifics ("distance 71km > 50km"); group by the kind.
      const kind = reason.split(':')[0]!.trim();
      tally.set(kind, (tally.get(kind) ?? 0) + 1);
    }
  }

  return {
    totalRejected: totalRejected ?? 0,
    sampleSize: rows.length,
    reasons: [...tally].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    recent: rows.slice(0, 100).map((row) => ({
      title: row.title,
      company: row.company,
      locationSuburb: row.location_suburb,
      distanceKm: row.distance_km === null ? null : Number(row.distance_km),
      reasons: row.prefilter_reasons ?? [],
      url: row.url,
      firstSeenAt: row.first_seen_at,
    })),
  };
}

export interface SettingsRow {
  is_paused: boolean;
  notify_score_threshold: number;
  max_notifications_per_day: number;
  scoring_enabled: boolean;
  max_scoring_spend_usd_per_day: number;
  max_scoring_spend_usd_per_cycle: number;
  scoring_spend_today: number;
}

export async function loadSettings(): Promise<SettingsRow> {
  const db = getServiceClient();
  const { data, error } = await db
    .from('app_settings')
    .select(
      'is_paused,notify_score_threshold,max_notifications_per_day,scoring_enabled,' +
        'max_scoring_spend_usd_per_day,max_scoring_spend_usd_per_cycle,scoring_spend_today',
    )
    .eq('id', 1)
    .single();
  if (error) throw new Error(`settings read failed: ${error.message}`);
  return data as unknown as SettingsRow;
}

export async function loadFilters(): Promise<FilterSet> {
  return loadActiveFilter();
}

export interface SourceStatus {
  name: string;
  enabled: boolean;
  pollIntervalMinutes: number;
  callsToday: number;
  maxCallsPerDay: number;
  lastPolledAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export async function loadSourceStatus(): Promise<SourceStatus[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from('sources')
    .select(
      'name,enabled,poll_interval_minutes,calls_today,max_calls_per_day,' +
        'last_polled_at,consecutive_failures,last_error',
    )
    .order('name');
  if (error) throw new Error(`sources read failed: ${error.message}`);
  return ((data ?? []) as unknown as Record<string, never>[]).map((row: any) => ({
    name: row.name,
    enabled: row.enabled,
    pollIntervalMinutes: row.poll_interval_minutes,
    callsToday: row.calls_today,
    maxCallsPerDay: row.max_calls_per_day,
    lastPolledAt: row.last_polled_at,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  }));
}

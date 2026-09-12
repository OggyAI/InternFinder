import { getServiceClient, type NotifiableMatch } from '@intern-finder/core';

/**
 * Everything a Telegram match card needs, loaded one way.
 *
 * Three places render a card — the notifier, /top, and the button handler that
 * rewrites a card after a tap — and each used to carry its own copy of this
 * select and this mapping. The button handler did not rebuild the card at all:
 * it looked up the text that had been sent by the tapped message's id in
 * notification_log. Only the notifier logs, so a card delivered by /top had
 * no log row, the lookup came back empty, and the edit was skipped without a
 * word — the database said "dismissed" while the phone still showed buttons.
 *
 * Rebuilding from the match row works for every card however it was sent, and
 * a formatting change applies to cards on the phone the next time one is
 * tapped instead of freezing the old text in the log.
 */

export const MATCH_CARD_SELECT =
  'id,fit_score,base_score,preference_multiplier,category,compensation,work_mode,' +
  'commitment,duration_weeks,reasoning,' +
  'job_listings!inner(title,company,location_suburb,distance_km,url,posted_date)';

export interface MatchCardRow {
  id: string;
  fit_score: number;
  base_score: number;
  preference_multiplier: number | string;
  category: string;
  compensation: string;
  work_mode: string;
  commitment: string;
  duration_weeks: number | null;
  reasoning: string;
  job_listings: {
    title: string;
    company: string | null;
    location_suburb: string | null;
    distance_km: number | string | null;
    url: string;
    posted_date: string | null;
  } | null;
}

/** Null when the listing join is missing, which a card cannot be drawn without. */
export function toNotifiableMatch(row: MatchCardRow): NotifiableMatch | null {
  const listing = row.job_listings;
  if (!listing) return null;
  return {
    matchId: row.id,
    fitScore: row.fit_score,
    baseScore: row.base_score,
    // PostgREST returns numeric columns as strings.
    preferenceMultiplier: Number(row.preference_multiplier),
    category: row.category,
    compensation: row.compensation,
    workMode: row.work_mode,
    commitment: row.commitment,
    durationWeeks: row.duration_weeks,
    reasoning: row.reasoning,
    title: listing.title,
    company: listing.company,
    locationSuburb: listing.location_suburb,
    distanceKm: listing.distance_km === null ? null : Number(listing.distance_km),
    url: listing.url,
    postedDate: listing.posted_date,
  };
}

export async function loadNotifiableMatch(matchId: string): Promise<NotifiableMatch | null> {
  const { data, error } = await getServiceClient()
    .from('matches')
    .select(MATCH_CARD_SELECT)
    .eq('id', matchId)
    .maybeSingle();
  if (error) throw new Error(`match load failed: ${error.message}`);
  return data ? toNotifiableMatch(data as unknown as MatchCardRow) : null;
}

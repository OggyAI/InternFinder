import { z } from 'zod';

/**
 * Shared vocabulary for the whole pipeline.
 *
 * The four "signal" enums below are the axes the soft preference weighting
 * works on. Every one of them includes 'unknown' on purpose: a job ad that
 * doesn't say whether it's remote is extremely common, and forcing a guess
 * there would corrupt the ranking. 'unknown' always scores neutral (1.00).
 */

export const Compensation = z.enum(['paid', 'unpaid', 'unknown']);
export const WorkMode = z.enum(['remote', 'onsite', 'hybrid', 'unknown']);
export const Commitment = z.enum(['full_time', 'part_time', 'casual', 'contract', 'unknown']);
export const RoleType = z.enum(['job', 'internship', 'unknown']);
export const SourceName = z.enum(['adzuna', 'jooble', 'careers_page']);
export const PrefilterStatus = z.enum(['pending', 'passed', 'rejected']);
export const MatchStatus = z.enum(['new', 'notified', 'applied', 'dismissed', 'saved']);
export const KeywordKind = z.enum(['include', 'exclude', 'exclude_work_rights']);
/**
 * domain     = identifies the FIELD (Cyber Security, IT Support, Data Entry)
 * structural = identifies the SHAPE (Internship, Trainee, Work Experience)
 *
 * Only a domain match admits a listing. A structural term matches an AFL
 * analysis internship as readily as an IT one, so on its own it is not
 * evidence of relevance.
 */
export const KeywordCategory = z.enum(['domain', 'structural']);
/**
 * Which text a keyword is tested against.
 *
 * 'title' exists for wrong-domain excludes. Matching "Nurse" against the full
 * text would reject a genuine IT Support role at a hospital; matching it
 * against the title rejects exactly the nursing jobs.
 */
export const KeywordMatchScope = z.enum(['text', 'title']);
export const PreferenceDimension = z.enum([
  'compensation',
  'work_mode',
  'commitment',
  'role_type',
]);

export type Compensation = z.infer<typeof Compensation>;
export type WorkMode = z.infer<typeof WorkMode>;
export type Commitment = z.infer<typeof Commitment>;
export type RoleType = z.infer<typeof RoleType>;
export type SourceName = z.infer<typeof SourceName>;
export type PrefilterStatus = z.infer<typeof PrefilterStatus>;
export type MatchStatus = z.infer<typeof MatchStatus>;
export type KeywordKind = z.infer<typeof KeywordKind>;
export type KeywordCategory = z.infer<typeof KeywordCategory>;
export type KeywordMatchScope = z.infer<typeof KeywordMatchScope>;
export type PreferenceDimension = z.infer<typeof PreferenceDimension>;

// ---------- Criteria rows, as loaded from Supabase --------------------------

export const FilterRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  is_active: z.boolean(),
  center_label: z.string(),
  center_lat: z.number(),
  center_lng: z.number(),
  radius_km: z.number().int(),
  min_duration_weeks: z.number().int(),
  max_duration_weeks: z.number().int().nullable(),
  exclude_sponsorship_required: z.boolean(),
  max_listing_age_days: z.number().int(),
  keep_unknown_location: z.boolean(),
});
export type FilterRow = z.infer<typeof FilterRow>;

export const FilterKeywordRow = z.object({
  id: z.string().uuid(),
  term: z.string(),
  kind: KeywordKind,
  weight: z.coerce.number(),
  whole_word: z.boolean(),
  /** Match with exact capitalisation. Essential for IT, which otherwise
   *  matches the pronoun "it" in every job ad in existence. */
  case_sensitive: z.boolean().default(false),
  category: KeywordCategory.default('domain'),
  match_scope: KeywordMatchScope.default('text'),
  is_active: z.boolean(),
});
export type FilterKeywordRow = z.infer<typeof FilterKeywordRow>;

export const FilterPreferenceRow = z.object({
  id: z.string().uuid(),
  dimension: PreferenceDimension,
  value: z.string(),
  weight: z.coerce.number(),
  is_active: z.boolean(),
});
export type FilterPreferenceRow = z.infer<typeof FilterPreferenceRow>;

/** The whole active criteria set, assembled by loadActiveFilter(). */
export interface FilterSet {
  filter: FilterRow;
  keywords: FilterKeywordRow[];
  preferences: FilterPreferenceRow[];
}

export const SourceRow = z.object({
  name: SourceName,
  enabled: z.boolean(),
  poll_interval_minutes: z.number().int(),
  max_calls_per_day: z.number().int(),
  calls_today: z.number().int(),
  quota_reset_at: z.string(),
  last_polled_at: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_error: z.string().nullable(),
  consecutive_failures: z.number().int(),
});
export type SourceRow = z.infer<typeof SourceRow>;

export const AppSettingsRow = z.object({
  id: z.literal(1),
  is_paused: z.boolean(),
  notify_score_threshold: z.number().int(),
  max_notifications_per_day: z.number().int(),
});
export type AppSettingsRow = z.infer<typeof AppSettingsRow>;

// ---------- The normalised listing every source must produce ----------------

/**
 * Sources differ wildly in shape — Adzuna gives coordinates and a structured
 * contract_time, Jooble gives a text blob and a link. Each adapter's job is to
 * flatten its provider into exactly this, keeping the untouched payload in
 * `raw` so nothing is lost when we later realise we needed a field.
 */
export interface NormalizedListing {
  source: SourceName;
  sourceId: string | null;
  url: string;
  title: string;
  company: string | null;
  description: string | null;
  locationRaw: string | null;
  latitude: number | null;
  longitude: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryIsPredicted: boolean;
  postedDate: Date | null;
  /**
   * The search term whose query returned this listing, when the source was
   * queried per-keyword.
   *
   * This matters because Adzuna full-text searches the WHOLE ad but returns
   * only a 500-character teaser. A `what_phrase` hit therefore proves the
   * phrase is in the ad even when it is nowhere in the text we received —
   * without this, 401 listings in the first live poll were rejected as
   * `no_keyword_match` despite the provider having already confirmed a match.
   */
  providerMatchedTerm: string | null;
  /** Structured hints the provider gave us directly; beats text sniffing. */
  providerHints: {
    commitment?: Commitment;
    workMode?: WorkMode;
    roleType?: RoleType;
  };
  raw: unknown;
}

/** Text-derived classification of a listing across the preference axes. */
export interface ListingSignals {
  compensation: Compensation;
  workMode: WorkMode;
  commitment: Commitment;
  roleType: RoleType;
  /** Best-effort weeks parsed from phrases like "12 week internship". */
  durationWeeks: number | null;
}

/** What the rule-based pre-filter decided, and why. */
export interface PrefilterResult {
  status: Exclude<PrefilterStatus, 'pending'>;
  /** Human-readable, stored on the row. Multiple rejections all get recorded. */
  reasons: string[];
  /** Include-keyword terms that matched. Empty means nothing matched. */
  matchedKeywords: string[];
  /** How the DOMAIN keyword requirement was satisfied. */
  keywordMatchSource: 'text' | 'provider' | 'none';
  distanceKm: number | null;
  suburb: string | null;
  state: string | null;
  signals: ListingSignals;
  preferenceMultiplier: number;
}

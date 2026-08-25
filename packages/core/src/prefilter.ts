import { distanceFromCentre, resolveLocation } from './geo';
import { computePreferenceMultiplier, indexPreferences } from './preferences';
import { detectSignals, listingText } from './signals';
import type {
  FilterKeywordRow,
  FilterSet,
  NormalizedListing,
  PrefilterResult,
} from './types';

/**
 * The rule-based pre-filter — the cheap gate that runs before any LLM call.
 *
 * Its whole job is volume reduction. Adzuna and Jooble between them return
 * thousands of Melbourne listings; scoring all of them through Claude would be
 * both slow and expensive, and the brief is explicit about cost sensitivity.
 *
 * Two deliberate design choices, both of which trade precision for recall:
 *
 *  1. DURATION IS EXCLUSION-ONLY. No job API exposes duration as a structured
 *     field, so a listing that simply doesn't state one passes. Requiring a
 *     positive 6+ week match would throw away nearly everything, including
 *     most real internships. We only reject when a duration IS stated and it
 *     clearly falls outside the window.
 *
 *  2. UNRESOLVED LOCATIONS ARE KEPT by default (filters.keep_unknown_location).
 *     A suburb missing from the bundled gazetteer is our gap, not the
 *     listing's fault, and silently dropping those would be invisible.
 *
 * Every rejection records a reason on the row rather than deleting it, so a
 * filter that is too aggressive shows up as a pile of rows sharing one reason
 * instead of as an empty inbox.
 */

/** Compile a keyword row into a matcher. Compiled once per poll, not per listing. */
export interface CompiledKeyword {
  term: string;
  kind: FilterKeywordRow['kind'];
  category: FilterKeywordRow['category'];
  scope: FilterKeywordRow['match_scope'];
  weight: number;
  re: RegExp;
}

export function compileKeywords(keywords: FilterKeywordRow[]): CompiledKeyword[] {
  return keywords
    .filter((k) => k.is_active)
    .map((k) => {
      // Multi-word terms tolerate hyphens and extra whitespace, so
      // "Cyber Security" also matches "cyber-security" and "Cyber  Security".
      const body = k.term.trim().split(/\s+/).map(escapeRe).join('[\\s-]*');
      // Two INDEPENDENT guards, and IT needs both.
      //
      // whole_word stops IT matching *security*, *monitor*, *editing*.
      // case_sensitive stops IT matching the pronoun "it" — which the first
      // live poll proved matters, because without it a Medical Receptionist
      // and a Cocktail Bartender both "matched" the keyword IT.
      const pattern = k.whole_word ? `(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])` : body;
      const flags = k.case_sensitive ? '' : 'i';
      return {
        term: k.term,
        kind: k.kind,
        category: k.category,
        scope: k.match_scope,
        weight: k.weight,
        re: new RegExp(pattern, flags),
      };
    });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface PrefilterOptions {
  /** Overrides "now" so tests are not time-dependent. */
  now?: Date;
  /** Reuse compiled keywords across a batch instead of recompiling per listing. */
  compiled?: CompiledKeyword[];
}

export function prefilter(
  listing: NormalizedListing,
  filterSet: FilterSet,
  options: PrefilterOptions = {},
): PrefilterResult {
  const { filter, keywords, preferences } = filterSet;
  const now = options.now ?? new Date();
  const compiled = options.compiled ?? compileKeywords(keywords);

  const text = listingText(listing);
  const reasons: string[] = [];

  // A keyword scoped to 'title' is tested against the title alone. This is how
  // "Cleaner" can be excluded without also rejecting a real IT Support role
  // whose description happens to mention the cleaning contractor.
  const against = (k: CompiledKeyword): string => (k.scope === 'title' ? listing.title : text);

  // --- Location ------------------------------------------------------------
  const loc = resolveLocation(listing.locationRaw, listing.latitude, listing.longitude);
  const distanceKm = distanceFromCentre(
    { lat: filter.center_lat, lng: filter.center_lng },
    loc,
  );

  if (distanceKm === null) {
    if (!filter.keep_unknown_location) {
      reasons.push(`location_unresolved: could not place "${listing.locationRaw ?? 'null'}"`);
    }
  } else if (distanceKm > filter.radius_km) {
    reasons.push(
      `out_of_radius: ${distanceKm}km from ${filter.center_label} (limit ${filter.radius_km}km)`,
    );
  }

  // --- Keywords ------------------------------------------------------------
  const hitExcludes = compiled.filter((k) => k.kind === 'exclude' && k.re.test(against(k)));
  for (const k of hitExcludes) {
    reasons.push(`excluded_keyword: "${k.term}"`);
  }

  if (filter.exclude_sponsorship_required) {
    const hitWorkRights = compiled.filter(
      (k) => k.kind === 'exclude_work_rights' && k.re.test(against(k)),
    );
    for (const k of hitWorkRights) {
      reasons.push(`work_rights: "${k.term}"`);
    }
  }

  const includes = compiled.filter((k) => k.kind === 'include');
  const textMatches = includes.filter((k) => k.re.test(against(k)));

  // ONLY a domain term admits a listing. Structural terms (Internship,
  // Trainee, Work Experience) describe the shape of a role, not its field, and
  // admitting on those alone ranked an AFL internship and nine cleaners above
  // every real IT job in the first ingest.
  const textDomainMatch = textMatches.some((k) => k.category === 'domain');

  // Fall back to the provider's own match. Adzuna searches the full ad and
  // returns a truncated teaser, so a phrase can be genuinely present and
  // invisible to us — but only honour it when the term that found the listing
  // was itself a domain term.
  const providerTerm = listing.providerMatchedTerm;
  const providerDomainMatch =
    !textDomainMatch &&
    providerTerm !== null &&
    includes.some((k) => k.category === 'domain' && k.term === providerTerm);

  // Everything that matched, domain or structural, for display and ranking.
  const matchedKeywords = textMatches.map((k) => k.term);
  if (providerDomainMatch && providerTerm && !matchedKeywords.includes(providerTerm)) {
    matchedKeywords.push(providerTerm);
  }

  const keywordMatchSource: PrefilterResult['keywordMatchSource'] = textDomainMatch
    ? 'text'
    : providerDomainMatch
      ? 'provider'
      : 'none';

  if (keywordMatchSource === 'none') {
    reasons.push('no_domain_keyword_match');
  }

  // --- Age -----------------------------------------------------------------
  if (listing.postedDate) {
    const ageDays = (now.getTime() - listing.postedDate.getTime()) / 86_400_000;
    if (ageDays > filter.max_listing_age_days) {
      reasons.push(
        `too_old: posted ${Math.round(ageDays)}d ago (limit ${filter.max_listing_age_days}d)`,
      );
    }
  }

  // --- Signals and duration ------------------------------------------------
  const signals = detectSignals(listing);

  // Exclusion-only, per the note at the top of this file: a null duration is
  // not evidence of a short role, so it passes.
  if (signals.durationWeeks !== null) {
    if (signals.durationWeeks < filter.min_duration_weeks) {
      reasons.push(
        `too_short: ~${signals.durationWeeks}w (minimum ${filter.min_duration_weeks}w)`,
      );
    }
    if (
      filter.max_duration_weeks !== null &&
      signals.durationWeeks > filter.max_duration_weeks
    ) {
      reasons.push(
        `too_long: ~${signals.durationWeeks}w (maximum ${filter.max_duration_weeks}w)`,
      );
    }
  }

  // --- Preference multiplier (ranking only, never a reason to reject) ------
  const { multiplier } = computePreferenceMultiplier(signals, indexPreferences(preferences));

  return {
    status: reasons.length === 0 ? 'passed' : 'rejected',
    reasons,
    matchedKeywords,
    keywordMatchSource,
    distanceKm,
    suburb: loc.suburb,
    state: loc.state,
    signals,
    preferenceMultiplier: multiplier,
  };
}

/** Convenience for a whole poll: compile once, filter many. */
export function prefilterBatch(
  listings: NormalizedListing[],
  filterSet: FilterSet,
  options: Omit<PrefilterOptions, 'compiled'> = {},
): PrefilterResult[] {
  const compiled = compileKeywords(filterSet.keywords);
  return listings.map((l) => prefilter(l, filterSet, { ...options, compiled }));
}

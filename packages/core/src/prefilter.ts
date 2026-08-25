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
      // whole_word exists because "IT" is a real keyword here: without a word
      // boundary it matches security, monitor, editing, recruiting — i.e.
      // everything. Longer distinctive terms don't need the constraint.
      const pattern = k.whole_word ? `(?<![a-z0-9])(?:${body})(?![a-z0-9])` : body;
      return { term: k.term, kind: k.kind, weight: k.weight, re: new RegExp(pattern, 'i') };
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
  const hitExcludes = compiled.filter((k) => k.kind === 'exclude' && k.re.test(text));
  for (const k of hitExcludes) {
    reasons.push(`excluded_keyword: "${k.term}"`);
  }

  if (filter.exclude_sponsorship_required) {
    const hitWorkRights = compiled.filter(
      (k) => k.kind === 'exclude_work_rights' && k.re.test(text),
    );
    for (const k of hitWorkRights) {
      reasons.push(`work_rights: "${k.term}"`);
    }
  }

  const matchedKeywords = compiled
    .filter((k) => k.kind === 'include' && k.re.test(text))
    .map((k) => k.term);

  if (matchedKeywords.length === 0) {
    reasons.push('no_keyword_match');
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

import type { FilterKeywordRow, FilterRow } from '@intern-finder/core';

/**
 * Turning the editable keyword table into API queries.
 *
 * THIS WAS WRONG THE FIRST TIME, and the first live poll is what exposed it.
 *
 * The original approach batched six keywords into one request using Adzuna's
 * `what_or`, on the assumption that it OR-ed the *phrases*. It does not — it
 * OR-es individual WORDS. So a group containing "Security Operations", "Blue
 * Team" and "Information Security" matched any ad containing "operations", or
 * "team", or "information". That returned 3,915 results, led with a Medical
 * Receptionist and a Cocktail Bartender, and made the API call almost
 * worthless as a filter.
 *
 * Measured against the live API:
 *      what_or  "Cyber Security SOC Analyst"  -> 3915 results, mostly junk
 *   what_phrase "Cyber Security"              ->  150 results, all relevant
 *   what_phrase "IT Support"                  ->   96 results, all relevant
 *
 * So: one exact-phrase request per keyword. More calls, but each one is worth
 * something, and the daily budget in `sources` is what keeps that honest.
 * Keywords are issued highest-weight first, so if the budget runs out
 * mid-poll the terms we lose are the ones that matter least.
 */

export interface KeywordQuery {
  /** A single exact phrase to search for. */
  term: string;
  /** Ordering only, for logs and for deciding what to drop when out of budget. */
  weight: number;
}

export function buildKeywordQueries(
  keywords: FilterKeywordRow[],
  opts: { limit?: number } = {},
): KeywordQuery[] {
  const queries = keywords
    .filter((k) => k.kind === 'include' && k.is_active)
    .sort((a, b) => b.weight - a.weight)
    .map((k) => ({ term: k.term, weight: k.weight }));

  return opts.limit ? queries.slice(0, opts.limit) : queries;
}

/**
 * Both APIs geocode the `where`/`location` string themselves, and neither
 * copes well with a fully-qualified "Suburb STATE 0000" — the state and
 * postcode confuse the lookup. Send the bare locality name.
 */
export function locationQuery(filter: FilterRow): string {
  return filter.center_label
    .replace(/\b\d{4}\b/g, '')
    .replace(/\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/gi, '')
    .replace(/[,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Small helper so adapters can be polite between requests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

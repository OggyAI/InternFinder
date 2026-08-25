import type { FilterKeywordRow, FilterRow } from '@intern-finder/core';

/**
 * Turning the editable keyword table into API queries.
 *
 * Neither provider will accept 30 keywords in one request and return anything
 * useful, and issuing one request per keyword would burn the free-tier budget
 * in a single poll. So keywords are sorted by their configured weight and
 * chunked into a handful of OR-groups — highest-value terms get queried first,
 * and if the budget runs out mid-poll the terms we lost are the ones that
 * mattered least.
 *
 * This reads the keyword rows every time, so adding a keyword in the dashboard
 * changes what gets queried on the very next cycle.
 */

export interface QueryGroup {
  /** Terms to OR together in one request. */
  terms: string[];
  /** Ordering only, for logs. */
  weight: number;
}

export function buildQueryGroups(
  keywords: FilterKeywordRow[],
  opts: { groupSize?: number; maxGroups?: number } = {},
): QueryGroup[] {
  const groupSize = opts.groupSize ?? 6;
  const maxGroups = opts.maxGroups ?? 4;

  const includes = keywords
    .filter((k) => k.kind === 'include' && k.is_active)
    .sort((a, b) => b.weight - a.weight);

  const groups: QueryGroup[] = [];
  for (let i = 0; i < includes.length && groups.length < maxGroups; i += groupSize) {
    const chunk = includes.slice(i, i + groupSize);
    if (chunk.length === 0) break;
    groups.push({
      terms: chunk.map((k) => k.term),
      weight: chunk.reduce((sum, k) => sum + k.weight, 0) / chunk.length,
    });
  }
  return groups;
}

/**
 * Both APIs geocode the `where`/`location` string themselves, and neither
 * copes well with "Hoppers Crossing VIC 3029" — the state and postcode
 * confuse the lookup. Send the bare locality name.
 */
export function locationQuery(filter: FilterRow): string {
  return filter.center_label
    .replace(/\b\d{4}\b/g, '')
    .replace(/\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/gi, '')
    .replace(/[,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Small helper so adapters can be polite between paginated requests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

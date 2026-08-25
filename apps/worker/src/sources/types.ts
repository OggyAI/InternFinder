import type { FilterSet, NormalizedListing, SourceName } from '@intern-finder/core';

export interface FetchResult {
  listings: NormalizedListing[];
  /** HTTP requests actually issued, so the daily quota counter stays honest. */
  calls: number;
}

export interface FetchArgs {
  filterSet: FilterSet;
  /** Hard ceiling on requests for this cycle, derived from the source's remaining daily quota. */
  maxCalls: number;
  pagesPerQuery?: number;
}

/**
 * Every source — Adzuna, Jooble, and the Phase 4 career-page scraper — flattens
 * its provider into NormalizedListing and reports how many calls it spent.
 * Nothing downstream of this interface knows which provider a listing came from
 * beyond the `source` field.
 */
export interface SourceAdapter {
  name: SourceName;
  /** False when the credentials for this source are absent. */
  isConfigured(): boolean;
  fetch(args: FetchArgs): Promise<FetchResult>;
}

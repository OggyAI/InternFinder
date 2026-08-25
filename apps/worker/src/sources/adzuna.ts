import { z } from 'zod';
import {
  getEnv,
  hasAdzunaCreds,
  log,
  type Commitment,
  type NormalizedListing,
} from '@intern-finder/core';
import { buildQueryGroups, locationQuery, sleep } from './query';
import type { FetchResult, SourceAdapter } from './types';

/**
 * Adzuna adapter.
 *
 * Adzuna is the better of the two sources for this use case: it returns real
 * coordinates, a structured contract_time, and supports a native radius
 * search, so we let it do the distance filtering server-side and only
 * re-check locally as a backstop.
 *
 * SHAPE CAVEAT: this is written against Adzuna's documented response, not
 * against captured traffic — there were no API keys available when it was
 * built. Every field is optional in the schema below and the untouched payload
 * is stored in raw_json, so a shape surprise degrades a listing rather than
 * killing the poll. Verify against a live response on first run with real keys.
 */

const AdzunaJob = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    created: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    redirect_url: z.string().optional(),
    company: z.object({ display_name: z.string().optional() }).partial().optional(),
    location: z
      .object({
        display_name: z.string().optional(),
        area: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    salary_min: z.number().optional(),
    salary_max: z.number().optional(),
    // Adzuna returns this as the STRING "0" or "1", not a boolean.
    salary_is_predicted: z.union([z.string(), z.boolean(), z.number()]).optional(),
    contract_time: z.string().optional(),
    contract_type: z.string().optional(),
    category: z.object({ label: z.string().optional(), tag: z.string().optional() }).partial().optional(),
  })
  .passthrough();

export const AdzunaResponse = z
  .object({
    count: z.number().optional(),
    results: z.array(AdzunaJob).default([]),
  })
  .passthrough();

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

function mapContractTime(v: string | undefined): Commitment | undefined {
  if (v === 'full_time') return 'full_time';
  if (v === 'part_time') return 'part_time';
  return undefined;
}

export function normalizeAdzunaJob(job: z.infer<typeof AdzunaJob>): NormalizedListing | null {
  // A listing with no URL cannot be deduped or applied to; drop it.
  const url = job.redirect_url;
  const title = job.title;
  if (!url || !title) return null;

  const commitment = mapContractTime(job.contract_time);

  return {
    source: 'adzuna',
    sourceId: job.id !== undefined ? String(job.id) : null,
    url,
    // Adzuna HTML-escapes titles and truncates descriptions with an ellipsis.
    title: decodeEntities(title),
    company: job.company?.display_name ?? null,
    description: job.description ? decodeEntities(job.description) : null,
    locationRaw: job.location?.display_name ?? job.location?.area?.slice(-1)[0] ?? null,
    latitude: job.latitude ?? null,
    longitude: job.longitude ?? null,
    salaryMin: job.salary_min ?? null,
    salaryMax: job.salary_max ?? null,
    salaryIsPredicted: toBool(job.salary_is_predicted),
    postedDate: job.created ? safeDate(job.created) : null,
    providerHints: commitment ? { commitment } : {},
    raw: job,
  };
}

function safeDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

export const adzunaAdapter: SourceAdapter = {
  name: 'adzuna',

  isConfigured() {
    return hasAdzunaCreds(getEnv());
  },

  async fetch({ filterSet, maxCalls, pagesPerQuery = 2 }): Promise<FetchResult> {
    const env = getEnv();
    const { filter, keywords } = filterSet;
    const groups = buildQueryGroups(keywords, { groupSize: 6, maxGroups: 4 });
    const where = locationQuery(filter);

    const listings: NormalizedListing[] = [];
    let calls = 0;

    outer: for (const group of groups) {
      for (let page = 1; page <= pagesPerQuery; page++) {
        if (calls >= maxCalls) {
          log.warn(`adzuna: stopping early, call budget of ${maxCalls} reached`);
          break outer;
        }

        const url = new URL(
          `https://api.adzuna.com/v1/api/jobs/${env.ADZUNA_COUNTRY}/search/${page}`,
        );
        url.searchParams.set('app_id', env.ADZUNA_APP_ID!);
        url.searchParams.set('app_key', env.ADZUNA_APP_KEY!);
        url.searchParams.set('results_per_page', '50');
        // what_or = match ANY of these terms, which is what a keyword group is.
        url.searchParams.set('what_or', group.terms.join(' '));
        url.searchParams.set('where', where);
        url.searchParams.set('distance', String(filter.radius_km));
        url.searchParams.set('max_days_old', String(filter.max_listing_age_days));
        url.searchParams.set('sort_by', 'date');
        url.searchParams.set('content-type', 'application/json');

        const res = await fetch(url, {
          headers: { accept: 'application/json', 'user-agent': 'intern-finder-bot/0.1' },
        });
        calls++;

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // 429 is the free-tier rate limit. Stop this source for the cycle
          // rather than hammering it; the next poll picks up where we left off.
          if (res.status === 429) {
            log.warn(`adzuna: rate limited (429), ending cycle`, body.slice(0, 200));
            break outer;
          }
          throw new Error(`Adzuna ${res.status}: ${body.slice(0, 300)}`);
        }

        const parsed = AdzunaResponse.safeParse(await res.json());
        if (!parsed.success) {
          log.warn('adzuna: unexpected response shape, skipping page', parsed.error.message);
          continue;
        }

        const page_listings = parsed.data.results
          .map(normalizeAdzunaJob)
          .filter((l): l is NormalizedListing => l !== null);
        listings.push(...page_listings);

        log.debug(
          `adzuna: q="${group.terms.join('|')}" page=${page} -> ${page_listings.length} listings`,
        );

        // Short page means we've exhausted this query; don't spend a call
        // fetching an empty next page.
        if (parsed.data.results.length < 50) break;
        await sleep(1200);
      }
    }

    return { listings, calls };
  },
};

import { z } from 'zod';
import {
  getEnv,
  hasJoobleCreds,
  log,
  type Commitment,
  type NormalizedListing,
} from '@intern-finder/core';
import { buildKeywordQueries, locationQuery, sleep } from './query';
import type { FetchResult, SourceAdapter } from './types';

/**
 * Jooble adapter.
 *
 * Jooble is an aggregator: it indexes other boards and hands back a link plus
 * a text snippet. That means two things for us.
 *
 *  - No coordinates, ever. Location is a string like "Werribee VIC 3030", so
 *    the bundled suburb gazetteer in core/geo does the distance work. Jooble's
 *    own `radius` parameter is still sent as a first-pass narrowing, but the
 *    authoritative filtering happens locally.
 *  - `snippet` is a truncated teaser, not the job description. Text sniffing
 *    for duration and work mode is therefore much weaker here than on Adzuna,
 *    and more listings will come back 'unknown'. That is expected, and it is
 *    why 'unknown' scores neutral instead of being penalised.
 *
 * Results may well originate from boards we are not allowed to scrape
 * directly. Consuming them through Jooble's public API is the sanctioned path
 * and is exactly why this source exists.
 *
 * SHAPE CAVEAT: as with Adzuna, written against the documented response rather
 * than captured traffic. Fields are optional; raw_json keeps everything.
 */

const JoobleJob = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    location: z.string().optional(),
    snippet: z.string().optional(),
    salary: z.string().optional(),
    source: z.string().optional(),
    type: z.string().optional(),
    link: z.string().optional(),
    company: z.string().optional(),
    updated: z.string().optional(),
  })
  .passthrough();

export const JoobleResponse = z
  .object({
    totalCount: z.number().optional(),
    jobs: z.array(JoobleJob).default([]),
  })
  .passthrough();

/** Jooble's `type` is free text from the originating board. */
function mapType(v: string | undefined): Commitment | undefined {
  if (!v) return undefined;
  const t = v.toLowerCase();
  if (t.includes('part')) return 'part_time';
  if (t.includes('casual')) return 'casual';
  if (t.includes('contract') || t.includes('temp')) return 'contract';
  if (t.includes('full')) return 'full_time';
  return undefined;
}

/**
 * Jooble's salary field is a display string: "$35 - $45 an hour", "$90,000",
 * "" when unknown. Pull the first number out for a rough floor. Anything we
 * fail to parse stays null rather than guessing — a wrong salary would flip
 * the paid/unpaid signal, which is a weighted axis.
 */
function parseSalaryFloor(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeJoobleJob(
  job: z.infer<typeof JoobleJob>,
  matchedTerm: string | null = null,
): NormalizedListing | null {
  const url = job.link;
  const title = job.title;
  if (!url || !title) return null;

  const commitment = mapType(job.type);

  return {
    source: 'jooble',
    sourceId: job.id !== undefined ? String(job.id) : null,
    url,
    title: stripHtml(title),
    company: job.company?.trim() || null,
    description: job.snippet ? stripHtml(job.snippet) : null,
    locationRaw: job.location ?? null,
    latitude: null,
    longitude: null,
    salaryMin: parseSalaryFloor(job.salary),
    salaryMax: null,
    // Jooble echoes what the source board advertised, so a salary here is a
    // real stated figure rather than an estimate.
    salaryIsPredicted: false,
    postedDate: job.updated ? safeDate(job.updated) : null,
    providerMatchedTerm: matchedTerm,
    providerHints: commitment ? { commitment } : {},
    raw: job,
  };
}

function safeDate(s: string): Date | null {
  // Jooble emits 7-digit fractional seconds ("2026-08-20T00:00:00.0000000"),
  // which Date rejects in some runtimes. Trim to milliseconds.
  const trimmed = s.replace(/(\.\d{3})\d+/, '$1');
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const joobleAdapter: SourceAdapter = {
  name: 'jooble',

  isConfigured() {
    return hasJoobleCreds(getEnv());
  },

  async fetch({ filterSet, maxCalls, pagesPerQuery = 1 }): Promise<FetchResult> {
    const env = getEnv();
    const { filter, keywords } = filterSet;
    const queries = buildKeywordQueries(keywords);
    const location = locationQuery(filter);

    const listings: NormalizedListing[] = [];
    let calls = 0;

    outer: for (const query of queries) {
      for (let page = 1; page <= pagesPerQuery; page++) {
        if (calls >= maxCalls) {
          log.warn(`jooble: call budget of ${maxCalls} spent, remaining keywords skipped`);
          break outer;
        }

        const res = await fetch(`https://jooble.org/api/${env.JOOBLE_API_KEY}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'intern-finder-bot/0.1' },
          body: JSON.stringify({
            // One phrase per request. Jooble's `keywords` is documented as a
            // search string rather than a strict phrase match, so precision
            // here is weaker than Adzuna's what_phrase - the local pre-filter
            // is what actually enforces relevance.
            keywords: query.term,
            location,
            radius: String(filter.radius_km),
            page: String(page),
            ResultOnPage: '50',
          }),
        });
        calls++;

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          if (res.status === 429) {
            log.warn('jooble: rate limited (429), ending cycle', body.slice(0, 200));
            break outer;
          }
          throw new Error(`Jooble ${res.status}: ${body.slice(0, 300)}`);
        }

        const parsed = JoobleResponse.safeParse(await res.json());
        if (!parsed.success) {
          log.warn('jooble: unexpected response shape, skipping page', parsed.error.message);
          continue;
        }

        const pageListings = parsed.data.jobs
          .map((j) => normalizeJoobleJob(j, query.term))
          .filter((l): l is NormalizedListing => l !== null);
        listings.push(...pageListings);

        log.debug(
          `jooble: "${query.term}" page=${page} -> ${pageListings.length} listings ` +
            `(${parsed.data.totalCount ?? '?'} total)`,
        );

        if (parsed.data.jobs.length < 50) break;
        await sleep(1200);
      }
    }

    return { listings, calls };
  },
};

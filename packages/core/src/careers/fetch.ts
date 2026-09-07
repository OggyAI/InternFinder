import { checkCareerUrl } from './denylist';
import { extractJobPostings, type ExtractedJob } from './jsonld';
import { fetchRobots, USER_AGENT, type RobotsRules } from './robots';

/**
 * Fetch one career page and pull the job postings out of it.
 *
 * Ordered so the cheapest refusal happens first: denylist (no request at all),
 * then robots.txt (one request to the origin), then the page itself. A URL that
 * should not be fetched costs nothing to reject.
 *
 * NO BROWSER. Career pages that publish schema.org JobPosting markup — which
 * is most of them, because Google Jobs requires it — are fully readable with a
 * plain GET. Chromium would cost ~150MB of RAM on a 956MB VM that already runs
 * two bots, for pages that mostly do not need it. Rendering is a later,
 * separate decision for the sites that genuinely require it.
 */

export interface CareerFetchResult {
  url: string;
  ok: boolean;
  /** Why it was refused or failed. Present whenever ok is false. */
  reason?: string;
  status?: number;
  jobs: ExtractedJob[];
  /** HTTP requests issued, including the robots.txt lookup. */
  calls: number;
  robots?: RobotsRules['source'];
  crawlDelaySeconds?: number | null;
  /** Set when the page fetched fine but carried no structured markup. */
  needsRendering?: boolean;
}

export interface CareerFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cache of robots rules by origin, so a batch of pages asks once per site. */
  robotsCache?: Map<string, RobotsRules>;
}

const MAX_BYTES = 4_000_000;

export async function fetchCareerPage(
  rawUrl: string,
  options: CareerFetchOptions = {},
): Promise<CareerFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base: CareerFetchResult = { url: rawUrl, ok: false, jobs: [], calls: 0 };

  const verdict = checkCareerUrl(rawUrl);
  if (verdict.blocked) return { ...base, reason: verdict.reason };

  const url = new URL(rawUrl);

  // --- robots.txt ----------------------------------------------------------
  let robots = options.robotsCache?.get(url.origin);
  if (!robots) {
    robots = await fetchRobots(url.origin, fetchImpl);
    base.calls++;
    options.robotsCache?.set(url.origin, robots);
  }

  if (!robots.allows(url.pathname)) {
    return {
      ...base,
      reason:
        robots.source === 'unreachable'
          ? 'robots.txt could not be read, so fetching is not permitted'
          : `robots.txt disallows ${url.pathname}`,
      robots: robots.source,
    };
  }

  // --- the page ------------------------------------------------------------
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    base.calls++;
  } catch (err) {
    return {
      ...base,
      calls: base.calls + 1,
      reason: err instanceof Error ? err.message : String(err),
      robots: robots.source,
    };
  }

  if (!response.ok) {
    return { ...base, reason: `HTTP ${response.status}`, status: response.status, robots: robots.source };
  }

  // A redirect can leave the denylist behind — re-check where we actually
  // landed, or a career page that forwards to a job board would be scraped.
  const landed = checkCareerUrl(response.url || url.toString());
  if (landed.blocked) {
    return { ...base, reason: `redirected to a blocked host: ${landed.reason}`, robots: robots.source };
  }

  const html = (await response.text()).slice(0, MAX_BYTES);
  const jobs = extractJobPostings(html, response.url || url.toString());

  return {
    url: rawUrl,
    ok: true,
    status: response.status,
    jobs,
    calls: base.calls,
    robots: robots.source,
    crawlDelaySeconds: robots.crawlDelaySeconds,
    // No markup is not an error — it means this page would need rendering, or
    // it is an index page whose postings live on separate URLs.
    needsRendering: jobs.length === 0,
  };
}

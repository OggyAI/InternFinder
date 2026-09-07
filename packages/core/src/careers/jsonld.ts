/**
 * Extract schema.org JobPosting data from a career page's HTML.
 *
 * This is the reason Phase 4 does not need a browser for most sites. Google
 * requires JSON-LD JobPosting markup for a role to appear in Google Jobs, so
 * the large ATS platforms and most company career pages emit it — structured,
 * documented, and stable across redesigns. Reading it is both cheaper and far
 * more reliable than driving Chromium at a DOM and guessing which div is a
 * job title.
 *
 * Deliberately tolerant. Every field is optional, a malformed block is skipped
 * rather than fatal, and anything unrecognised is ignored: a page that half
 * implements the spec should yield a degraded listing, not an exception.
 */

export interface ExtractedJob {
  title: string;
  company: string | null;
  description: string | null;
  url: string | null;
  locationRaw: string | null;
  postedDate: Date | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  /** Whatever the page actually said, kept so a mapping mistake is diagnosable. */
  raw: unknown;
}

const SCRIPT_RE =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Minimal entity decode — enough for titles and locations, not a full parser. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * JobPosting descriptions are HTML. The pipeline wants text.
 *
 * Decode BEFORE stripping, not after. ATS platforms emit the description both
 * as real HTML and as entity-escaped HTML (&lt;p&gt;) — stripping first leaves
 * the escaped form untouched, and decoding afterwards turns it back into
 * literal tags inside what was supposed to be plain text. Decoding first
 * reduces both shapes to the same input; the second decode catches anything
 * that was double-escaped.
 */
export function htmlToText(html: string): string {
  const asHtml = decodeEntities(html);
  return decodeEntities(
    asHtml
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}

const text = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
};

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
};

const first = <T>(value: T | T[] | undefined): T | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Walk arrays, `@graph`, and nested objects looking for JobPosting nodes. */
function collectJobPostings(node: unknown, found: Record<string, unknown>[], depth = 0): void {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectJobPostings(item, found, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')) {
    found.push(obj);
  }

  if (obj['@graph']) collectJobPostings(obj['@graph'], found, depth + 1);
  // Some pages nest postings under itemListElement.
  if (obj['itemListElement']) collectJobPostings(obj['itemListElement'], found, depth + 1);
  if (obj['item']) collectJobPostings(obj['item'], found, depth + 1);
}

function locationOf(posting: Record<string, unknown>): string | null {
  const location = first(posting['jobLocation'] as unknown[] | unknown) as
    | Record<string, unknown>
    | undefined;
  if (!location) {
    // Fully remote roles use jobLocationType instead of an address.
    return text(posting['jobLocationType']) ? 'Remote' : null;
  }
  const address = (location['address'] ?? location) as Record<string, unknown>;
  if (typeof address === 'string') return address;

  const parts = [
    text(address['streetAddress']),
    text(address['addressLocality']),
    text(address['addressRegion']),
    text(address['postalCode']),
    text(address['addressCountry']) ??
      text((address['addressCountry'] as Record<string, unknown> | undefined)?.['name']),
  ].filter((p): p is string => Boolean(p));

  return parts.length ? parts.join(', ') : null;
}

function salaryOf(posting: Record<string, unknown>): {
  min: number | null;
  max: number | null;
  currency: string | null;
} {
  const base = posting['baseSalary'] as Record<string, unknown> | undefined;
  if (!base) return { min: null, max: null, currency: null };
  const value = (base['value'] ?? base) as Record<string, unknown>;
  const single = num(value['value']);
  return {
    min: num(value['minValue']) ?? single,
    max: num(value['maxValue']) ?? single,
    currency: text(base['currency']) ?? text(value['currency']),
  };
}

function toDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toJob(posting: Record<string, unknown>, pageUrl: string): ExtractedJob | null {
  const title = text(posting['title']) ?? text(posting['name']);
  // A posting with no title is not usable — everything downstream keys off it.
  if (!title) return null;

  const org = posting['hiringOrganization'] as Record<string, unknown> | string | undefined;
  const company =
    typeof org === 'string' ? org : org ? (text(org['name']) ?? text(org['legalName'])) : null;

  const rawDescription = text(posting['description']);
  const employment = first(posting['employmentType'] as unknown);

  let url = text(posting['url']) ?? text(posting['sameAs']);
  if (url) {
    try {
      url = new URL(url, pageUrl).toString();
    } catch {
      url = null;
    }
  }

  const salary = salaryOf(posting);

  return {
    title: decodeEntities(title),
    company: company ? decodeEntities(company) : null,
    description: rawDescription ? htmlToText(rawDescription) : null,
    url: url ?? null,
    locationRaw: locationOf(posting),
    postedDate: toDate(posting['datePosted']),
    employmentType: text(employment),
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    raw: posting,
  };
}

/**
 * Every JobPosting on the page, in document order.
 *
 * A listing index page often carries one block per role; a detail page carries
 * exactly one. Both work without the caller needing to know which it fetched.
 */
export function extractJobPostings(html: string, pageUrl: string): ExtractedJob[] {
  const postings: Record<string, unknown>[] = [];

  for (const match of html.matchAll(SCRIPT_RE)) {
    const body = match[1];
    if (!body) continue;
    try {
      // Raw control characters inside JSON strings are illegal and make
      // JSON.parse throw, and real career pages emit them (stray tabs and
      // newlines pasted into a description field). Replace rather than delete,
      // so words either side do not run together.
      const cleaned = Array.from(body, (c) => (c.charCodeAt(0) < 32 ? " " : c)).join("");
      collectJobPostings(JSON.parse(cleaned), postings);
    } catch {
      // One malformed block must not lose the others on the page.
      continue;
    }
  }

  const jobs: ExtractedJob[] = [];
  const seen = new Set<string>();
  for (const posting of postings) {
    const job = toJob(posting, pageUrl);
    if (!job) continue;
    // The same posting is sometimes emitted twice (once bare, once in @graph).
    const key = `${job.title.toLowerCase()}|${job.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(job);
  }
  return jobs;
}

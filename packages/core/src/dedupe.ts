import { createHash } from 'node:crypto';

/**
 * Deduplication.
 *
 * Two different problems, handled two different ways:
 *
 *  1. THE SAME LISTING SEEN AGAIN on a later poll. This is the common case and
 *     it must be exact and cheap. `dedupeHash` is a sha256 of the canonical
 *     URL and backs a single unique index, so ingest is a plain upsert with
 *     one conflict target — no ambiguity about which constraint fired.
 *
 *  2. THE SAME JOB LISTED BY BOTH SOURCES under different URLs. This is fuzzy
 *     and getting it wrong loses real listings, so it does NOT block inserts.
 *     `contentFingerprint` hashes the normalised title and company into a
 *     non-unique index, letting the dashboard group probable duplicates while
 *     both rows stay in the table.
 */

/** Query params that identify a campaign or session, never the job itself. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'dclid',
  'ref', 'referrer', 'source', 'src', 'cid', 'mc_cid', 'mc_eid',
  'campaign', 'trk', 'trkCampaign', 'sid', 'session', 'token',
  // Adzuna's redirect URLs carry a per-request signature in `se` and a build
  // token in `v`; the ad id in the path is the stable identity.
  'se', 'v',
  // Jooble appends its own click tracking.
  'utm', 'p', 'pos',
]);

/**
 * Reduce a URL to a stable identity string.
 *
 * A URL that fails to parse is not dropped — it falls back to a trimmed,
 * lowercased version of the original, so a malformed link still dedupes
 * against itself on the next poll.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  // Sort what's left so ?a=1&b=2 and ?b=2&a=1 collapse to one identity.
  url.searchParams.sort();

  let out = url.toString();
  out = out.replace(/\?$/, '');
  if (url.pathname !== '/' ) out = out.replace(/\/(\?|$)/, '$1');
  return out;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function dedupeHash(rawUrl: string): string {
  return sha256(canonicalizeUrl(rawUrl));
}

/** Strip the boilerplate advertisers pad titles with. */
const TITLE_NOISE =
  /\b(job|jobs|vacancy|vacancies|position|opportunity|opportunities|role|hiring|urgent|new|apply now|m\/f\/d)\b/gi;

function normaliseForFingerprint(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(TITLE_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fuzzy identity for cross-source duplicate detection. Intentionally ignores
 * location: the same job is often listed as "Melbourne" on one board and
 * "Docklands, Melbourne" on the other.
 */
export function contentFingerprint(title: string, company: string | null): string {
  return sha256(`${normaliseForFingerprint(title)}|${normaliseForFingerprint(company)}`);
}

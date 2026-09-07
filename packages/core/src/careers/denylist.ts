/**
 * Hosts this project must never scrape.
 *
 * CLAUDE.md states "No direct scraping of SEEK, LinkedIn, or Indeed" as a hard
 * constraint. Until now that was a promise in a document; Phase 4 introduces
 * code that fetches arbitrary user-supplied URLs, so the constraint becomes a
 * check that runs before every request and at the moment a page is added.
 *
 * Deliberately enforced in TWO places — on insert and again on fetch. The
 * insert check gives a readable error; the fetch check is what actually holds,
 * because a row could reach the table by any route (a manual SQL insert, a
 * restored backup, a future bulk importer) and the guard must not depend on
 * having been asked nicely.
 *
 * Consuming Jooble's public API is a different thing entirely and stays
 * allowed: an API a provider publishes for this purpose is the sanctioned
 * path, whereas driving a browser at a job board's own site is not.
 */

/** Registrable domains, matched against the host and any subdomain of it. */
const BLOCKED_DOMAINS = [
  'seek.com.au',
  'seek.co.nz',
  'seek.com',
  'linkedin.com',
  'indeed.com',
  'au.indeed.com',
  'glassdoor.com',
  'glassdoor.com.au',
  'ziprecruiter.com',
  'monster.com',
  'careerone.com.au',
  'jora.com',
  'adzuna.com.au',
  'jooble.org',
];

export interface DenylistVerdict {
  blocked: boolean;
  /** Present when blocked; safe to show a user. */
  reason?: string;
}

/**
 * Is this URL one we refuse to fetch?
 *
 * An unparseable URL is BLOCKED, not allowed. A guard that fails open is not a
 * guard, and "we could not tell what host this is" is not a reason to send a
 * request to it.
 */
export function checkCareerUrl(rawUrl: string): DenylistVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { blocked: true, reason: 'not a valid absolute URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { blocked: true, reason: `unsupported scheme "${url.protocol}"` };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  for (const domain of BLOCKED_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return {
        blocked: true,
        reason:
          `${domain} is a job board, not a company career page. This project ` +
          `does not scrape job boards — it consumes their APIs where one exists.`,
      };
    }
  }

  // Loopback and private ranges: a career page is on the public internet, and
  // fetching internal addresses on request is server-side request forgery.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^(?:127|10)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('[')
  ) {
    return { blocked: true, reason: 'private or loopback address' };
  }

  return { blocked: false };
}

/** The list, for display in the dashboard so the rule is visible, not folklore. */
export function blockedDomains(): readonly string[] {
  return BLOCKED_DOMAINS;
}

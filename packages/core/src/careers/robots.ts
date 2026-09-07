/**
 * robots.txt, honoured rather than assumed.
 *
 * Phase 4 fetches pages the user chose, but "the user chose it" is not consent
 * from the site operator. Checking robots.txt before requesting a path is the
 * minimum courtesy for automated fetching, and it costs one cached request per
 * origin per run.
 *
 * Implements the parts that matter here — User-agent grouping, Allow/Disallow
 * with longest-match-wins, and Crawl-delay. Not a complete RFC 9309
 * implementation; it errs toward NOT fetching wherever the standard is
 * ambiguous, which is the right direction for a guard.
 */

export const USER_AGENT =
  'intern-finder-bot/1.0 (personal job-search assistant; +https://github.com/OggyAI/InternFinder)';

export interface RobotsRules {
  /** May we request this path? */
  allows(path: string): boolean;
  /** Seconds the site asked us to wait between requests, if it said. */
  crawlDelaySeconds: number | null;
  /** Why this ruleset is what it is — for logs when a fetch is refused. */
  source: 'parsed' | 'absent' | 'unreachable';
}

interface Rule {
  allow: boolean;
  path: string;
}

const ALLOW_ALL: RobotsRules = {
  allows: () => true,
  crawlDelaySeconds: null,
  source: 'absent',
};

const DENY_ALL: RobotsRules = {
  allows: () => false,
  crawlDelaySeconds: null,
  source: 'unreachable',
};

/**
 * A `Disallow: /x` prefix match, with `*` and `$` as robots.txt defines them.
 * Escaped so a path containing regex metacharacters cannot alter the pattern.
 */
function toMatcher(pattern: string): (path: string) => boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const anchored = escaped.endsWith('\\$') ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  const re = new RegExp(anchored);
  return (path) => re.test(path);
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const lines = text.split(/\r?\n/);

  // Collect rule groups by user-agent token. A group's agents are the run of
  // User-agent lines immediately preceding its rules.
  const groups = new Map<string, { rules: Rule[]; crawlDelay: number | null }>();
  let currentAgents: string[] = [];
  let expectingAgents = true;

  const groupFor = (agent: string) => {
    let g = groups.get(agent);
    if (!g) {
      g = { rules: [], crawlDelay: null };
      groups.set(agent, g);
    }
    return g;
  };

  for (const raw of lines) {
    const line = raw.split('#')[0]!.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (currentAgents.length === 0) continue;
    expectingAgents = false;

    if (field === 'disallow' || field === 'allow') {
      // "Disallow:" with an empty value means allow everything for this group.
      if (field === 'disallow' && value === '') continue;
      for (const agent of currentAgents) {
        groupFor(agent).rules.push({ allow: field === 'allow', path: value });
      }
    } else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) {
        for (const agent of currentAgents) groupFor(agent).crawlDelay = delay;
      }
    }
  }

  // Most specific matching agent wins; fall back to the wildcard group.
  const ua = userAgent.toLowerCase();
  let chosen = groups.get('*');
  for (const [agent, group] of groups) {
    if (agent !== '*' && ua.includes(agent)) {
      chosen = group;
      break;
    }
  }
  if (!chosen) return { ...ALLOW_ALL, source: 'parsed' };

  const matchers = chosen.rules.map((r) => ({ ...r, test: toMatcher(r.path) }));

  return {
    source: 'parsed',
    crawlDelaySeconds: chosen.crawlDelay,
    allows(path: string): boolean {
      // Longest matching rule wins; Allow beats Disallow at equal length.
      let best: { allow: boolean; length: number } | null = null;
      for (const rule of matchers) {
        if (!rule.test(path)) continue;
        const length = rule.path.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) {
          best = { allow: rule.allow, length };
        }
      }
      return best ? best.allow : true;
    },
  };
}

/**
 * Fetch and parse an origin's robots.txt.
 *
 * Per RFC 9309: a 4xx means no restrictions, while a 5xx means the site is
 * unwell and a crawler should treat everything as disallowed. A network
 * failure gets the same treatment as a 5xx — if we cannot ask permission, we
 * do not proceed.
 */
export async function fetchRobots(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RobotsRules> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('/robots.txt', origin).toString(), {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return DENY_ALL;
  }

  if (response.status >= 500) return DENY_ALL;
  if (response.status >= 400) return ALLOW_ALL;

  try {
    return parseRobots(await response.text(), USER_AGENT);
  } catch {
    return DENY_ALL;
  }
}

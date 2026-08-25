import type { Commitment, Compensation, ListingSignals, NormalizedListing, RoleType, WorkMode } from './types';

/**
 * Text sniffing for the four preference axes plus duration.
 *
 * This is deliberately conservative. Every axis can return 'unknown', and
 * 'unknown' scores neutral — a wrong confident guess is worse than an honest
 * shrug, because Phase 2 hands the same text to Claude and will do a better
 * job. What this buys us is a cheap ordering signal so the LLM budget gets
 * spent on the most promising listings first.
 *
 * Where a provider gave us a structured hint (Adzuna's contract_time, for
 * instance), that always beats anything sniffed from prose.
 */

/** Matches a whole phrase, tolerating "part time" / "part-time" / "parttime". */
function phrase(...variants: string[]): RegExp {
  const alts = variants
    .map((v) => v.trim().split(/\s+/).map(escapeRe).join('[\\s-]*'))
    .join('|');
  return new RegExp(`(?<![a-z])(?:${alts})(?![a-z])`, 'i');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- Compensation ----------------------------------------------------

const UNPAID_PATTERNS = [
  phrase('unpaid'),
  phrase('voluntary', 'volunteer'),
  phrase('no remuneration'),
  phrase('for course credit', 'course credit', 'academic credit'),
  phrase('work integrated learning'),
  phrase('industry based learning'),
  phrase('university placement', 'student placement'),
  phrase('expenses only', 'reimbursement only'),
];

const PAID_PATTERNS = [
  phrase('paid internship', 'paid placement'),
  phrase('hourly rate', 'per hour'),
  phrase('salary', 'remuneration', 'competitive pay'),
  phrase('award wage', 'penalty rates', 'superannuation'),
];

export function detectCompensation(
  text: string,
  salaryMin: number | null,
  salaryIsPredicted: boolean,
): Compensation {
  // Unpaid wins over paid: an ad reading "unpaid internship, superannuation
  // not applicable" hits both lists, and the unpaid statement is the explicit one.
  if (UNPAID_PATTERNS.some((p) => p.test(text))) return 'unpaid';

  // A REAL salary is strong evidence. A predicted one is not — Adzuna invents
  // a salary estimate for listings that stated none, so trusting it would mark
  // every silent listing as paid.
  if (salaryMin !== null && salaryMin > 0 && !salaryIsPredicted) return 'paid';

  if (PAID_PATTERNS.some((p) => p.test(text))) return 'paid';
  return 'unknown';
}

// ---------- Work mode -------------------------------------------------------

const HYBRID = [phrase('hybrid'), phrase('days in the office', 'days in office'), phrase('flexible working arrangement')];
const REMOTE = [phrase('remote', 'fully remote', 'remote first'), phrase('work from home'), phrase('wfh'), phrase('telecommute')];
const ONSITE = [phrase('on site', 'onsite'), phrase('in person'), phrase('in the office'), phrase('office based'), phrase('based on campus')];

export function detectWorkMode(text: string): WorkMode {
  // Order matters. "Hybrid — 2 days remote" mentions remote but is hybrid, so
  // hybrid is checked first and short-circuits.
  if (HYBRID.some((p) => p.test(text))) return 'hybrid';
  const remote = REMOTE.some((p) => p.test(text));
  const onsite = ONSITE.some((p) => p.test(text));
  if (remote && onsite) return 'hybrid';
  if (remote) return 'remote';
  if (onsite) return 'onsite';
  return 'unknown';
}

// ---------- Commitment ------------------------------------------------------

const CASUAL = [phrase('casual')];
const PART_TIME = [phrase('part time'), phrase('0.5 fte', '0.6 fte', '0.8 fte'), phrase('a few days a week')];
const FULL_TIME = [phrase('full time'), phrase('38 hours', '40 hours'), phrase('1.0 fte')];
const CONTRACT = [phrase('fixed term'), phrase('contract role', 'contract position'), phrase('max term')];

export function detectCommitment(text: string): Commitment {
  if (CASUAL.some((p) => p.test(text))) return 'casual';
  if (PART_TIME.some((p) => p.test(text))) return 'part_time';
  if (CONTRACT.some((p) => p.test(text))) return 'contract';
  if (FULL_TIME.some((p) => p.test(text))) return 'full_time';
  return 'unknown';
}

// ---------- Role type -------------------------------------------------------

const INTERNSHIP = [
  phrase('internship', 'internships'),
  phrase('intern'),
  phrase('placement'),
  phrase('cadetship', 'cadet'),
  phrase('trainee', 'traineeship'),
  phrase('work experience'),
  phrase('vacation program', 'vacationer', 'summer program'),
];

export function detectRoleType(text: string): RoleType {
  if (INTERNSHIP.some((p) => p.test(text))) return 'internship';
  // Everything reaching this point came off a job board, so 'job' is the
  // honest default rather than 'unknown'. Phase 2 can still overrule it.
  return 'job';
}

// ---------- Duration --------------------------------------------------------

const WEEKS_PER_MONTH = 4.345;

/**
 * Pull a duration in weeks out of prose.
 *
 * Handles "12 week", "8-12 weeks", "3 month placement", "6 months", "10 days",
 * and the word "semester". Where a range is given we take the LOWER bound,
 * because the minimum-duration filter should judge the worst case: an
 * "8-12 week" internship must clear a 6-week floor on its 8, not its 12.
 *
 * Returns null when nothing is stated, which is the common case — job ads
 * almost never expose duration as structured data.
 */
export function detectDurationWeeks(text: string): number | null {
  const t = text.toLowerCase();

  const range = t.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(week|month)s?/);
  if (range?.[1] && range[3]) {
    const low = Number(range[1]);
    return range[3] === 'month' ? Math.round(low * WEEKS_PER_MONTH) : low;
  }

  const weeks = t.match(/(\d{1,3})\s*week/);
  if (weeks?.[1]) return Number(weeks[1]);

  const months = t.match(/(\d{1,2})\s*month/);
  if (months?.[1]) return Math.round(Number(months[1]) * WEEKS_PER_MONTH);

  const days = t.match(/(\d{1,3})\s*day/);
  if (days?.[1]) return Math.max(1, Math.round(Number(days[1]) / 7));

  // An Australian university semester runs roughly 12 teaching weeks plus
  // assessment; 16 is the usual end-to-end figure for a semester placement.
  if (/\bsemester\b/.test(t)) return 16;

  return null;
}

// ---------- Combined --------------------------------------------------------

/** Full text of a listing, as fed to every detector above. */
export function listingText(listing: NormalizedListing): string {
  return [listing.title, listing.company, listing.description].filter(Boolean).join('\n');
}

export function detectSignals(listing: NormalizedListing): ListingSignals {
  const text = listingText(listing);
  const hints = listing.providerHints;

  return {
    compensation: detectCompensation(text, listing.salaryMin, listing.salaryIsPredicted),
    // Provider hints beat prose. Adzuna's contract_time is a structured field
    // set by the advertiser; our regexes are guessing.
    workMode: hints.workMode ?? detectWorkMode(text),
    commitment: hints.commitment ?? detectCommitment(text),
    roleType: hints.roleType ?? detectRoleType(text),
    durationWeeks: detectDurationWeeks(text),
  };
}

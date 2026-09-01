import type { InlineButton } from './telegram';

/**
 * Turning a scored match into something readable on a phone.
 *
 * Kept apart from `telegram.ts` because formatting is where the bugs live and
 * the network is where the tests can't go. Everything here is a pure function
 * over plain data, so the whole message surface is covered by unit tests.
 *
 * HTML parse mode, not MarkdownV2. Markdown requires escaping 18 characters
 * including `-`, `.` and `!`, which appear in almost every job title; HTML
 * needs exactly three, and an unescaped one degrades to visible text rather
 * than a 400 that drops the notification entirely.
 */

/** Telegram's hard limit is 4096 characters for a message. */
export const MAX_MESSAGE_CHARS = 4096;
/** Reasoning is model output and can run long; the rest of the card is small. */
const MAX_REASONING_CHARS = 600;

export type MatchDecision = 'applied' | 'dismissed' | 'saved';

export interface NotifiableMatch {
  matchId: string;
  fitScore: number;
  baseScore: number;
  preferenceMultiplier: number;
  category: string;
  compensation: string;
  workMode: string;
  commitment: string;
  durationWeeks: number | null;
  reasoning: string;
  title: string;
  company: string | null;
  locationSuburb: string | null;
  distanceKm: number | null;
  url: string;
  postedDate: string | null;
}

/** The only three characters HTML parse mode cares about. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  // Cut at a word boundary so the ellipsis doesn't land mid-word.
  const cut = trimmed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const LABELS: Record<string, string> = {
  full_time: 'full-time',
  part_time: 'part-time',
  onsite: 'on-site',
};

/** 'full_time' -> 'full-time'. 'unknown' is dropped by the caller, not renamed. */
export function label(value: string): string {
  return LABELS[value] ?? value;
}

/**
 * The facts line: only what is actually known.
 *
 * 'unknown' is a first-class value everywhere else in this project precisely
 * so it can be honest, and printing "unknown · unknown · unknown" on a phone
 * is noise rather than honesty. Omitting the axis says the same thing in no
 * space at all.
 */
function factsLine(m: NotifiableMatch): string {
  const parts = [m.category, m.compensation, m.workMode, m.commitment]
    .filter((v) => v && v !== 'unknown')
    .map(label);
  if (m.durationWeeks !== null) parts.push(`~${m.durationWeeks} weeks`);
  return parts.join(' · ');
}

function placeLine(m: NotifiableMatch): string {
  const bits: string[] = [];
  if (m.locationSuburb) bits.push(m.locationSuburb);
  if (m.distanceKm !== null) bits.push(`${Math.round(m.distanceKm)} km away`);
  return bits.join(' · ');
}

/**
 * One match, as a Telegram message body.
 *
 * The score breakdown is shown rather than just the final number because the
 * multiplier is a preference weight, not a quality judgement — seeing
 * "71 base x 1.30" makes it obvious that a role ranked high partly because it
 * is unpaid and part-time, which is exactly the ranking behaviour that was
 * asked for and would otherwise look like the model overrating a listing.
 */
export function formatMatch(m: NotifiableMatch): string {
  const lines: string[] = [];

  lines.push(`<b>${m.fitScore}</b> · <b>${escapeHtml(m.title)}</b>`);
  if (m.company) lines.push(escapeHtml(m.company));

  const place = placeLine(m);
  if (place) lines.push(`📍 ${escapeHtml(place)}`);

  const facts = factsLine(m);
  if (facts) lines.push(`💼 ${escapeHtml(facts)}`);

  const reasoning = truncate(m.reasoning, MAX_REASONING_CHARS);
  if (reasoning) lines.push(`\n${escapeHtml(reasoning)}`);

  const multiplier = Number(m.preferenceMultiplier).toFixed(2);
  lines.push(`\n<i>${m.baseScore} resume match × ${multiplier} preference</i>`);
  if (m.postedDate) lines.push(`<i>posted ${escapeHtml(m.postedDate)}</i>`);
  lines.push(`\n${escapeHtml(m.url)}`);

  return truncate(lines.join('\n'), MAX_MESSAGE_CHARS);
}

// --- Callback data ---------------------------------------------------------
// Telegram caps callback_data at 64 BYTES. A uuid is 36, so a one-character
// action prefix leaves room to spare — but only just, which is why the action
// is a letter rather than the word.

const ACTION_CODE: Record<MatchDecision, string> = {
  applied: 'a',
  dismissed: 'd',
  saved: 's',
};
const CODE_ACTION: Record<string, MatchDecision> = {
  a: 'applied',
  d: 'dismissed',
  s: 'saved',
};

export function encodeCallback(decision: MatchDecision, matchId: string): string {
  return `${ACTION_CODE[decision]}:${matchId}`;
}

/** Returns null for anything unrecognised — including data from an older build. */
export function decodeCallback(
  data: string | undefined,
): { decision: MatchDecision; matchId: string } | null {
  if (!data) return null;
  const separator = data.indexOf(':');
  if (separator !== 1) return null;
  const decision = CODE_ACTION[data.slice(0, 1)];
  const matchId = data.slice(separator + 1);
  if (!decision || !/^[0-9a-f-]{36}$/i.test(matchId)) return null;
  return { decision, matchId };
}

/**
 * The three buttons under a match.
 *
 * "Applied" RECORDS that the human applied; it does not apply. Nothing in this
 * project may contact an employer, so every button here writes one row in our
 * own database and nothing else.
 */
export function matchKeyboard(matchId: string): InlineButton[][] {
  return [
    [
      { text: '✅ Applied', callback_data: encodeCallback('applied', matchId) },
      { text: '⭐ Save', callback_data: encodeCallback('saved', matchId) },
      { text: '🗑 Dismiss', callback_data: encodeCallback('dismissed', matchId) },
    ],
  ];
}

const DECISION_SUFFIX: Record<MatchDecision, string> = {
  applied: '✅ Marked as applied',
  saved: '⭐ Saved for later',
  dismissed: '🗑 Dismissed',
};

/**
 * The message body after a button is tapped.
 *
 * The buttons are removed and replaced by the outcome so the card reads as
 * settled. Rebuilt from the original text rather than stored, so a formatting
 * change never has to migrate messages already on the phone.
 */
export function withDecision(originalText: string, decision: MatchDecision): string {
  const stripped = originalText.replace(/\n*(✅|⭐|🗑) .*$/u, '');
  return truncate(`${stripped}\n\n${DECISION_SUFFIX[decision]}`, MAX_MESSAGE_CHARS);
}

// --- Command replies -------------------------------------------------------

export interface StatsSummary {
  listingsTotal: number;
  listingsPassed: number;
  duplicates: number;
  scored: number;
  awaitingScore: number;
  aboveThreshold: number;
  threshold: number;
  spentToday: number;
  spendCapPerDay: number;
  notifiedToday: number;
  notifyCapPerDay: number;
  paused: boolean;
  byStatus: Record<string, number>;
}

export function formatStats(s: StatsSummary): string {
  const statusLine = ['new', 'notified', 'saved', 'applied', 'dismissed']
    .map((k) => `${k} ${s.byStatus[k] ?? 0}`)
    .join(' · ');

  return [
    `<b>Pipeline</b>${s.paused ? ' — ⏸ paused' : ''}`,
    ``,
    `Listings   ${s.listingsTotal} stored · ${s.listingsPassed} passed the filter · ${s.duplicates} near-duplicates`,
    `Scored     ${s.scored} · ${s.awaitingScore} awaiting`,
    `Above ${s.threshold}   ${s.aboveThreshold}`,
    ``,
    `Decisions  ${statusLine}`,
    ``,
    `Spend      $${s.spentToday.toFixed(4)} of $${s.spendCapPerDay.toFixed(2)} today`,
    `Notified   ${s.notifiedToday} of ${s.notifyCapPerDay} today`,
  ].join('\n');
}

export interface FilterSummary {
  name: string;
  centerLabel: string;
  radiusKm: number;
  includeKeywords: string[];
  excludeKeywords: string[];
  threshold: number;
  preferences: { axis: string; value: string; weight: number }[];
}

export function formatFilters(f: FilterSummary): string {
  const prefs = f.preferences
    .filter((p) => Number(p.weight) !== 1)
    .map((p) => `  ${p.axis}=${label(p.value)} ×${Number(p.weight).toFixed(2)}`)
    .join('\n');

  return [
    `<b>${escapeHtml(f.name)}</b>`,
    `${f.radiusKm} km around ${escapeHtml(f.centerLabel)}`,
    `Notify at fit ≥ ${f.threshold}`,
    ``,
    `<b>Include</b> (${f.includeKeywords.length})`,
    escapeHtml(truncate(f.includeKeywords.join(', '), 700)) || '  none',
    ``,
    `<b>Exclude</b> (${f.excludeKeywords.length})`,
    escapeHtml(truncate(f.excludeKeywords.join(', '), 500)) || '  none',
    ``,
    `<b>Preference weights</b>`,
    prefs ? escapeHtml(prefs) : '  all neutral',
    ``,
    `<i>Edit these in the database — they are read fresh on every poll, so no restart is needed.</i>`,
  ].join('\n');
}

export interface HistoryEntry {
  fitScore: number;
  title: string;
  company: string | null;
  status: string;
  url: string;
}

export function formatHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return 'Nothing decided yet. Tap a button under a match and it will show up here.';
  }
  const icon: Record<string, string> = {
    applied: '✅',
    saved: '⭐',
    dismissed: '🗑',
    notified: '📨',
    new: '·',
  };
  const lines = entries.map(
    (e) =>
      `${icon[e.status] ?? '·'} <b>${e.fitScore}</b> ${escapeHtml(truncate(e.title, 60))}` +
      (e.company ? `\n     ${escapeHtml(truncate(e.company, 50))}` : ''),
  );
  return truncate([`<b>Recent decisions</b>`, ``, ...lines].join('\n'), MAX_MESSAGE_CHARS);
}

export const HELP_TEXT = [
  '<b>intern finder</b>',
  '',
  'I watch the job boards and message you when something scores above your threshold.',
  '',
  '/stats — pipeline, spend and decisions',
  '/top — best matches not yet decided',
  '/filters — current search criteria',
  '/history — what you have decided recently',
  '/pause — stop polling and notifying',
  '/resume — start again',
  '/help — this',
  '',
  '<i>Buttons record YOUR decision. I never contact an employer, submit an ' +
    'application, or fill in a form — you apply manually, every time.</i>',
].join('\n');

export const COMMANDS = [
  { command: 'stats', description: 'Pipeline, spend and decisions' },
  { command: 'top', description: 'Best matches not yet decided' },
  { command: 'filters', description: 'Current search criteria' },
  { command: 'history', description: 'Recent decisions' },
  { command: 'pause', description: 'Stop polling and notifying' },
  { command: 'resume', description: 'Start again' },
  { command: 'help', description: 'What I can do' },
];

import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  decodeCallback,
  encodeCallback,
  escapeHtml,
  formatFilters,
  formatHistory,
  formatMatch,
  formatStats,
  matchKeyboard,
  withDecision,
  type NotifiableMatch,
} from './telegram-format';

const base: NotifiableMatch = {
  matchId: '3f8e1c22-9a4b-4d1e-8f77-2b6c5d0a1e93',
  fitScore: 92,
  baseScore: 71,
  preferenceMultiplier: 1.3,
  category: 'internship',
  compensation: 'unpaid',
  workMode: 'onsite',
  commitment: 'part_time',
  durationWeeks: 12,
  reasoning: 'Cyber security internship; resume shows SOC tooling and Splunk.',
  title: 'Cyber Security Intern',
  company: 'Acme Security',
  locationSuburb: 'Footscray',
  distanceKm: 8.4,
  url: 'https://example.com/job/1',
  postedDate: '2026-08-28',
};

describe('escapeHtml', () => {
  it('escapes exactly the three characters HTML parse mode cares about', () => {
    expect(escapeHtml('R&D <script> "quoted" \'apos\'')).toBe(
      'R&amp;D &lt;script&gt; "quoted" \'apos\'',
    );
  });

  it('leaves the characters MarkdownV2 would have required escaping', () => {
    // The reason for choosing HTML: these are in nearly every job title.
    expect(escapeHtml('Help Desk - Level 1 (2026!) 50% onsite. #IT')).toBe(
      'Help Desk - Level 1 (2026!) 50% onsite. #IT',
    );
  });
});

describe('formatMatch', () => {
  it('escapes a title containing HTML rather than emitting raw tags', () => {
    const text = formatMatch({ ...base, title: 'IT Support <urgent> & Helpdesk' });
    expect(text).toContain('IT Support &lt;urgent&gt; &amp; Helpdesk');
    expect(text).not.toContain('<urgent>');
  });

  it("omits 'unknown' axes instead of printing them", () => {
    const text = formatMatch({
      ...base,
      compensation: 'unknown',
      workMode: 'unknown',
      commitment: 'unknown',
      durationWeeks: null,
    });
    expect(text).not.toContain('unknown');
    expect(text).toContain('internship');
  });

  it('renders the score as a breakdown, so a preference-driven rank is visible', () => {
    // A 71 that ranks at 92 did so because the role is unpaid and part-time.
    // Showing only "92" would look like the model overrating the listing.
    expect(formatMatch(base)).toContain('71 resume match × 1.30 preference');
  });

  it('humanises the enum labels', () => {
    const text = formatMatch(base);
    expect(text).toContain('part-time');
    expect(text).toContain('on-site');
    expect(text).not.toContain('part_time');
  });

  it('stays within the Telegram message limit even with runaway reasoning', () => {
    const text = formatMatch({ ...base, reasoning: 'very relevant. '.repeat(2000) });
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    // The URL is the point of the message; truncation must not eat it.
    expect(text).toContain(base.url);
  });

  it('survives a listing with almost nothing known', () => {
    const text = formatMatch({
      ...base,
      company: null,
      locationSuburb: null,
      distanceKm: null,
      postedDate: null,
      category: 'unknown',
      compensation: 'unknown',
      workMode: 'unknown',
      commitment: 'unknown',
      durationWeeks: null,
    });
    expect(text).toContain('Cyber Security Intern');
    expect(text).toContain(base.url);
    expect(text).not.toContain('📍');
  });
});

describe('callback data', () => {
  it('round-trips every decision', () => {
    for (const decision of ['applied', 'dismissed', 'saved'] as const) {
      expect(decodeCallback(encodeCallback(decision, base.matchId))).toEqual({
        decision,
        matchId: base.matchId,
      });
    }
  });

  it('fits inside the 64-byte Telegram limit', () => {
    for (const row of matchKeyboard(base.matchId)) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
  });

  it('rejects anything unrecognised rather than guessing', () => {
    expect(decodeCallback(undefined)).toBeNull();
    expect(decodeCallback('')).toBeNull();
    expect(decodeCallback('applied:' + base.matchId)).toBeNull(); // old-build format
    expect(decodeCallback('a:not-a-uuid')).toBeNull();
    expect(decodeCallback('z:' + base.matchId)).toBeNull();
    expect(decodeCallback(base.matchId)).toBeNull();
  });
});

describe('withDecision', () => {
  it('appends the outcome', () => {
    expect(withDecision(formatMatch(base), 'applied')).toContain('✅ Marked as applied');
  });

  it('replaces a previous decision rather than stacking them', () => {
    // An update can be redelivered if the offset was never confirmed, so this
    // has to be idempotent.
    const once = withDecision(formatMatch(base), 'saved');
    const twice = withDecision(once, 'applied');
    expect(twice).toContain('✅ Marked as applied');
    expect(twice).not.toContain('⭐ Saved for later');
    expect(withDecision(twice, 'applied')).toBe(twice);
  });
});

describe('command replies', () => {
  it('formats stats with every decision bucket, including empty ones', () => {
    const text = formatStats({
      listingsTotal: 2454,
      listingsPassed: 1000,
      duplicates: 235,
      scored: 1468,
      awaitingScore: 454,
      aboveThreshold: 11,
      threshold: 70,
      spentToday: 2.0095,
      spendCapPerDay: 2,
      notifiedToday: 3,
      notifyCapPerDay: 25,
      paused: false,
      byStatus: { notified: 3 },
    });
    expect(text).toContain('applied 0');
    expect(text).toContain('notified 3');
    expect(text).toContain('$2.0095 of $2.00 today');
    expect(text).not.toContain('paused');
  });

  it('marks a paused pipeline', () => {
    const text = formatStats({
      listingsTotal: 0, listingsPassed: 0, duplicates: 0, scored: 0, awaitingScore: 0,
      aboveThreshold: 0, threshold: 70, spentToday: 0, spendCapPerDay: 2,
      notifiedToday: 0, notifyCapPerDay: 25, paused: true, byStatus: {},
    });
    expect(text).toContain('⏸ paused');
  });

  it('shows only the preference weights that actually change the ranking', () => {
    const text = formatFilters({
      name: 'default',
      centerLabel: 'Melbourne CBD',
      radiusKm: 50,
      includeKeywords: ['IT', 'SOC Analyst'],
      excludeKeywords: ['sponsorship'],
      threshold: 70,
      preferences: [
        { axis: 'compensation', value: 'unpaid', weight: 1.3 },
        { axis: 'work_mode', value: 'remote', weight: 1 },
      ],
    });
    expect(text).toContain('compensation=unpaid ×1.30');
    expect(text).not.toContain('work_mode=remote');
  });

  it('tells you what to do when there is no history yet', () => {
    expect(formatHistory([])).toContain('Nothing decided yet');
  });

  it('escapes history entries and stays within the limit', () => {
    const text = formatHistory(
      Array.from({ length: 60 }, () => ({
        fitScore: 88,
        title: 'Analyst <b>x</b> & co',
        company: 'A & B',
        status: 'applied',
        url: 'https://example.com',
      })),
    );
    expect(text).toContain('&lt;b&gt;');
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

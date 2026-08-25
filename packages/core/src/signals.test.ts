import { describe, expect, it } from 'vitest';
import {
  detectCommitment,
  detectCompensation,
  detectDurationWeeks,
  detectRoleType,
  detectSignals,
  detectWorkMode,
} from './signals';
import { makeListing } from './testing';

describe('detectCompensation', () => {
  it('detects an explicitly unpaid role', () => {
    expect(detectCompensation('This is an unpaid internship.', null, false)).toBe('unpaid');
  });

  it('treats volunteer as unpaid', () => {
    expect(detectCompensation('Volunteer IT support assistant', null, false)).toBe('unpaid');
  });

  it('lets an explicit unpaid statement beat incidental paid vocabulary', () => {
    // Real ads do this: "Unpaid placement. No salary or superannuation applies."
    const text = 'Unpaid placement. No salary or superannuation applies.';
    expect(detectCompensation(text, null, false)).toBe('unpaid');
  });

  it('treats a real stated salary as paid', () => {
    expect(detectCompensation('Great opportunity', 38.5, false)).toBe('paid');
  });

  it('does NOT treat a predicted salary as paid', () => {
    // This is the important one. Adzuna invents a salary estimate for listings
    // that stated none, so trusting it would mark every silent ad as paid and
    // quietly suppress the unpaid roles the weighting is supposed to surface.
    expect(detectCompensation('Great opportunity', 55000, true)).toBe('unknown');
  });

  it('returns unknown when there is no evidence either way', () => {
    expect(detectCompensation('Join our team.', null, false)).toBe('unknown');
  });
});

describe('detectWorkMode', () => {
  it('detects remote', () => {
    expect(detectWorkMode('Fully remote, work from home.')).toBe('remote');
  });

  it('detects onsite', () => {
    expect(detectWorkMode('This is an on-site role at our Werribee campus.')).toBe('onsite');
  });

  it('detects hybrid explicitly', () => {
    expect(detectWorkMode('Hybrid working arrangement.')).toBe('hybrid');
  });

  it('calls a mix of remote and onsite hybrid', () => {
    expect(detectWorkMode('Two days in the office, three days working from home.')).toBe('hybrid');
  });

  it('returns unknown when unstated', () => {
    expect(detectWorkMode('Exciting opportunity for a graduate.')).toBe('unknown');
  });
});

describe('detectCommitment', () => {
  it('detects part-time across spellings', () => {
    expect(detectCommitment('Part time role')).toBe('part_time');
    expect(detectCommitment('part-time role')).toBe('part_time');
  });

  it('detects casual', () => {
    expect(detectCommitment('Casual position, weekends')).toBe('casual');
  });

  it('detects full-time', () => {
    expect(detectCommitment('Full-time permanent')).toBe('full_time');
  });

  it('returns unknown when unstated', () => {
    expect(detectCommitment('Join the team')).toBe('unknown');
  });
});

describe('detectRoleType', () => {
  it('detects an internship', () => {
    expect(detectRoleType('Cyber Security Internship')).toBe('internship');
  });

  it('does not match "intern" inside "internal"', () => {
    expect(detectRoleType('Internal Communications Officer')).toBe('job');
  });

  it('defaults to job', () => {
    expect(detectRoleType('IT Support Officer')).toBe('job');
  });
});

describe('detectDurationWeeks', () => {
  it('parses a plain week count', () => {
    expect(detectDurationWeeks('A 12 week internship')).toBe(12);
  });

  it('takes the LOWER bound of a range', () => {
    // An "8-12 week" internship must clear a 6-week floor on its 8, not its 12.
    expect(detectDurationWeeks('an 8-12 week placement')).toBe(8);
  });

  it('converts months to weeks', () => {
    expect(detectDurationWeeks('3 month placement')).toBe(13);
  });

  it('converts days to weeks', () => {
    expect(detectDurationWeeks('10 day work experience')).toBe(1);
  });

  it('maps semester to ~16 weeks', () => {
    expect(detectDurationWeeks('Semester long internship')).toBe(16);
  });

  it('returns null when duration is unstated — the common case', () => {
    expect(detectDurationWeeks('IT Support Officer, ongoing')).toBeNull();
  });
});

describe('detectSignals', () => {
  it('lets a provider hint override text sniffing', () => {
    // The prose says full time; Adzuna's structured contract_time says part_time.
    // The structured field was set by the advertiser, so it wins.
    const listing = makeListing({
      description: 'Full time hours available.',
      providerHints: { commitment: 'part_time' },
    });
    expect(detectSignals(listing).commitment).toBe('part_time');
  });

  it('falls back to text when there is no hint', () => {
    const listing = makeListing({ description: 'Casual role.', providerHints: {} });
    expect(detectSignals(listing).commitment).toBe('casual');
  });
});

import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  contentFingerprint,
  dedupeHash,
  prefilterBatch,
  type NormalizedListing,
  type PrefilterResult,
} from '@intern-finder/core';
import { makeTestFilterSet } from '@intern-finder/core/testing';
import { AdzunaResponse, normalizeAdzunaJob } from './sources/adzuna';
import { JoobleResponse, normalizeJoobleJob } from './sources/jooble';
import adzunaFixture from './fixtures/adzuna.sample.json' with { type: 'json' };
import adzunaCaptured from './fixtures/adzuna.captured.json' with { type: 'json' };
import joobleFixture from './fixtures/jooble.sample.json' with { type: 'json' };

/**
 * End-to-end Phase 1 pipeline test: provider payload -> zod -> normalise ->
 * pre-filter, with no network and no database.
 *
 * This is the check that Phase 1 actually works. It runs the real schemas and
 * the real normalisers over the fixtures, so it catches a broken regex or a
 * mis-mapped field. What it deliberately CANNOT prove is that Adzuna and
 * Jooble really return these shapes — the fixtures are modelled on their
 * documented responses, not captured from live traffic. That confirmation
 * needs API keys.
 */

const NOW = new Date('2026-08-23T12:00:00Z');
const filterSet = makeTestFilterSet();

function normaliseAll(): NormalizedListing[] {
  const adzuna = AdzunaResponse.parse(adzunaFixture)
    .results.map((j) => normalizeAdzunaJob(j))
    .filter((l): l is NormalizedListing => l !== null);
  const jooble = JoobleResponse.parse(joobleFixture)
    .jobs.map((j) => normalizeJoobleJob(j))
    .filter((l): l is NormalizedListing => l !== null);
  return [...adzuna, ...jooble];
}

const listings = normaliseAll();
const results = prefilterBatch(listings, filterSet, { now: NOW });

function find(titleFragment: string): { listing: NormalizedListing; result: PrefilterResult } {
  const i = listings.findIndex((l) => l.title.toLowerCase().includes(titleFragment.toLowerCase()));
  if (i === -1) throw new Error(`No fixture listing matching "${titleFragment}"`);
  return { listing: listings[i]!, result: results[i]! };
}

const buckets = (r: PrefilterResult) => r.reasons.map((x) => x.split(':')[0]);

describe('fixture parsing', () => {
  it('parses every fixture listing without loss', () => {
    expect(listings).toHaveLength(
      adzunaFixture.results.length + joobleFixture.jobs.length,
    );
  });

  it('reads Adzuna string booleans correctly', () => {
    // salary_is_predicted arrives as "1"/"0", not true/false.
    const { listing } = find('Cyber Security Internship');
    expect(listing.salaryIsPredicted).toBe(true);
    const { listing: paid } = find('IT Support Officer');
    expect(paid.salaryIsPredicted).toBe(false);
  });

  it('parses Jooble 7-digit fractional-second timestamps', () => {
    const { listing } = find('Cyber Security Intern (Semester');
    expect(listing.postedDate).toBeInstanceOf(Date);
    expect(Number.isNaN(listing.postedDate!.getTime())).toBe(false);
  });

  it('carries the untouched provider payload through to raw', () => {
    const { listing } = find('Service Desk Analyst');
    expect(listing.raw).toMatchObject({ source: 'seek.com.au' });
  });
});

describe('real captured Adzuna traffic', () => {
  // adzuna.sample.json is hand-built to exercise specific filter paths.
  // adzuna.captured.json is a genuine response, so this is the test that the
  // zod schema matches what Adzuna actually sends rather than what its docs
  // describe. Re-capture it if the shape ever drifts.
  it('parses without loss', () => {
    const parsed = AdzunaResponse.parse(adzunaCaptured);
    expect(parsed.results).toHaveLength(adzunaCaptured.results.length);
  });

  it('normalises every captured result', () => {
    const out = AdzunaResponse.parse(adzunaCaptured)
      .results.map((j) => normalizeAdzunaJob(j, 'Cyber Security'))
      .filter((l): l is NormalizedListing => l !== null);
    expect(out).toHaveLength(adzunaCaptured.results.length);
    for (const l of out) {
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.url).toMatch(/^https?:/);
      expect(l.providerMatchedTerm).toBe('Cyber Security');
    }
  });

  it('confirms the live quirks the adapter was written for', () => {
    const j = AdzunaResponse.parse(adzunaCaptured).results[0]!;
    // salary_is_predicted really does arrive as a string, not a boolean.
    expect(typeof j.salary_is_predicted).toBe('string');
    // Descriptions really are truncated to 500 characters, which is why
    // signal detection so often lands on 'unknown'.
    expect(j.description!.length).toBe(500);
    // area[] is ordered least-specific-first, the opposite of display_name.
    expect(j.location!.area![0]).toBe('Australia');
  });
});

describe('pre-filter outcomes across both sources', () => {
  const expectations: [string, 'passed' | 'rejected', string | null][] = [
    ['Cyber Security Internship', 'passed', null],
    ['IT Support Officer', 'passed', null],
    ['Data Entry Officer', 'passed', null],
    ['Senior Information Security Consultant', 'passed', null],
    ['Security Guard', 'rejected', 'excluded_keyword'],
    ['SOC Analyst - Cyber Security', 'rejected', 'out_of_radius'],
    ['Cyber Security Graduate Program', 'rejected', 'work_rights'],
    ['IT Work Experience Placement', 'rejected', 'too_short'],
    ['Cyber Security Intern (Semester', 'passed', null],
    ['Service Desk Analyst', 'passed', null],
    ['Barista', 'rejected', 'no_keyword_match'],
    ['IT Helpdesk Support Officer', 'rejected', 'out_of_radius'],
    ['Volunteer IT Support Assistant', 'passed', null],
  ];

  it.each(expectations)('%s -> %s', (title, status, reason) => {
    const { result } = find(title);
    expect(result.status, `reasons: ${result.reasons.join(' | ')}`).toBe(status);
    if (reason) expect(buckets(result)).toContain(reason);
  });
});

describe('signal extraction on real-shaped listings', () => {
  it('reads an unpaid 12-week onsite part-time internship correctly', () => {
    const { result } = find('Cyber Security Internship');
    expect(result.signals).toMatchObject({
      compensation: 'unpaid',
      workMode: 'onsite',
      commitment: 'part_time',
      roleType: 'internship',
      durationWeeks: 12,
    });
  });

  it('does not mark a listing paid on the strength of a predicted salary', () => {
    // This listing has salary_is_predicted="1" and says "unpaid" in the body.
    const { result } = find('Cyber Security Internship');
    expect(result.signals.compensation).toBe('unpaid');
  });

  it('maps a semester placement to ~16 weeks', () => {
    const { result } = find('Cyber Security Intern (Semester');
    expect(result.signals.durationWeeks).toBe(16);
  });

  it('detects an unpaid volunteer role from a thin Jooble snippet', () => {
    const { result } = find('Volunteer IT Support Assistant');
    expect(result.signals.compensation).toBe('unpaid');
  });
});

describe('ranking', () => {
  it('puts the unpaid onsite part-time internship at the top of the passing set', () => {
    const passing = listings
      .map((l, i) => ({ l, r: results[i]! }))
      .filter((x) => x.r.status === 'passed')
      .sort((a, b) => b.r.preferenceMultiplier - a.r.preferenceMultiplier);

    expect(passing[0]!.l.title).toContain('Cyber Security Internship');
  });

  it('ranks the paid remote full-time senior role last, but still keeps it', () => {
    const passing = listings
      .map((l, i) => ({ l, r: results[i]! }))
      .filter((x) => x.r.status === 'passed')
      .sort((a, b) => b.r.preferenceMultiplier - a.r.preferenceMultiplier);

    const last = passing[passing.length - 1]!;
    expect(last.l.title).toContain('Senior Information Security Consultant');
    expect(last.r.status).toBe('passed');
    expect(last.r.preferenceMultiplier).toBeLessThan(1);
  });
});

describe('dedupe over fixture data', () => {
  it('gives every fixture listing a distinct dedupe hash', () => {
    const hashes = new Set(listings.map((l) => dedupeHash(l.url)));
    expect(hashes.size).toBe(listings.length);
  });

  it('collapses Adzuna tracking params so a re-poll is not a new listing', () => {
    const { listing } = find('Cyber Security Internship');
    expect(listing.url).toContain('se=abc123');
    expect(canonicalizeUrl(listing.url)).not.toContain('se=');
    expect(canonicalizeUrl(listing.url)).not.toContain('utm_');
  });

  it('would flag the same job listed by both sources', () => {
    // Simulate Jooble carrying the Adzuna listing under its own URL.
    const { listing } = find('IT Support Officer');
    const viaOtherSource: NormalizedListing = {
      ...listing,
      url: 'https://au.jooble.org/desc/999',
      source: 'jooble',
    };
    expect(dedupeHash(listing.url)).not.toBe(dedupeHash(viaOtherSource.url));
    // Different rows, same fingerprint — flagged for grouping, not dropped.
    expect(contentFingerprint(listing.title, listing.company)).toBe(
      contentFingerprint(viaOtherSource.title, viaOtherSource.company),
    );
  });
});

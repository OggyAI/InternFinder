import { describe, expect, it } from 'vitest';
import { resolveDuplicates, type DedupableListing } from './duplicates';

/**
 * The three cases below are taken from real stored listings, because the whole
 * point of this module is that fingerprint alone gets two of them wrong.
 */

let seq = 0;
function listing(over: Partial<DedupableListing> = {}): DedupableListing {
  seq++;
  return {
    id: `id-${seq}`,
    contentFingerprint: 'fp-default',
    latitude: -37.8136,
    longitude: 144.9631,
    locationSuburb: 'Melbourne',
    firstSeenAt: `2026-08-${String(10 + seq).padStart(2, '0')}T00:00:00Z`,
    ...over,
  };
}

describe('resolveDuplicates', () => {
  it('leaves a listing with no fingerprint twin alone', () => {
    const a = listing({ contentFingerprint: 'alone' });
    expect(resolveDuplicates([a]).get(a.id)).toBeNull();
  });

  it('collapses a recruiter re-posting the same ad from the same place', () => {
    // Real: "Senior Engineer" — Halcyon Knights, Melbourne CBD, posted 22/27/30 Aug.
    const fp = 'senior-engineer|halcyon';
    const first = listing({ contentFingerprint: fp, firstSeenAt: '2026-08-22T00:00:00Z' });
    const second = listing({ contentFingerprint: fp, firstSeenAt: '2026-08-27T00:00:00Z' });
    const third = listing({ contentFingerprint: fp, firstSeenAt: '2026-08-30T00:00:00Z' });

    const map = resolveDuplicates([third, first, second]);
    expect(map.get(first.id)).toBeNull();
    expect(map.get(second.id)).toBe(first.id);
    expect(map.get(third.id)).toBe(first.id);
  });

  it('keeps the same role advertised at genuinely different sites', () => {
    // Real: "Service Desk Engineer" — GPK Group, Dandenong East / Knoxfield /
    // Frankston East, all posted the same day. Three vacancies, three
    // applications. Merging these would silently cost real opportunities.
    const fp = 'service-desk-engineer|gpk';
    const dandenong = listing({ contentFingerprint: fp, latitude: -37.9833, longitude: 145.2167, locationSuburb: 'Dandenong East' });
    const knoxfield = listing({ contentFingerprint: fp, latitude: -37.8833, longitude: 145.25, locationSuburb: 'Knoxfield' });
    const frankston = listing({ contentFingerprint: fp, latitude: -38.1417, longitude: 145.1233, locationSuburb: 'Frankston East' });

    const map = resolveDuplicates([dandenong, knoxfield, frankston]);
    expect(map.get(dandenong.id)).toBeNull();
    expect(map.get(knoxfield.id)).toBeNull();
    expect(map.get(frankston.id)).toBeNull();
  });

  it('merges one vacancy geocoded to two nearby suburbs', () => {
    // Real: "Cyber Security Engineer" — Myer, West Melbourne and Docklands,
    // both posted 28 Aug. ~1.5km apart; one job.
    const fp = 'cyber-security-engineer|myer';
    const west = listing({ contentFingerprint: fp, latitude: -37.81, longitude: 144.94, locationSuburb: 'West Melbourne', firstSeenAt: '2026-08-28T01:00:00Z' });
    const docklands = listing({ contentFingerprint: fp, latitude: -37.815, longitude: 144.945, locationSuburb: 'Docklands', firstSeenAt: '2026-08-28T02:00:00Z' });

    const map = resolveDuplicates([west, docklands]);
    expect(map.get(west.id)).toBeNull();
    expect(map.get(docklands.id)).toBe(west.id);
  });

  it('keeps the EARLIEST sighting as canonical', () => {
    // The oldest row is the one that may already be marked applied or
    // dismissed. Promoting a newer copy would discard that decision and
    // re-notify about a job already dealt with.
    const fp = 'same';
    const newer = listing({ contentFingerprint: fp, firstSeenAt: '2026-08-30T00:00:00Z' });
    const older = listing({ contentFingerprint: fp, firstSeenAt: '2026-08-01T00:00:00Z' });

    const map = resolveDuplicates([newer, older]);
    expect(map.get(older.id)).toBeNull();
    expect(map.get(newer.id)).toBe(older.id);
  });

  it('falls back to suburb name when coordinates are missing', () => {
    const fp = 'no-coords';
    const a = listing({ contentFingerprint: fp, latitude: null, longitude: null, locationSuburb: 'Werribee', firstSeenAt: '2026-08-01T00:00:00Z' });
    const b = listing({ contentFingerprint: fp, latitude: null, longitude: null, locationSuburb: 'werribee', firstSeenAt: '2026-08-05T00:00:00Z' });
    expect(resolveDuplicates([a, b]).get(b.id)).toBe(a.id);
  });

  it('treats unplaceable listings as DISTINCT rather than merging on title alone', () => {
    // Wrongly merging hides a real job permanently; wrongly keeping one costs
    // a duplicate notification. Prefer the recoverable mistake.
    const fp = 'unplaceable';
    const a = listing({ contentFingerprint: fp, latitude: null, longitude: null, locationSuburb: null });
    const b = listing({ contentFingerprint: fp, latitude: null, longitude: null, locationSuburb: null });
    const map = resolveDuplicates([a, b]);
    expect(map.get(a.id)).toBeNull();
    expect(map.get(b.id)).toBeNull();
  });

  it('chains nearby sightings that drift apart across a group', () => {
    // A -> B is close, B -> C is close, A -> C is not. Still one job that has
    // wandered, not two.
    const fp = 'drift';
    const a = listing({ contentFingerprint: fp, latitude: -37.80, longitude: 144.96, locationSuburb: 'A', firstSeenAt: '2026-08-01T00:00:00Z' });
    const b = listing({ contentFingerprint: fp, latitude: -37.84, longitude: 144.96, locationSuburb: 'B', firstSeenAt: '2026-08-02T00:00:00Z' });
    const c = listing({ contentFingerprint: fp, latitude: -37.88, longitude: 144.96, locationSuburb: 'C', firstSeenAt: '2026-08-03T00:00:00Z' });

    const map = resolveDuplicates([a, b, c]);
    expect(map.get(a.id)).toBeNull();
    expect(map.get(b.id)).toBe(a.id);
    expect(map.get(c.id)).toBe(a.id);
  });

  it('does not merge across different fingerprints however close they are', () => {
    const a = listing({ contentFingerprint: 'one', locationSuburb: 'Melbourne' });
    const b = listing({ contentFingerprint: 'two', locationSuburb: 'Melbourne' });
    const map = resolveDuplicates([a, b]);
    expect(map.get(a.id)).toBeNull();
    expect(map.get(b.id)).toBeNull();
  });
});

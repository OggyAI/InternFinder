import { describe, expect, it } from 'vitest';
import { distanceFromCentre, hasAustralianSignal, haversineKm, resolveLocation } from './geo';

// Melbourne CBD — the placeholder centre the seed migration ships with.
// Distances below all follow from THIS point; move the centre and they change,
// which is the subject of the last test in this file.
const CENTRE = { lat: -37.8136, lng: 144.9631 };

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(CENTRE, CENTRE)).toBe(0);
  });

  it('matches a known distance: Melbourne CBD to Geelong (~65km)', () => {
    const geelong = { lat: -38.1499, lng: 144.3617 };
    expect(haversineKm(CENTRE, geelong)).toBeGreaterThan(63);
    expect(haversineKm(CENTRE, geelong)).toBeLessThan(67);
  });

  it('is symmetric', () => {
    const cbd = { lat: -37.8136, lng: 144.9631 };
    expect(haversineKm(CENTRE, cbd)).toBeCloseTo(haversineKm(cbd, CENTRE), 6);
  });
});

describe('resolveLocation', () => {
  it('prefers provider coordinates over any text', () => {
    // The text says Sydney but the coordinates say Melbourne. Coordinates win:
    // a provider that gives lat/lng is more reliable than its own display string.
    const r = resolveLocation('Sydney, New South Wales', -37.8136, 144.9631);
    expect(r.method).toBe('coordinates');
    expect(r.lat).toBe(-37.8136);
  });

  it('resolves by postcode', () => {
    const r = resolveLocation('Werribee VIC 3030');
    expect(r.method).toBe('postcode');
    expect(r.suburb).toBe('Werribee');
    expect(r.state).toBe('VIC');
  });

  it('resolves a postcode shared by several suburbs to the first listed', () => {
    // 3029 covers Hoppers Crossing, Tarneit and Truganina. One postcode cannot
    // resolve to three points, so gazetteer order decides — deterministically,
    // and close enough that a few km either way does not change the outcome.
    const r = resolveLocation('VIC 3029');
    expect(r.suburb).toBe('Hoppers Crossing');
  });

  it('resolves by suburb name inside a comma-separated string', () => {
    const r = resolveLocation('Footscray, Maribyrnong, Victoria');
    expect(r.method).toBe('suburb');
    expect(r.suburb).toBe('Footscray');
  });

  it('prefers the more specific suburb over the enclosing city', () => {
    const r = resolveLocation('Docklands, Melbourne');
    expect(r.suburb).toBe('Docklands');
  });

  it('resolves alias phrases', () => {
    const r = resolveLocation('CBD & Inner Suburbs');
    expect(r.method).toBe('alias');
    expect(r.suburb).toBe('Melbourne');
  });

  it('returns unresolved for a suburb missing from the gazetteer', () => {
    const r = resolveLocation('Nowhereville, Victoria');
    expect(r.method).toBe('unresolved');
    expect(r.lat).toBeNull();
    // The state is still extracted, and the raw suburb text is preserved so the
    // gap is visible in the dashboard rather than silent.
    expect(r.state).toBe('VIC');
    expect(r.suburb).toBe('Nowhereville');
  });

  it('handles a null location', () => {
    const r = resolveLocation(null);
    expect(r.method).toBe('unresolved');
    expect(r.suburb).toBeNull();
  });
});

describe('distanceFromCentre', () => {
  it('is null when the location could not be resolved', () => {
    expect(distanceFromCentre(CENTRE, resolveLocation('Nowhereville'))).toBeNull();
  });

  it('puts Werribee inside a 50km radius', () => {
    const d = distanceFromCentre(CENTRE, resolveLocation('Werribee VIC 3030'));
    expect(d).not.toBeNull();
    expect(d!).toBeLessThan(50);
  });

  it('puts Geelong outside a 50km radius of the CBD', () => {
    const d = distanceFromCentre(CENTRE, resolveLocation('Geelong VIC 3220'));
    expect(d!).toBeGreaterThan(50);
  });

  it('puts Ballarat outside a 50km radius', () => {
    const d = distanceFromCentre(CENTRE, resolveLocation('Ballarat VIC 3350'));
    expect(d!).toBeGreaterThan(50);
  });

  it('puts outer eastern suburbs like Lilydale inside the radius', () => {
    const d = distanceFromCentre(CENTRE, resolveLocation('Lilydale VIC 3140'));
    expect(d!).toBeLessThan(50);
  });

  it('gives a completely different answer from a different centre point', () => {
    // The centre is configuration, not a constant, and moving it inverts which
    // places are in range. From the CBD, Lilydale is in and Geelong is out.
    // From an outer western suburb the reverse holds — Geelong comes within
    // 50km and Lilydale drops out. Worth asserting, because "50km of Melbourne"
    // sounds like it means one fixed thing and does not.
    const west = { lat: -37.9, lng: 144.6614 }; // Werribee
    const geelong = resolveLocation('Geelong VIC 3220');
    const lilydale = resolveLocation('Lilydale VIC 3140');

    expect(distanceFromCentre(CENTRE, geelong)!).toBeGreaterThan(50);
    expect(distanceFromCentre(west, geelong)!).toBeLessThan(50);

    expect(distanceFromCentre(CENTRE, lilydale)!).toBeLessThan(50);
    expect(distanceFromCentre(west, lilydale)!).toBeGreaterThan(50);
  });

  it('puts Sydney far outside', () => {
    const d = distanceFromCentre(CENTRE, resolveLocation('Sydney, New South Wales'));
    expect(d!).toBeGreaterThan(700);
  });
});

describe('hasAustralianSignal', () => {
  // This exists because a Jooble API key turned out to be bound to the US
  // region: searching "Melbourne" returned Melbourne, FLORIDA. Those resolve
  // to no suburb, so keep_unknown_location would have passed every one.
  it('rejects US locations that share a name with Australian ones', () => {
    expect(hasAustralianSignal('Melbourne, FL')).toBe(false);
    expect(hasAustralianSignal('Palm Bay, FL')).toBe(false);
    expect(hasAustralianSignal('Arizona')).toBe(false);
    expect(hasAustralianSignal('Remote')).toBe(false);
  });

  it('accepts an Australian state abbreviation or name', () => {
    expect(hasAustralianSignal('Werribee VIC')).toBe(true);
    expect(hasAustralianSignal('Somewhere, Victoria')).toBe(true);
    expect(hasAustralianSignal('Nowhereville, New South Wales')).toBe(true);
  });

  it('accepts an explicit country', () => {
    expect(hasAustralianSignal('Melbourne, Australia')).toBe(true);
    expect(hasAustralianSignal('Australian Capital Territory')).toBe(true);
  });

  it('accepts a bare 4-digit postcode but not a 5-digit US ZIP', () => {
    expect(hasAustralianSignal('Werribee 3030')).toBe(true);
    expect(hasAustralianSignal('Melbourne 32901')).toBe(false);
  });

  it('rejects a null or empty location', () => {
    expect(hasAustralianSignal(null)).toBe(false);
    expect(hasAustralianSignal('')).toBe(false);
  });
});

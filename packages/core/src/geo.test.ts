import { describe, expect, it } from 'vitest';
import { distanceFromCentre, haversineKm, resolveLocation } from './geo';

const HOPPERS = { lat: -37.8829, lng: 144.7003 };

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(HOPPERS, HOPPERS)).toBe(0);
  });

  it('matches a known distance: Hoppers Crossing to Melbourne CBD (~25km)', () => {
    const cbd = { lat: -37.8136, lng: 144.9631 };
    expect(haversineKm(HOPPERS, cbd)).toBeGreaterThan(23);
    expect(haversineKm(HOPPERS, cbd)).toBeLessThan(27);
  });

  it('is symmetric', () => {
    const cbd = { lat: -37.8136, lng: 144.9631 };
    expect(haversineKm(HOPPERS, cbd)).toBeCloseTo(haversineKm(cbd, HOPPERS), 6);
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

  it('resolves 3029 to Hoppers Crossing, the search centre', () => {
    // 3029 also covers Tarneit and Truganina; Hoppers Crossing is listed first
    // in the gazetteer precisely so it wins this lookup.
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
    expect(distanceFromCentre(HOPPERS, resolveLocation('Nowhereville'))).toBeNull();
  });

  it('puts Werribee comfortably inside a 50km radius', () => {
    const d = distanceFromCentre(HOPPERS, resolveLocation('Werribee VIC 3030'));
    expect(d).not.toBeNull();
    expect(d!).toBeLessThan(10);
  });

  it('puts Geelong INSIDE a 50km radius, which is easy to get wrong', () => {
    // Hoppers Crossing is far enough west that Geelong (42km) is closer than
    // several eastern Melbourne suburbs. Worth an explicit test because the
    // intuition "Geelong is a different city, so it must be out of range" is
    // wrong for this particular centre point.
    const d = distanceFromCentre(HOPPERS, resolveLocation('Geelong VIC 3220'));
    expect(d!).toBeLessThan(50);
  });

  it('puts Ballarat outside a 50km radius', () => {
    const d = distanceFromCentre(HOPPERS, resolveLocation('Ballarat VIC 3350'));
    expect(d!).toBeGreaterThan(50);
  });

  it('puts eastern suburbs like Lilydale outside the radius', () => {
    // The flip side of the same geometry: a real Melbourne job in Lilydale is
    // further from the centre point than Geelong is.
    const d = distanceFromCentre(HOPPERS, resolveLocation('Lilydale VIC 3140'));
    expect(d!).toBeGreaterThan(50);
  });

  it('puts Sydney far outside', () => {
    const d = distanceFromCentre(HOPPERS, resolveLocation('Sydney, New South Wales'));
    expect(d!).toBeGreaterThan(700);
  });
});

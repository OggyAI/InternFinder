import { MELBOURNE_SUBURBS, SUBURB_ALIASES, type SuburbEntry } from './data/melbourne-suburbs';

/** Mean Earth radius in km. */
const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in km. Haversine is accurate to well under 1% at these
 * distances, which is far tighter than the suburb-centroid error already in
 * the input, so there is no reason to reach for Vincenty here.
 */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// ---------- Lookup indexes (built once at module load) ----------------------

const byName = new Map<string, SuburbEntry>();
const byPostcode = new Map<string, SuburbEntry>();

for (const entry of MELBOURNE_SUBURBS) {
  const key = normaliseName(entry.name);
  if (!byName.has(key)) byName.set(key, entry);
  for (const pc of entry.postcodes) {
    // First entry wins: 3029 covers Hoppers Crossing, Tarneit and Truganina,
    // and Hoppers Crossing is listed first because it is the search centre.
    if (!byPostcode.has(pc)) byPostcode.set(pc, entry);
  }
}

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AU_STATES = ['VIC', 'NSW', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

export interface ResolvedLocation {
  suburb: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  /** How the match was made — useful when auditing why something was kept. */
  method: 'coordinates' | 'postcode' | 'suburb' | 'alias' | 'unresolved';
}

/**
 * Turn whatever a provider gave us into coordinates.
 *
 * Providers hand us things like:
 *   "Hoppers Crossing, Wyndham, Melbourne, Victoria"   (Adzuna)
 *   "Werribee VIC 3030"                                 (Jooble)
 *   "Melbourne"                                         (both)
 *
 * Strategy, cheapest and most reliable first:
 *  1. Coordinates the provider supplied — always trust these over any text.
 *  2. A 4-digit postcode in the string.
 *  3. Any comma-separated segment that names a known suburb.
 *  4. An alias phrase like "cbd & inner suburbs".
 *
 * Unresolved is a legitimate outcome, not a failure. The caller decides via
 * filters.keep_unknown_location whether to keep the listing anyway.
 */
export function resolveLocation(
  locationRaw: string | null | undefined,
  providedLat?: number | null,
  providedLng?: number | null,
): ResolvedLocation {
  const state = extractState(locationRaw);

  // 1. Provider coordinates win outright.
  if (typeof providedLat === 'number' && typeof providedLng === 'number') {
    return {
      suburb: locationRaw ? firstSegment(locationRaw) : null,
      state,
      lat: providedLat,
      lng: providedLng,
      method: 'coordinates',
    };
  }

  if (!locationRaw) {
    return { suburb: null, state: null, lat: null, lng: null, method: 'unresolved' };
  }

  // 2. Postcode.
  const postcode = locationRaw.match(/\b(\d{4})\b/)?.[1];
  if (postcode) {
    const hit = byPostcode.get(postcode);
    if (hit) {
      return { suburb: hit.name, state: hit.state, lat: hit.lat, lng: hit.lng, method: 'postcode' };
    }
  }

  // 3. Named suburb, checking each comma-separated segment IN ORDER.
  //    Both providers write location strings most-specific-first:
  //      "Footscray, Maribyrnong, Victoria"  (suburb, council, state)
  //      "Docklands, Melbourne"              (suburb, city)
  //    so the first segment that names a known locality is the right answer.
  //    Do not sort these — an earlier attempt ordered by length, which picked
  //    the council ("Maribyrnong") over the suburb ("Footscray").
  const segments = locationRaw
    .split(/[,/|]/)
    .map((s) => normaliseName(stripStateAndPostcode(s)))
    .filter(Boolean);

  for (const seg of segments) {
    const hit = byName.get(seg);
    if (hit) {
      return { suburb: hit.name, state: hit.state, lat: hit.lat, lng: hit.lng, method: 'suburb' };
    }
  }

  // 4. Alias phrases.
  const whole = normaliseName(locationRaw);
  const aliasKey = SUBURB_ALIASES[whole] ?? segments.map((s) => SUBURB_ALIASES[s]).find(Boolean);
  if (aliasKey) {
    const hit = byName.get(normaliseName(aliasKey));
    if (hit) {
      return { suburb: hit.name, state: hit.state, lat: hit.lat, lng: hit.lng, method: 'alias' };
    }
  }

  return { suburb: firstSegment(locationRaw), state, lat: null, lng: null, method: 'unresolved' };
}

function firstSegment(s: string): string | null {
  const seg = s.split(/[,/|]/)[0];
  return seg ? stripStateAndPostcode(seg).trim() || null : null;
}

function stripStateAndPostcode(s: string): string {
  return s.replace(/\b\d{4}\b/g, '').replace(new RegExp(`\\b(${AU_STATES.join('|')})\\b`, 'gi'), '');
}

function extractState(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(new RegExp(`\\b(${AU_STATES.join('|')})\\b`, 'i'));
  if (m?.[1]) return m[1].toUpperCase();
  if (/\bvictoria\b/i.test(s)) return 'VIC';
  if (/\bnew south wales\b/i.test(s)) return 'NSW';
  if (/\bqueensland\b/i.test(s)) return 'QLD';
  return null;
}

/**
 * Does this location string look Australian at all?
 *
 * Exists because a Jooble API key turned out to be bound to the US region:
 * searching "Melbourne" returned Melbourne, FLORIDA. Those listings resolve to
 * no suburb, so distance_km is null, and `keep_unknown_location` — which is on
 * by default, correctly, so we don't silently drop suburbs missing from the
 * gazetteer — would have passed every single one.
 *
 * An unresolved location is only tolerable when it is plausibly local. This is
 * the difference between "a Melbourne suburb we haven't catalogued" and
 * "another continent".
 *
 * Deliberately generous: any state name or abbreviation, the word Australia,
 * or a bare 4-digit postcode (US ZIPs are 5). A local listing that says none
 * of those is rare; a foreign one that says one of them is rarer still.
 */
export function hasAustralianSignal(locationRaw: string | null | undefined): boolean {
  if (!locationRaw) return false;
  if (extractState(locationRaw) !== null) return true;
  // Prefix boundary only, so "Australian Capital Territory" counts too.
  // Leading boundary only, so "Australian Capital Territory" counts too.
  if (/\baustralia/i.test(locationRaw)) return true;
  // A 4-digit token, not part of a longer number. Australian postcodes are
  // 0800-7999; US ZIP codes are five digits and will not match.
  return /(?<!\d)\d{4}(?!\d)/.test(locationRaw);
}

/**
 * Distance from a filter's centre to a listing, or null when the listing's
 * location could not be resolved.
 */
export function distanceFromCentre(
  centre: { lat: number; lng: number },
  loc: ResolvedLocation,
): number | null {
  if (loc.lat === null || loc.lng === null) return null;
  return Number(haversineKm(centre, { lat: loc.lat, lng: loc.lng }).toFixed(2));
}

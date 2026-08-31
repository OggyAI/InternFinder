import { haversineKm } from './geo';

/**
 * Near-duplicate detection.
 *
 * `content_fingerprint` (title + company) finds candidates, but it is not on
 * its own a duplicate test, and the live data shows exactly why:
 *
 *   [3x] "Senior Engineer" — Halcyon Knights
 *        Melbourne CBD, posted 22 / 27 / 30 August
 *        -> ONE job. A recruiter refreshing the same ad weekly.
 *
 *   [3x] "Service Desk Engineer" — GPK Group
 *        Dandenong East / Knoxfield / Frankston East, all posted 10 August
 *        -> THREE jobs. Same role, three sites, three applications.
 *
 *   [2x] "Cyber Security Engineer" — Myer
 *        West Melbourne / Docklands, both posted 28 August
 *        -> ONE job. Those suburbs are ~1.5km apart; the provider geocoded
 *           the same vacancy to two nearby points.
 *
 * So the test is fingerprint AND proximity: same title, same company, and
 * close enough together to be the same physical vacancy. Distance separates
 * "re-posted" from "also hiring in Frankston", which a date comparison cannot
 * — the GPK listings share a posting date and the Halcyon ones do not.
 */

/** Two listings this close are treated as the same vacancy. Chosen from the
 *  data: it merges Myer's West Melbourne/Docklands pair (~1.5km) while keeping
 *  GPK's Dandenong/Knoxfield/Frankston listings (15km+) separate. */
export const DUPLICATE_RADIUS_KM = 5;

export interface DedupableListing {
  id: string;
  contentFingerprint: string;
  latitude: number | null;
  longitude: number | null;
  locationSuburb: string | null;
  /** Earliest sighting. The oldest listing in a cluster becomes the canonical
   *  one, because it is the row that may already carry a status — applied,
   *  dismissed — and promoting a newer copy would lose that decision and
   *  re-notify about a job already dealt with. */
  firstSeenAt: string;
}

/**
 * Map every listing to its canonical listing id.
 *
 * A listing that is its own canonical (the survivor of its cluster, or a
 * listing with no duplicates) maps to null — meaning `duplicate_of` stays
 * null, which is what marks it as the one to act on.
 */
export function resolveDuplicates(
  listings: DedupableListing[],
  radiusKm = DUPLICATE_RADIUS_KM,
): Map<string, string | null> {
  const result = new Map<string, string | null>();

  const byFingerprint = new Map<string, DedupableListing[]>();
  for (const l of listings) {
    const group = byFingerprint.get(l.contentFingerprint) ?? [];
    group.push(l);
    byFingerprint.set(l.contentFingerprint, group);
  }

  for (const group of byFingerprint.values()) {
    if (group.length === 1) {
      result.set(group[0]!.id, null);
      continue;
    }

    // Oldest first, so the canonical of each cluster is the earliest sighting.
    const ordered = [...group].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));

    // Single-link clustering: a listing joins a cluster if it is close to ANY
    // member. Chaining is the right behaviour here — three sightings of one
    // job drifting a couple of kilometres apart are still one job.
    const clusters: DedupableListing[][] = [];
    for (const listing of ordered) {
      const target = clusters.find((c) => c.some((m) => sameVacancy(m, listing, radiusKm)));
      if (target) target.push(listing);
      else clusters.push([listing]);
    }

    for (const cluster of clusters) {
      const canonical = cluster[0]!;
      result.set(canonical.id, null);
      for (const dup of cluster.slice(1)) result.set(dup.id, canonical.id);
    }
  }

  return result;
}

/** Same vacancy? Requires the fingerprint to already match. */
function sameVacancy(a: DedupableListing, b: DedupableListing, radiusKm: number): boolean {
  const aHasCoords = a.latitude !== null && a.longitude !== null;
  const bHasCoords = b.latitude !== null && b.longitude !== null;

  if (aHasCoords && bHasCoords) {
    const km = haversineKm(
      { lat: a.latitude!, lng: a.longitude! },
      { lat: b.latitude!, lng: b.longitude! },
    );
    return km <= radiusKm;
  }

  // Without coordinates, fall back to the resolved suburb. Two listings that
  // name the same suburb are as close as we can establish they are.
  if (a.locationSuburb && b.locationSuburb) {
    return a.locationSuburb.toLowerCase() === b.locationSuburb.toLowerCase();
  }

  // One or both unplaceable. Treat as DISTINCT rather than merging on the
  // fingerprint alone — wrongly merging hides a real job permanently, whereas
  // wrongly keeping one costs a duplicate notification. The cheaper mistake
  // is the recoverable one.
  return false;
}

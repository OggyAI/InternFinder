import {
  getServiceClient,
  log,
  resolveDuplicates,
  type DedupableListing,
} from '@intern-finder/core';

/**
 * Re-derive `duplicate_of` across the whole table.
 *
 * Deliberately a whole-table pass rather than something ingest does per batch.
 * A recruiter re-posting the same ad a week later produces a listing whose
 * twin is in the DATABASE, not in the current batch, so batch-local detection
 * would miss exactly the case that motivated this. At a few thousand rows the
 * full pass costs one read and a handful of writes, which is cheaper than the
 * per-listing lookup the batch-local version would need anyway.
 *
 * Idempotent: it recomputes from scratch every time, so a changed radius or a
 * fixed clustering bug is picked up by re-running rather than needing a
 * migration.
 */

export interface DedupeStats {
  examined: number;
  duplicates: number;
  changed: number;
}

interface Row {
  id: string;
  content_fingerprint: string;
  latitude: number | null;
  longitude: number | null;
  location_suburb: string | null;
  first_seen_at: string;
  duplicate_of: string | null;
}

export async function runDedupePass(dryRun = false): Promise<DedupeStats> {
  const db = getServiceClient();
  const stats: DedupeStats = { examined: 0, duplicates: 0, changed: 0 };

  const PAGE = 1000;
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('job_listings')
      .select('id,content_fingerprint,latitude,longitude,location_suburb,first_seen_at,duplicate_of')
      .order('id')
      .range(offset, offset + PAGE - 1);
    if (error) {
      // The column only exists after the duplicate-marking migration. Treat a
      // missing column as "not enabled yet" rather than failing the poll cycle.
      if (/duplicate_of/.test(error.message)) {
        log.warn('dedupe: duplicate_of column missing — apply 20260831030000_duplicate_marking.sql');
        return stats;
      }
      throw new Error(`dedupe read failed: ${error.message}`);
    }
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  stats.examined = rows.length;
  if (rows.length === 0) return stats;

  const dedupable: DedupableListing[] = rows.map((r) => ({
    id: r.id,
    contentFingerprint: r.content_fingerprint,
    latitude: r.latitude,
    longitude: r.longitude,
    locationSuburb: r.location_suburb,
    firstSeenAt: r.first_seen_at,
  }));

  const resolved = resolveDuplicates(dedupable);

  // Only write rows whose answer actually changed. Most runs change nothing,
  // and rewriting every row would churn updated_at and the write budget for
  // no reason.
  const changes: { id: string; duplicate_of: string | null }[] = [];
  for (const row of rows) {
    const canonical = resolved.get(row.id) ?? null;
    if (canonical !== null) stats.duplicates++;
    if (canonical !== row.duplicate_of) changes.push({ id: row.id, duplicate_of: canonical });
  }
  stats.changed = changes.length;

  if (dryRun || changes.length === 0) return stats;

  const CONCURRENCY = 8;
  for (let i = 0; i < changes.length; i += CONCURRENCY) {
    const slice = changes.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      slice.map(({ id, duplicate_of }) =>
        db.from('job_listings').update({ duplicate_of }).eq('id', id),
      ),
    );
    const failure = settled.find((r) => r.error);
    if (failure?.error) throw new Error(`dedupe write failed: ${failure.error.message}`);
  }

  return stats;
}

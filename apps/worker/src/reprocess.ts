import {
  getServiceClient,
  loadActiveFilter,
  log,
  prefilterBatch,
  type NormalizedListing,
} from '@intern-finder/core';

/**
 * `npm run reprocess` — re-run the pre-filter over listings already stored.
 *
 * The whole premise of this project is that criteria are editable at runtime.
 * That is hollow if editing a keyword only affects listings fetched *after*
 * the edit: widen the radius and the listings you already rejected for being
 * too far stay rejected forever, sitting in the table with a stale reason.
 *
 * This rebuilds each listing from the columns we stored — no `raw_json`
 * re-parsing, because the normalisers already did that work and their output
 * is what the columns hold — re-runs the current criteria over it, and writes
 * back status, reasons, signals and multiplier.
 *
 * Costs nothing: zero API calls, one read and one batched write. Run it after
 * any change to filters, filter_keywords or filter_preferences.
 *
 *   npm run reprocess              apply and write
 *   npm run reprocess -- --dry-run report the delta, change nothing
 */

const dryRun = process.argv.includes('--dry-run');

interface StoredRow {
  id: string;
  source: string;
  source_id: string | null;
  url: string;
  title: string;
  company: string | null;
  description: string | null;
  location_raw: string | null;
  latitude: number | null;
  longitude: number | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_is_predicted: boolean;
  posted_date: string | null;
  commitment: string;
  provider_matched_term: string | null;
  prefilter_status: string;
}

/** Rebuild the adapter's output from the stored columns. */
function toListing(row: StoredRow): NormalizedListing {
  return {
    source: row.source as NormalizedListing['source'],
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    company: row.company,
    description: row.description,
    locationRaw: row.location_raw,
    latitude: row.latitude,
    longitude: row.longitude,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryIsPredicted: row.salary_is_predicted,
    postedDate: row.posted_date ? new Date(row.posted_date) : null,
    providerMatchedTerm: row.provider_matched_term,
    // The stored commitment came from the provider hint where there was one.
    // Re-supplying it keeps a re-run from silently downgrading to text
    // sniffing and producing a different answer than the original ingest.
    providerHints:
      row.commitment !== 'unknown'
        ? { commitment: row.commitment as NonNullable<NormalizedListing['providerHints']['commitment']> }
        : {},
    raw: {},
  };
}

async function main(): Promise<void> {
  const db = getServiceClient();
  const filterSet = await loadActiveFilter();
  log.info(
    `reprocessing against "${filterSet.filter.name}": ` +
      `${filterSet.filter.radius_km}km of ${filterSet.filter.center_label}`,
  );

  const PAGE = 1000;
  let offset = 0;
  let seen = 0;
  let flipped = { toPassed: 0, toRejected: 0, unchanged: 0 };
  const reasons: Record<string, number> = {};

  for (;;) {
    const { data, error } = await db
      .from('job_listings')
      .select(
        'id,source,source_id,url,title,company,description,location_raw,latitude,longitude,salary_min,salary_max,salary_is_predicted,posted_date,commitment,provider_matched_term,prefilter_status',
      )
      .order('id')
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as StoredRow[];
    if (rows.length === 0) break;

    const listings = rows.map(toListing);
    const results = prefilterBatch(listings, filterSet);

    const updates = rows.map((row, i) => {
      const r = results[i]!;
      if (r.status === row.prefilter_status) flipped.unchanged++;
      else if (r.status === 'passed') flipped.toPassed++;
      else flipped.toRejected++;

      for (const reason of r.reasons) {
        const key = reason.split(':')[0]!.trim();
        reasons[key] = (reasons[key] ?? 0) + 1;
      }

      return {
        id: row.id,
        prefilter_status: r.status,
        prefilter_reasons: r.reasons,
        preference_multiplier: r.preferenceMultiplier,
        distance_km: r.distanceKm,
        location_suburb: r.suburb,
        location_state: r.state,
        compensation: r.signals.compensation,
        work_mode: r.signals.workMode,
        commitment: r.signals.commitment,
        role_type: r.signals.roleType,
        duration_weeks: r.signals.durationWeeks,
      };
    });

    if (!dryRun) {
      // upsert on the primary key updates in place; every row already exists.
      const { error: writeError } = await db.from('job_listings').upsert(updates);
      if (writeError) throw new Error(`write failed: ${writeError.message}`);
    }

    seen += rows.length;
    offset += PAGE;
    if (rows.length < PAGE) break;
  }

  log.info(
    `${seen} listings ${dryRun ? 'evaluated (nothing written)' : 'reprocessed'} — ` +
      `${flipped.toPassed} now pass, ${flipped.toRejected} now rejected, ${flipped.unchanged} unchanged`,
  );
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  if (top.length) log.info(`rejections — ${top.map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

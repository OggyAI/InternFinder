import {
  canonicalizeUrl,
  contentFingerprint,
  dedupeHash,
  getServiceClient,
  log,
  prefilterBatch,
  type FilterSet,
  type NormalizedListing,
  type PrefilterResult,
} from '@intern-finder/core';

/**
 * Ingest: normalised listings in, rows in `job_listings` out.
 *
 * Order of operations matters here.
 *
 *  1. Dedupe WITHIN the batch first. A single poll issues several keyword
 *     queries, and "Cyber Security" and "SOC Analyst" will both return the
 *     same SOC internship. Collapsing these locally avoids sending the same
 *     row to Postgres twice in one upsert, which PostgreSQL rejects outright
 *     ("ON CONFLICT DO UPDATE command cannot affect row a second time").
 *
 *  2. Pre-filter, so the status is written in the same round-trip as the row.
 *
 *  3. Upsert on dedupe_hash. `first_seen_at` and `created_at` are deliberately
 *     absent from the payload so that re-seeing a listing updates it without
 *     rewriting when we first found it.
 *
 * Re-running ingest re-evaluates the pre-filter against the CURRENT criteria,
 * which is what makes an edited keyword take effect on already-stored rows.
 */

export interface IngestStats {
  fetched: number;
  duplicatesInBatch: number;
  crossSourceCandidates: number;
  passed: number;
  rejected: number;
  written: number;
  rejectionReasons: Record<string, number>;
  /**
   * How passing listings cleared the include-keyword gate. A high 'provider'
   * share means the gate is mostly rubber-stamping the query that fetched the
   * listing, i.e. it is no longer reducing volume - which matters because the
   * pre-filter's pass rate is a direct Phase 2 cost driver.
   */
  keywordMatchSource: Record<string, number>;
}

export interface IngestOptions {
  dryRun?: boolean;
  now?: Date;
}

interface PreparedRow {
  listing: NormalizedListing;
  result: PrefilterResult;
  row: Record<string, unknown>;
}

export async function ingest(
  listings: NormalizedListing[],
  filterSet: FilterSet,
  options: IngestOptions = {},
): Promise<IngestStats> {
  const now = options.now ?? new Date();

  // --- 1. Within-batch dedupe ---------------------------------------------
  const byHash = new Map<string, NormalizedListing>();
  let duplicatesInBatch = 0;
  for (const listing of listings) {
    const hash = dedupeHash(listing.url);
    if (byHash.has(hash)) {
      duplicatesInBatch++;
      continue;
    }
    byHash.set(hash, listing);
  }
  const unique = [...byHash.entries()];

  // --- 2. Pre-filter -------------------------------------------------------
  const results = prefilterBatch(
    unique.map(([, l]) => l),
    filterSet,
    { now },
  );

  const prepared: PreparedRow[] = unique.map(([hash, listing], i) => {
    const result = results[i]!;
    const fingerprint = contentFingerprint(listing.title, listing.company);
    return {
      listing,
      result,
      row: {
        source: listing.source,
        source_id: listing.sourceId,
        url: listing.url,
        url_canonical: canonicalizeUrl(listing.url),
        dedupe_hash: hash,
        content_fingerprint: fingerprint,
        title: listing.title,
        company: listing.company,
        description: listing.description,
        location_raw: listing.locationRaw,
        location_suburb: result.suburb,
        location_state: result.state,
        latitude: listing.latitude,
        longitude: listing.longitude,
        distance_km: result.distanceKm,
        salary_min: listing.salaryMin,
        salary_max: listing.salaryMax,
        salary_is_predicted: listing.salaryIsPredicted,
        posted_date: listing.postedDate?.toISOString() ?? null,
        compensation: result.signals.compensation,
        work_mode: result.signals.workMode,
        commitment: result.signals.commitment,
        role_type: result.signals.roleType,
        duration_weeks: result.signals.durationWeeks,
        provider_matched_term: listing.providerMatchedTerm,
        raw_json: listing.raw,
        prefilter_status: result.status,
        prefilter_reasons: result.reasons,
        preference_multiplier: result.preferenceMultiplier,
        last_seen_at: now.toISOString(),
      },
    };
  });

  // Same job under two different URLs — flagged, never dropped.
  const fingerprints = new Map<string, number>();
  for (const p of prepared) {
    const fp = p.row.content_fingerprint as string;
    fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1);
  }
  const crossSourceCandidates = [...fingerprints.values()].filter((n) => n > 1).length;

  // --- 3. Stats ------------------------------------------------------------
  const rejectionReasons: Record<string, number> = {};
  for (const p of prepared) {
    for (const reason of p.result.reasons) {
      // Bucket by reason type, dropping the specific detail after the colon,
      // so "out_of_radius: 71km..." and "out_of_radius: 84km..." aggregate.
      const key = reason.split(':')[0]!.trim();
      rejectionReasons[key] = (rejectionReasons[key] ?? 0) + 1;
    }
  }

  const keywordMatchSource: Record<string, number> = {};
  for (const p of prepared) {
    if (p.result.status !== 'passed') continue;
    const k = p.result.keywordMatchSource;
    keywordMatchSource[k] = (keywordMatchSource[k] ?? 0) + 1;
  }

  const passed = prepared.filter((p) => p.result.status === 'passed').length;
  const stats: IngestStats = {
    fetched: listings.length,
    duplicatesInBatch,
    crossSourceCandidates,
    passed,
    rejected: prepared.length - passed,
    written: 0,
    rejectionReasons,
    keywordMatchSource,
  };

  if (options.dryRun) {
    printDryRun(prepared);
    return stats;
  }

  // --- 4. Upsert -----------------------------------------------------------
  if (prepared.length === 0) return stats;

  const db = getServiceClient();
  // Chunked so one poll of several hundred listings doesn't build a single
  // oversized request body.
  const CHUNK = 200;
  for (let i = 0; i < prepared.length; i += CHUNK) {
    const chunk = prepared.slice(i, i + CHUNK).map((p) => p.row);
    const { error, count } = await db
      .from('job_listings')
      .upsert(chunk, { onConflict: 'dedupe_hash', count: 'exact' });

    if (error) throw new Error(`Failed to upsert job_listings: ${error.message}`);
    stats.written += count ?? chunk.length;
  }

  return stats;
}

function printDryRun(prepared: PreparedRow[]): void {
  log.info(`--- DRY RUN: ${prepared.length} unique listings, nothing written ---`);
  const sorted = [...prepared].sort((a, b) => {
    if (a.result.status !== b.result.status) return a.result.status === 'passed' ? -1 : 1;
    return b.result.preferenceMultiplier - a.result.preferenceMultiplier;
  });

  for (const p of sorted) {
    const { result, listing } = p;
    const mark = result.status === 'passed' ? 'PASS' : 'DROP';
    const dist = result.distanceKm === null ? ' ?km' : `${String(result.distanceKm).padStart(5)}km`;
    log.info(
      `${mark} x${result.preferenceMultiplier.toFixed(2)} ${dist}  ${listing.title} — ${listing.company ?? 'unknown'} [${listing.source}]`,
    );
    log.info(
      `       ${result.signals.compensation}/${result.signals.workMode}/${result.signals.commitment}/${result.signals.roleType}` +
        (result.signals.durationWeeks !== null ? ` ~${result.signals.durationWeeks}w` : '') +
        (result.matchedKeywords.length ? `  kw: ${result.matchedKeywords.slice(0, 4).join(', ')}` : ''),
    );
    for (const reason of result.reasons) log.info(`       ! ${reason}`);
  }
}

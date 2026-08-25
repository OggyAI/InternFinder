import { log, prefilterBatch, type NormalizedListing } from '@intern-finder/core';
import { makeTestFilterSet } from '@intern-finder/core/testing';
import { AdzunaResponse, normalizeAdzunaJob } from './sources/adzuna';
import { JoobleResponse, normalizeJoobleJob } from './sources/jooble';
import adzunaFixture from './fixtures/adzuna.sample.json' with { type: 'json' };
import joobleFixture from './fixtures/jooble.sample.json' with { type: 'json' };

/**
 * `npm run demo` — the whole Phase 1 pipeline with no credentials at all.
 *
 * The real worker reads its criteria from Supabase, which is the correct
 * design (filters must be editable without a redeploy) but means it cannot run
 * before the schema is applied. This script substitutes the mirrored seed
 * criteria from @intern-finder/core/testing so the parse -> normalise ->
 * pre-filter -> rank chain can be seen working on a bare checkout.
 *
 * It is a demo, not the production path: nothing here writes to a database and
 * nothing here talks to Adzuna or Jooble.
 */

function load(): NormalizedListing[] {
  const adzuna = AdzunaResponse.parse(adzunaFixture)
    .results.map(normalizeAdzunaJob)
    .filter((l): l is NormalizedListing => l !== null);
  const jooble = JoobleResponse.parse(joobleFixture)
    .jobs.map(normalizeJoobleJob)
    .filter((l): l is NormalizedListing => l !== null);
  return [...adzuna, ...jooble];
}

const filterSet = makeTestFilterSet();
const listings = load();
const results = prefilterBatch(listings, filterSet);

const rows = listings
  .map((l, i) => ({ l, r: results[i]! }))
  .sort((a, b) => {
    if (a.r.status !== b.r.status) return a.r.status === 'passed' ? -1 : 1;
    return b.r.preferenceMultiplier - a.r.preferenceMultiplier;
  });

log.info(
  `filter "${filterSet.filter.name}" — ${filterSet.filter.radius_km}km of ${filterSet.filter.center_label}`,
);
log.info(`${listings.length} fixture listings from 2 sources\n`);

for (const { l, r } of rows) {
  const mark = r.status === 'passed' ? ' PASS ' : ' DROP ';
  const dist = r.distanceKm === null ? '   ?km' : `${String(r.distanceKm.toFixed(1)).padStart(5)}km`;
  const mult = `x${r.preferenceMultiplier.toFixed(2)}`;
  console.log(`${mark} ${mult} ${dist}  ${l.title}`);
  console.log(
    `              ${l.company ?? 'unknown'} · ${r.suburb ?? l.locationRaw ?? '?'} · [${l.source}]`,
  );
  console.log(
    `              ${r.signals.compensation} / ${r.signals.workMode} / ${r.signals.commitment} / ${r.signals.roleType}` +
      (r.signals.durationWeeks !== null ? ` · ~${r.signals.durationWeeks}w` : ''),
  );
  if (r.matchedKeywords.length) {
    console.log(`              matched: ${r.matchedKeywords.join(', ')}`);
  }
  for (const reason of r.reasons) console.log(`              ! ${reason}`);
  console.log('');
}

const passed = rows.filter((x) => x.r.status === 'passed').length;
log.info(`${passed} passed, ${rows.length - passed} rejected`);
log.info('These are the rows that would reach the Phase 2 scoring queue.');

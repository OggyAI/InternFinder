import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestFilterSet, TEST_FILTER } from './testing';

/**
 * Drift guard.
 *
 * `testing.ts` hand-mirrors the seed migration so unit tests don't need a
 * database. That duplication is only safe if something notices when the two
 * disagree — otherwise the tests keep passing against criteria that no longer
 * match what is actually deployed. This file is that something.
 *
 * It checks values, not structure: every keyword term, preference weight and
 * filter constant used by the tests must literally appear in the migration.
 */

const SEED = readFileSync(
  new URL('../../../supabase/migrations/20260823090100_seed_filters.sql', import.meta.url),
  'utf8',
);

const fs = makeTestFilterSet();

describe('test fixtures match the seed migration', () => {
  it.each(fs.keywords.map((k) => [k.kind, k.term] as const))(
    'seeds the %s keyword "%s"',
    (kind, term) => {
      expect(SEED).toContain(`'${term}'`);
      // The term must appear on a line that also declares the same kind, so a
      // keyword that got reclassified (include -> exclude) is caught too.
      const line = SEED.split('\n').find((l) => l.includes(`'${term}'`) && l.includes(`'${kind}'`));
      expect(line, `"${term}" is not seeded as kind '${kind}'`).toBeDefined();
    },
  );

  it.each(fs.preferences.map((p) => [p.dimension, p.value, p.weight] as const))(
    'seeds %s/%s at weight %s',
    (dimension, value, weight) => {
      const line = SEED.split('\n').find(
        (l) => l.includes(`'${dimension}'`) && l.includes(`'${value}'`),
      );
      expect(line, `no seed row for ${dimension}/${value}`).toBeDefined();
      expect(line).toContain(weight.toFixed(2));
    },
  );

  it('seeds the same centre point and radius', () => {
    expect(SEED).toContain(`'${TEST_FILTER.center_label}'`);
    expect(SEED).toContain(String(TEST_FILTER.center_lat));
    expect(SEED).toContain(String(TEST_FILTER.center_lng));
    expect(SEED).toMatch(new RegExp(`${TEST_FILTER.center_lng},\\s*${TEST_FILTER.radius_km}`));
  });

  it('seeds the same minimum duration', () => {
    expect(SEED).toMatch(new RegExp(`\\n\\s*${TEST_FILTER.min_duration_weeks},\\s*null,`));
  });
});

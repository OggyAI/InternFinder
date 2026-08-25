import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * Every migration, concatenated.
 *
 * Criteria are no longer seeded by one file: later migrations add keywords
 * (the broader IT domain terms), retire them (bare "Vulnerability") and
 * reclassify them (structural, title-scoped). Reading only the original seed
 * made this guard blind to all of that, and it failed as soon as a keyword
 * arrived from a second file.
 */
const MIGRATIONS_DIR = new URL('../../../supabase/migrations/', import.meta.url);
const SEED = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  .join('\n');

const fs = makeTestFilterSet();

describe('test fixtures match the seed migration', () => {
  it.each(fs.keywords.map((k) => [k.kind, k.term] as const))(
    'seeds the %s keyword "%s"',
    (kind, term) => {
      expect(SEED, `"${term}" is not seeded in any migration`).toContain(`'${term}'`);

      // Terms seeded one-per-row carry their kind on the same line, and for
      // those we can check it — that catches a keyword quietly reclassified
      // from include to exclude. Terms seeded by a bulk INSERT ... SELECT get
      // their kind from the enclosing statement instead, so there is no kind
      // on the line and nothing to compare against; presence is all we can
      // assert. Only apply the stricter check where it is meaningful.
      const lines = SEED.split('\n').filter((l) => l.includes(`'${term}'`));
      const KINDS = ["'include'", "'exclude'", "'exclude_work_rights'"];
      const linesDeclaringAKind = lines.filter((l) => KINDS.some((k) => l.includes(k)));

      if (linesDeclaringAKind.length > 0) {
        const matching = linesDeclaringAKind.some((l) => l.includes(`'${kind}'`));
        expect(matching, `"${term}" is seeded, but not as kind '${kind}'`).toBe(true);
      }
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

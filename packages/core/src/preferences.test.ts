import { describe, expect, it } from 'vitest';
import {
  applyMultiplier,
  computePreferenceMultiplier,
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
} from './preferences';
import { makeTestFilterSet } from './testing';
import type { ListingSignals } from './types';

const prefs = makeTestFilterSet().preferences;

function signals(over: Partial<ListingSignals> = {}): ListingSignals {
  return {
    compensation: 'unknown',
    workMode: 'unknown',
    commitment: 'unknown',
    roleType: 'unknown',
    durationWeeks: null,
    ...over,
  };
}

describe('computePreferenceMultiplier', () => {
  it('is neutral when every axis is unknown', () => {
    expect(computePreferenceMultiplier(signals(), prefs).multiplier).toBe(1);
  });

  it('boosts the fully-preferred combination', () => {
    const r = computePreferenceMultiplier(
      signals({
        compensation: 'unpaid',
        workMode: 'onsite',
        commitment: 'part_time',
        roleType: 'internship',
      }),
      prefs,
    );
    expect(r.multiplier).toBe(MULTIPLIER_MAX);
    expect(r.clamped).toBe(true);
  });

  it('demotes the fully non-preferred combination without excluding it', () => {
    const r = computePreferenceMultiplier(
      signals({ compensation: 'paid', workMode: 'remote', commitment: 'full_time' }),
      prefs,
    );
    expect(r.multiplier).toBeLessThan(1);
    // The floor is what stops "ranked lower" from becoming "hidden".
    expect(r.multiplier).toBeGreaterThanOrEqual(MULTIPLIER_MIN);
  });

  it('never returns a multiplier of zero, even with everything against it', () => {
    const r = computePreferenceMultiplier(
      signals({ compensation: 'paid', workMode: 'remote', commitment: 'full_time', roleType: 'job' }),
      prefs,
    );
    expect(r.multiplier).toBeGreaterThan(0);
  });

  it('treats a missing preference row as neutral rather than crashing', () => {
    // Deleting a preference row in the dashboard must weaken that axis, not
    // break the pipeline.
    const r = computePreferenceMultiplier(signals({ workMode: 'onsite' }), []);
    expect(r.multiplier).toBe(1);
  });

  it('reports a per-dimension breakdown', () => {
    const r = computePreferenceMultiplier(signals({ workMode: 'remote' }), prefs);
    const workMode = r.parts.find((p) => p.dimension === 'work_mode');
    expect(workMode).toEqual({ dimension: 'work_mode', value: 'remote', weight: 0.85 });
  });
});

describe('applyMultiplier', () => {
  it('clamps to 100', () => {
    expect(applyMultiplier(90, 1.5)).toBe(100);
  });

  it('rounds to an integer', () => {
    expect(Number.isInteger(applyMultiplier(73, 1.15))).toBe(true);
  });

  it('lets an exceptional non-preferred role outrank a mediocre preferred one', () => {
    // This is the brief's actual requirement: paid/remote/full-time must still
    // be able to win on merit. The bounds are chosen so this holds.
    const exceptionalButNonPreferred = applyMultiplier(95, MULTIPLIER_MIN);
    const mediocreButPreferred = applyMultiplier(45, MULTIPLIER_MAX);
    expect(exceptionalButNonPreferred).toBeGreaterThan(mediocreButPreferred);
  });

  it('still ranks a preferred role above a comparable non-preferred one', () => {
    // The other half of the requirement: the weighting must actually bite when
    // resume fit is similar, otherwise it is decorative.
    expect(applyMultiplier(70, MULTIPLIER_MAX)).toBeGreaterThan(
      applyMultiplier(70, MULTIPLIER_MIN),
    );
  });

  it('keeps the break-even ratio at a level where "exceptional" is achievable', () => {
    // Guards the spread itself. If someone widens the bounds, a non-preferred
    // listing could need an impossible score to ever surface.
    expect(MULTIPLIER_MAX / MULTIPLIER_MIN).toBeLessThanOrEqual(2);
  });
});

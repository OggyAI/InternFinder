import type { FilterPreferenceRow, ListingSignals, PreferenceDimension } from './types';

/**
 * Soft preference weighting.
 *
 * The brief is explicit that this must never exclude: unpaid, in-person and
 * part-time roles are surfaced harder, but a paid, remote, full-time role
 * still appears — just lower — and an exceptional one should be able to climb
 * back above a mediocre "preferred" one.
 *
 * The multiplier is the product of the matching weight on each dimension.
 * Left unbounded that product would swing from 0.85^3 = 0.61 up to
 * 1.35 * 1.30 * 1.30 * 1.20 = 2.74, which is enough to let preferences alone
 * dominate resume fit — a bad outcome, since fit is the thing that actually
 * matters. So the product is clamped.
 */

/**
 * Hard bounds on the combined multiplier.
 *
 * The spread between them is the whole design decision, because it sets how
 * good a non-preferred listing must be to outrank a preferred one. The
 * break-even ratio is MAX/MIN = 1.8, so a paid/remote/full-time role needs
 * roughly 1.8x the resume fit of an unpaid/onsite/part-time one to rank above
 * it: a fit of 95 scores 71 against a fit of 45 scoring 61. That matches the
 * brief — ranked lower, but able to win when the match is exceptional.
 *
 * An earlier [0.7, 1.5] gave a ratio of 2.14, which was too punitive: a 95-fit
 * role lost to a 45-fit one, meaning "exceptional" could never actually win.
 *
 * NOTE ON SATURATION: because the seeded weights multiply, unpaid (1.35) and
 * onsite (1.30) alone already exceed the ceiling, so strongly-preferred
 * listings bunch at 1.35 and lose resolution between each other. That is
 * acceptable — ties at the ceiling are broken by the Phase 2 fit score, which
 * is the thing that should be breaking them.
 */
export const MULTIPLIER_MIN = 0.75;
export const MULTIPLIER_MAX = 1.35;

const DIMENSIONS: PreferenceDimension[] = [
  'compensation',
  'work_mode',
  'commitment',
  'role_type',
];

/**
 * Index preference rows for lookup. Inactive rows are dropped here so callers
 * never have to remember to check is_active.
 */
export function indexPreferences(
  rows: FilterPreferenceRow[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!row.is_active) continue;
    map.set(`${row.dimension}:${row.value}`, row.weight);
  }
  return map;
}

export interface MultiplierBreakdown {
  multiplier: number;
  /** Per-dimension contribution, for showing the user why something ranked where it did. */
  parts: { dimension: PreferenceDimension; value: string; weight: number }[];
  clamped: boolean;
}

export function computePreferenceMultiplier(
  signals: ListingSignals,
  preferences: FilterPreferenceRow[] | Map<string, number>,
): MultiplierBreakdown {
  const index =
    preferences instanceof Map ? preferences : indexPreferences(preferences);

  const values: Record<PreferenceDimension, string> = {
    compensation: signals.compensation,
    work_mode: signals.workMode,
    commitment: signals.commitment,
    role_type: signals.roleType,
  };

  const parts: MultiplierBreakdown['parts'] = [];
  let product = 1;

  for (const dimension of DIMENSIONS) {
    const value = values[dimension];
    // A dimension with no configured row is neutral. This is what makes the
    // table safely editable: deleting a preference row weakens that axis
    // rather than crashing the pipeline.
    const weight = index.get(`${dimension}:${value}`) ?? 1;
    product *= weight;
    parts.push({ dimension, value, weight });
  }

  const raw = product;
  const multiplier = Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, raw));

  return {
    multiplier: Number(multiplier.toFixed(2)),
    parts,
    clamped: multiplier !== Number(raw.toFixed(4)),
  };
}

/**
 * Apply the multiplier to a 0-100 base score.
 * Phase 2 calls this with Claude's fit score; Phase 1 only stores the
 * multiplier itself, since there is no base score yet.
 */
export function applyMultiplier(baseScore: number, multiplier: number): number {
  return Math.max(0, Math.min(100, Math.round(baseScore * multiplier)));
}

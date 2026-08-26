import { describe, expect, it } from 'vitest';
import type { AppSettingsRow } from '@intern-finder/core';
import { scoreBucket, spendAllowance } from './scoring-run';

/**
 * The spend guard is the only thing standing between an unattended worker and
 * an open-ended bill, so it gets tested like it matters.
 */

const NOW = new Date('2026-08-26T12:00:00Z');

function settings(over: Partial<AppSettingsRow> = {}): AppSettingsRow {
  return {
    id: 1,
    is_paused: false,
    notify_score_threshold: 70,
    max_notifications_per_day: 25,
    scoring_enabled: true,
    scoring_batch_size: 8,
    max_scoring_spend_usd_per_cycle: 0.5,
    max_scoring_spend_usd_per_day: 2.0,
    scoring_spend_today: 0,
    // Tomorrow, so the daily window is still open unless a test says otherwise.
    scoring_spend_reset_at: '2026-08-27T00:00:00Z',
    ...over,
  };
}

describe('spendAllowance', () => {
  it('allows the per-cycle ceiling when nothing has been spent', () => {
    const { allowed } = spendAllowance(settings(), NOW);
    expect(allowed).toBe(0.5);
  });

  it('never allows more in one cycle than the cycle ceiling, however much is left today', () => {
    // $2 of daily headroom must not become a $2 cycle. The per-cycle cap is
    // what stops a single surge — a widened keyword list, an Adzuna spike —
    // from scoring the whole database in one go.
    const { allowed } = spendAllowance(settings({ max_scoring_spend_usd_per_day: 100 }), NOW);
    expect(allowed).toBe(0.5);
  });

  it('allows only what is left of the daily budget when that is the tighter limit', () => {
    const { allowed } = spendAllowance(settings({ scoring_spend_today: 1.8 }), NOW);
    expect(allowed).toBeCloseTo(0.2, 6);
  });

  it('allows nothing once the daily budget is spent', () => {
    const { allowed, reason } = spendAllowance(settings({ scoring_spend_today: 2.0 }), NOW);
    expect(allowed).toBe(0);
    expect(reason).toContain('daily scoring budget spent');
  });

  it('allows nothing when the daily budget is overspent', () => {
    // Overshoot is possible by design: the ceiling is checked between batches,
    // so the last batch can carry it past. The guard must not go negative or
    // wrap around into allowing more.
    const { allowed } = spendAllowance(settings({ scoring_spend_today: 2.4 }), NOW);
    expect(allowed).toBe(0);
  });

  it('rolls the daily total over once the reset time has passed', () => {
    const stale = settings({
      scoring_spend_today: 2.0,
      scoring_spend_reset_at: '2026-08-26T00:00:00Z', // earlier today
    });
    const { allowed, spentToday } = spendAllowance(stale, NOW);
    expect(spentToday).toBe(0);
    expect(allowed).toBe(0.5);
  });

  it('treats a zero daily budget as a hard stop', () => {
    const { allowed } = spendAllowance(settings({ max_scoring_spend_usd_per_day: 0 }), NOW);
    expect(allowed).toBe(0);
  });

  it('coerces numeric columns that arrive as strings from PostgREST', () => {
    // numeric(8,4) comes back as a string. Without coercion the arithmetic
    // becomes string concatenation and the ceiling silently stops applying.
    const raw = settings({
      max_scoring_spend_usd_per_cycle: '0.50' as unknown as number,
      scoring_spend_today: '1.90' as unknown as number,
    });
    const { allowed } = spendAllowance(raw, NOW);
    expect(allowed).toBeCloseTo(0.1, 6);
  });
});

describe('scoreBucket', () => {
  it.each([
    [100, '80-100'], [80, '80-100'],
    [79, '70-79'], [70, '70-79'],
    [69, '50-69'], [50, '50-69'],
    [49, '25-49'], [25, '25-49'],
    [24, '0-24'], [0, '0-24'],
  ])('%i -> %s', (score, expected) => {
    expect(scoreBucket(score)).toBe(expected);
  });
});

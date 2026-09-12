import { describe, expect, it } from 'vitest';
import { toNotifiableMatch, type MatchCardRow } from './match-card';

const row: MatchCardRow = {
  id: '3f8e1c22-9a4b-4d1e-8f77-2b6c5d0a1e93',
  fit_score: 100,
  base_score: 88,
  // PostgREST hands numeric columns back as strings.
  preference_multiplier: '1.20',
  category: 'internship',
  compensation: 'unknown',
  work_mode: 'onsite',
  commitment: 'part_time',
  duration_weeks: 12,
  reasoning: 'Direct match.',
  job_listings: {
    title: 'IT Support Intern',
    company: 'Acme',
    location_suburb: 'Footscray',
    distance_km: '8.40',
    url: 'https://example.com/job/1',
    posted_date: '2026-09-01T00:00:00+00:00',
  },
};

describe('toNotifiableMatch', () => {
  it('maps a card row, coercing the numeric strings PostgREST returns', () => {
    const m = toNotifiableMatch(row)!;
    expect(m.matchId).toBe(row.id);
    expect(m.preferenceMultiplier).toBe(1.2);
    expect(m.distanceKm).toBe(8.4);
    expect(m.title).toBe('IT Support Intern');
  });

  it('keeps an unknown distance unknown rather than turning it into 0', () => {
    // Number(null) is 0, which would render "0 km away" for an unplaced job.
    const m = toNotifiableMatch({ ...row, job_listings: { ...row.job_listings!, distance_km: null } })!;
    expect(m.distanceKm).toBeNull();
  });

  it('returns null when the listing join is missing, instead of a half-drawn card', () => {
    expect(toNotifiableMatch({ ...row, job_listings: null })).toBeNull();
  });
});

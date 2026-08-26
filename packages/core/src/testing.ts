import type {
  FilterKeywordRow,
  FilterPreferenceRow,
  FilterRow,
  FilterSet,
  NormalizedListing,
} from './types';

/**
 * Test doubles.
 *
 * `makeTestFilterSet()` mirrors the seed migration
 * (supabase/migrations/20260823090100_seed_filters.sql). It is a subset — only
 * the rows the tests actually exercise — but every value in it must match the
 * migration. `seed-drift.test.ts` asserts exactly that, so this file cannot
 * quietly diverge from the real seed.
 */

let idCounter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

export const TEST_FILTER: FilterRow = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Melbourne — IT & cyber',
  is_active: true,
  center_label: 'Melbourne VIC 3000',
  center_lat: -37.8136,
  center_lng: 144.9631,
  radius_km: 50,
  min_duration_weeks: 6,
  max_duration_weeks: null,
  exclude_sponsorship_required: true,
  max_listing_age_days: 30,
  keep_unknown_location: true,
};

function kw(
  term: string,
  kind: FilterKeywordRow['kind'],
  wholeWord = false,
  weight = 1,
  scope: FilterKeywordRow['match_scope'] = 'text',
): FilterKeywordRow {
  // Mirrors the migration rule: an all-caps initialism matches case-sensitively.
  const caseSensitive = /^[A-Z0-9]{2,6}$/.test(term);
  // Mirrors the migration: these describe a role's shape, not its field.
  const structural = /^(internship|intern|trainee|traineeship|cadet|cadetship|work experience)$/i;
  return {
    id: nextId(),
    term,
    kind,
    weight,
    whole_word: wholeWord,
    case_sensitive: caseSensitive,
    category: structural.test(term) ? 'structural' : 'domain',
    match_scope: scope,
    is_active: true,
  };
}

function pref(
  dimension: FilterPreferenceRow['dimension'],
  value: string,
  weight: number,
): FilterPreferenceRow {
  return { id: nextId(), dimension, value, weight, is_active: true };
}

export function makeTestFilterSet(overrides: Partial<FilterRow> = {}): FilterSet {
  return {
    filter: { ...TEST_FILTER, ...overrides },
    keywords: [
      kw('IT', 'include', true, 1.0),
      kw('Cyber Security', 'include', false, 1.5),
      kw('Information Security', 'include', false, 1.4),
      kw('SOC Analyst', 'include', false, 1.5),
      kw('Blue Team', 'include', false, 1.5),
      kw('IT Support', 'include', false, 1.3),
      kw('Help Desk', 'include', false, 1.2),
      kw('Helpdesk', 'include', false, 1.2),
      kw('Service Desk', 'include', false, 1.2),
      kw('Data Entry', 'include', false, 1.0),
      kw('Internship', 'include', false, 1.25),
      kw('Intern', 'include', true, 1.15),
      kw('Work Experience', 'include', false, 1.1),

      kw('Security Guard', 'exclude'),
      // Title-scoped, mirroring the wrong-domain excludes in the migration.
      kw('Cleaner', 'exclude', false, 1, 'title'),
      kw('Nurse', 'exclude', false, 1, 'title'),
      kw('Security Officer', 'exclude'),
      kw('Crowd Control', 'exclude'),
      kw('Loss Prevention', 'exclude'),

      kw('must be an Australian Citizen', 'exclude_work_rights'),
      kw('Baseline Clearance', 'exclude_work_rights'),
      kw('Graduate Program', 'exclude_work_rights'),
      kw('visa sponsorship', 'exclude_work_rights'),
    ],
    preferences: [
      pref('compensation', 'unpaid', 1.35),
      pref('compensation', 'paid', 1.0),
      pref('compensation', 'unknown', 1.0),
      pref('work_mode', 'onsite', 1.3),
      pref('work_mode', 'hybrid', 1.1),
      pref('work_mode', 'remote', 0.85),
      pref('work_mode', 'unknown', 1.0),
      pref('commitment', 'part_time', 1.3),
      pref('commitment', 'casual', 1.25),
      pref('commitment', 'contract', 1.0),
      pref('commitment', 'full_time', 0.85),
      pref('commitment', 'unknown', 1.0),
      pref('role_type', 'internship', 1.2),
      pref('role_type', 'job', 1.0),
      pref('role_type', 'unknown', 1.0),
    ],
  };
}

export function makeListing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: 'adzuna',
    sourceId: 'test-1',
    url: 'https://example.com/job/1',
    title: 'IT Support Officer',
    company: 'Test Co',
    description: 'A test listing.',
    locationRaw: 'Werribee, Victoria',
    latitude: null,
    longitude: null,
    salaryMin: null,
    salaryMax: null,
    salaryIsPredicted: false,
    postedDate: new Date('2026-08-22T00:00:00Z'),
    providerMatchedTerm: null,
    providerHints: {},
    raw: {},
    ...overrides,
  };
}

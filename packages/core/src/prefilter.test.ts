import { describe, expect, it } from 'vitest';
import { prefilter } from './prefilter';
import { makeListing, makeTestFilterSet } from './testing';

const NOW = new Date('2026-08-23T00:00:00Z');
const fs = makeTestFilterSet();
const run = (over = {}, filterSet = fs) => prefilter(makeListing(over), filterSet, { now: NOW });

/** Reason bucket, ignoring the detail after the colon. */
const buckets = (r: { reasons: string[] }) => r.reasons.map((x) => x.split(':')[0]);

describe('prefilter — passing', () => {
  it('passes an in-radius listing that matches a keyword', () => {
    const r = run({ title: 'IT Support Officer', locationRaw: 'Werribee VIC 3030' });
    expect(r.status).toBe('passed');
    expect(r.reasons).toEqual([]);
    expect(r.matchedKeywords).toContain('IT Support');
  });

  it('passes a listing with no stated duration', () => {
    // Exclusion-only duration filtering: silence is not evidence of a short role,
    // and requiring a positive match would drop almost every real listing.
    const r = run({ title: 'Cyber Security Intern', description: 'Ongoing opportunity.' });
    expect(r.signals.durationWeeks).toBeNull();
    expect(r.status).toBe('passed');
  });

  it('keeps an unresolvable location when keep_unknown_location is true', () => {
    const r = run({ title: 'IT Support', locationRaw: 'Nowhereville, Victoria' });
    expect(r.distanceKm).toBeNull();
    expect(r.status).toBe('passed');
  });
});

describe('prefilter — rejecting', () => {
  it('rejects a listing outside the radius', () => {
    const r = run({ title: 'IT Helpdesk Support', locationRaw: 'Ballarat VIC 3350' });
    expect(buckets(r)).toContain('out_of_radius');
  });

  it('rejects an eastern-suburbs Melbourne role that falls outside the radius', () => {
    // Documents a real consequence of centring on Hoppers Crossing rather than
    // the CBD: Lilydale is 59km away and gets dropped.
    const r = run({ title: 'IT Support Officer', locationRaw: 'Lilydale VIC 3140' });
    expect(buckets(r)).toContain('out_of_radius');
  });

  it('rejects a listing matching no include keyword', () => {
    const r = run({ title: 'Barista', description: 'Weekend cafe work.' });
    expect(buckets(r)).toContain('no_domain_keyword_match');
  });

  it('rejects physical security roles that keyword-match on "security"', () => {
    // The single most important exclude in Australian job search.
    const r = run({
      title: 'Security Guard - Retail Loss Prevention',
      description: 'Crowd control and patrol duties.',
    });
    expect(buckets(r)).toContain('excluded_keyword');
  });

  it('rejects roles requiring work rights a student visa does not confer', () => {
    const r = run({
      title: 'Cyber Security Graduate Program 2027',
      description: 'Applicants must be an Australian Citizen and obtain a Baseline Clearance.',
    });
    expect(buckets(r)).toContain('work_rights');
  });

  it('rejects a listing shorter than the minimum duration', () => {
    const r = run({
      title: 'IT Work Experience Placement',
      description: 'A short 2 week work experience placement.',
    });
    expect(buckets(r)).toContain('too_short');
  });

  it('rejects a listing older than max_listing_age_days', () => {
    const r = run({ title: 'IT Support', postedDate: new Date('2026-06-01T00:00:00Z') });
    expect(buckets(r)).toContain('too_old');
  });

  it('records every reason, not just the first', () => {
    // An over-aggressive filter should be diagnosable from the stored rows.
    const r = run({
      title: 'Security Guard',
      locationRaw: 'Sydney, New South Wales',
      description: 'Crowd control. Must be an Australian Citizen.',
    });
    expect(r.reasons.length).toBeGreaterThan(2);
    expect(buckets(r)).toEqual(expect.arrayContaining(['out_of_radius', 'excluded_keyword', 'work_rights']));
  });
});

describe('prefilter — toggles', () => {
  it('drops unresolvable locations when keep_unknown_location is false', () => {
    const strict = makeTestFilterSet({ keep_unknown_location: false });
    const r = run({ title: 'IT Support', locationRaw: 'Nowhereville, Victoria' }, strict);
    expect(buckets(r)).toContain('location_unresolved');
  });

  it('stops applying work-rights excludes when the toggle is off', () => {
    const relaxed = makeTestFilterSet({ exclude_sponsorship_required: false });
    const r = run(
      {
        title: 'Cyber Security Analyst',
        description: 'Must be an Australian Citizen. Baseline Clearance required.',
      },
      relaxed,
    );
    expect(buckets(r)).not.toContain('work_rights');
  });

  it('honours a widened radius', () => {
    const wide = makeTestFilterSet({ radius_km: 100 });
    const r = run({ title: 'IT Helpdesk Support', locationRaw: 'Ballarat VIC 3350' }, wide);
    expect(buckets(r)).not.toContain('out_of_radius');
  });
});

describe('prefilter — whole_word keyword matching', () => {
  it('does not let bare "IT" match unrelated words', () => {
    // Without a word boundary, "IT" matches security, monitor, editing,
    // recruiting — i.e. it would pass essentially every listing on the board.
    const r = run({
      title: 'Recruiting Coordinator',
      description: 'Monitoring and editing candidate records.',
    });
    expect(r.matchedKeywords).not.toContain('IT');
    expect(buckets(r)).toContain('no_domain_keyword_match');
  });

  it('still matches "IT" as a standalone word', () => {
    const r = run({ title: 'IT Officer', description: 'General IT duties.' });
    expect(r.matchedKeywords).toContain('IT');
  });

  it('does NOT let the keyword "IT" match the English pronoun "it"', () => {
    // The bug that made the first live poll useless. `whole_word` correctly
    // stopped IT matching *security* and *monitor*, but matching was still
    // case-insensitive, so IT matched "it" — a word in essentially every job
    // ad ever written. A Medical Receptionist and a Cocktail Bartender both
    // passed the filter on the strength of it.
    const r = run({
      title: 'Medical Receptionist',
      description: 'We think it is a great role and it suits many people.',
      locationRaw: 'Werribee VIC 3030',
    });
    expect(r.matchedKeywords).not.toContain('IT');
    expect(buckets(r)).toContain('no_domain_keyword_match');
  });

  it('matches "IT" in an all-caps title', () => {
    // Case-sensitive must not mean "misses IT SUPPORT OFFICER", which is how
    // a good share of Australian job ads are written.
    const r = run({ title: 'IT SUPPORT OFFICER', locationRaw: 'Werribee VIC 3030' });
    expect(r.matchedKeywords).toContain('IT');
  });

  it('matches multi-word terms across hyphens', () => {
    const r = run({ title: 'Cyber-Security Analyst', locationRaw: 'Werribee VIC 3030' });
    expect(r.matchedKeywords).toContain('Cyber Security');
  });
});

describe('prefilter — provider keyword match', () => {
  it('accepts a listing the provider matched, even when our text does not', () => {
    // Adzuna full-text searches the whole ad but returns a 500-char teaser.
    // A what_phrase hit proves the phrase is in the ad even when it is absent
    // from the text we received. 401 listings in the first live poll were
    // being discarded this way.
    const r = run({
      title: 'Analyst, Technology Risk',
      description: 'Join a growing team. Excellent benefits and career growth.',
      locationRaw: 'Werribee VIC 3030',
      providerMatchedTerm: 'Cyber Security',
    });
    expect(r.status).toBe('passed');
    expect(r.keywordMatchSource).toBe('provider');
    expect(r.matchedKeywords).toEqual(['Cyber Security']);
  });

  it('prefers our own text match when there is one', () => {
    const r = run({
      title: 'IT Support Officer',
      locationRaw: 'Werribee VIC 3030',
      providerMatchedTerm: 'Cyber Security',
    });
    expect(r.keywordMatchSource).toBe('text');
    expect(r.matchedKeywords).toContain('IT Support');
  });

  it('does NOT let a provider match bypass the exclude keywords', () => {
    // The fallback gets a listing past the include gate and nothing more.
    const r = run({
      title: 'Security Guard',
      description: 'Crowd control duties.',
      locationRaw: 'Werribee VIC 3030',
      providerMatchedTerm: 'Cyber Security',
    });
    expect(r.status).toBe('rejected');
    expect(buckets(r)).toContain('excluded_keyword');
  });

  it('reports none when neither our text nor the provider matched', () => {
    const r = run({ title: 'Barista', description: 'Weekend cafe work.' });
    expect(r.keywordMatchSource).toBe('none');
  });
});

describe('prefilter — title-scoped excludes', () => {
  it('rejects a wrong-domain role by its title', () => {
    const r = run({
      title: 'Cleaner',
      description: 'Cleaning duties across the site. Report faults to the helpdesk.',
      locationRaw: 'Werribee VIC 3030',
      providerMatchedTerm: 'Helpdesk',
    });
    expect(r.status).toBe('rejected');
    expect(buckets(r)).toContain('excluded_keyword');
  });

  it('does NOT reject a real IT role that merely mentions the excluded word', () => {
    // The reason these excludes are title-scoped. A hospital IT job mentions
    // nurses; a school IT job mentions teachers. Matching on full text would
    // throw away exactly the roles we want.
    const r = run({
      title: 'IT Support Officer',
      description: 'Supporting nurses and clinical staff across the hospital network.',
      locationRaw: 'Werribee VIC 3030',
    });
    expect(r.status).toBe('passed');
    expect(buckets(r)).not.toContain('excluded_keyword');
  });
});

describe('prefilter — domain vs structural keywords', () => {
  it('rejects a role whose only match is structural', () => {
    // The first real ingest ranked an AFL Football Analysis Internship and
    // nine Cleaners above every actual IT job, because "Internship" and
    // "Work Experience" describe a role's SHAPE, not its FIELD.
    const r = run({
      title: 'AFL Football Analysis Internship',
      description: 'A 12 week internship with our football analytics department.',
      locationRaw: 'Melbourne VIC 3000',
    });
    expect(r.status).toBe('rejected');
    expect(buckets(r)).toContain('no_domain_keyword_match');
  });

  it('accepts a structural role that also matches a domain term', () => {
    const r = run({
      title: 'IT Support Internship',
      description: 'A 12 week internship with our service desk team.',
      locationRaw: 'Werribee VIC 3030',
    });
    expect(r.status).toBe('passed');
    expect(r.matchedKeywords).toEqual(expect.arrayContaining(['IT Support', 'Internship']));
  });

  it('does not honour a provider match on a structural term', () => {
    // A listing found by querying "Internship" is not thereby relevant.
    const r = run({
      title: 'Graduate Nursing Programme',
      description: 'Join our team caring for the community.',
      locationRaw: 'Werribee VIC 3030',
      providerMatchedTerm: 'Internship',
    });
    expect(r.status).toBe('rejected');
    expect(r.keywordMatchSource).toBe('none');
  });

  it('does honour a provider match on a domain term', () => {
    const r = run({
      title: 'Analyst, Technology Risk',
      description: 'Join a growing team.',
      locationRaw: 'Werribee VIC 3030',
      providerMatchedTerm: 'Cyber Security',
    });
    expect(r.status).toBe('passed');
    expect(r.keywordMatchSource).toBe('provider');
  });
});

describe('prefilter — ranking signal', () => {
  it('ranks unpaid + onsite + part-time internships above paid remote full-time roles', () => {
    const preferred = run({
      title: 'Cyber Security Internship',
      description: 'Unpaid 12 week internship, on-site, part time.',
      locationRaw: 'Werribee VIC 3030',
    });
    const demoted = run({
      title: 'Senior Information Security Consultant',
      description: 'Fully remote, work from home. Full time permanent.',
      locationRaw: 'Melbourne VIC 3000',
      salaryMin: 160000,
    });

    expect(preferred.preferenceMultiplier).toBeGreaterThan(demoted.preferenceMultiplier);
    // Crucially, the demoted one still PASSES. Weighting ranks; it never excludes.
    expect(demoted.status).toBe('passed');
  });
});

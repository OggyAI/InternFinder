-- ============================================================================
-- intern_finder_bot — wider IT domain, and excludes that target the title
--
-- Two problems the first real ingest exposed, both decided by the user:
--
-- 1. RECALL. `Web Developer Intern` and `STAR Program Intern - Melbourne` were
--    rejected with no_domain_keyword_match because the domain list only knew
--    about cyber and IT support. For an IT student rather than a purely
--    security-focused one, a dev or cloud internship is real experience and a
--    real stepping stone into a SOC role.
--
-- 2. PRECISION. Eight Cleaner listings passed, every one of them matched via
--    provider_matched_term = 'Helpdesk'. Adzuna full-text searches the whole
--    ad, so a facilities ad mentioning a helpdesk somewhere is a legitimate
--    phrase hit that is useless to us, and the 500-char teaser gives us no way
--    to see that for ourselves.
--
--    The fix is an exclude that looks ONLY at the title. Matching these terms
--    against the full text would be actively harmful: a genuine IT Support
--    role at a hospital mentions nurses, and an IT role at a school mentions
--    teachers. The title is where a role's actual domain lives.
-- ============================================================================

alter table public.filter_keywords
  add column if not exists match_scope text not null default 'text'
    check (match_scope in ('text', 'title'));

comment on column public.filter_keywords.match_scope is
  'text  = match against title + company + description (the default). '
  'title = match against the title only. Use for wrong-domain excludes, where '
  'a full-text match would kill real IT roles that merely mention nurses, '
  'teachers or cleaners in passing.';

-- ---------- 1. Broader IT domain terms --------------------------------------
insert into public.filter_keywords
  (filter_id, term, kind, weight, whole_word, case_sensitive, category, match_scope, notes)
select f.id, v.term, 'include', v.weight, v.whole_word, v.case_sensitive,
       'domain', 'text', v.notes
  from public.filters f
 cross join (values
   -- Development. A dev internship is a realistic entry point.
   ('Web Developer',          1.15, false, false, null),
   ('Software Engineer',      1.15, false, false, null),
   ('Software Developer',     1.15, false, false, null),
   ('Junior Developer',       1.20, false, false, null),
   ('Graduate Developer',     1.15, false, false, null),
   ('Full Stack',             1.10, false, false, null),
   ('Frontend Developer',     1.05, false, false, null),
   ('Backend Developer',      1.05, false, false, null),
   -- Platform and infrastructure, the usual road into security work.
   ('DevSecOps',              1.45, false, false, 'Security-adjacent by definition'),
   ('DevOps',                 1.30, false, false, null),
   ('Site Reliability',       1.20, false, false, null),
   ('Cloud Engineer',         1.20, false, false, null),
   ('AWS',                    1.10, true,  true,  'Acronym: whole word, exact case'),
   ('Azure',                  1.10, true,  false, null),
   ('Network Engineer',       1.25, false, false, null),
   ('Database Administrator', 1.10, false, false, null),
   ('Systems Analyst',        1.10, false, false, null),
   ('Application Support',    1.20, false, false, null),
   ('Technical Analyst',      1.10, false, false, null),
   ('QA Engineer',            1.05, false, false, null),
   ('Software Testing',       1.05, false, false, null)
 ) as v(term, weight, whole_word, case_sensitive, notes)
 where f.is_active
on conflict (filter_id, lower(term), kind) do nothing;

-- ---------- 2. Wrong-domain title excludes ----------------------------------
-- TITLE ONLY. See the note at the top of this file for why full text would be
-- a mistake. Deliberately does NOT include Receptionist or Administrator —
-- those shade into the Data Entry and admin work that is genuinely wanted.
insert into public.filter_keywords
  (filter_id, term, kind, whole_word, category, match_scope, notes)
select f.id, v.term, 'exclude', false, 'domain', 'title', 'Wrong-domain title'
  from public.filters f
 cross join (values
   -- Health and care. The single biggest source of noise in the first ingest.
   ('Nurse'), ('Nursing'), ('Midwife'), ('Paramedic'), ('Pharmacist'),
   ('Physiotherapist'), ('Psychologist'), ('Therapist'), ('Dentist'),
   ('General Practitioner'), ('Support Worker'), ('Disability Support'),
   ('Aged Care'), ('Personal Care'), ('Social Worker'), ('Harm Reduction'),
   -- Hospitality, retail, trades.
   ('Cleaner'), ('Cleaning'), ('Chef'), ('Cook'), ('Barista'), ('Bartender'),
   ('Waiter'), ('Waitress'), ('Housekeeper'), ('Kitchen Hand'),
   ('Sales Assistant'), ('Retail Assistant'), ('Store Manager'),
   ('Forklift'), ('Warehouse Operator'), ('Truck Driver'), ('Delivery Driver'),
   -- Education and other clearly-unrelated fields.
   ('Educator'), ('Childcare'), ('Teacher'), ('Tutor'), ('Lecturer')
 ) as v(term)
 where f.is_active
on conflict (filter_id, lower(term), kind) do nothing;

-- ============================================================================
-- intern_finder_bot — domain vs structural keywords
--
-- WHY: the first real ingest stored 754 listings and ranked a Red Cross shop
-- volunteer, a General Practitioner, an AFL Football Analysis Internship and
-- nine Cleaner positions above every actual IT role.
--
-- The keyword list was conflating two different kinds of term:
--
--   DOMAIN     — what FIELD the role is in.
--                Cyber Security, SOC Analyst, IT Support, Data Entry, IT
--   STRUCTURAL — what SHAPE the role is.
--                Internship, Intern, Trainee, Cadet, Work Experience
--
-- A structural term on its own is not evidence of relevance. "Internship"
-- matches an AFL analysis internship and a nursing traineeship just as happily
-- as an IT one. Treating the two as interchangeable is what let the provider
-- keyword-match fallback rubber-stamp anything a broad query returned.
--
-- New rule, enforced in prefilter.ts: a listing must match at least one DOMAIN
-- term to pass. Structural terms still drive queries — they are how we find
-- "IT Support Intern" — and still contribute to ranking, but they can no
-- longer admit a listing on their own.
-- ============================================================================

alter table public.filter_keywords
  add column if not exists category text not null default 'domain'
    check (category in ('domain', 'structural'));

comment on column public.filter_keywords.category is
  'domain = identifies the field (Cyber Security, IT Support). structural = '
  'identifies the shape (Internship, Trainee). Only a domain match admits a '
  'listing; structural terms qualify and rank it. Applies to include terms.';

update public.filter_keywords
   set category = 'structural'
 where kind = 'include'
   and lower(term) in (
     'internship', 'intern', 'trainee', 'traineeship',
     'cadet', 'cadetship', 'work experience'
   );

-- ---------- Ambiguous domain terms ------------------------------------------
-- "Vulnerability" is a cyber term in our heads and a social-services term in
-- Australian job ads, where "supporting vulnerable people" is boilerplate. It
-- was pulling in disability and aged-care roles. Replaced with the two phrases
-- that are unambiguously ours.
delete from public.filter_keywords
 where kind = 'include' and lower(term) = 'vulnerability';

insert into public.filter_keywords (filter_id, term, kind, weight, whole_word, category, notes)
select id, v.term, 'include', 1.20, false, 'domain', v.notes
  from public.filters
 cross join (values
   ('Vulnerability Management', 'Replaces bare "Vulnerability", which matched "vulnerable people"'),
   ('Vulnerability Assessment', 'Replaces bare "Vulnerability", which matched "vulnerable people"')
 ) as v(term, notes)
 where is_active
on conflict (filter_id, lower(term), kind) do nothing;

-- ---------- Persist which query found each listing ---------------------------
-- The pre-filter honours a provider phrase match as domain evidence, but that
-- term only existed in memory during the poll. Without it on the row,
-- re-evaluating stored listings against edited criteria (see `npm run
-- reprocess`) silently loses the evidence and rejects listings that were
-- legitimately matched. Filters are meant to be editable at runtime, and that
-- is worth nothing if re-running the filter degrades the result.
alter table public.job_listings
  add column if not exists provider_matched_term text;

comment on column public.job_listings.provider_matched_term is
  'The search phrase whose query returned this listing. Adzuna full-text '
  'searches the whole ad but returns a 500-char teaser, so this is often the '
  'only evidence that a domain keyword is present.';

-- ============================================================================
-- intern_finder_bot — title-scoped seniority excludes
--
-- WHY: measured over 1,299 scored, passed, non-duplicate listings, only 11
-- (0.8%) reached the notify threshold and 896 (69%) scored under 25. The
-- pre-filter matches the FIELD correctly — it has no notion of LEVEL, so every
-- Senior Engineer, Solutions Architect and Delivery Manager in IT and cyber
-- passed the domain gate and was paid for at the LLM.
--
-- A final-year student seeking an internship cannot fill a Senior, Principal,
-- Manager or Director role. That is true independently of this sample, which
-- is the point: the first cut of this analysis produced ~37 terms with "zero
-- good matches", including `data`, `cloud`, `developer` and `software` — but
-- with only 11 good listings in the entire dataset, "zero good hits" is what
-- almost any term scores by chance. Excluding those would have gutted the
-- pipeline. This list is justified by reasoning about seniority and then
-- checked against the data, not selected from the data.
--
-- MEASURED EFFECT on the 1,299 already-scored listings:
--   skipped        539  (41.5% of scoring spend)
--     under 25     464  pure waste avoided
--     25-49         73  never notifiable
--     50-69          2  "Data Security Delivery Lead", "Senior IT Cluster Specialist"
--     70+            0  <- nothing notifiable is lost
--   mean base score of skipped 13.9, of kept 23.4
--
-- SAFETY CHECK: across all 4,412 listings ever ingested, ZERO titles contain
-- both a seniority word and an intern/graduate/trainee word. There is no
-- "Senior Intern" to lose, so a plain title-scoped exclude needs no exception
-- logic.
--
-- match_scope = 'title' matters. "Senior" appears in the body of countless
-- junior ads ("reporting to a senior engineer", "supported by senior staff");
-- matching the full text would reject genuine internships. Only the title
-- states the level of the role being advertised.
-- ============================================================================

insert into public.filter_keywords
  (filter_id, term, kind, category, match_scope, whole_word, case_sensitive, weight, is_active, notes)
select
  f.id, t.term, 'exclude', 'structural', 'title', true, false, 1.00, true,
  'Seniority level a student cannot fill. Title-scoped: the word appears in the body of junior ads too.'
from public.filters f
cross join (values
  ('Senior'),
  ('Snr'),
  ('Sr'),
  ('Lead'),
  ('Principal'),
  ('Manager'),
  ('Director'),
  ('Chief'),
  ('Supervisor'),
  ('Architect'),
  ('Executive'),
  ('Superintendent'),
  ('Foreman'),
  ('Vice President'),
  -- Not 'VP': two letters, and whole_word would still hit the surname-like
  -- fragments some feeds put in titles. Low volume, not worth the risk.
  ('Partner')
) as t(term)
where f.is_active
-- Idempotent: the unique index is (filter_id, lower(term), kind), and "Head of"
-- already exists as a text-scoped exclude.
on conflict do nothing;

-- 'Head of' is already present as a text-scoped exclude from the seed. Left
-- alone deliberately: it is a phrase rather than a bare word, so matching it
-- in the body is not the hazard that a bare "Senior" would be.

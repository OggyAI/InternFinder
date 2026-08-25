-- ============================================================================
-- intern_finder_bot — case-sensitive keyword matching
--
-- WHY: the first live Adzuna poll passed a Medical Receptionist, a Cocktail
-- Bartender and a Room Attendant, every one of them "matching" the keyword IT.
--
-- `whole_word` correctly stopped IT matching *security* and *monitor*, but the
-- match was still case-insensitive, so the term IT also matched the English
-- pronoun "it" — which appears in essentially every job ad ever written. The
-- word-boundary guard and the case guard are two different problems and the
-- schema only had a column for one of them.
--
-- Adding it as a ROW rather than a rule in code, because which terms are
-- case-sensitive is a property of the keyword list, and the keyword list is
-- meant to be editable without a redeploy. New acronyms will get added later
-- (HR, QA, AWS, ISO) and each will need this.
-- ============================================================================

alter table public.filter_keywords
  add column if not exists case_sensitive boolean not null default false;

comment on column public.filter_keywords.case_sensitive is
  'Match the term with exact capitalisation. Required for acronyms whose '
  'lowercase form is an ordinary English word — IT vs "it" being the one that '
  'actually broke. Harmless but pointless on ordinary multi-word terms.';

-- Acronyms. Only IT is genuinely dangerous today, but every one of these is a
-- capitalised initialism where a lowercase match would be a false positive.
update public.filter_keywords
   set case_sensitive = true
 where upper(term) = term
   and term ~ '^[A-Z0-9]{2,6}$';

-- The first live poll also showed the query strategy was wrong: Adzuna's
-- `what_or` ORs individual WORDS, not phrases, so a group containing "Security
-- Operations" and "Blue Team" matched anything with "operations" or "team" —
-- 3915 results, almost all irrelevant. The adapter now issues one
-- `what_phrase` request per keyword instead, which is far more precise but
-- spends roughly one API call per keyword per poll.
--
-- At 34 include keywords that is ~34 calls a poll; every 3 hours would be 272
-- calls a day against a 200 budget. Six-hourly keeps it near 136. Guarded so
-- it will not overwrite a cadence that has already been tuned by hand.
update public.sources
   set poll_interval_minutes = 360
 where name = 'adzuna'
   and poll_interval_minutes = 180;

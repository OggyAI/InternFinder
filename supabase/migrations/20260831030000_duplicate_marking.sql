-- ============================================================================
-- intern_finder_bot — near-duplicate marking
--
-- WHY: the top of the scored results had "Web Developer Intern" from the same
-- company twice, and 90 of 1000 passing listings are near-duplicates of
-- another. Without this, Phase 3 notifies you twice about one job.
--
-- `content_fingerprint` (title + company) already existed to FLAG these, and
-- nothing consumed it. Deliberately so — it flags candidates, not duplicates,
-- and the live data shows why the distinction matters:
--
--   "Senior Engineer" / Halcyon Knights, Melbourne CBD, posted 22, 27 and 30
--   August — one job, re-posted weekly by a recruiter.
--
--   "Service Desk Engineer" / GPK Group, Dandenong East, Knoxfield and
--   Frankston East, all posted 10 August — three real vacancies at three
--   sites. Collapsing these would silently cost real opportunities.
--
-- So the rule is fingerprint AND proximity (see packages/core/src/duplicates.ts).
-- Nothing is deleted: duplicates keep their row, their score and their
-- reasons, and simply point at the listing that represents them.
-- ============================================================================

alter table public.job_listings
  add column if not exists duplicate_of uuid
    references public.job_listings (id) on delete set null;

comment on column public.job_listings.duplicate_of is
  'The canonical listing this one duplicates, or null if it is itself the one '
  'to act on. The EARLIEST sighting in a cluster wins, because that is the row '
  'that may already carry an applied/dismissed status — promoting a newer copy '
  'would discard that decision and re-notify about a job already dealt with.';

-- The hot query is "everything that is not a duplicate", so index the
-- canonical rows rather than the whole column.
create index if not exists job_listings_canonical_idx
  on public.job_listings (prefilter_status, preference_multiplier desc)
  where duplicate_of is null;

create index if not exists job_listings_duplicate_of_idx
  on public.job_listings (duplicate_of)
  where duplicate_of is not null;

-- A listing cannot duplicate itself. Cheap guard against a clustering bug
-- writing a self-reference and making a row invisible to every query that
-- filters on `duplicate_of is null`.
alter table public.job_listings
  drop constraint if exists job_listings_no_self_duplicate;
alter table public.job_listings
  add constraint job_listings_no_self_duplicate
    check (duplicate_of is null or duplicate_of <> id);

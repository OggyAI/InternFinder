-- ============================================================================
-- intern_finder_bot — initial schema
--
-- A single-user job/internship discovery pipeline. Sources (Adzuna, Jooble)
-- are polled by a worker on an Oracle Cloud VM; listings are deduped, run
-- through a rule-based pre-filter, then (Phase 2) scored by Claude against a
-- stored resume; survivors (Phase 3) are pushed to Telegram and a dashboard.
--
-- Design rules this file enforces:
--  * NOTHING about the search criteria is a constant. Location, radius,
--    keywords, and the soft preference weights are all editable ROWS, so they
--    can change from the dashboard or a Telegram command without a deploy.
--  * Preference weighting is a SOFT multiplier, never a filter. A paid,
--    remote, full-time role is demoted, not excluded — an exceptional match
--    still surfaces.
--  * The pre-filter is exclusion-biased. Job APIs do not expose duration as a
--    structured field, so we only reject on clear disqualifying signals and
--    let the LLM make the real call in Phase 2. Rejections are recorded with a
--    reason rather than deleted, so an over-aggressive filter is visible as a
--    pile of rows sharing one reason, instead of as silence.
--  * RLS is default-deny on every table with no policies. The worker connects
--    with the service_role key, which bypasses RLS. Phase 3 adds authenticated
--    policies for the dashboard; until then nothing else can read these tables.
--  * raw_json is never discarded. Provider response shapes drift, and the raw
--    payload is the only way to backfill a column we did not think to add.
--
-- Apply with:  supabase db push
-- ============================================================================

-- ---------- 1. Search criteria (editable at runtime) ------------------------

-- The top-level criteria set. Exactly one row is active at a time.
create table if not exists public.filters (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (char_length(name) between 1 and 80),
  is_active            boolean not null default false,

  -- Centre point for the radius search. Seeded to a placeholder; set it to
  -- wherever you actually search from.
  -- Stored as a plain lat/lng rather than PostGIS: one point, one distance
  -- formula, no extension needed.
  center_label         text not null,
  center_lat           double precision not null check (center_lat between -90 and 90),
  center_lng           double precision not null check (center_lng between -180 and 180),
  radius_km            integer not null default 50 check (radius_km between 1 and 500),

  -- Duration window, in weeks. max_duration_weeks null = no upper bound.
  min_duration_weeks   integer not null default 6 check (min_duration_weeks >= 0),
  max_duration_weeks   integer check (max_duration_weeks is null
                                      or max_duration_weeks >= min_duration_weeks),

  -- Reject listings requiring work rights the applicant does not hold
  -- (sponsorship, PR/citizen-only, security clearance). Which terms count is
  -- configured in filter_keywords, so this suits any visa situation.
  exclude_sponsorship_required boolean not null default true,

  -- Drop listings older than this at ingest. Stale postings are usually filled.
  max_listing_age_days integer not null default 30
                         check (max_listing_age_days between 1 and 365),

  -- Listings whose suburb is not in the bundled gazetteer get distance = null.
  -- true  = keep them, let the LLM judge (higher recall, more noise)
  -- false = reject them outright (higher precision, risks dropping good roles)
  keep_unknown_location boolean not null default true,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Enforce "exactly one active criteria set" without needing a trigger.
-- Every row this partial index covers has is_active = true, so making that
-- column unique within the index allows at most one active row.
create unique index if not exists filters_single_active_idx
  on public.filters (is_active) where is_active;

-- Role keywords. Rows, not a hardcoded array — this list is meant to grow.
-- kind='include'  : at least one must match for a listing to pass.
-- kind='exclude'  : any match rejects the listing. Mostly wrong-domain false
--                   positives, e.g. "security guard" matching a cyber search.
-- kind='exclude_work_rights': same as exclude, but only applied when
--                   filters.exclude_sponsorship_required is true. Kept as rows
--                   rather than in code so the whole class can be toggled off
--                   (say, after a visa change) without a redeploy.
create table if not exists public.filter_keywords (
  id         uuid primary key default gen_random_uuid(),
  filter_id  uuid not null references public.filters (id) on delete cascade,
  term       text not null check (char_length(term) between 2 and 120),
  kind       text not null default 'include'
               check (kind in ('include','exclude','exclude_work_rights')),
  -- Relative pull of this term in scoring. Does not affect pass/fail.
  weight     numeric(4,2) not null default 1.00 check (weight between 0 and 5),
  -- Match only on a word boundary. Without this, "IT" matches "security",
  -- "monitor", and "editing" — so short terms need it on.
  whole_word boolean not null default true,
  is_active  boolean not null default true,
  notes      text,
  created_at timestamptz not null default now()
);

create unique index if not exists filter_keywords_unique_idx
  on public.filter_keywords (filter_id, lower(term), kind);
create index if not exists filter_keywords_active_idx
  on public.filter_keywords (filter_id, kind) where is_active;

-- Soft preferences. These NEVER exclude — they multiply a listing's score.
--   weight > 1.0  ->  surface more (unpaid, in-person, part-time)
--   weight = 1.0  ->  neutral
--   weight < 1.0  ->  still shown, ranked lower (paid, remote, full-time)
create table if not exists public.filter_preferences (
  id         uuid primary key default gen_random_uuid(),
  filter_id  uuid not null references public.filters (id) on delete cascade,
  dimension  text not null check (dimension in
               ('compensation','work_mode','commitment','role_type')),
  value      text not null check (char_length(value) between 1 and 40),
  weight     numeric(4,2) not null default 1.00 check (weight between 0.10 and 3.00),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists filter_preferences_unique_idx
  on public.filter_preferences (filter_id, dimension, value);

-- ---------- 2. Sources and worker state -------------------------------------

create table if not exists public.sources (
  name                  text primary key
                          check (name in ('adzuna','jooble','careers_page')),
  enabled               boolean not null default true,
  -- Cadence lives here, not in env, so it is tunable without a redeploy.
  poll_interval_minutes integer not null default 180 check (poll_interval_minutes >= 5),
  -- Free-tier budget guard. The worker refuses to call past this.
  max_calls_per_day     integer not null default 200 check (max_calls_per_day > 0),
  calls_today           integer not null default 0 check (calls_today >= 0),
  quota_reset_at        timestamptz not null
                          default (date_trunc('day', now()) + interval '1 day'),
  last_polled_at        timestamptz,
  last_success_at       timestamptz,
  last_error            text,
  consecutive_failures  integer not null default 0 check (consecutive_failures >= 0),
  updated_at            timestamptz not null default now()
);

-- Single-row settings table. The id check keeps it single-row.
create table if not exists public.app_settings (
  id                        integer primary key default 1 check (id = 1),
  -- Telegram /pause and /resume flip this. The loop keeps ticking, does no work.
  is_paused                 boolean not null default false,
  -- Phase 2: minimum fit_score that earns a Telegram notification.
  notify_score_threshold    integer not null default 70
                              check (notify_score_threshold between 0 and 100),
  -- Phase 3: guard against a bad filter edit spamming the phone.
  max_notifications_per_day integer not null default 25
                              check (max_notifications_per_day >= 0),
  updated_at                timestamptz not null default now()
);

-- ---------- 3. Listings -----------------------------------------------------

create table if not exists public.job_listings (
  id              uuid primary key default gen_random_uuid(),
  source          text not null references public.sources (name),
  -- The provider's own id, when it gives one. Not unique across sources.
  source_id       text,

  url             text not null,
  -- url with tracking params and trailing slash stripped; the dedupe input.
  url_canonical   text not null,
  -- sha256 of url_canonical. THE dedupe key — one unique index means one
  -- conflict target, so upserts never choose between competing constraints.
  dedupe_hash     text not null,
  -- sha256 of normalised title + company. Non-unique: used to FLAG the same
  -- job listed by two sources under different URLs, without blocking inserts.
  content_fingerprint text not null,

  title           text not null,
  company         text,
  description     text,

  location_raw    text,
  location_suburb text,
  location_state  text,
  latitude        double precision,
  longitude       double precision,
  -- Distance from the active filter's centre, computed at ingest.
  -- null = suburb not resolvable from the bundled gazetteer.
  distance_km     double precision,

  salary_min      numeric(12,2),
  salary_max      numeric(12,2),
  salary_currency text default 'AUD',
  -- Adzuna returns predicted salaries for listings that stated none. A
  -- predicted salary is NOT evidence that the role is paid.
  salary_is_predicted boolean not null default false,

  posted_date     timestamptz,

  -- Signals sniffed from the text at ingest. All may be 'unknown'; Phase 2
  -- overwrites these with the LLM's read on the `matches` row.
  compensation    text not null default 'unknown'
                    check (compensation in ('paid','unpaid','unknown')),
  work_mode       text not null default 'unknown'
                    check (work_mode in ('remote','onsite','hybrid','unknown')),
  commitment      text not null default 'unknown'
                    check (commitment in ('full_time','part_time','casual','contract','unknown')),
  role_type       text not null default 'unknown'
                    check (role_type in ('job','internship','unknown')),
  duration_weeks  integer check (duration_weeks is null or duration_weeks >= 0),

  raw_json        jsonb not null,

  prefilter_status  text not null default 'pending'
                      check (prefilter_status in ('pending','passed','rejected')),
  prefilter_reasons text[] not null default '{}',
  -- Cheap ordering signal from the soft preferences; real score is Phase 2.
  preference_multiplier numeric(4,2) not null default 1.00,

  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create unique index if not exists job_listings_dedupe_idx
  on public.job_listings (dedupe_hash);
create index if not exists job_listings_fingerprint_idx
  on public.job_listings (content_fingerprint);
create index if not exists job_listings_source_idx
  on public.job_listings (source, source_id);
create index if not exists job_listings_posted_idx
  on public.job_listings (posted_date desc nulls last);
-- The Phase 2 work queue: passed the cheap filter, has no score yet.
create index if not exists job_listings_prefilter_idx
  on public.job_listings (prefilter_status, preference_multiplier desc)
  where prefilter_status = 'passed';

-- ---------- 4. Resume -------------------------------------------------------

create table if not exists public.resume_versions (
  id         uuid primary key default gen_random_uuid(),
  label      text not null check (char_length(label) between 1 and 80),
  content    text not null check (char_length(content) > 0),
  is_active  boolean not null default false,
  created_at timestamptz not null default now()
);

-- Same one-active-row trick as filters_single_active_idx above.
create unique index if not exists resume_versions_single_active_idx
  on public.resume_versions (is_active) where is_active;

-- ---------- 5. Matches (Phase 2 writes these) -------------------------------

create table if not exists public.matches (
  id                uuid primary key default gen_random_uuid(),
  listing_id        uuid not null references public.job_listings (id) on delete cascade,
  resume_version_id uuid references public.resume_versions (id) on delete set null,

  -- The model's raw read of resume fit, before preference weighting.
  base_score        integer not null check (base_score between 0 and 100),
  -- base_score * preference_multiplier, clamped to 0..100. What gets ranked.
  fit_score         integer not null check (fit_score between 0 and 100),
  preference_multiplier numeric(4,2) not null default 1.00,

  reasoning         text not null,

  -- The LLM's classification, which supersedes the ingest-time guess.
  category          text not null default 'unknown'
                      check (category in ('job','internship','unknown')),
  compensation      text not null default 'unknown'
                      check (compensation in ('paid','unpaid','unknown')),
  work_mode         text not null default 'unknown'
                      check (work_mode in ('remote','onsite','hybrid','unknown')),
  commitment        text not null default 'unknown'
                      check (commitment in ('full_time','part_time','casual','contract','unknown')),
  duration_weeks    integer check (duration_weeks is null or duration_weeks >= 0),

  status            text not null default 'new'
                      check (status in ('new','notified','applied','dismissed','saved')),

  model             text,
  scored_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One match row per listing; re-scoring updates in place.
create unique index if not exists matches_listing_idx on public.matches (listing_id);
create index if not exists matches_status_score_idx on public.matches (status, fit_score desc);
create index if not exists matches_created_idx on public.matches (created_at desc);

-- ---------- 6. Notification log (Phase 3 writes these) ----------------------

create table if not exists public.notification_log (
  id                  uuid primary key default gen_random_uuid(),
  match_id            uuid references public.matches (id) on delete set null,
  channel             text not null default 'telegram'
                        check (channel in ('telegram','dashboard')),
  telegram_chat_id    text,
  telegram_message_id bigint,
  -- Exactly what was sent, so a formatting bug is reconstructable afterwards.
  payload             text,
  status              text not null default 'sent'
                        check (status in ('sent','failed','edited')),
  error               text,
  sent_at             timestamptz not null default now()
);

create index if not exists notification_log_match_idx on public.notification_log (match_id);
create index if not exists notification_log_sent_idx on public.notification_log (sent_at desc);

-- ---------- 7. updated_at maintenance ---------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

do $do$
declare t text;
begin
  foreach t in array array['filters','sources','app_settings','matches'] loop
    execute format('drop trigger if exists %I on public.%I',
                   t || '_touch_updated_at', t);
    execute format('create trigger %I before update on public.%I
                      for each row execute function public.touch_updated_at()',
                   t || '_touch_updated_at', t);
  end loop;
end;
$do$;

-- ---------- 8. RLS: default deny, no policies -------------------------------
-- The worker uses the service_role key and bypasses all of this. Nothing else
-- can read or write until Phase 3 adds explicit authenticated policies.

alter table public.filters            enable row level security;
alter table public.filter_keywords    enable row level security;
alter table public.filter_preferences enable row level security;
alter table public.sources            enable row level security;
alter table public.app_settings       enable row level security;
alter table public.job_listings       enable row level security;
alter table public.resume_versions    enable row level security;
alter table public.matches            enable row level security;
alter table public.notification_log   enable row level security;

-- ---------- 9. Privileges, stated explicitly --------------------------------
-- Deliberately NOT left to the project's "automatically expose new tables"
-- setting. That toggle decides whether the Data API roles are granted
-- privileges on new tables, which means the schema would behave differently
-- depending on how a checkbox was ticked at project-creation time. Spelling
-- the grants out here makes this migration self-sufficient either way.

-- The worker. service_role also bypasses RLS, but bypassing RLS is not the
-- same as holding table privileges — it still needs these GRANTs.
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

-- Nothing else gets anything. RLS is already default-deny with no policies,
-- so this is belt-and-braces: even a leaked anon key reaches zero rows.
--
-- PHASE 3 WILL NEED TO UNDO PART OF THIS. The dashboard authenticates with the
-- anon key, so it will need both (a) RLS policies and (b) SELECT/UPDATE grants
-- re-added here for `authenticated`. A policy alone is not enough — without a
-- GRANT the query fails on permissions before RLS is ever consulted.
revoke all on all tables in schema public from anon, authenticated;

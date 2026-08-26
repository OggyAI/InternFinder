-- ============================================================================
-- intern_finder_bot — scoring settings and spend guards
--
-- Phase 2 shipped as a manual `npm run score`. Wiring it into the worker loop
-- means it runs unattended on a box nobody is watching, so it needs the same
-- kind of budget guard the API sources already have.
--
-- The shape deliberately mirrors `sources`: a per-run ceiling, a daily
-- ceiling, a running total, and a reset timestamp. One idiom for "this costs
-- money, do not let it run away" rather than two.
--
-- Why two ceilings. The per-cycle cap stops one bad poll — a widened keyword
-- list, an Adzuna surge — from scoring a thousand listings in a single go. The
-- daily cap stops a slow leak across the four cycles in a day. Either alone
-- leaves a hole.
-- ============================================================================

alter table public.app_settings
  add column if not exists scoring_enabled boolean not null default true,

  -- Listings per request. Larger batches amortise the cached prompt prefix and
  -- cost less per listing, but raise the chance of the model running array
  -- entries together (which the worker detects and retries). 8 measured well.
  add column if not exists scoring_batch_size integer not null default 8
    check (scoring_batch_size between 1 and 20),

  -- USD. At the measured ~$0.0021 per listing, $0.50 is roughly 240 listings
  -- in one cycle — comfortably more than a normal poll produces, and far short
  -- of a runaway.
  add column if not exists max_scoring_spend_usd_per_cycle numeric(8,4) not null default 0.50
    check (max_scoring_spend_usd_per_cycle >= 0),

  add column if not exists max_scoring_spend_usd_per_day numeric(8,4) not null default 2.00
    check (max_scoring_spend_usd_per_day >= 0),

  add column if not exists scoring_spend_today numeric(10,6) not null default 0
    check (scoring_spend_today >= 0),

  add column if not exists scoring_spend_reset_at timestamptz not null
    default (date_trunc('day', now()) + interval '1 day');

comment on column public.app_settings.scoring_enabled is
  'Master switch for Phase 2 scoring inside the worker loop. Off means polling '
  'and pre-filtering continue and the scoring queue simply builds up; nothing '
  'is lost, because the queue is derived from listings without a match row.';

comment on column public.app_settings.max_scoring_spend_usd_per_cycle is
  'Hard USD ceiling for one worker cycle. Checked between batches, so the '
  'overshoot is at most one batch. Raise it to clear a backlog faster.';

comment on column public.app_settings.scoring_spend_today is
  'Running USD total, rolled over when scoring_spend_reset_at passes. Same '
  'mechanism as sources.calls_today.';

-- ============================================================================
-- intern_finder_bot — seed data
--
-- The starting criteria set. Every row here is meant to be EDITED later from
-- the dashboard or a Telegram command; nothing in this file is load-bearing on
-- a redeploy. Written idempotently so `supabase db push` can be re-run safely
-- and will not clobber edits already made in production.
-- ============================================================================

-- Fixed UUID so the child rows below can reference it without a lookup, and so
-- re-running this file targets the same row instead of creating a second one.
-- Any additional criteria sets created later get random UUIDs as normal.
insert into public.filters (
  id, name, is_active,
  center_label, center_lat, center_lng, radius_km,
  min_duration_weeks, max_duration_weeks,
  exclude_sponsorship_required, max_listing_age_days, keep_unknown_location
) values (
  '00000000-0000-4000-8000-000000000001',
  'Melbourne — IT & cyber, student visa',
  true,
  -- Hoppers Crossing VIC 3029. Approximate suburb centroid, not a rooftop
  -- geocode; a few hundred metres of error is irrelevant against a 50 km radius.
  -- Edit this row (not any code) to search from somewhere else.
  'Hoppers Crossing VIC 3029', -37.8829, 144.7003, 50,
  -- Filter out anything under ~6 weeks. No upper bound: a semester-long
  -- part-time internship can run well past 12 weeks and is still wanted.
  6, null,
  true, 30, true
)
on conflict (id) do nothing;

-- ---------- Include keywords ------------------------------------------------
-- whole_word matters here. "IT" without a word boundary matches "security",
-- "monitor", "editing", and "recruiting" — it would pass essentially everything.
insert into public.filter_keywords (filter_id, term, kind, weight, whole_word, notes)
values
  -- Core identity terms
  ('00000000-0000-4000-8000-000000000001', 'IT',                    'include', 1.00, true,  'Short term — whole_word is essential'),
  ('00000000-0000-4000-8000-000000000001', 'Information Technology','include', 1.10, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Data Entry',            'include', 1.00, false, 'Casual/admin work, pays the bills'),

  -- Cyber security proper
  ('00000000-0000-4000-8000-000000000001', 'Cyber Security',        'include', 1.50, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Cybersecurity',         'include', 1.50, false, 'One-word spelling is common in AU ads'),
  ('00000000-0000-4000-8000-000000000001', 'Information Security',  'include', 1.40, false, null),
  ('00000000-0000-4000-8000-000000000001', 'InfoSec',               'include', 1.30, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Network Security',      'include', 1.30, false, null),

  -- Blue team / defensive
  ('00000000-0000-4000-8000-000000000001', 'Blue Team',             'include', 1.50, false, 'Also matches "Blue Teaming"'),
  ('00000000-0000-4000-8000-000000000001', 'SOC Analyst',           'include', 1.50, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Security Operations',   'include', 1.40, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Incident Response',     'include', 1.35, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Threat Intelligence',   'include', 1.30, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Digital Forensics',     'include', 1.30, false, null),
  ('00000000-0000-4000-8000-000000000001', 'SIEM',                  'include', 1.30, true,  null),
  ('00000000-0000-4000-8000-000000000001', 'Splunk',                'include', 1.20, true,  null),

  -- Adjacent / entry paths into cyber
  ('00000000-0000-4000-8000-000000000001', 'Security Analyst',      'include', 1.40, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Vulnerability',         'include', 1.20, false, 'Catches "vulnerability management/assessment"'),
  ('00000000-0000-4000-8000-000000000001', 'Penetration Testing',   'include', 1.20, false, null),
  ('00000000-0000-4000-8000-000000000001', 'GRC',                   'include', 1.15, true,  'Governance, risk & compliance'),
  ('00000000-0000-4000-8000-000000000001', 'Identity and Access',   'include', 1.15, false, null),

  -- Help desk / support — the realistic entry point while studying
  ('00000000-0000-4000-8000-000000000001', 'Help Desk',             'include', 1.20, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Helpdesk',              'include', 1.20, false, 'One-word spelling'),
  ('00000000-0000-4000-8000-000000000001', 'Service Desk',          'include', 1.20, false, null),
  ('00000000-0000-4000-8000-000000000001', 'IT Support',            'include', 1.30, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Desktop Support',       'include', 1.20, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Technical Support',     'include', 1.10, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Systems Administrator', 'include', 1.10, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Network Administrator', 'include', 1.10, false, null),

  -- Structural terms — an ad titled only "Intern, Technology" still matters
  ('00000000-0000-4000-8000-000000000001', 'Internship',            'include', 1.25, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Intern',                'include', 1.15, true,  'whole_word so it does not match "internal"'),
  ('00000000-0000-4000-8000-000000000001', 'Trainee',               'include', 1.10, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Cadet',                 'include', 1.10, false, null),
  ('00000000-0000-4000-8000-000000000001', 'Work Experience',       'include', 1.10, false, null)
on conflict (filter_id, lower(term), kind) do nothing;

-- ---------- Exclude keywords (wrong-domain false positives) -----------------
-- "Security" is the single worst term in Australian job search: physical
-- security work outnumbers cyber roles by a wide margin. These excludes are
-- what make an unqualified "security" match usable at all.
insert into public.filter_keywords (filter_id, term, kind, whole_word, notes)
values
  ('00000000-0000-4000-8000-000000000001', 'Security Guard',        'exclude', false, 'Physical security'),
  ('00000000-0000-4000-8000-000000000001', 'Security Officer',      'exclude', false, 'Physical security'),
  ('00000000-0000-4000-8000-000000000001', 'Crowd Control',         'exclude', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Concierge',             'exclude', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Loss Prevention',       'exclude', false, 'Retail security'),
  ('00000000-0000-4000-8000-000000000001', 'Patrol',                'exclude', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Cash in Transit',       'exclude', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Door Supervisor',       'exclude', false, null),
  -- Sales roles that keyword-match on the product they sell
  ('00000000-0000-4000-8000-000000000001', 'Sales Representative',  'exclude', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Business Development Manager', 'exclude', false, null),
  -- Seniority that is out of reach for a final-year student
  ('00000000-0000-4000-8000-000000000001', 'Head of',               'exclude', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Principal Consultant',  'exclude', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Chief Information Security Officer', 'exclude', false, null)
on conflict (filter_id, lower(term), kind) do nothing;

-- ---------- Work-rights excludes (gated by the filter toggle) ---------------
-- Applied only while filters.exclude_sponsorship_required is true. These are
-- the roles a student-visa holder cannot take regardless of fit — Australian
-- government and defence work in particular is citizenship-gated.
insert into public.filter_keywords (filter_id, term, kind, whole_word, notes)
values
  ('00000000-0000-4000-8000-000000000001', 'must be an Australian Citizen',   'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Australian Citizenship is required','exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Permanent Residents only',        'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'NV1',                             'exclude_work_rights', true,  'Defence clearance'),
  ('00000000-0000-4000-8000-000000000001', 'NV2',                             'exclude_work_rights', true,  'Defence clearance'),
  ('00000000-0000-4000-8000-000000000001', 'Baseline Clearance',              'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Negative Vetting',                'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'AGSVA',                           'exclude_work_rights', true,  null),
  ('00000000-0000-4000-8000-000000000001', 'Security Clearance',              'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'Graduate Program',                'exclude_work_rights', false, 'Full-year grad programs, not internships'),
  ('00000000-0000-4000-8000-000000000001', 'Graduate Programme',              'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'visa sponsorship',                'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'sponsorship is not available',    'exclude_work_rights', false, null),
  ('00000000-0000-4000-8000-000000000001', 'unrestricted work rights',        'exclude_work_rights', false, 'Student visas are restricted')
on conflict (filter_id, lower(term), kind) do nothing;

-- ---------- Soft preference weights -----------------------------------------
-- These bias the RANKING. Nothing here removes a listing from the results.
--
--   > 1.00  surface more    = 1.00  neutral    < 1.00  show, but lower down
--
-- Per the brief: unpaid over paid, in-person over remote, part-time over
-- full-time. The demoted values sit at 0.85 rather than something punitive,
-- so a genuinely exceptional paid/remote/full-time role still climbs above a
-- mediocre unpaid/onsite/part-time one.
insert into public.filter_preferences (filter_id, dimension, value, weight)
values
  -- Unpaid roles are more abundant and more accessible to a student, so they
  -- are surfaced harder. NOTE: Adzuna and Jooble are paid-job aggregators and
  -- carry very few genuinely unpaid postings — this weight will have little to
  -- act on until a volunteer source is added.
  ('00000000-0000-4000-8000-000000000001', 'compensation', 'unpaid',    1.35),
  ('00000000-0000-4000-8000-000000000001', 'compensation', 'paid',      1.00),
  ('00000000-0000-4000-8000-000000000001', 'compensation', 'unknown',   1.00),

  ('00000000-0000-4000-8000-000000000001', 'work_mode',    'onsite',    1.30),
  ('00000000-0000-4000-8000-000000000001', 'work_mode',    'hybrid',    1.10),
  ('00000000-0000-4000-8000-000000000001', 'work_mode',    'remote',    0.85),
  ('00000000-0000-4000-8000-000000000001', 'work_mode',    'unknown',   1.00),

  ('00000000-0000-4000-8000-000000000001', 'commitment',   'part_time', 1.30),
  ('00000000-0000-4000-8000-000000000001', 'commitment',   'casual',    1.25),
  ('00000000-0000-4000-8000-000000000001', 'commitment',   'contract',  1.00),
  ('00000000-0000-4000-8000-000000000001', 'commitment',   'full_time', 0.85),
  ('00000000-0000-4000-8000-000000000001', 'commitment',   'unknown',   1.00),

  ('00000000-0000-4000-8000-000000000001', 'role_type',    'internship',1.20),
  ('00000000-0000-4000-8000-000000000001', 'role_type',    'job',       1.00),
  ('00000000-0000-4000-8000-000000000001', 'role_type',    'unknown',   1.00)
on conflict (filter_id, dimension, value) do nothing;

-- ---------- Sources ---------------------------------------------------------
-- Cadence is deliberately slow. Job boards do not turn over fast enough to
-- justify tighter polling, and both free tiers are metered per day.
insert into public.sources (name, enabled, poll_interval_minutes, max_calls_per_day)
values
  -- Adzuna free tier is the tighter budget of the two.
  ('adzuna',       true,  180, 200),
  ('jooble',       true,  240, 400),
  -- Phase 4. Off until specific career pages are supplied.
  ('careers_page', false, 720, 100)
on conflict (name) do nothing;

-- ---------- App settings ----------------------------------------------------
insert into public.app_settings (id, is_paused, notify_score_threshold, max_notifications_per_day)
values (1, false, 70, 25)
on conflict (id) do nothing;

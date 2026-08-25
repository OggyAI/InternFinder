# CLAUDE.md — intern_finder_bot

Job and internship discovery agent for a final-year IT/Cybersecurity student in
Melbourne on a **student visa**. Scans job boards, filters against editable
criteria, scores against a resume, notifies via Telegram and a dashboard.

Read `README.md` for setup. This file is the set of rules that must not be
broken by a future change.

---

## 1. Hard constraints (NON-NEGOTIABLE)

- **No auto-apply. No auto-form-fill.** Discovery and notification only. The
  human reviews and applies manually, every time. Nothing in this repo may
  submit an application, fill a form, or send anything to an employer.
- **No direct scraping of SEEK, LinkedIn, or Indeed.** ToS risk. API sources
  only. Jooble aggregates from those boards and that is fine — consuming their
  public API is the sanctioned path. Phase 4 adds Playwright scraping of
  *specific company career pages the user supplies*, and nothing else.
- **All credentials in environment variables.** Adzuna, Jooble, Telegram,
  Anthropic, Supabase. Never a literal, never a fallback default, never
  committed. `packages/core/src/env.ts` is the only place they are read.
- **The service_role key never reaches the browser.**
  `packages/core/src/supabase.ts` bypasses RLS and is worker-only. The Phase 3
  dashboard gets its own anon-key client under `apps/web`.
- **Filters are editable at runtime.** Anything the user might want to tune —
  keywords, radius, weights, cadence, thresholds — is a database row read fresh
  on every poll. If a change would require a redeploy to take effect, it is
  wrong. This is why `filters`, `filter_keywords`, `filter_preferences`,
  `sources` and `app_settings` exist as tables rather than constants.
- **Respect free-tier rate limits.** Cadence and daily call budgets live in the
  `sources` table and are enforced in `isSourceDue()` before any request.

## 2. Design rules

- **Preference weighting ranks; it never excludes.** Unpaid, in-person and
  part-time are surfaced harder, but a paid, remote, full-time role must still
  appear, and must be able to win on an exceptional resume match. The
  `[0.75, 1.35]` clamp in `preferences.ts` is what guarantees that, and there
  is a test asserting the break-even ratio stays achievable. Do not widen it
  without re-checking that test.
- **The pre-filter is exclusion-biased.** Job APIs do not expose duration, so a
  listing with no stated duration **passes**. Only reject on positive evidence
  of disqualification. Requiring a positive match on a field providers do not
  populate would silently empty the pipeline.
- **Rejections are stored, never deleted.** `prefilter_reasons` on every row.
  An over-aggressive filter must be diagnosable.
- **`raw_json` is never discarded.** Provider shapes drift; the raw payload is
  the only way to backfill a column we didn't think to add.
- **'unknown' is a first-class value on every signal axis** and always scores
  neutral. A confident wrong guess is worse than an honest shrug, because
  Phase 2 hands the same text to Claude and will do better.
- **Cost matters.** This loop runs continuously. Phase 2 uses **Sonnet, not
  Opus**, and batches sensibly. The rule-based pre-filter exists to keep listings
  away from the LLM, and its pass rate is a cost metric.

## 3. Stack

- **TypeScript everywhere**, npm workspaces. The worker and the Phase 3
  dashboard share `@intern-finder/core` so the filter and scoring logic exists
  exactly once and cannot drift.
- **Supabase** (Postgres + RLS). Migrations in `supabase/migrations`, applied
  with `supabase db push`. RLS default-deny on every table.
- **zod** at every boundary — env, provider responses, database rows.
- **Vitest**. No network, no database in tests.
- **tsx** to run; there is no build step.
- Worker runs under **systemd on an Oracle Cloud Always Free VM**.

## 4. Phase status

| Phase | State |
|---|---|
| 1 — schema, Adzuna/Jooble ingest, rule-based pre-filter | **done**, verified offline |
| 2 — Claude scoring, threshold promotion to `matches` | not started |
| 3 — Telegram bot, Next.js dashboard | not started |
| 4 — Playwright career-page scraping | not started, optional |

Phase 1 is verified against **fixtures, not live APIs** — the user had Supabase
credentials but not Adzuna/Jooble ones. The adapters are written to documented
response shapes. Confirm them against real responses on the first live run
before trusting Phase 2 output.

## 5. Gotchas that have already bitten

- **`whole_word` on short keywords.** Bare `IT` without a word boundary matches
  *security*, *monitor*, *editing*, *recruiting* — it passes everything. Same
  for `Intern` matching *internal*.
- **Adzuna's predicted salaries.** `salary_is_predicted` arrives as the string
  `"1"`, and a predicted salary is **not** evidence a role is paid. Treating it
  as such would mark every silent listing paid and suppress exactly the unpaid
  roles the weighting is meant to surface.
- **The radius is not "Melbourne".** From Hoppers Crossing, 50km reaches
  Geelong (42km) but excludes Lilydale and Berwick (both 59km).
- **Location segment order.** Providers write location most-specific-first
  (`"Footscray, Maribyrnong, Victoria"`). Take the first recognised segment.
  Sorting by length picks the council over the suburb.
- **Duration ranges take the lower bound.** An "8–12 week" internship must
  clear a 6-week floor on its 8, not its 12.

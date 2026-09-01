# intern_finder_bot

Background agent that scans job boards for Melbourne IT/cyber roles and casual work,
filters them against editable criteria, scores them against a resume, and notifies via
Telegram + a dashboard. **Discovery and notification only — no auto-apply, ever.**

**Phase 1 (this) is complete and verified offline.** Phases 2–4 are not started.

---

## What Phase 1 does

```
Adzuna ─┐
        ├─> normalise ─> dedupe ─> rule-based pre-filter ─> job_listings
Jooble ─┘                                                        │
                                                                 └─> Phase 2 queue
                                                                     (prefilter_status='passed')
```

Everything about *what* it looks for lives in database rows, not in code. Change a
keyword, the radius, or a preference weight and the next poll picks it up — no redeploy.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. See it work before configuring anything

```bash
npm run demo
```

Runs the full pipeline over bundled fixtures with no credentials and no database.
Prints every listing, its extracted signals, its rank multiplier, and — for rejects —
exactly why it was dropped.

### 3. Create the Supabase project

| Setting | Choose | Why |
|---|---|---|
| Region | **Sydney (`ap-southeast-2`)** | Closest to you and the Oracle VM. Cannot be changed later. |
| Enable Data API | **On** | Required. `supabase-js` talks to PostgREST, which *is* the Data API. |
| Automatically expose new tables | **Off** | Supabase's own recommendation. The migration grants privileges explicitly, so this toggle doesn't affect us either way. |
| Enable automatic RLS | **On** | Free safety net for Phase 2/3 tables. The migration already enables RLS on all 9 tables, so it changes nothing today. |
| Postgres Type | **Postgres (default)** | OrioleDB is alpha. Cannot be changed later. |

Save the database password shown at creation — it is not displayed again.

### 4. Apply the schema

The Supabase CLI isn't installed on this machine yet:

```bash
npm install -g supabase
```

Then, from the repo root — **run `supabase init` first**, so the CLI writes a
`config.toml` matching its own version. It leaves the existing `migrations/` alone:

```bash
supabase init
```

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

```bash
supabase db push
```

`YOUR_PROJECT_REF` is the subdomain of your project URL
(`https://<ref>.supabase.co`), also shown under Project Settings → General.

That applies two migrations:

| Migration | What it does |
|---|---|
| `20260823090000_init.sql` | All 9 tables, indexes, `updated_at` triggers, RLS default-deny |
| `20260823090100_seed_filters.sql` | Your criteria as editable rows |

Both are idempotent — re-running `db push` will not clobber edits you've made in
production.

### 5. Environment

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API).
The service_role key bypasses RLS — worker only, never the browser.

### 6. Get the job board keys

Neither is needed to run the demo or the tests, but both are needed for live polling.

- **Adzuna** — register at <https://developer.adzuna.com/>. Gives an `app_id` and an
  `app_key`. Free tier is metered per day; `sources.max_calls_per_day` is seeded to 200
  as a guard.
- **Jooble** — request a key at <https://jooble.org/api/about>.

### 7. Run

```bash
npm run worker:once
```

One cycle against live APIs, then exit. Add `--dry-run` to see what *would* be written:

```bash
npm run worker -- --once --dry-run
```

Long-running loop (what systemd runs):

```bash
npm run worker
```

**Worker flags:** `--once`, `--dry-run`, `--fixtures` (read from disk instead of the
network), `--force` (ignore poll cadence and quota gating), `--source=adzuna,jooble`.

---

## Deploying to the Oracle VM

**Deployed and running** as `intern-finder-worker` on the Ubuntu 22.04 E2.1.Micro that
also runs `libstaffer-bot`.

| | |
|---|---|
| App | `/home/ubuntu/intern-finder-bot`, run as `ubuntu` |
| Secrets | `/home/ubuntu/intern-finder-bot/.env`, mode `0600` (same convention as libstaffer-bot) |
| Repo access | Read-only GitHub deploy key at `~/.ssh/id_internfinder` |
| Runtime | Node 22 from NodeSource — Ubuntu 22.04's default Node is far too old |
| Swap | 2 GB swapfile. The box has 956 MB RAM and shipped with none; `npm install` peaks around 139 MB and does touch swap |
| Memory limits | `MemoryHigh=200M` / `MemoryMax=300M`, set from a measured cycle that peaked at 121.5 MB |

Update it — pull, install, typecheck, doctor, restart:

```bash
~/intern-finder-bot/apps/worker/deploy/update.sh
```

Logs:

```bash
journalctl -u intern-finder-worker -f
```

**The VM is on UTC.** `recordPoll()` rolls each source's daily quota at UTC midnight,
so the Adzuna budget resets around 10am Melbourne time.

---

## The criteria, and how to change them

| Table | Holds |
|---|---|
| `filters` | Centre point, radius, duration window, age cutoff, toggles |
| `filter_keywords` | Include / exclude / work-rights terms, per-term weight |
| `filter_preferences` | The soft weighting across 4 axes |
| `sources` | Per-source enable, cadence, daily call budget |
| `app_settings` | Pause switch, notify threshold |

Seeded to a **Melbourne CBD placeholder** with a **50km** radius, minimum **6 weeks**,
no upper bound, listings under **30 days** old, work-rights excludes **on**.

The centre point is a placeholder on purpose — set it to wherever you actually search
from, then re-evaluate everything already stored:

```sql
update public.filters
   set center_label = 'Your Suburb STATE 0000',
       center_lat = -00.0000, center_lng = 000.0000
 where is_active;
```

```bash
npm run reprocess
```

### Soft preference weighting

Weighting **ranks, it never excludes**. Each axis contributes a multiplier; the product
is clamped to `[0.75, 1.35]`.

| Axis | Surfaced harder | Neutral | Ranked lower |
|---|---|---|---|
| Compensation | unpaid (1.35) | paid (1.00) | — |
| Work mode | onsite (1.30), hybrid (1.10) | — | remote (0.85) |
| Commitment | part-time (1.30), casual (1.25) | contract (1.00) | full-time (0.85) |
| Role type | internship (1.20) | job (1.00) | — |

The `1.35 / 0.75` spread means a paid/remote/full-time role needs roughly **1.8× the
resume fit** to outrank an unpaid/onsite/part-time one — ranked lower, but able to win
when the match is genuinely exceptional. That is the brief's requirement, and
[`preferences.test.ts`](packages/core/src/preferences.test.ts) guards it.

---

## Things worth knowing before Phase 2

**Unpaid roles barely exist on these two sources.** Adzuna and Jooble are paid-job
aggregators. The unpaid weighting is fully built and works, but it has very little to
act on until a volunteer source (SEEK Volunteer, GoVolunteer, Volunteering Victoria) is
added. The one unpaid listing in the fixtures came via Jooble from `volunteer.com.au`,
which is a real but thin path.

**Duration filtering is exclusion-only.** No job API exposes duration as a structured
field, so it's parsed out of prose. A listing that doesn't state a duration **passes** —
silence isn't evidence of a short role, and requiring a positive 6-week match would
throw away nearly every real internship. Only a stated-and-clearly-too-short duration
gets rejected.

**The radius is not "Melbourne", and what it reaches depends entirely on your centre
point.** From the CBD a 50km circle covers Lilydale (35km) but not Geelong (65km). Move
the centre to an outer western suburb and it inverts — Geelong falls to 42km while
Lilydale climbs to 59km, so genuinely-Melbourne eastern roles get dropped on distance.
Check what your own centre actually reaches before deciding the radius is wrong.

**Rejections are kept, not deleted.** Every dropped listing is stored with its reasons
in `prefilter_reasons`. An over-aggressive filter shows up as a pile of rows sharing one
reason rather than as an empty inbox.

**The API response shapes are unverified.** Both adapters are written against Adzuna's
and Jooble's *documented* responses, not captured traffic — there were no keys available
when Phase 1 was built. Every field is optional, parsing is defensive, and the full
payload is kept in `raw_json`. Confirm against a real response on the first live run.

---

## Layout

```
supabase/migrations/     schema + seed
packages/core/           shared logic (worker today, dashboard in Phase 3)
  src/geo.ts             haversine + suburb resolution
  src/signals.ts         text sniffing for the 4 preference axes + duration
  src/prefilter.ts       the rule-based gate
  src/preferences.ts     soft weighting
  src/dedupe.ts          URL canonicalisation + fingerprinting
apps/worker/             the polling loop
  src/sources/           Adzuna, Jooble, fixture adapters
  src/ingest.ts          dedupe -> prefilter -> upsert
  deploy/                systemd unit
```

## Tests

```bash
npm test
```

150 tests, no network, no database. Includes an end-to-end pipeline test over the
fixtures and a drift guard that fails if the test criteria stop matching the seed
migration.

```bash
npm run typecheck
```

---

## The dashboard (`apps/web`)

A Next.js App Router dashboard: overview, matches with Applied/Save/Dismiss,
rejection diagnostics, and runtime-editable filters and settings.

```bash
npm run web          # http://localhost:3000
npm run web:build    # production build
```

`DASHBOARD_PASSWORD` gates the whole site. **Unset means every page returns
503** — an unconfigured deployment stays shut rather than serving the database
to whoever finds the URL. Generate one with:

```bash
openssl rand -base64 24
```

### How it reads the database

Server-side only. Every query runs in a Server Component or a Server Action
using the service-role key, and the browser receives rendered HTML — it never
holds a Supabase client. `src/lib/data.ts` begins with `import 'server-only'`,
so importing it from a Client Component fails the build instead of shipping the
key to the browser.

This is deliberately **not** the anon-key client the original plan called for.
RLS is default-deny and privileges are revoked from `anon`, so an anon client
reads nothing; the policies that would change that would publish the pipeline
to anyone holding a key that ships inside the browser bundle.

### Deploying to Vercel

The worker stays on the Oracle VM — it is a continuous loop holding a 25-second
Telegram long poll, which serverless cannot do. Only the dashboard goes to
Vercel, and it talks to Supabase directly.

1. Import the GitHub repo in Vercel.
2. Set **Root Directory** to `apps/web`.
3. Add these Environment Variables (Production and Preview):

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | same as the worker's |
   | `SUPABASE_SERVICE_ROLE_KEY` | same as the worker's |
   | `DASHBOARD_PASSWORD` | a long random string |

   None of them are prefixed `NEXT_PUBLIC_`, and they must not be — that prefix
   inlines a value into the browser bundle.
4. Deploy, then open the URL and sign in.

Preview deployments get the same environment, so treat a preview URL as just as
sensitive as production.

### Local development note

Next reads `.env` from its own directory, but this repo keeps one `.env` at the
workspace root. `apps/web/scripts/with-env.mjs` loads that file *before*
starting Next so the server, the render workers and the Edge middleware runtime
all inherit it. Loading it from `next.config.mjs` does not work — those are
separate processes. On Vercel the wrapper finds no file and does nothing.

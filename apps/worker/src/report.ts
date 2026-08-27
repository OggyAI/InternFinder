import { getServiceClient } from '@intern-finder/core';

/**
 * `npm run report` — what is actually in job_listings.
 *
 * Until the Phase 3 dashboard exists there is no way to see the pipeline's
 * output, and "669 passed" is not an answer to "is any of this any good?".
 * This reads only; it never calls a job board, so it is free to run.
 *
 *   npm run report              top passing listings
 *   npm run report -- --all     include rejected ones
 *   npm run report -- --n=40    how many to show
 */

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const limit = Number(args.find((a) => a.startsWith('--n='))?.slice(4) ?? 25);

const db = getServiceClient();

/** Shape of the columns selected below. supabase-js cannot infer a type
 *  through a concatenated select string, so state it once here. */
interface ListingRow {
  title: string;
  company: string | null;
  location_suburb: string | null;
  distance_km: number | null;
  prefilter_status: string;
  prefilter_reasons: string[];
  preference_multiplier: number;
  compensation: string;
  work_mode: string;
  commitment: string;
  role_type: string;
  duration_weeks: number | null;
  salary_min: number | null;
  salary_is_predicted: boolean;
  posted_date: string | null;
  url: string;
}

function bar(label: string, n: number, total: number, width = 28): string {
  const filled = total > 0 ? Math.round((n / total) * width) : 0;
  return `  ${label.padEnd(12)} ${'#'.repeat(filled).padEnd(width)} ${String(n).padStart(4)}`;
}

async function main(): Promise<void> {
  const { count: total } = await db
    .from('job_listings')
    .select('*', { count: 'exact', head: true });

  const { data: rows, error } = await db
    .from('job_listings')
    .select(
      'title, company, location_suburb, distance_km, prefilter_status, prefilter_reasons, ' +
        'preference_multiplier, compensation, work_mode, commitment, role_type, ' +
        'duration_weeks, salary_min, salary_is_predicted, posted_date, url',
    )
    .order('preference_multiplier', { ascending: false })
    .limit(2000);

  if (error) throw new Error(error.message);
  const all = (rows ?? []) as unknown as ListingRow[];
  const passed = all.filter((r) => r.prefilter_status === 'passed');

  console.log(`\n${total} listings stored, ${passed.length} passing the pre-filter\n`);

  // --- Distributions, to see whether the signals are doing anything --------
  for (const axis of ['role_type', 'compensation', 'work_mode', 'commitment'] as const) {
    const counts = new Map<string, number>();
    for (const r of passed) {
      const v = r[axis];
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    console.log(`${axis}`);
    for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(bar(k, v, passed.length));
    }
    console.log('');
  }

  const withDuration = passed.filter((r) => r.duration_weeks !== null).length;
  const withRealSalary = passed.filter(
    (r) => r.salary_min !== null && !r.salary_is_predicted,
  ).length;
  console.log(
    `duration stated  ${withDuration}/${passed.length}` +
      `   real salary stated  ${withRealSalary}/${passed.length}\n`,
  );

  // --- Scored matches (Phase 2) --------------------------------------------
  const { data: matchData, count: matchCount } = await db
    .from('matches')
    .select('fit_score,base_score,preference_multiplier,category,status,reasoning,listing_id', { count: 'exact' })
    .order('fit_score', { ascending: false })
    // fit_score clamps at 100, so several listings tie there. base_score is the
    // unclamped judgement and breaks those ties in the order that means something.
    .order('base_score', { ascending: false })
    .limit(2000);

  const matches = (matchData ?? []) as unknown as {
    fit_score: number; base_score: number; preference_multiplier: number;
    category: string; status: string; reasoning: string; listing_id: string;
  }[];

  if (matches.length > 0) {
    const { data: settingsRow } = await db
      .from('app_settings').select('notify_score_threshold,scoring_spend_today').eq('id', 1).maybeSingle();
    const st = settingsRow as { notify_score_threshold: number; scoring_spend_today: number } | null;
    const threshold = st?.notify_score_threshold ?? 70;

    console.log(`${matchCount} scored, $${Number(st?.scoring_spend_today ?? 0).toFixed(4)} spent today
`);
    console.log('fit score');
    const buckets = new Map<string, number>();
    for (const m of matches) {
      const b = m.fit_score >= 80 ? '80-100' : m.fit_score >= 70 ? '70-79'
        : m.fit_score >= 50 ? '50-69' : m.fit_score >= 25 ? '25-49' : '0-24';
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    for (const b of ['80-100', '70-79', '50-69', '25-49', '0-24']) {
      console.log(bar(b, buckets.get(b) ?? 0, matches.length));
    }

    const worthSeeing = matches.filter((m) => m.fit_score >= threshold);
    console.log(`
${worthSeeing.length} at or above the notify threshold of ${threshold}
`);

    const titles = new Map<string, string>();
    for (const r of all) titles.set(r.url, r.title);
    console.log(`Top ${Math.min(limit, worthSeeing.length)} matches:
`);
    for (const m of worthSeeing.slice(0, limit)) {
      const { data: l } = await db
        .from('job_listings').select('title,company,location_suburb,distance_km,url')
        .eq('id', m.listing_id).single();
      const j = l as { title: string; company: string | null; location_suburb: string | null; distance_km: number | null; url: string };
      console.log(`${String(m.fit_score).padStart(3)}  base ${String(m.base_score).padStart(3)} x${Number(m.preference_multiplier).toFixed(2)}  [${m.category}/${m.status}]  ${j.title}`);
      console.log(`     ${j.company ?? '?'} · ${j.location_suburb ?? '?'}${j.distance_km !== null ? ` · ${Math.round(j.distance_km)}km` : ''}`);
      console.log(`     ${m.reasoning}`);
      console.log(`     ${j.url}
`);
    }
  }

  // --- The actual listings -------------------------------------------------
  const show = (showAll ? all : passed).slice(0, limit);
  console.log(`Top ${show.length} by preference multiplier:\n`);
  for (const r of show) {
    const mark = r.prefilter_status === 'passed' ? 'PASS' : 'DROP';
    const dist = r.distance_km === null ? '   ?' : String(Math.round(r.distance_km)).padStart(4);
    console.log(
      `${mark} x${Number(r.preference_multiplier).toFixed(2)} ${dist}km  ${r.title}`,
    );
    console.log(
      `                  ${r.company ?? '?'} · ${r.location_suburb ?? '?'} · ` +
        `${r.compensation}/${r.work_mode}/${r.commitment}/${r.role_type}` +
        (r.duration_weeks !== null ? ` ~${r.duration_weeks}w` : ''),
    );
    if (r.prefilter_status !== 'passed') {
      console.log(`                  ! ${r.prefilter_reasons.join(' | ')}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

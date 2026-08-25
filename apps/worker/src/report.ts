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

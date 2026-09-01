import { getServiceClient } from './supabase';
import type { StatsSummary } from './telegram-format';

/**
 * One definition of "how is the pipeline doing", shared by `npm run doctor`,
 * the Telegram /stats command and the dashboard overview.
 *
 * In core rather than in the worker because the dashboard needs the same
 * numbers, and three implementations of "how many are awaiting a score" would
 * disagree the moment one of them was updated.
 *
 * Shared because it was already drifting. doctor computed the scoring backlog
 * as `passed - scored`, which was right until near-duplicate suppression
 * shipped: duplicates are `passed` but are deliberately never scored, so that
 * subtraction leaves a permanent phantom backlog that never reaches zero. The
 * queue the worker actually works from is "passed AND not a duplicate AND has
 * no match row", and this is that.
 */

/** The check constraint on matches.status, in the order /stats reads best. */
const MATCH_STATUSES = ['new', 'notified', 'saved', 'applied', 'dismissed'] as const;

/**
 * `head: true` is safe HERE and nowhere else in this project: these tables are
 * known to exist because the worker has already read from them. On a MISSING
 * table PostgREST answers a HEAD request with a bodiless 404, which supabase-js
 * reports as `error: null, count: null` — indistinguishable from an empty
 * table, and the reason `checkConnection()` uses a real GET.
 */
async function countRows(
  table: 'job_listings' | 'matches',
  apply: (q: any) => any = (q) => q,
  select = '*',
): Promise<number> {
  const db = getServiceClient();
  const { count, error } = await apply(
    db.from(table).select(select, { count: 'exact', head: true }),
  );
  if (error) throw new Error(`${table} count failed: ${error.message}`);
  return count ?? 0;
}

export async function collectPipelineStats(): Promise<StatsSummary> {
  const db = getServiceClient();

  const listingsTotal = await countRows('job_listings');
  const listingsPassed = await countRows('job_listings', (q) =>
    q.eq('prefilter_status', 'passed'),
  );
  const duplicates = await countRows('job_listings', (q) => q.not('duplicate_of', 'is', null));

  // The real denominator: what scoring will ever be asked to look at.
  const scorable = await countRows('job_listings', (q) =>
    q.eq('prefilter_status', 'passed').is('duplicate_of', null),
  );
  const scored = await countRows('matches');
  // Scored AND still scorable. A listing scored before it was recognised as a
  // duplicate is excluded from both sides, so the subtraction stays honest.
  const scoredScorable = await countRows(
    'matches',
    (q) =>
      q
        .eq('job_listings.prefilter_status', 'passed')
        .is('job_listings.duplicate_of', null),
    '*, job_listings!inner(id)',
  );

  const { data: settingsRow, error: settingsError } = await db
    .from('app_settings')
    .select(
      'notify_score_threshold,max_notifications_per_day,is_paused,' +
        'scoring_spend_today,max_scoring_spend_usd_per_day',
    )
    .eq('id', 1)
    .maybeSingle();
  if (settingsError) throw new Error(`app_settings read failed: ${settingsError.message}`);
  const settings = settingsRow as {
    notify_score_threshold: number;
    max_notifications_per_day: number;
    is_paused: boolean;
    scoring_spend_today: number;
    max_scoring_spend_usd_per_day: number;
  } | null;

  const threshold = settings?.notify_score_threshold ?? 70;

  const aboveThreshold = await countRows(
    'matches',
    (q) => q.gte('fit_score', threshold).is('job_listings.duplicate_of', null),
    '*, job_listings!inner(id)',
  );

  // Counted per status rather than by pulling rows and tallying them.
  // PostgREST caps a response at 1000 rows whatever `.limit()` says, so the
  // tally silently described only the oldest 1000 matches — every one of them
  // still `new`, which reported "new 1000 · saved 0 · applied 0" on a phone
  // immediately after two decisions had been made.
  const byStatus: Record<string, number> = {};
  for (const status of MATCH_STATUSES) {
    byStatus[status] = await countRows('matches', (q) => q.eq('status', status));
  }

  return {
    listingsTotal,
    listingsPassed,
    duplicates,
    scored,
    awaitingScore: Math.max(0, scorable - scoredScorable),
    aboveThreshold,
    threshold,
    spentToday: Number(settings?.scoring_spend_today ?? 0),
    spendCapPerDay: Number(settings?.max_scoring_spend_usd_per_day ?? 0),
    notifiedToday: await notificationsSentToday(),
    notifyCapPerDay: settings?.max_notifications_per_day ?? 0,
    paused: settings?.is_paused ?? false,
    byStatus,
  };
}

/**
 * Notifications already sent in the current UTC day. The VM runs on UTC, so
 * this rolls at UTC midnight — the same boundary as the source call quotas and
 * the scoring spend, deliberately, so "today" means one thing project-wide.
 *
 * Derived by counting log rows rather than kept as a counter column: a counter
 * would drift the moment a send failed halfway through updating it, and the
 * log is written anyway for diagnosis.
 */
export async function notificationsSentToday(): Promise<number> {
  const db = getServiceClient();
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const { count, error } = await db
    .from('notification_log')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'telegram')
    .eq('status', 'sent')
    .gte('sent_at', since.toISOString());

  if (error) throw new Error(`notification_log read failed: ${error.message}`);
  return count ?? 0;
}

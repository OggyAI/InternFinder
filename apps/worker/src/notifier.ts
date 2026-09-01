import {
  formatMatch,
  getEnv,
  getServiceClient,
  log,
  matchKeyboard,
  notificationsSentToday,
  sendMessage,
  TelegramError,
  type NotifiableMatch,
} from '@intern-finder/core';

/**
 * Send the matches worth seeing, once each.
 *
 * Runs after scoring in every cycle. The queue is "scored at or above the
 * threshold and still `new`", which means it is derived from durable state
 * rather than from what happened during this run — a crashed cycle, a revoked
 * token or a week of downtime all resolve by simply running again.
 *
 * NOTHING HERE CONTACTS AN EMPLOYER. It sends the human a link and three
 * buttons that write to our own database.
 */

export interface NotifyStats {
  candidates: number;
  sent: number;
  failed: number;
  /** Matches left unsent because the daily cap was reached. */
  deferred: number;
  reason?: string;
}

interface MatchRow {
  id: string;
  fit_score: number;
  base_score: number;
  preference_multiplier: number;
  category: string;
  compensation: string;
  work_mode: string;
  commitment: string;
  duration_weeks: number | null;
  reasoning: string;
  job_listings: {
    title: string;
    company: string | null;
    location_suburb: string | null;
    distance_km: number | null;
    url: string;
    posted_date: string | null;
  } | null;
}

export async function runNotifier(opts: { dryRun?: boolean } = {}): Promise<NotifyStats> {
  const stats: NotifyStats = { candidates: 0, sent: 0, failed: 0, deferred: 0 };
  const env = getEnv();
  const db = getServiceClient();

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    stats.reason = 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set';
    return stats;
  }

  const { data: settingsRow, error: settingsError } = await db
    .from('app_settings')
    .select('notify_score_threshold,max_notifications_per_day,is_paused')
    .eq('id', 1)
    .maybeSingle();
  if (settingsError) throw new Error(`app_settings read failed: ${settingsError.message}`);
  const settings = settingsRow as {
    notify_score_threshold: number;
    max_notifications_per_day: number;
    is_paused: boolean;
  } | null;
  if (!settings) {
    stats.reason = 'app_settings row missing';
    return stats;
  }

  if (settings.is_paused) {
    stats.reason = 'paused';
    return stats;
  }

  const sentToday = await notificationsSentToday();
  const remaining = settings.max_notifications_per_day - sentToday;
  if (remaining <= 0) {
    stats.reason = `daily notification cap reached (${sentToday}/${settings.max_notifications_per_day})`;
    return stats;
  }

  // !inner so the duplicate filter on the embedded table actually restricts the
  // result; without it a match whose listing is a duplicate comes back with a
  // null listing rather than being excluded.
  const { data, error } = await db
    .from('matches')
    .select(
      'id,fit_score,base_score,preference_multiplier,category,compensation,work_mode,' +
        'commitment,duration_weeks,reasoning,' +
        'job_listings!inner(title,company,location_suburb,distance_km,url,posted_date)',
    )
    .eq('status', 'new')
    .gte('fit_score', settings.notify_score_threshold)
    .is('job_listings.duplicate_of', null)
    .order('fit_score', { ascending: false })
    .order('base_score', { ascending: false })
    .limit(100);

  if (error) throw new Error(`match queue read failed: ${error.message}`);

  const rows = (data ?? []) as unknown as MatchRow[];
  stats.candidates = rows.length;
  if (rows.length === 0) return stats;

  const batch = rows.slice(0, remaining);
  stats.deferred = rows.length - batch.length;

  if (opts.dryRun) {
    stats.reason = `dry run — would send ${batch.length}`;
    return stats;
  }

  for (const row of batch) {
    const listing = row.job_listings;
    if (!listing) continue;

    const match: NotifiableMatch = {
      matchId: row.id,
      fitScore: row.fit_score,
      baseScore: row.base_score,
      preferenceMultiplier: Number(row.preference_multiplier),
      category: row.category,
      compensation: row.compensation,
      workMode: row.work_mode,
      commitment: row.commitment,
      durationWeeks: row.duration_weeks,
      reasoning: row.reasoning,
      title: listing.title,
      company: listing.company,
      locationSuburb: listing.location_suburb,
      distanceKm: listing.distance_km === null ? null : Number(listing.distance_km),
      url: listing.url,
      postedDate: listing.posted_date,
    };

    const text = formatMatch(match);

    try {
      const message = await sendMessage(env.TELEGRAM_BOT_TOKEN, {
        chatId: env.TELEGRAM_CHAT_ID,
        text,
        keyboard: matchKeyboard(row.id),
      });

      // Log BEFORE flipping status. If the process dies between the two, the
      // match stays 'new' and is re-sent next cycle — a duplicate message,
      // which costs one tap. Flipping first would risk a match that was never
      // actually delivered being marked notified and never seen again.
      await db.from('notification_log').insert({
        match_id: row.id,
        channel: 'telegram',
        telegram_chat_id: env.TELEGRAM_CHAT_ID,
        telegram_message_id: message.message_id,
        payload: text,
        status: 'sent',
      });

      const { error: statusError } = await db
        .from('matches')
        .update({ status: 'notified' })
        .eq('id', row.id)
        .eq('status', 'new');
      if (statusError) {
        log.warn(`notify: sent but could not mark ${row.id} notified — ${statusError.message}`);
      }

      stats.sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.failed++;
      log.error(`notify: ${listing.title} — ${message}`);

      await db.from('notification_log').insert({
        match_id: row.id,
        channel: 'telegram',
        telegram_chat_id: env.TELEGRAM_CHAT_ID,
        payload: text,
        status: 'failed',
        error: message.slice(0, 500),
      });

      // A revoked token or a wrong chat id fails identically for every row.
      // Stop rather than logging the same 401 twenty-five times.
      if (err instanceof TelegramError && err.errorCode === 401) {
        stats.reason = 'bot token rejected (401) — stopped';
        break;
      }
      if (err instanceof TelegramError && err.errorCode === 400 && /chat not found/i.test(message)) {
        stats.reason = 'chat not found — check TELEGRAM_CHAT_ID';
        break;
      }
    }

    // Telegram tolerates about one message per second to a single chat.
    await new Promise((r) => setTimeout(r, 400));
  }

  return stats;
}

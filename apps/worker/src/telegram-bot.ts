import {
  AbortedError,
  COMMANDS,
  HELP_TEXT,
  answerCallbackQuery,
  collectPipelineStats,
  decodeCallback,
  editMessageText,
  formatFilters,
  formatHistory,
  formatMatch,
  formatStats,
  getEnv,
  getServiceClient,
  getUpdates,
  loadActiveFilter,
  log,
  matchKeyboard,
  sendMessage,
  setMyCommands,
  sleep,
  withDecision,
  type MatchDecision,
  type NotifiableMatch,
  type TelegramUpdate,
} from '@intern-finder/core';

/**
 * The command and button side of the Telegram bot.
 *
 * Runs CONCURRENTLY with the poll loop rather than inside it. A cycle can take
 * minutes, and a bot that only listened between cycles would leave /pause
 * unanswered for exactly as long as the thing you were trying to stop kept
 * running. It also means the bot stays responsive while `is_paused` is true —
 * otherwise /resume could never be delivered.
 *
 * Long polling, so there is no inbound port and nothing to secure at the
 * network layer. Authorisation is instead a single check against
 * TELEGRAM_CHAT_ID: a bot token is a bearer credential that anyone who
 * discovers the username can message, and without this check a stranger could
 * read the user's job pipeline and pause their search.
 */

interface Context {
  token: string;
  chatId: string;
}

const AUTH_REFUSAL =
  'This bot is private and is not configured to talk to this chat.';

/** Strip the `@botname` Telegram appends in groups, and lowercase. */
function parseCommand(text: string): { command: string; args: string } | null {
  const match = /^\/([a-z_]+)(?:@\S+)?\s*(.*)$/is.exec(text.trim());
  if (!match) return null;
  return { command: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() };
}

async function reply(ctx: Context, text: string): Promise<void> {
  await sendMessage(ctx.token, { chatId: ctx.chatId, text });
}

// --- Commands --------------------------------------------------------------

async function commandStats(ctx: Context): Promise<void> {
  await reply(ctx, formatStats(await collectPipelineStats()));
}

async function commandFilters(ctx: Context): Promise<void> {
  const db = getServiceClient();
  const filterSet = await loadActiveFilter();
  const { data } = await db
    .from('app_settings')
    .select('notify_score_threshold')
    .eq('id', 1)
    .maybeSingle();

  const active = filterSet.keywords.filter((k) => k.is_active);
  await reply(
    ctx,
    formatFilters({
      name: filterSet.filter.name,
      centerLabel: filterSet.filter.center_label,
      radiusKm: filterSet.filter.radius_km,
      includeKeywords: active.filter((k) => k.kind === 'include').map((k) => k.term),
      excludeKeywords: active.filter((k) => k.kind !== 'include').map((k) => k.term),
      threshold: (data as { notify_score_threshold: number } | null)?.notify_score_threshold ?? 70,
      preferences: filterSet.preferences
        .filter((p) => p.is_active)
        .map((p) => ({ axis: p.dimension, value: p.value, weight: p.weight })),
    }),
  );
}

async function setPaused(ctx: Context, paused: boolean): Promise<void> {
  const db = getServiceClient();
  const { error } = await db.from('app_settings').update({ is_paused: paused }).eq('id', 1);
  if (error) {
    await reply(ctx, `Could not update: ${error.message}`);
    return;
  }
  await reply(
    ctx,
    paused
      ? '⏸ Paused. No polling, no scoring, no notifications. Nothing already found is lost — /resume when you want it back.'
      : '▶️ Resumed. The next cycle will poll, score and notify as normal.',
  );
}

async function commandHistory(ctx: Context): Promise<void> {
  const db = getServiceClient();
  const { data, error } = await db
    .from('matches')
    .select('fit_score,status,job_listings!inner(title,company,url)')
    .in('status', ['applied', 'dismissed', 'saved'])
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as {
    fit_score: number;
    status: string;
    job_listings: { title: string; company: string | null; url: string } | null;
  }[];

  await reply(
    ctx,
    formatHistory(
      rows
        .filter((r) => r.job_listings)
        .map((r) => ({
          fitScore: r.fit_score,
          title: r.job_listings!.title,
          company: r.job_listings!.company,
          status: r.status,
          url: r.job_listings!.url,
        })),
    ),
  );
}

/**
 * The best matches you have not decided on yet.
 *
 * Includes ones already notified, because the point of /top is "show me the
 * shortlist again" — a card scrolled past a week ago is exactly what this is
 * for. Anything applied, saved or dismissed is a settled decision and stays out.
 */
async function commandTop(ctx: Context, args: string): Promise<void> {
  const db = getServiceClient();
  const requested = Number.parseInt(args, 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 10) : 5;

  const { data, error } = await db
    .from('matches')
    .select(
      'id,fit_score,base_score,preference_multiplier,category,compensation,work_mode,' +
        'commitment,duration_weeks,reasoning,' +
        'job_listings!inner(title,company,location_suburb,distance_km,url,posted_date)',
    )
    .in('status', ['new', 'notified'])
    .is('job_listings.duplicate_of', null)
    .order('fit_score', { ascending: false })
    .order('base_score', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as {
    id: string; fit_score: number; base_score: number; preference_multiplier: number;
    category: string; compensation: string; work_mode: string; commitment: string;
    duration_weeks: number | null; reasoning: string;
    job_listings: {
      title: string; company: string | null; location_suburb: string | null;
      distance_km: number | null; url: string; posted_date: string | null;
    } | null;
  }[];

  if (rows.length === 0) {
    await reply(ctx, 'Nothing undecided right now. /stats shows where the pipeline is.');
    return;
  }

  for (const row of rows) {
    const listing = row.job_listings!;
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
    await sendMessage(ctx.token, {
      chatId: ctx.chatId,
      text: formatMatch(match),
      keyboard: matchKeyboard(row.id),
    });
    await new Promise((r) => setTimeout(r, 400));
  }
}

// --- Buttons ---------------------------------------------------------------

const DECISION_TOAST: Record<MatchDecision, string> = {
  applied: 'Recorded as applied',
  saved: 'Saved',
  dismissed: 'Dismissed',
};

/**
 * A tapped button.
 *
 * Writes one row in our own database and edits the message. It does not, and
 * must not, contact the employer — "Applied" records that the human applied,
 * it does not apply on their behalf.
 */
async function handleCallback(
  ctx: Context,
  callbackId: string,
  data: string | undefined,
  message: { message_id: number } | undefined,
): Promise<void> {
  const decoded = decodeCallback(data);
  if (!decoded) {
    await answerCallbackQuery(ctx.token, callbackId, 'Unrecognised button');
    return;
  }

  const db = getServiceClient();
  const { error } = await db
    .from('matches')
    .update({ status: decoded.decision })
    .eq('id', decoded.matchId);

  if (error) {
    // Answer regardless — an unanswered callback spins on the phone forever.
    await answerCallbackQuery(ctx.token, callbackId, 'Could not save that');
    log.error(`callback: ${decoded.decision} on ${decoded.matchId} — ${error.message}`);
    return;
  }

  await answerCallbackQuery(ctx.token, callbackId, DECISION_TOAST[decoded.decision]);

  if (message) {
    const { data: logRow } = await db
      .from('notification_log')
      .select('payload')
      .eq('telegram_message_id', message.message_id)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const original = (logRow as { payload: string | null } | null)?.payload;
    if (original) {
      // Buttons dropped: the decision is made, and leaving them invites a
      // second tap that would silently overwrite the first.
      await editMessageText(ctx.token, {
        chatId: ctx.chatId,
        messageId: message.message_id,
        text: withDecision(original, decoded.decision),
      });
    }
  }
}

// --- Dispatch --------------------------------------------------------------

export async function handleUpdate(update: TelegramUpdate, ctx: Context): Promise<void> {
  if (update.callback_query) {
    const query = update.callback_query;
    const fromChat = query.message?.chat.id ?? query.from.id;
    if (String(fromChat) !== ctx.chatId) {
      await answerCallbackQuery(ctx.token, query.id, AUTH_REFUSAL);
      log.warn(`telegram: ignored callback from unauthorised chat ${fromChat}`);
      return;
    }
    await handleCallback(ctx, query.id, query.data, query.message);
    return;
  }

  const message = update.message;
  if (!message?.text) return;

  if (String(message.chat.id) !== ctx.chatId) {
    log.warn(`telegram: ignored message from unauthorised chat ${message.chat.id}`);
    await sendMessage(ctx.token, { chatId: String(message.chat.id), text: AUTH_REFUSAL });
    return;
  }

  const parsed = parseCommand(message.text);
  if (!parsed) {
    await reply(ctx, 'I only understand commands. /help for the list.');
    return;
  }

  switch (parsed.command) {
    case 'start':
    case 'help':
      await reply(ctx, HELP_TEXT);
      break;
    case 'stats':
      await commandStats(ctx);
      break;
    case 'filters':
      await commandFilters(ctx);
      break;
    case 'history':
      await commandHistory(ctx);
      break;
    case 'top':
      await commandTop(ctx, parsed.args);
      break;
    case 'pause':
      await setPaused(ctx, true);
      break;
    case 'resume':
      await setPaused(ctx, false);
      break;
    default:
      await reply(ctx, `I don't know /${parsed.command}. /help for the list.`);
  }
}

export function botContext(): Context | null {
  const env = getEnv();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;
  return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
}

/**
 * Poll for updates until told to stop.
 *
 * Never throws: this runs alongside the poll loop, and a Telegram outage must
 * not take ingestion down with it.
 */
export async function runBot(
  shouldStop: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const ctx = botContext();
  if (!ctx) {
    log.info('telegram: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — bot disabled');
    return;
  }

  try {
    await setMyCommands(ctx.token, COMMANDS);
  } catch (err) {
    log.debug(`telegram: setMyCommands failed — ${err instanceof Error ? err.message : err}`);
  }

  log.info('telegram: listening for commands');
  let offset: number | undefined;
  let consecutiveFailures = 0;

  while (!shouldStop()) {
    try {
      const updates = await getUpdates(ctx.token, { offset, timeoutSeconds: 25, signal });
      consecutiveFailures = 0;

      for (const update of updates) {
        // Advance the offset BEFORE handling, which confirms the update to
        // Telegram. A handler that throws is logged and dropped rather than
        // redelivered forever — one poison update must not wedge the bot.
        offset = update.update_id + 1;
        try {
          await handleUpdate(update, ctx);
        } catch (err) {
          log.error(`telegram: update ${update.update_id} — ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      // A cancelled poll means we are shutting down, not that Telegram broke.
      // Backing off here would spend the systemd stop timeout doing nothing.
      if (err instanceof AbortedError || shouldStop()) break;

      consecutiveFailures++;
      const message = err instanceof Error ? err.message : String(err);
      // Back off to a minute so a revoked token doesn't spin at full speed.
      const waitMs = Math.min(60_000, 2_000 * 2 ** Math.min(consecutiveFailures, 5));
      log.error(`telegram: poll failed (${consecutiveFailures}) — ${message}`);
      await sleep(waitMs, signal);
    }
  }

  log.info('telegram: stopped listening');
}

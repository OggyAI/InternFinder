import { z } from 'zod';

/**
 * Telegram Bot API transport.
 *
 * Deliberately thin and dependency-free — no bot framework. The whole surface
 * this project needs is five methods, and a framework would bring its own
 * update loop, its own state, and its own opinions about process lifetime,
 * none of which fit a worker that is already looping on its own schedule.
 *
 * LONG POLLING, NOT WEBHOOKS. A webhook needs a public HTTPS endpoint with a
 * valid certificate; the Oracle VM has no domain and no open inbound port, and
 * opening one to receive unauthenticated POSTs is a worse trade than polling.
 * getUpdates costs nothing on the free tier and works from behind NAT.
 *
 * Nothing here knows what a job listing is. Formatting lives in
 * `telegram-format.ts` so it can be tested without touching the network.
 */

const API_ROOT = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }

  /** 429, or a 5xx — worth trying again. A 400 means the request is wrong. */
  get retryable(): boolean {
    if (this.retryAfterSeconds !== undefined) return true;
    return this.errorCode !== undefined && this.errorCode >= 500;
  }
}

/**
 * A request cancelled because the process is shutting down.
 *
 * Distinct from TelegramError so the bot loop can tell "we are stopping" from
 * "Telegram is broken" — the second backs off and retries, the first must exit
 * immediately or systemd kills us.
 */
export class AbortedError extends Error {
  constructor(method: string) {
    super(`${method}: aborted`);
    this.name = 'AbortedError';
  }
}

/** Telegram wraps every response in this envelope, success or failure. */
const EnvelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

export const TelegramMessageSchema = z.object({
  message_id: z.number(),
  date: z.number().optional(),
  text: z.string().optional(),
  chat: z.object({
    id: z.number(),
    type: z.string().optional(),
    username: z.string().optional(),
  }),
  from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
});
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

export const CallbackQuerySchema = z.object({
  id: z.string(),
  data: z.string().optional(),
  from: z.object({ id: z.number(), username: z.string().optional() }),
  message: TelegramMessageSchema.optional(),
});
export type CallbackQuery = z.infer<typeof CallbackQuerySchema>;

export const UpdateSchema = z.object({
  update_id: z.number(),
  message: TelegramMessageSchema.optional(),
  callback_query: CallbackQuerySchema.optional(),
});
export type TelegramUpdate = z.infer<typeof UpdateSchema>;

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendOptions {
  chatId: string;
  text: string;
  /** Rows of buttons. Telegram caps callback_data at 64 BYTES per button. */
  keyboard?: InlineButton[][];
  disablePreview?: boolean;
}

/**
 * One request, with bounded retries.
 *
 * Retries only what is worth retrying: a 429 (Telegram tells us how long to
 * wait) and 5xx. A 400 is a bug in what we sent and retrying it just burns the
 * rate limit — those surface immediately so the notifier can log the payload.
 */
async function call<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  schema: z.ZodType<T>,
  opts: { timeoutMs?: number; attempts?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const attempts = opts.attempts ?? 3;

  let lastError: TelegramError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new AbortedError(method);
    try {
      return await once(token, method, payload, schema, timeoutMs, opts.signal);
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      const tgError =
        err instanceof TelegramError
          ? err
          : new TelegramError(err instanceof Error ? err.message : String(err));
      lastError = tgError;

      // A network failure (no errorCode at all) is worth one more go; a 400 is not.
      const worthRetrying = tgError.retryable || tgError.errorCode === undefined;
      if (!worthRetrying || attempt === attempts) throw tgError;

      const waitMs = tgError.retryAfterSeconds
        ? tgError.retryAfterSeconds * 1000
        : 500 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw lastError ?? new TelegramError(`${method} failed`);
}

async function once<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  schema: z.ZodType<T>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Either the per-request timeout or a shutdown cancels the request. Without
  // the second, SIGTERM waits out a 25-second long poll before the process can
  // exit, and systemd eventually SIGKILLs it.
  const signal = external
    ? AbortSignal.any([controller.signal, external])
    : controller.signal;

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (external?.aborted) throw new AbortedError(method);
    const message = err instanceof Error ? err.message : String(err);
    throw new TelegramError(
      controller.signal.aborted ? `${method} timed out after ${timeoutMs}ms` : message,
    );
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    // Same failure shape as the Jooble Cloudflare page: an HTML error document
    // where JSON was expected. Name it rather than leaking "Unexpected token".
    throw new TelegramError(
      `${method}: expected JSON, got ${response.status} ${bodyText.slice(0, 120)}`,
      response.status,
    );
  }

  const envelope = EnvelopeSchema.safeParse(parsedBody);
  if (!envelope.success) {
    throw new TelegramError(`${method}: unrecognised response shape`, response.status);
  }

  if (!envelope.data.ok) {
    throw new TelegramError(
      `${method}: ${envelope.data.description ?? 'failed'}`,
      envelope.data.error_code ?? response.status,
      envelope.data.parameters?.retry_after,
    );
  }

  const result = schema.safeParse(envelope.data.result);
  if (!result.success) {
    throw new TelegramError(`${method}: unexpected result — ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

/** Verify the token. Used by `npm run doctor`. */
export async function getMe(token: string): Promise<{ id: number; username?: string }> {
  return call(
    token,
    'getMe',
    {},
    z.object({ id: z.number(), username: z.string().optional() }),
  );
}

export async function sendMessage(
  token: string,
  opts: SendOptions,
): Promise<TelegramMessage> {
  return call(token, 'sendMessage', {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: opts.disablePreview ?? true },
    ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
  }, TelegramMessageSchema);
}

/**
 * Rewrite a message already on the phone.
 *
 * This is how a tapped button becomes visible: the buttons are replaced by the
 * decision they produced, so the message reads as settled rather than still
 * asking. Telegram answers "message is not modified" with a 400 when the new
 * text matches the old one, which is a no-op, not a failure.
 */
export async function editMessageText(
  token: string,
  opts: { chatId: string; messageId: number; text: string; keyboard?: InlineButton[][] },
): Promise<void> {
  try {
    await call(token, 'editMessageText', {
      chat_id: opts.chatId,
      message_id: opts.messageId,
      text: opts.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
    }, z.unknown());
  } catch (err) {
    if (err instanceof TelegramError && /not modified/i.test(err.message)) return;
    throw err;
  }
}

/**
 * Acknowledge a button tap.
 *
 * Telegram shows a spinner on the button until this is called, so it must
 * happen even when the work behind the tap failed — otherwise the UI hangs
 * with no explanation.
 */
export async function answerCallbackQuery(
  token: string,
  callbackId: string,
  text?: string,
): Promise<void> {
  await call(
    token,
    'answerCallbackQuery',
    { callback_query_id: callbackId, ...(text ? { text } : {}) },
    z.unknown(),
  );
}

/**
 * Long-poll for updates.
 *
 * `offset` is the confirmation mechanism: passing lastUpdateId + 1 tells
 * Telegram everything below it was handled, and it drops them server-side. So
 * the offset does not need to survive a restart — an unconfirmed update is
 * simply redelivered, which is why every handler here is idempotent.
 */
export async function getUpdates(
  token: string,
  opts: { offset?: number; timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<TelegramUpdate[]> {
  const timeoutSeconds = opts.timeoutSeconds ?? 25;
  return call(
    token,
    'getUpdates',
    {
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    },
    z.array(UpdateSchema),
    // The socket must outlive the long poll itself, or every poll "times out".
    { timeoutMs: (timeoutSeconds + 10) * 1000, attempts: 1, signal: opts.signal },
  );
}

/** Populate the "/" menu in the Telegram client. Cosmetic; failure is ignored. */
export async function setMyCommands(
  token: string,
  commands: { command: string; description: string }[],
): Promise<void> {
  await call(token, 'setMyCommands', { commands }, z.unknown());
}

/**
 * Authentication for the dashboard.
 *
 * The dashboard reads and writes the whole job pipeline using the service-role
 * key, so the ONLY thing standing between a stranger and that data is this
 * file. It is deliberately small enough to read in one sitting.
 *
 * Single user, one password, a signed cookie. No user table, no OAuth, no
 * session store — there is exactly one person who may log in, and inventing
 * accounts for them would add moving parts without adding safety.
 *
 * Web Crypto rather than node:crypto, because this runs in BOTH places: the
 * Edge runtime in middleware.ts and the Node runtime in Server Actions. Only
 * Web Crypto exists in both.
 *
 * FAILS CLOSED. If DASHBOARD_PASSWORD is unset the app denies every request
 * rather than defaulting to open — a misconfigured deploy must not silently
 * publish the database.
 */

export const SESSION_COOKIE = 'if_session';
const SESSION_DAYS = 30;
/** Domain separation, so the signing key is not the password itself. */
const KEY_CONTEXT = 'intern-finder:dashboard-session:v1';

export interface AuthConfig {
  password: string;
}

/** Null means "not configured" — callers must treat that as deny, not allow. */
export function authConfig(): AuthConfig | null {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) return null;
  return { password };
}

async function signingKey(password: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${KEY_CONTEXT}:${password}`);
  // Hash first so the HMAC key is fixed-length regardless of password length.
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Compare without leaking where the difference is.
 *
 * `a === b` on a signature short-circuits at the first differing byte, which
 * makes the comparison time a measurable oracle. The stakes here are modest,
 * but a constant-time compare costs three lines.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(payload: string, password: string): Promise<string> {
  const key = await signingKey(password);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return toBase64Url(signature);
}

/** A cookie value proving the holder knew the password, valid for 30 days. */
export async function createSessionToken(password: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = String(expiresAt);
  return `${payload}.${await sign(payload, password)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  password: string,
): Promise<boolean> {
  if (!token) return false;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  // Verify the signature even on an expired token? No — an expired token is
  // rejected above and there is nothing to learn from signing it anyway.
  return timingSafeEqual(signature, await sign(payload, password));
}

/** Constant-time password check, so login timing does not reveal a prefix. */
export function passwordMatches(submitted: string, expected: string): boolean {
  return timingSafeEqual(submitted, expected);
}

export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;

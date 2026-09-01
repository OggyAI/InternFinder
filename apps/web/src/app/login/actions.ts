'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  authConfig,
  createSessionToken,
  passwordMatches,
} from '@/lib/auth';

/**
 * Login and logout.
 *
 * The only unauthenticated endpoint in the app, so it is the one an attacker
 * can actually reach. Two deliberate properties:
 *
 *  - A wrong password costs a fixed ~400ms. That is not a rate limiter, but it
 *    turns an online guessing attack from thousands of tries per second into a
 *    couple, which for a single-user dashboard behind a random Vercel hostname
 *    is proportionate. Serverless gives no shared memory to count attempts in,
 *    so a real limiter would need external state this project does not need.
 *
 *  - The response is identical whether the password is wrong or the dashboard
 *    is unconfigured, except where saying so helps the owner rather than an
 *    attacker.
 */

const WRONG_PASSWORD_DELAY_MS = 400;

function safeNextPath(value: FormDataEntryValue | null): string {
  const path = typeof value === 'string' ? value : '';
  // Must be a path on this site. A value starting with `//` or containing a
  // scheme would make this an open redirect that bounces the owner to an
  // attacker's page after a genuine login.
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  return path;
}

export async function login(formData: FormData): Promise<void> {
  const config = authConfig();
  const submitted = String(formData.get('password') ?? '');
  const target = safeNextPath(formData.get('next'));

  if (!config || !passwordMatches(submitted, config.password)) {
    await new Promise((resolve) => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS));
    redirect(`/login?error=1${target !== '/' ? `&next=${encodeURIComponent(target)}` : ''}`);
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createSessionToken(config.password), {
    httpOnly: true,
    // Not readable by JavaScript, not sent cross-site, and — on Vercel, which
    // is always HTTPS — never sent over plaintext.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  redirect(target);
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}

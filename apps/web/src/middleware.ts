import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, authConfig, verifySessionToken } from '@/lib/auth';

/**
 * The gate. Every request that is not the login page passes through here.
 *
 * Middleware rather than a per-page check, because a per-page check is a list
 * that someone eventually forgets to add a page to. Here the default is
 * "denied" and the exceptions are named explicitly, which is the safer shape:
 * a new page added tomorrow is protected without anyone remembering to protect
 * it.
 */

const PUBLIC_PATHS = ['/login'];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const config = authConfig();
  if (!config) {
    // Unconfigured means denied, never open. A deploy that forgot the password
    // must not serve the pipeline to the internet.
    return new NextResponse(
      'DASHBOARD_PASSWORD is not set on this deployment, so the dashboard is ' +
        'refusing every request. Set it in the environment and redeploy.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, config.password)) {
    return NextResponse.next();
  }

  const loginUrl = new URL('/login', request.url);
  // Come back to whatever was asked for, but only ever to a path on this site;
  // taking a full URL here would make this an open redirect.
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next's own static assets and the favicon. Server Actions
  // POST to the page they live on, so they are covered by this too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

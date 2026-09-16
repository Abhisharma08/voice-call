import { NextResponse, type NextRequest } from "next/server";

/**
 * The cookie gate. It only checks that a session cookie is *present*; it does
 * not validate it.
 *
 * Next.js 16 deprecated the `middleware` file convention and renamed it to
 * `proxy`, which also changed the default runtime from edge to Node.js. That
 * removes the old technical reason this could not reach the database - but not
 * the reason it should not. Next's own guidance is that a proxy "is meant to
 * be invoked separately of your render code and in optimized cases deployed to
 * your CDN", so anything it concludes is a hint, not a fact the application may
 * rely on.
 *
 * The real authorization happens server-side in the admin layout and in each
 * route handler, via resolveSession() and requireGrant(). This file is a
 * redirect convenience, never a security boundary; treating it as one is how
 * "authenticated" pages end up rendering for unauthenticated users.
 */

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health"];

/**
 * Service surfaces authenticate with a bearer credential, not a session
 * cookie, so the cookie gate must not touch them: redirecting a scheduler or
 * a provider callback to /login turns a clean 401 into a 307 the caller cannot
 * act on - and a cron that follows the redirect gets an HTML login page and a
 * 200, which reads as success while nothing has been dialled.
 *
 * Each of these routes authenticates itself: `authenticateService()` for the
 * webhook and internal paths, the `CRON_SECRET` shared secret for /api/cron/,
 * and each is rate limited on its own account (migration 0011).
 */
const SERVICE_PATH_PREFIXES = ["/api/webhooks/", "/api/internal/", "/api/cron/"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (SERVICE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  if (!request.cookies.has("lc_session")) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

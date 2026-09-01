import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge gate. It only checks that a session cookie is *present* - it cannot
 * validate it, because the edge runtime has no database access.
 *
 * The real authorization happens server-side in the admin layout and in each
 * route handler, via resolveSession() and requireGrant(). This middleware is a
 * redirect convenience, never a security boundary; treating it as one is how
 * "authenticated" pages end up rendering for unauthenticated users.
 */

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/health"];

/**
 * Service surfaces authenticate with a bearer service token, not a session
 * cookie, so the cookie gate must not touch them: redirecting an n8n worker or
 * a provider callback to /login turns a clean 401 into a 307 the caller cannot
 * act on. Each of these routes calls authenticateService() itself.
 */
const SERVICE_PATH_PREFIXES = ["/api/webhooks/", "/api/internal/"];

export function middleware(request: NextRequest) {
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

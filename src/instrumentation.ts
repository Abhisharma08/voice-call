import type { Instrumentation } from "next";
import { logger } from "@/lib/observability/log";

/**
 * Server error capture (PRD 18.3's alerting signals).
 *
 * Before this, an exception that escaped a route handler or a server component
 * reached Next's own default handler, which logs it in a shape nothing else in
 * this application produces and attributes it to nothing. In practice that
 * meant the errors most worth alerting on - the unanticipated ones - were the
 * only ones not emitted as structured, filterable lines.
 *
 * Every deliberate failure path already logs for itself: a failed dial, a
 * dead-lettered sync, a rejected signature. What lands here is by definition
 * what nobody predicted, so it is logged at error with the route attached and
 * nothing else assumed about it.
 *
 * `register` is intentionally absent. It runs before the server accepts
 * traffic and must complete first, so the tempting thing to do in it -
 * validate `env()` and fail fast - would turn a recoverable misconfiguration
 * into a server that never starts and serves no health endpoint to explain
 * why. `env()` already throws at the first call site that needs it, which
 * fails the request rather than the process.
 */

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest: unknown }).digest)
      : undefined;

  logger.error("unhandled server error", {
    // `path` carries the query string, which on this application's routes
    // includes `?campaign=<uuid>`. That is not sensitive, but it is also not
    // useful for grouping, so the route file path is logged alongside it.
    path: request.path,
    method: request.method,
    route: context.routePath,
    route_type: context.routeType,
    render_source: context.renderSource,
    digest,
    // Passed through `redact()` by the logger, which turns an Error into
    // `{name, message}` and drops the stack unless LOG_STACKS is set.
    err: error,
  });
};

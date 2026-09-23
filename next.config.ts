import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Hosts allowed to reach the dev server's own endpoints.
   *
   * `next dev` blocks cross-origin requests to dev-only assets, which includes
   * the HMR websocket. Reached through a tunnel, that block is silent and
   * expensive to read: the page renders, HMR fails with "Unauthorized", the
   * client never hydrates, and the login form - whose submit is a React
   * onSubmit handler, on inputs that carry no `name` - falls back to a native
   * GET. The browser lands back on `/login?` with an empty query and it looks
   * like the password was wrong.
   *
   * A Cloudflare quick tunnel gets a new hostname every restart, so the
   * wildcard is the only form that survives `npm run tunnel`. Development
   * only; Next ignores this in a production build.
   */
  allowedDevOrigins: ["*.trycloudflare.com"],
  // No transcripts/recordings/phone numbers in public URLs, HTTPS everywhere.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

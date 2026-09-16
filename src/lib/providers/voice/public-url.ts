/**
 * The URL a provider actually requested, as opposed to the one this process
 * received.
 *
 * Twilio signs the absolute URL it called. Behind anything that terminates TLS
 * and forwards - a tunnel in development, a load balancer or ingress in
 * production - `request.url` is the internal address (`http://localhost:3001/...`)
 * while the signature covers the public one (`https://example.com/...`). Compare
 * against the wrong string and every callback fails verification, which looks
 * like a credential problem and is not one.
 *
 * `APP_URL` is the right basis rather than `x-forwarded-*`: the calling worker
 * minted the callback URL from it, so it is by construction the URL the
 * provider was told to call, and it cannot be spoofed by a request header.
 */
export function publicRequestUrl(requestUrl: string): string {
  const base = process.env.APP_URL?.trim().replace(/\/$/, "");
  if (!base) return requestUrl;

  const url = new URL(requestUrl);
  return `${base}${url.pathname}${url.search}`;
}

// src/lib/public-origin.ts — the origin to put in a link somebody receives OUTSIDE the browser.
//
// WHY THIS EXISTS. Four routes built emailed links with `new URL(request.url).origin`, and on a
// serverless deployment that is the address the FUNCTION was invoked on, not the address the person
// typed. In production it resolved to `https://localhost`, so:
//
//   * every invitation to apply carried https://localhost/invite/<token>
//   * every password-reset mail carried https://localhost/reset-password?token=<token>
//
// The second one is the sharper of the two: all three recovery methods — date of birth, ID + face
// match, and the question set — go through issueAndMailReset(), so anybody locked out of an account
// was mailed a dead link by whichever route they used. The tokens were fine; only the host was
// wrong, which is why nothing errored and nothing was logged.
//
// THE HOST HEADER IS NOT THE ANSWER EITHER. The obvious repair is to read x-forwarded-host, and it
// is the wrong one for links that leave the building: that header is attacker-controlled, so a
// crafted request could put a host of somebody else's choosing into an email OUR domain sent, with
// a real token in it. Configuration is the only trustworthy source for an outbound link.
//
// So: configured value, then the site constant, and never the request. A preview deployment will
// therefore mint production links — which is correct for these, because the token they carry lives
// in the production database whichever host issued it.
import { SITE } from '@/lib/site';

/** Hosts that mean "this is not reachable from anybody else's machine". */
const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

/**
 * The origin for a link in an email, an SMS, a QR code — anything opened somewhere else.
 *
 * Never returns a loopback host in production, even if PUBLIC_SITE_URL is set to one: that is how
 * this class of bug comes back, and a reset link nobody can open is indistinguishable from a mail
 * that never arrived. In development a loopback value is honoured, because there the whole point is
 * that the link opens on this machine.
 */
export function publicOrigin(): string {
  const configured = String(process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').trim();
  const fallback = String(SITE.url).replace(/\/+$/, '');
  if (!configured) return fallback;

  let host = '';
  try {
    host = new URL(configured).hostname;
  } catch {
    // Not a URL at all. A malformed setting must not become a malformed link.
    return fallback;
  }

  // Strict UNLESS explicitly told this is a development run. An unset or unexpected NODE_ENV lands
  // on the safe side: refusing a loopback link costs a developer one env var, while allowing one
  // costs a locked-out person their account, and this bug reached production once already.
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (!isDev && LOOPBACK.test(host)) return fallback;

  return configured.replace(/\/+$/, '');
}

/** Join the public origin to a path. The path is used as given; it is ours, not user input. */
export function publicUrl(path: string): string {
  const p = String(path || '');
  return publicOrigin() + (p.startsWith('/') ? p : '/' + p);
}

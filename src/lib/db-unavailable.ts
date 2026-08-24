// src/lib/db-unavailable.ts — WHAT TO SHOW WHEN THE AUTH GATE COULD NOT REACH THE DATABASE.
//
// =================================================================================================
// WHY THIS IS ITS OWN MODULE
// =================================================================================================
//
// src/middleware.ts already had the right idea: a 503 that says what is actually true, never a
// redirect, never cached. What it did not have is any notion that the failure it is reporting is
// USUALLY OVER BY THE TIME THE PAGE HAS FINISHED PAINTING.
//
// Measured against the live site on 2026-08-24, from src/lib/db/index.ts's own fourth measurement
// and confirmed again today with a fourteen-request burst against /api/health:
//
//   latencyMs 128-134   the connection was REUSED    14 of 14 answered, none ever failed
//   latencyMs ~951      the connection was OPENED    ~810ms of that is the handshake alone
//   no answer at 5000ms                              about a QUARTER of the ones that had to open
//
// So the failure is not "the database is down". It is one connection OPEN stalling, on one request,
// on one serverless instance. withDbRetry() already asks a second time; when both attempts land on
// a stalled open, middleware gives up and the person is handed a dead page — for a condition that
// the very next request answers in 130ms. That is the gap this module closes.
//
// THE PARENT PAGE RENDERING WHILE THE NEXT REQUEST FAILS IS THE SIGNATURE OF THIS, not a
// contradiction of it: the parent was served by an instance with a warm connection, the next
// request went to one that had to open one.
//
// =================================================================================================
// THREE ANSWERS, NOT ONE
// =================================================================================================
//
// The old code returned one full HTML page to everything, which is wrong in both directions:
//
//   SILENT   Nobody is looking at this response. A prefetch, a fetch(), an image, a stylesheet, a
//            POST. Painting a full-page apology into a speculative prefetch is how a working screen
//            gets replaced by an error the person never navigated to, and answering a POST with a
//            page that refreshes itself would re-submit it. Status only, no body.
//
//   RETRY    A real navigation, first failure. Say what happened AND reload once, automatically.
//            One retry, marked by a short-lived cookie so it is impossible to loop: the second
//            failure inside the marker's lifetime always falls through to MANUAL.
//
//   MANUAL   A real navigation that has already been retried once. The database is not having a
//            blip, it is having a problem. Stop reloading, name the gate that failed so the report
//            is diagnosable, and let the person decide.
//
// PURE FUNCTIONS, DELIBERATELY. middleware.ts cannot be imported by a test — it pulls in astro:
// middleware, the driver and every gate — so the decision lives here where a test can put twenty
// header combinations through it in a millisecond, and middleware.ts is left holding only the
// Response construction.

/** What kind of answer this request should get. */
export type UnavailableMode = 'silent' | 'retry' | 'manual';

/**
 * The one-shot marker.
 *
 * A COOKIE AND NOT A QUERY PARAMETER, because a parameter has to be removed again. `?__dbretry=1`
 * would survive the successful reload, sit in the address bar, be copied into a bug report, and be
 * shared as a link — and the only way to strip it is a second redirect on the success path, which
 * means touching the code that runs when everything is fine in order to tidy up after the code that
 * runs when it is not.
 *
 * Ten seconds, so it expires on its own with nothing to clear. Long enough that a reload one second
 * later still sees it; short enough that a person who comes back in a minute gets a fresh automatic
 * retry rather than being told to try again by hand for a failure that has moved on.
 */
export const DB_RETRY_COOKIE = 'era_db_retry';
export const DB_RETRY_COOKIE_MAX_AGE = 10;

/** How long the browser waits before the one automatic reload. */
export const DB_RETRY_DELAY_SECONDS = 2;

/**
 * Everything about the request this decision needs, lifted off the Request so it can be tested.
 * Every field is exactly what the header contained, including null for absent.
 */
export interface UnavailableRequestFacts {
  method: string;
  /** Sec-Fetch-Mode. 'navigate' is the browser putting this in a window, a tab or a frame. */
  fetchMode: string | null;
  /** Sec-Fetch-Dest. 'document' and 'iframe' are the destinations that paint. */
  fetchDest: string | null;
  /** Sec-Purpose (current) or Purpose (older). 'prefetch' means nobody is looking at it yet. */
  purpose: string | null;
  /** The fallback when Sec-Fetch-* is absent: a browser navigation asks for text/html. */
  accept: string | null;
  /** True when this request already carries DB_RETRY_COOKIE. */
  alreadyRetried: boolean;
}

/** Pull the facts off a real Request. The cookie is read by the caller, which has AstroCookies. */
export function factsFromRequest(request: Request, alreadyRetried: boolean): UnavailableRequestFacts {
  const h = request.headers;
  return {
    method: String(request.method || 'GET').toUpperCase(),
    fetchMode: h.get('sec-fetch-mode'),
    fetchDest: h.get('sec-fetch-dest'),
    purpose: h.get('sec-purpose') || h.get('purpose') || h.get('x-purpose'),
    accept: h.get('accept'),
    alreadyRetried,
  };
}

/**
 * Would a browser PAINT this response, or is it a resource fetched behind the scenes?
 *
 * Sec-Fetch-Dest is the reliable answer and every browser this deployment supports sends it. The
 * Accept fallback exists for the ones that do not, and for curl: a navigation asks for text/html
 * near the front of its Accept list, an XHR almost never does.
 */
function isPainted(f: UnavailableRequestFacts): boolean {
  const dest = (f.fetchDest || '').toLowerCase();
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object';
  const mode = (f.fetchMode || '').toLowerCase();
  if (mode) return mode === 'navigate';
  return (f.accept || '').toLowerCase().includes('text/html');
}

/**
 * THE DECISION.
 *
 * Order matters and each rule is here for a failure somebody could actually have:
 *
 *  1. Not a GET or HEAD. A POST answered with a self-refreshing page re-submits it, and no API
 *     caller wants HTML. Status only.
 *  2. A prefetch. Chrome and the speculation rules API fetch pages nobody has asked for yet; a 503
 *     body here can end up painted over a screen the person was reading. Status only.
 *  3. Not painted. A fetch(), an image, a script. Status only, for the same reason.
 *  4. Already retried once. Do not reload again — this is no longer a blip.
 *  5. Everything else: a real navigation, first failure. Retry it once, automatically.
 */
export function unavailableMode(f: UnavailableRequestFacts): UnavailableMode {
  if (f.method !== 'GET' && f.method !== 'HEAD') return 'silent';
  if ((f.purpose || '').toLowerCase().includes('prefetch')) return 'silent';
  if (!isPainted(f)) return 'silent';
  if (f.alreadyRetried) return 'manual';
  return 'retry';
}

/** Minimal escaping for the one interpolated value. The gate names are literals; this is the belt. */
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE =
  '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0b0f;color:#e7e7ea;'
  + 'display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}div{max-width:34rem}'
  + 'h1{font-size:1.25rem;margin:0 0 .75rem}p{line-height:1.6;color:#9aa6b6;margin:0 0 .75rem}'
  + 'code{color:#c9d1d9;font-size:.85em}a{color:#FF7040}</style>';

/**
 * The page body for a mode. Empty string for 'silent' — there is deliberately nothing to paint.
 *
 * THE COPY IS DIFFERENT FOR THE TWO VISIBLE MODES, because they are not the same news. "Trying
 * again" while a page is about to reload itself is a description of what is happening; showing it
 * after the retry has already failed would be a lie told by a page that is doing nothing.
 */
export function unavailableBody(mode: UnavailableMode, where: string): string {
  if (mode === 'silent') return '';

  const head = '<!doctype html><meta charset="utf-8"><title>Temporarily unavailable</title>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">';

  if (mode === 'retry') {
    // The reload is a meta refresh rather than a script so it works with JavaScript disabled and
    // needs no inline-script allowance in any CSP this site ever grows.
    return head
      + '<meta http-equiv="refresh" content="' + DB_RETRY_DELAY_SECONDS + '">'
      + STYLE
      + '<div><h1>One moment</h1>'
      + '<p>The database did not answer in time, so nothing is being shown rather than something '
      + 'wrong. This usually clears in a second or two, and this page is trying again by itself.</p>'
      + '<p>Nothing about your account or your sign-in is wrong.</p>'
      + '<p><a href="">Try now</a></p></div>';
  }

  return head + STYLE
    + '<div><h1>We cannot reach the database right now</h1>'
    + '<p>Your sign-in could not be verified, so nothing is being shown rather than something wrong. '
    + 'This is a database problem on our side, not a problem with your account.</p>'
    + '<p>We already retried once and it did not clear, so this page has stopped reloading itself. '
    + 'If you report this, the check that failed was <code>' + esc(where) + '</code>.</p>'
    + '<p><a href="">Try again</a></p></div>';
}

/**
 * Retry-After, in seconds, for a mode.
 *
 * It was 15 for everything. Fifteen seconds is a claim about how long the failure lasts, and it is
 * wrong by an order of magnitude for the failure this actually reports: the next request answers in
 * about 130ms. The header is read by crawlers, uptime monitors and Vercel's own retry behaviour, and
 * telling them to stay away for fifteen seconds after a one-second stall makes an outage out of a
 * hiccup. The manual mode keeps a longer value on purpose: by then it is not a hiccup.
 */
export function unavailableRetryAfter(mode: UnavailableMode): number {
  return mode === 'manual' ? 15 : DB_RETRY_DELAY_SECONDS;
}

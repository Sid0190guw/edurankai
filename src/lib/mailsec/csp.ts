// src/lib/mailsec/csp.ts — THERE IS NO CONTENT-SECURITY-POLICY ON THIS DEPLOYMENT AT ALL.
//
// ═══ WHAT IS MISSING, AND WHAT IT WOULD HAVE COST US ═══
//
// vercel.json sets Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, Permissions-Policy and X-DNS-Prefetch-Control on every route, and
// secureHeaders() in src/lib/http-guard.ts sets the same family per response. Every one of those
// bounds a different attack. NONE of them bounds script execution.
//
// So when mail HTML rendered into the reading pane carried a payload — the hole the sanitiser in
// src/lib/mailsec/html.ts closes — there was no second line. A single parser gap in one regex was
// the whole of the defence, and the script that got through ran with the session's full authority
// on an admin origin: read any page the operator can read, POST to any endpoint they can POST to.
// The sanitiser is now good, and it is still one file. A CSP is the control that makes a future
// gap in it survivable instead of total, which is the entire reason it belongs in the response and
// not in a comment on the roadmap.
//
// ═══ WHY THIS SHIPS REPORT-ONLY, AND WHY THAT IS NOT HEDGING ═══
//
// 75 files in src/pages use `define:vars`, which Astro can only implement as an INLINE <script>.
// Five more evaluate strings at runtime on purpose — src/pages/aquintutor/labs/plot.astro and
// teach.astro build a grapher with `new Function`, portal/tools/ide.astro and notebook.astro run
// learner code the same way, and src/lib/aes/providers/engine-loader.ts loads engines with it.
// An enforcing policy turned on blind takes all of that off the air: the graphing lab, the
// notebook, the IDE and every page whose server-computed variables reach the client through
// `define:vars` stop working, in production, with no error visible to the person using them.
//
// The predictable result of that is a revert, and a CSP that has been reverted once is harder to
// land than one that was never tried. Report-only breaks nothing, and the violation stream IS the
// migration plan: it enumerates precisely which inline scripts and which eval sites have to be
// dealt with, which is information nobody currently has.
//
// ═══ WHAT HAS TO HAPPEN BEFORE `reportOnly: false` ═══
//
// In order, none of which is done:
//
//   1. A per-request nonce. Generate one in middleware, put it in `script-src` as 'nonce-<value>',
//      and add `nonce={nonce}` to every inline <script> Astro emits. `define:vars` scripts cannot
//      be hashed instead — their content contains the injected values, so the hash changes with
//      the data and no static hash can match. Nonce or nothing for those 75 files.
//   2. A decision on the five `new Function` sites. Either `'unsafe-eval'` goes into script-src —
//      which weakens the policy globally for the sake of four learner tools — or those evaluators
//      move into a sandboxed iframe or worker that carries its own, looser policy. The second is
//      the right answer and the more expensive one. THIS FILE DELIBERATELY OMITS 'unsafe-eval' so
//      that those five sites keep appearing in the report until somebody chooses.
//   3. A collector, so the reports go somewhere a human reads. See `reportUri` below: there is no
//      such route in this repository today and this module refuses to invent one.
//   4. A soak period with the report-only policy live and the stream actually read. Enforcing on
//      the strength of a policy nobody has watched is the same blind switch, one step later.
//
// Until all four are done, `mailCsp()` defaults to report-only. The default is the safe direction
// on purpose: a caller that forgets the option gets the mode that cannot cause an outage.
//
// ═══ WHAT THIS FILE IS NOT ═══
//
// It is data and one pure function. It does not read the environment, touch the database, or know
// how a response is built — so the policy can be asserted character by character in a test, which
// is the only way anybody is going to trust it enough to enforce it.

import { looksLikeHeaderInjection } from './headers';

/**
 * A policy as data. Insertion order is the emitted order, which keeps the serialized value stable
 * and diffable. An empty value list emits a bare directive (`upgrade-insecure-requests`).
 */
export type CspDirectives = Readonly<Record<string, readonly string[]>>;

/**
 * Which document this policy is describing.
 *
 * `DOCUMENT` — an HTML page of ours. Carries the origins the site genuinely loads from.
 * `API`      — a JSON or file response. Loads nothing, so it is allowed nothing.
 */
export type CspProfile = 'DOCUMENT' | 'API';

/**
 * Script origins that are real, current and load-bearing. Each one is a third party we execute
 * code from on the user's behalf, so each is a supply-chain dependency worth seeing written down:
 *
 *   checkout.razorpay.com   the payment widget; the paid flows do not work without it
 *   unpkg.com               pdf-lib (certificate generation) and leaflet
 *   cdnjs.cloudflare.com    pdf.js (document viewer)
 *
 * unpkg and cdnjs serve whatever the named version resolves to, unpinned by integrity attributes.
 * Narrowing these to specific files, or vendoring them into public/ the way face-api already is,
 * would remove two remote-code dependencies outright. Recorded here rather than fixed here.
 */
const SCRIPT_CDNS = [
  'https://checkout.razorpay.com',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
] as const;

/**
 * Origins that are allowed to become an <iframe>. Taken from the provider table in
 * src/lib/video-embed.ts plus Google Drive, which is where every document in this product lives
 * because we link documents rather than store them.
 *
 * This list is long, and that is honest rather than sloppy: each entry is a provider a course
 * author can already embed today. A shorter list would not be a tighter policy, it would be a
 * broken embed nobody connected back to this file.
 */
const FRAME_ORIGINS = [
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
  'https://player.vimeo.com',
  'https://drive.google.com',
  'https://iframe.mediadelivery.net',
  'https://iframe.videodelivery.net',
  'https://players.brightcove.net',
  'https://player.twitch.tv',
  'https://clips.twitch.tv',
  'https://player.bilibili.com',
  'https://www.dailymotion.com',
  'https://www.loom.com',
  'https://fast.wistia.net',
  'https://archive.org',
  'https://mega.nz',
] as const;

/**
 * The policy for one of our own HTML pages.
 *
 * Two deliberate looseness decisions, both of which cost something and are stated so that the next
 * person tightening this knows they were choices:
 *
 *   style-src 'unsafe-inline'  Astro emits scoped <style> blocks and the pages use style
 *                              attributes throughout. Without this the report fills with thousands
 *                              of style violations that nobody is going to fix, and the script
 *                              violations — the ones somebody must act on — are buried under them.
 *                              CSS injection is not the vector the mail sanitiser closed.
 *   img-src https:             Course content references partner images and Google Drive
 *                              thumbnails from origins we do not enumerate. An image load is not
 *                              script execution, and narrowing this would refuse legitimate
 *                              content while buying very little.
 *
 * Everything else is as tight as the application currently permits. In particular script-src has
 * NEITHER 'unsafe-inline' NOR 'unsafe-eval', so the inline scripts and the eval sites both report.
 * That is the point of the exercise — see the migration plan at the top of this file.
 */
export const DOCUMENT_CSP: CspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'", ...SCRIPT_CDNS],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
  // blob: covers the live-camera photo capture and the recording preview; data: covers inline SVG.
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  // Every SSE stream and API call in this product is same-origin. Anything reported here is
  // something phoning out, which is exactly what we want to hear about.
  'connect-src': ["'self'"],
  'media-src': ["'self'", 'blob:', 'data:'],
  // The service worker (public/offline-sync.js, and the offline package) is governed by this.
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'self'", 'blob:', ...FRAME_ORIGINS],
  'manifest-src': ["'self'"],
  // Matches the X-Frame-Options: SAMEORIGIN already set in vercel.json. Both are kept: the header
  // is what older agents honour, this is what current ones honour.
  'frame-ancestors': ["'self'"],
  // A <base> tag injected into a page rewrites every relative URL on it, including the ones the
  // scripts above are loaded from. There is no legitimate <base> in this codebase.
  'base-uri': ["'self'"],
  // Stops an injected form from posting a session's data to somewhere else.
  'form-action': ["'self'"],
  // No <object>, <embed> or <applet> anywhere in this product, and they are a classic bypass.
  'object-src': ["'none'"],
};

/**
 * The policy for a JSON or file response — which is what secureHeaders() decorates today.
 *
 * An API response is not a document and loads nothing, so it is allowed nothing. This matters for
 * one specific case: a response whose body is attacker-influenced and which an older agent decides
 * to render as HTML despite X-Content-Type-Options. `default-src 'none'` means that even then
 * nothing in it executes.
 *
 * `upgrade-insecure-requests` and `sandbox` are absent on purpose — both are IGNORED in
 * report-only mode per spec, so listing them here would put a directive in the header that does
 * nothing and reads as though it does something.
 */
export const API_CSP: CspDirectives = {
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
};

const PROFILES: Readonly<Record<CspProfile, CspDirectives>> = {
  DOCUMENT: DOCUMENT_CSP,
  API: API_CSP,
};

/** Serialize a policy. Pure, deterministic, and the exact string that goes in the header. */
export function serializeCsp(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const [name, values] of Object.entries(directives)) {
    parts.push(values.length ? `${name} ${values.join(' ')}` : name);
  }
  return parts.join('; ');
}

export interface CspResult {
  /** The header name — report-only or enforcing. */
  header: 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only';
  /** The header value. */
  value: string;
  /**
   * What was dropped and why. Empty when nothing was. A refused report-uri is REPORTED rather than
   * silently omitted, because "reports are being collected" and "reports are going nowhere" are
   * different states and a caller that cannot tell them apart will believe the wrong one.
   */
  refused: string[];
}

export interface CspOptions {
  /**
   * Enforce instead of report. Defaults to REPORT-ONLY, and must stay that way until the four
   * steps at the top of this file are done. The safe direction is the default so that forgetting
   * the option cannot cause an outage.
   */
  reportOnly?: boolean;
  /** Which document this is. Defaults to API, because that is what secureHeaders() decorates. */
  profile?: CspProfile;
  /**
   * Where violation reports are POSTed. A SAME-ORIGIN ABSOLUTE PATH ONLY.
   *
   * Cross-origin collectors are refused rather than passed through. A CSP violation report carries
   * the URL of the page, its referrer, the blocked URI and — for an inline script violation — a
   * sample of the script itself. On an admin origin those URLs are internal structure and that
   * sample can contain values `define:vars` injected from the server. Handing that to a third
   * party is a data export, and it is not one anybody has agreed to, so it fails closed.
   *
   * There is NO report collector route in this repository today. Omitting this option is the
   * correct call until one exists: with no report-uri the browser still surfaces violations in its
   * console, whereas a report-uri pointing at a 404 is a control that looks live and collects
   * nothing, which is the worse of the two failures.
   */
  reportUri?: string;
}

/**
 * Build the Content-Security-Policy header for a response.
 *
 * Report-only by default. See the top of this file for what enforcement requires.
 */
export function mailCsp(opts: CspOptions = {}): CspResult {
  const reportOnly = opts.reportOnly !== false;
  const profile: CspProfile = opts.profile === 'DOCUMENT' ? 'DOCUMENT' : 'API';
  const refused: string[] = [];

  const directives: Record<string, readonly string[]> = { ...PROFILES[profile] };

  if (opts.reportUri !== undefined && opts.reportUri !== null && opts.reportUri !== '') {
    const raw = String(opts.reportUri);
    const bad = reportUriRefusal(raw);
    if (bad) refused.push(`report-uri: ${bad}`);
    else directives['report-uri'] = [raw];
  }

  return {
    header: reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
    value: serializeCsp(directives),
    refused,
  };
}

/**
 * Why this report-uri cannot be used, or null if it can.
 *
 * Exported so the refusals can be asserted one at a time. The order matters: the header-injection
 * check runs first because a value carrying CR/LF is not a bad path, it is an attempt to write a
 * second response header, and it should be named as that.
 */
export function reportUriRefusal(raw: unknown): string | null {
  const s = String(raw ?? '');
  if (!s) return 'empty';

  // A newline here does not make a broken policy, it makes a second header. Same class of bug as
  // the one src/lib/mailsec/headers.ts exists for, so it reuses that check rather than restating it.
  if (looksLikeHeaderInjection(s)) return 'contains a line break or control character';

  // A semicolon ENDS the report-uri directive and starts another one. A value of
  // "/r; script-src *" would append a directive that defeats the whole policy, which is the CSP
  // equivalent of SQL injection. A comma is worse: it separates two entire policies.
  if (s.includes(';')) return 'contains a semicolon, which would start a new directive';
  if (s.includes(',')) return 'contains a comma, which would start a new policy';
  if (/\s/.test(s)) return 'contains whitespace, which would split the directive';

  // ═══ SAME-ORIGIN ONLY, AND THE PARSER DECIDES, NOT A PATTERN ═══
  //
  // Anything off-origin is a third-party collector receiving page URLs and inline-script samples —
  // exactly the data a CSP report carries. The first version of this check pattern-matched the
  // shapes it could think of (`//host`, `scheme:`) and a review found the one it could not: a
  // slash followed by a BACKSLASH. Browsers normalise `\` to `/` in a URL, so `/\evil.example/c`
  // is `//evil.example/c` by the time it is fetched — it passes `startsWith('/')`, fails
  // `startsWith('//')`, and points at somebody else's server.
  //
  // Enumerating shapes is how that happens. So the URL parser answers instead: resolve against a
  // sentinel origin and require the result to have stayed on it. Anything that escapes — a scheme,
  // a protocol-relative prefix, a backslash, or a form nobody has thought of yet — changes the
  // origin and is refused by construction.
  //
  // The header-shape rules above still run FIRST, and must: a CR, a semicolon or a space is not a
  // bad URL, it is an attempt to write a second header or a second directive, and the URL parser
  // would quietly normalise several of them away before we ever saw them.
  // The two shapes that have their own names, kept ahead of the parser so the refusal SAYS which
  // mistake was made. "resolves to another origin" is correct but unhelpful to somebody who typed a
  // full URL into a field that wanted a path.
  if (s.startsWith('//')) return 'is protocol-relative, which points off-origin';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return 'is an absolute URL, which points off-origin';
  if (!s.startsWith('/')) return 'is not an absolute path';

  const SENTINEL = 'https://csp-origin.invalid';
  let resolved: URL;
  try {
    resolved = new URL(s, SENTINEL);
  } catch {
    return 'is not a resolvable path';
  }
  if (resolved.origin !== SENTINEL) return 'resolves to another origin';

  return null;
}

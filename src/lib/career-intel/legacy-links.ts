// src/lib/career-intel/legacy-links.ts — THE LINKS PEOPLE ALREADY SHARED MUST KEEP WORKING.
//
// =================================================================================================
// WHAT BROKE, AND WHY IT BROKE SILENTLY
// =================================================================================================
//
// The old /careers read four query parameters and server-rendered a filtered list:
//
//     /careers?q=&dept=&level=Intern&utm_source=chatgpt.com
//
// That link was shared. So were others like it. The rebuilt /careers reads NO query parameters at
// all — it is a discovery surface, and the filtered, paginated catalogue lives at
// /careers/opportunities. So the link still returned 200, still rendered a perfectly good page, and
// silently ignored the one thing the person who followed it actually asked for. Measured: the
// response for the link above is BYTE-IDENTICAL to /careers with no query string.
//
// That is the worst shape a broken link can take. A 404 tells somebody. A 200 that quietly drops
// the filter tells nobody — not the visitor, not the person who shared it, and not us.
//
// =================================================================================================
// WHY A REDIRECT AND NOT A RE-RENDER
// =================================================================================================
//
// /careers could read the parameters again and render the matching postings inline. It would also
// be the start of the road back to a page that renders the whole catalogue, and it would only work
// where the enhancement script runs. A 302 to /careers/opportunities — which is a fully
// server-rendered, filterable, paginated catalogue — behaves identically with JavaScript and
// without it, and lands the person on a page built for exactly what they asked for.
//
// 302 AND NOT 301, DELIBERATELY. The filter combinations are effectively unbounded and a 301 is
// cached hard by browsers, so a mapping we later change would keep sending people to the old place
// from caches nobody can clear. Nothing here is in the sitemap, so there is no ranking to preserve.
//
// TRACKING PARAMETERS SURVIVE. Dropping utm_source on the redirect would silently break attribution
// for every campaign that ever used one of these links — which is a second invisible failure
// introduced while fixing the first.
//
// Pure: a URL in, a decision out. No database, no framework, no Astro. Tested in legacy-links.test.ts.

/** Parameters the old /careers actually read. Anything non-empty here is a real filter. */
const FILTER_PARAMS = ['q', 'dept', 'level', 'product'] as const;

/**
 * Parameters other pages have always SENT to /careers that it never read.
 *
 * `role` comes from the two "Apply for cohort" buttons on /bootcamp. The old page ignored it, so
 * those buttons have always dropped somebody on an unfiltered list. Since these links are being
 * repaired anyway, it is mapped to a search rather than left as a decade of near-misses.
 */
const SEARCH_ALIASES = ['role'] as const;

/**
 * Carried through untouched. Not a whitelist of things we use — a whitelist of things that must not
 * be lost, because losing them is invisible and shows up a quarter later as a campaign that
 * "stopped working".
 */
const TRACKING_PREFIXES = ['utm_'];
const TRACKING_EXACT = ['ref', 'source', 'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid'];

function isTracking(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_PREFIXES.some((p) => k.startsWith(p)) || TRACKING_EXACT.includes(k);
}

export interface LegacyDecision {
  /** Where to send them, or null to render /careers normally. */
  redirectTo: string | null;
  /**
   * A posting that no longer exists, from /careers/[slug]'s 302. NOT redirected — the person
   * followed a link to a specific job and needs to be told what happened to it, which a second
   * redirect would swallow.
   */
  goneSlug: string | null;
}

/**
 * Decide what to do with a request to /careers.
 *
 * EMPTY IS NOT A FILTER. The link that prompted this carried `q=&dept=&level=Intern` — two empty
 * parameters and one real one. Treating presence rather than value as the signal would redirect
 * every link that ever carried an empty box, including plain `?utm_source=` marketing links, and
 * bounce people off the landing page for nothing.
 */
export function legacyCareersDecision(rawUrl: string | URL): LegacyDecision {
  let url: URL;
  try {
    url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl;
  } catch {
    return { redirectTo: null, goneSlug: null };
  }
  const p = url.searchParams;

  const gone = (p.get('gone') || '').trim();
  const goneSlug = gone ? gone.slice(0, 200) : null;

  const next = new URLSearchParams();
  let hasFilter = false;

  for (const key of FILTER_PARAMS) {
    const v = (p.get(key) || '').trim();
    if (!v) continue;
    next.set(key, v.slice(0, 200));
    hasFilter = true;
  }

  // `role` and `q` both become the search box. If a real `q` is already set it wins — it is the
  // more specific of the two and overwriting it would lose what the person actually typed.
  for (const key of SEARCH_ALIASES) {
    const v = (p.get(key) || '').trim();
    if (!v || next.get('q')) continue;
    next.set('q', humanise(v).slice(0, 200));
    hasFilter = true;
  }

  // A "gone" notice must be READ, so it is never redirected away from — even when the URL also
  // carries filters, which /careers/[slug]'s 302 never sets but a hand-edited link might.
  if (goneSlug) return { redirectTo: null, goneSlug };
  if (!hasFilter) return { redirectTo: null, goneSlug: null };

  for (const [key, value] of p.entries()) {
    if (isTracking(key) && !next.has(key)) next.set(key, value.slice(0, 200));
  }

  return { redirectTo: '/careers/opportunities?' + next.toString(), goneSlug: null };
}

/**
 * "bootcamp-quantum" -> "bootcamp quantum".
 *
 * A slug matches no posting title as a single word, and searching for the literal slug returns
 * nothing — which is how a repaired link becomes an empty results page instead of a broken one.
 */
export function humanise(slug: string): string {
  return String(slug || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** What to tell somebody who followed a link to a posting that is no longer listed. */
export function goneMessage(slug: string): string {
  const name = humanise(slug);
  return name
    ? 'The posting you followed ("' + name + '") is no longer listed. It may have been filled, '
      + 'closed, or withdrawn. Everything currently open is below.'
    : 'That posting is no longer listed. Everything currently open is below.';
}

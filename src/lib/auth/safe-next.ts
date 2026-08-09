// src/lib/auth/safe-next.ts — the one answer to "is this `?next=` value somewhere on OUR site?"
//
// WHY THIS EXISTS. Two auth surfaces took a destination out of the query string and used it without
// asking where it pointed:
//
//   /portal/signup        `if (nextUrl && nextUrl.startsWith('/')) return Astro.redirect(nextUrl)`
//   /portal/face-setup    `const next = url.searchParams.get('next') || '/portal'`, then used for
//                         an immediate Astro.redirect, the "Skip for now" link, AND
//                         `window.location.href = nextUrl` after a successful enrolment.
//
// `startsWith('/')` is not an origin check. `//evil.example/x` starts with a slash and is a
// PROTOCOL-RELATIVE URL: every browser resolves it to `https://evil.example/x`. `/\evil.example` is
// normalised the same way by several of them. face-setup did not even have that much — it accepted
// `https://evil.example` verbatim.
//
// The consequence is a phishing primitive with our own domain on the front of it. Middleware itself
// mints `/portal/face-setup?next=<path>` links, so the shape is familiar and legitimate; a link
// handed to a signed-in employee sends them off-site from an edurankai.in URL, on the page that is
// asking them to set up a security factor, at the exact moment they are primed to re-enter
// credentials. A signup redirect does the same to a brand-new account holder one second after they
// chose a password.
//
// THE RULE: a `next` is a PATH ON THIS SITE or it is nothing. One leading slash, never two, never a
// backslash, no control characters (which are how a value gets split into a second header), and
// bounded in length. Anything else falls back to the caller's own safe default rather than being
// "cleaned up" — guessing at what an attacker-supplied destination meant is how these get reopened.
//
// Declared as a plain pure function with no imports on purpose: it is called from page frontmatter
// before anything else runs, and `const` is not hoisted.

/** The longest `next` worth honouring. Nothing legitimate on this platform is close. */
const MAX_NEXT_LENGTH = 512;

/** Control characters, including CR and LF — a redirect target must never carry them. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Return `raw` when it is a same-origin path, otherwise `fallback`.
 *
 *   const next = safeNextPath(url.searchParams.get('next'), '/portal');
 *
 * Accepts: '/portal', '/portal/employee?tab=leave', '/admin/hr#today'.
 * Refuses: 'https://evil.example', '//evil.example', '/\evil.example', 'javascript:...', 'portal'.
 */
export function safeNextPath(raw: unknown, fallback: string): string {
  const v = String(raw ?? '').trim();
  if (!v) return fallback;
  if (v.length > MAX_NEXT_LENGTH) return fallback;
  // A scheme ('https:'), a scheme-relative host ('//host') or a bare word ('portal') all fail here.
  if (v.charAt(0) !== '/') return fallback;
  // '//host' and '/\host' both resolve to another origin in browsers.
  if (v.charAt(1) === '/' || v.charAt(1) === '\\') return fallback;
  if (CONTROL_CHARS.test(v)) return fallback;
  return v;
}

// src/lib/upcoming.ts — features that exist in the product but are not open yet.
//
// WHY THIS EXISTS RATHER THAN DELETING THE PAGES. Messaging and mail are built, and they are being
// held back rather than abandoned. Three ways to express that, and only one is honest:
//
//   - REMOVE the entry: the feature vanishes, and everybody who used it once assumes it broke.
//   - LEAVE it live: people write messages nobody reads, which is worse than not offering it.
//   - SAY SO: the door is visible, clearly marked, and opening it explains when and why.
//
// The third is what this does. A person who knows a feature is coming asks a different question from
// one who thinks something is broken, and only one of those questions reaches the founder.
//
// ONE DECLARATION, EVERY SURFACE. Marking a feature upcoming in one place and forgetting the other
// three doors into it is how a "paused" feature stays half-live — which on this product has already
// happened with a messaging path that threw on every send for four months while the screen looked
// perfectly normal. Every entry point asks THIS module.
//
// TURNING ONE ON is a code change and deliberately so. These are product decisions, not settings: a
// toggle in an admin console invites somebody to open a feature on a Tuesday without deciding that
// it is ready. src/lib/feature-flags.ts is the right home for things that genuinely vary by
// environment; this is not one of them.

export interface UpcomingFeature {
  key: string;
  /** What a person sees where the feature would have been. */
  label: string;
  /** Said in the product's own voice, to the person who just tried to open it. */
  note: string;
  /** Where to go instead, when there is somewhere. */
  insteadHref?: string;
  insteadLabel?: string;
}

/**
 * The features currently held back.
 *
 * Each note says what to do NOW, because "coming soon" on its own is an answer that helps nobody.
 * Somebody who needed to send a message still needs to send it.
 */
export const UPCOMING: readonly UpcomingFeature[] = Object.freeze([
  {
    key: 'messaging',
    label: 'Messages',
    note: 'Internal messaging is not open yet. It is built and being finished rather than abandoned, '
      + 'and it will appear here when it is ready to be relied on. Until then, anything that needs a '
      + 'record — a decision, an approval, a request — should go through the screen that owns it, so '
      + 'it is on the record rather than in a chat.',
    insteadHref: '/portal/employee',
    insteadLabel: 'Back to your workspace',
  },
  {
    key: 'mail',
    label: 'Mail',
    note: 'Mail is not open yet. It is built and being finished rather than abandoned. Until it is, '
      + 'use your own email for anything that needs to reach somebody today.',
    insteadHref: '/portal/employee',
    insteadLabel: 'Back to your workspace',
  },
]);

const BY_KEY: Readonly<Record<string, UpcomingFeature>> = Object.freeze(
  Object.fromEntries(UPCOMING.map((f) => [f.key, f])),
);

/** Is this feature being held back? */
export function isUpcoming(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(BY_KEY, key);
}

/** The whole declaration, for a page that wants to explain itself. */
export function upcomingFeature(key: string): UpcomingFeature | null {
  return BY_KEY[key] || null;
}

/**
 * Does this path belong to a feature that is not open yet?
 *
 * Path-based so a nav entry, a deep link and a stray bookmark all get the same answer. Prefix
 * matching, because /portal/messages/42 is as much messaging as /portal/messages.
 */
const PREFIXES: readonly { prefix: string; key: string }[] = Object.freeze([
  { prefix: '/portal/messages', key: 'messaging' },
  { prefix: '/portal/mail', key: 'mail' },
  { prefix: '/admin/mail', key: 'mail' },
  { prefix: '/admin/threads', key: 'messaging' },
  { prefix: '/portal/dms', key: 'messaging' },
  { prefix: '/admin/dms', key: 'messaging' },
]);

export function upcomingForPath(pathname: string): UpcomingFeature | null {
  const p = String(pathname || '');
  for (const { prefix, key } of PREFIXES) {
    if (p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '?')) {
      return BY_KEY[key] || null;
    }
  }
  return null;
}

/** Every path prefix held back, so a nav can mark its own entries without repeating the list. */
export function upcomingPrefixes(): readonly string[] {
  return PREFIXES.map((p) => p.prefix);
}

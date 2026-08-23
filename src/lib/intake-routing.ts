// src/lib/intake-routing.ts — where a request goes after somebody sends it.
//
// ==================================================================================================
// NINE FORMS THAT TOOK A REAL REQUEST AND ROUTED IT NOWHERE
// ==================================================================================================
//
// Measured across every table the AquinTutor campus surface creates. For each one: does anything
// SELECT a row from it (a COUNT does not count), and does the file that writes it notify anybody?
//
//   buddy_requests                  no reader, no notification
//   club_joins                      no reader, no notification
//   coffee_matches                  no reader, no notification
//   cultural_literacy_applications  no reader, no notification
//   dorm_circle_signups             no reader, no notification
//   library_ill_requests            no reader, no notification
//   sleep_program_signups           no reader, no notification
//   test_bookings                   no reader, no notification
//   counselling_requests            was the ninth, until it was routed
//
// These are not abandoned features. Each has a working form, validation, a rate limit, a table, and
// a page that thanks the person afterwards. Everything about them is built except the part where a
// human finds out.
//
// The two that cost somebody something real:
//
//   test_bookings carries `special_accommodations` — "extra time, screen reader, sign-language
//   interpreter, low-distraction room", in the page's own placeholder text. A candidate declares a
//   disability accommodation, is told the booking is pending, and no operator is told to arrange an
//   interpreter. The accommodation cannot happen. That is worse than not offering the field.
//
//   library_ill_requests is somebody who needs a specific book by a specific date, with a `needed_by`
//   column that nothing reads before it passes.
//
// ==================================================================================================
// WHY A REGISTRY AND NOT NINE FIXES
// ==================================================================================================
//
// Wiring each form to a hard-coded address would fix nine bugs and leave the tenth form free to be
// written the same way next month. The defect is structural: nothing in the codebase ever had to
// state where an intake goes, so it was possible — easy, even — to build a complete intake that goes
// nowhere and looks finished.
//
// So a form declares its destination here or it has no destination, and either way the page says
// which. `unroutedIntakes()` puts the unconfigured ones on /admin/deployment-check, so "nobody is
// reading the accommodation requests" is a visible line on a screen rather than a discovery somebody
// makes in a complaint.
//
// ==================================================================================================
// RECIPIENTS ARE NOT INVENTED HERE
// ==================================================================================================
//
// Who answers a counselling request or a library request is a decision for the people running the
// place, not a default in a library file. Every kind below is unconfigured until somebody sets its
// variable, and unconfigured is handled by TELLING THE PERSON, not by quietly mailing an
// administrator. A fallback recipient would recreate the original bug in a form that no longer looks
// like one — the request would appear to be routed while landing on somebody with no remit to act.

export interface IntakeKind {
  key: string;
  /** What the person asked for, in the words they would use. */
  label: string;
  table: string;
  /** The variable naming whoever answers. Unset is legitimate; see the header. */
  envVar: string;
  /**
   * Whether the notification may carry what the person wrote.
   *
   * FALSE IS THE INTERESTING CASE. A counselling disclosure must not travel into an inbox, a backup
   * and a forwarded thread — CLAUDE.md forbids the equivalent screen, and email is more permanent
   * than a screen. Those notifications carry the fact of the request and a way to reply, and the
   * responder hears the rest from the person.
   */
  mayForwardContent: boolean;
  /** Why content is withheld, carried into the notification itself so it reads as a decision. */
  contentNote?: string;
}

export const INTAKE_KINDS: readonly IntakeKind[] = Object.freeze([
  {
    key: 'counselling', label: 'a counselling appointment', table: 'counselling_requests',
    envVar: 'WELLNESS_COUNSELLOR_EMAIL', mayForwardContent: false,
    contentNote: 'A mental-health disclosure stays in the database. The responder gets the fact of the request and a way to reply.',
  },
  {
    key: 'sleep', label: 'the sleep programme', table: 'sleep_program_signups',
    envVar: 'WELLNESS_COUNSELLOR_EMAIL', mayForwardContent: false,
    contentNote: 'Chronotype, bedtime and stated goals are health data about a named person and are not forwarded.',
  },
  {
    // The one where withholding content would defeat the purpose. An accommodation cannot be
    // arranged by somebody who has not been told what it is, and the person filled the field in
    // precisely so that it would be acted on. Forwarding it IS the consent they gave.
    key: 'test-booking', label: 'a test-centre booking', table: 'test_bookings',
    envVar: 'TEST_CENTRE_EMAIL', mayForwardContent: true,
  },
  { key: 'library-ill', label: 'an inter-library loan', table: 'library_ill_requests',
    envVar: 'LIBRARY_EMAIL', mayForwardContent: true },
  { key: 'cultural-literacy', label: 'a place on the cultural literacy programme', table: 'cultural_literacy_applications',
    envVar: 'CAMPUS_PROGRAMMES_EMAIL', mayForwardContent: true },
  { key: 'dorm-circle', label: 'a dorm circle', table: 'dorm_circle_signups',
    envVar: 'CAMPUS_COMMONS_EMAIL', mayForwardContent: true },
  { key: 'club-join', label: 'to join a club', table: 'club_joins',
    envVar: 'CAMPUS_COMMONS_EMAIL', mayForwardContent: true },
  { key: 'coffee-match', label: 'a coffee match', table: 'coffee_matches',
    envVar: 'CAMPUS_COMMONS_EMAIL', mayForwardContent: true },
  { key: 'buddy', label: 'a study buddy', table: 'buddy_requests',
    envVar: 'CAMPUS_COMMONS_EMAIL', mayForwardContent: true },
]);

export function intakeKind(key: string): IntakeKind | null {
  return INTAKE_KINDS.find((k) => k.key === key) || null;
}

/**
 * Read a configured value, from wherever it actually is.
 *
 * `import.meta.env` is Vite's, and it is UNDEFINED when this module is loaded by a plain Node
 * process — the test runner, and any script. Reading it unguarded threw "Cannot read properties of
 * undefined", which meant the one test asserting that a recipient is never invented could not run at
 * all. A guarantee that cannot be tested outside the app is not much of a guarantee.
 *
 * process.env covers that case and changes nothing in the running application, where Vite has
 * already substituted the value.
 */
export function envValue(name: string): string {
  const viteEnv = (import.meta as any)?.env as Record<string, string | undefined> | undefined;
  const fromVite = viteEnv ? viteEnv[name] : undefined;
  const fromNode = typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
  return String(fromVite ?? fromNode ?? '').trim();
}

/** Read a recipient by variable name. Whitespace-trimmed, and an address or nothing. */
export function recipientFor(envVar: string): string | null {
  const v = envValue(envVar);
  return v && v.includes('@') ? v : null;
}

export function intakeRecipient(key: string): string | null {
  const k = intakeKind(key);
  return k ? recipientFor(k.envVar) : null;
}

export function isIntakeRouted(key: string): boolean {
  return intakeRecipient(key) !== null;
}

/**
 * What the page may tell somebody after a successful write.
 *
 * The sentence comes from here rather than from the page, because a page cannot know whether anybody
 * is configured — and the bug being fixed is precisely a page that said something the configuration
 * did not support.
 */
export function intakePromise(key: string, routed = isIntakeRouted(key)): string {
  const k = intakeKind(key);
  const what = k ? k.label : 'your request';
  if (routed) {
    return 'Your request for ' + what + ' has been sent, and whoever handles it will reply to the contact you gave.';
  }
  return 'Your request for ' + what + ' is saved, and nobody is monitoring these at the moment, '
    + 'so it may not be read for a while. We would rather say so than leave you waiting on an answer '
    + 'that is not coming.';
}

export interface IntakeNotice {
  /**
   * The subject line. IDENTITY-FREE, ALWAYS.
   *
   * sendExternal writes to, from and subject into `email_logs`, which is readable on the admin mail
   * screens. A subject naming the person would leak them into exactly the place several of these
   * notifications exist to keep them out of. The body is not logged; the subject is.
   */
  subject: string;
  /** The body, one fact per line. What a responder needs in order to answer. */
  lines: string[];
}

/**
 * Tell whoever answers that a request exists.
 *
 * NEVER THROWS. The row is written before this runs, and a mail outage must not turn a saved request
 * into an error the person reads as "it did not send".
 */
export async function notifyIntake(key: string, n: IntakeNotice): Promise<{ notified: boolean; reason?: string }> {
  const k = intakeKind(key);
  if (!k) return { notified: false, reason: 'unknown intake kind' };
  const to = recipientFor(k.envVar);
  if (!to) return { notified: false, reason: 'no recipient configured' };

  const body = n.lines
    .concat(k.mayForwardContent ? [] : ['', k.contentNote || '', 'Ask them directly. It stays theirs to tell.'])
    .filter((l) => l !== null && l !== undefined)
    .join(String.fromCharCode(10));

  try {
    const { sendExternal } = await import('@/lib/mail-transport');
    const r = await sendExternal({
      from: envValue('EMAIL_FROM') || 'AquinTutor <connect@edurankai.in>',
      to,
      subject: n.subject,
      html: '<pre style="font:14px/1.6 ui-monospace,monospace;white-space:pre-wrap;">'
        + body.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>',
      text: body,
    });
    return r.ok ? { notified: true } : { notified: false, reason: r.error || 'send failed' };
  } catch (e: any) {
    // The reason, never the payload: an error string from this path could carry the person's contact.
    console.error('[intake-routing] could not notify for ' + key + ':', e?.cause?.message || e?.message);
    return { notified: false, reason: 'send failed' };
  }
}

/** The unconfigured kinds, for /admin/deployment-check. */
export function unroutedIntakes(): IntakeKind[] {
  return INTAKE_KINDS.filter((k) => recipientFor(k.envVar) === null);
}

/** Distinct variables to set, since several kinds legitimately share one mailbox. */
export function intakeEnvVars(): string[] {
  return Array.from(new Set(INTAKE_KINDS.map((k) => k.envVar))).sort();
}

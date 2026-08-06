// src/lib/meet-access.ts — MAY THIS PERSON CALL A MEETING? Asked in ONE place.
//
// WHY IT IS NOT INLINE IN THE ROUTE. The question is asked by three surfaces — /portal/meet (to
// decide whether the two scheduling buttons are live), POST /api/meet/rooms (to decide whether a
// meeting is written) and any later scheduling caller. Three copies of a gate are three chances for
// the button and the endpoint to disagree, and a button that is enabled in front of an endpoint that
// refuses is the same class of defect as the schema split this pass exists to remove: the screen
// says one thing and the write says another.
//
// WHAT IT ASKS, AND WHY THAT EXACT QUESTION. Not a role name — src/lib/workforce/navigation.ts
// already publishes the reachability rule for this destination, and it is `worksHere`:
//
//     const worksHere: NavAudience = (v) => v.ctx.hasEmployeeRecord || v.ctx.holds('admin.access');
//     { key: 'meet', href: '/portal/meet', audience: worksHere }   (navigation.ts:271-279)
//
// so the nav has NEVER offered /portal/meet to anyone else. The endpoint was the only party not
// honouring the rule already written down. This restates nothing: it resolves the SAME composition
// through composeWorkspace() and applies the SAME predicate, so the API cannot end up more generous
// than the menu that leads to it.
//
// THIS IS A NARROWING OF THE WRITE PATH, SAID OUT LOUD. Before this, anyone signed in could POST a
// meeting; now the caller must work here. It is deliberate and it is scoped as tightly as it can be:
//
//   * Only CREATE is gated. Reading, updating and cancelling an EXISTING meeting stay scoped to
//     `host_user_id::text = <caller>` in the WHERE clause (src/pages/api/meet/rooms/[id].ts), which
//     is strictly stronger than any capability test — so nobody who already has a meeting is
//     stranded and unable to cancel it.
//   * JOINING IS NOT GATED AT ALL. /portal/meet/[id] is signed-in-only and stays that way. A learner
//     opening a course room through the iframe at src/pages/portal/courses/[slug].astro:344, and a
//     teacher opening /portal/meet/teacher-<id> from the AquinTutor console, never touch this file.
//     Gating the room would have broken both, which is why the room page is untouched.
//
// IT FAILS CLOSED, in every direction. composeWorkspace() denies on a failed employee lookup, and
// resolvePermissions() returns an EMPTY set on any error (registry.ts: no exception path ever adds a
// permission), so ctx.holds() answers false when the database blinks. A hiccup refuses a meeting; it
// never authorises one. There is no `catch` here that returns ok — the catch below denies.
import { composeWorkspace } from '@/lib/workforce/composer';
import { logEvent } from '@/lib/logger';

// Declared at the very top, above every function that uses them: `const` is not hoisted, and a
// handler reaching a later declaration has taken pages down on this project.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/**
 * The sentence a surface shows when the caller may not call a meeting.
 *
 * It names the actual condition rather than "forbidden", because the reader is far more likely to be
 * a learner who followed a link from a product page than an attacker — and it does not offer a
 * workaround that does not exist.
 */
export const MEET_NOT_YOURS_TO_SCHEDULE =
  'Scheduling a meeting is for people who work here. You can still open a room somebody has shared ' +
  'with you by using its code, and you can still join anything you were invited to.';

export interface MeetGate {
  /** May this person create a meeting? */
  ok: boolean;
  /** Empty when ok. Otherwise a sentence a person can read, already decided — never a code. */
  reason: string;
  /** True when something did not answer, so a surface can avoid stating the refusal as settled. */
  degraded: boolean;
  /**
   * Is this refusal WORTH RETRYING? True only when the answer was "we could not tell" — which is a
   * 503 and an invitation to try again. A settled "this is not for you" is a 403 and never a 503:
   * telling somebody to come back later when the answer will be identical wastes their time. Kept
   * separate from `degraded`, which can be true on a refusal that is nonetheless final.
   */
  retryable: boolean;
}

/**
 * May `user` schedule or open a NEW meeting?
 *
 * Pass Astro.locals wherever you have it: composeWorkspace memoises on it, so a page that already
 * composed (and every /api route that calls this once) pays for one composition, not two.
 */
export async function canScheduleMeeting(
  user: any,
  opts: { locals?: any; next?: string } = {},
): Promise<MeetGate> {
  if (!user?.id) {
    return { ok: false, reason: 'Please sign in to schedule a meeting.', degraded: false, retryable: false };
  }

  try {
    const composed = await composeWorkspace(user, {
      locals: opts.locals,
      next: opts.next || '/portal/meet',
    });
    const ctx = composed.context;

    // The nav's `worksHere`, restated against the same composition it reads. holds() is
    // WILDCARD-aware, so a super_admin passes without holding the literal key.
    const worksHere = ctx.hasEmployeeRecord === true || ctx.holds('admin.access') === true;

    if (worksHere) return { ok: true, reason: '', degraded: composed.degraded, retryable: false };

    // A composition that could not be trusted is a REFUSAL, not a grant — and it gets its own
    // sentence, because "we could not read your record" and "this is not for you" are different
    // facts and sending somebody to the wrong one wastes their afternoon.
    if (composed.reason === 'lookup-failed') {
      return {
        ok: false,
        degraded: true,
        retryable: true,
        reason:
          'Your record could not be read just now, so a new meeting has not been created. Nothing ' +
          'has been lost. Try again in a moment.',
      };
    }

    return { ok: false, reason: MEET_NOT_YOURS_TO_SCHEDULE, degraded: composed.degraded, retryable: false };
  } catch (e: any) {
    // NOT swallowed into a pass. Logged, and denied.
    logEvent('error', 'meet.access.gate-failed', {
      userId: String(user?.id || ''),
      message: reasonOf(e),
    });
    return {
      ok: false,
      degraded: true,
      retryable: true,
      reason:
        'We could not confirm whether you can call a meeting just now, so nothing has been created. ' +
        'Try again in a moment.',
    };
  }
}

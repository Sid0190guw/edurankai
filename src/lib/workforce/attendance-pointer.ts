// ------------------------------------------------------------------------------------------------
// WHERE DO I MARK MY ATTENDANCE?
//
// Reported on 2026-08-23 by a joiner who opened /portal/profile, found the "Work log" card, opened
// it, and could not find attendance anywhere on it. She was right: there was nothing to find.
//
//   * /portal/employee/attendance is the attendance surface, and it is reachable ONLY from the
//     employee workspace navigation. Somebody whose account still renders the applicant shell
//     (BaseLayout, "My applications", "Browse roles") never sees that navigation at all.
//   * The work log is NOT attendance. It is an offline note of what you did, written into
//     offline_work. It has no clock, no check-in, no day. Sitting alone on the profile page under a
//     heading about "recording your work", it is the only thing on that screen that looks like the
//     answer, so it is what people open.
//   * And if HR has not linked the hr_employees record to the sign-in address yet, the attendance
//     page refuses — correctly — but the person had no way to reach the page and read that refusal.
//     The absence of a link and the absence of a record looked identical from the profile page:
//     nothing at all, with no sentence anywhere saying which one it was.
//
// This resolves that question ONCE, in the shape a card can render, so /portal/profile and
// /portal/worklog say the same thing rather than each inventing an answer. It never hides the state
// it resolves: when a person cannot mark attendance the card SAYS SO and says why, because a missing
// card is indistinguishable from a missing feature and sends them to their manager instead of to HR.
//
// COST: one requireEmployee() call. lookupWorkspace() memoizes on the user object for the request,
// so on a page that already gated with requireEmployee/composeWorkspace this adds no query at all.
// Deliberately no read of today's punches here — punchesOn() calls ensureAttendanceSchema(), and
// request-time DDL on the profile page is a trade this project has already paid for once.
// ------------------------------------------------------------------------------------------------
import { requireEmployee, type WorkspaceUser } from '@/lib/auth/workspace-access';

/** The one attendance destination. Anything that links to attendance links here. */
export const ATTENDANCE_HREF = '/portal/employee/attendance';

export interface AttendancePointer {
  /** True only when this person can actually open the attendance screen and punch. */
  ok: boolean;
  /** Null whenever `ok` is false — a link that lands on a refusal is worse than no link. */
  href: string | null;
  cta: string;
  headline: string;
  body: string;
  /** 'action' = go here now. 'warn' = something needs a human. 'muted' = nothing to do here. */
  tone: 'action' | 'warn' | 'muted';
}

/**
 * What to show a signed-in person about marking their attendance.
 *
 * @param user Astro.locals.user.
 */
export async function attendancePointer(
  user: WorkspaceUser | null | undefined,
): Promise<AttendancePointer> {
  const gate = await requireEmployee(user, ATTENDANCE_HREF);

  if (gate.ok) {
    return {
      ok: true,
      href: ATTENDANCE_HREF,
      cta: 'Mark attendance',
      headline: 'Attendance',
      body: 'Check in for the day, take a break and check out. This is your attendance record and it is not the same thing as the work log.',
      tone: 'action',
    };
  }

  const email = String(user?.email || '').trim();
  const signedInAs = email ? ' You are signed in as ' + email + '.' : '';

  // The gate already writes each of these sentences for the attendance page itself. Rendering the
  // SAME words here keeps one explanation for one situation — the alternative is a card that says
  // one thing and a page that says another about the same account.
  if (gate.code === 'no-employee-record') {
    return {
      ok: false,
      href: null,
      cta: '',
      // Softer words than the gate's own, and MUTED rather than amber, on purpose. This page is also
      // the profile of every job applicant on the site, and most of them have no employee record
      // because they do not work here — an alert-coloured box telling them so would be a support
      // ticket, not information. Hiding it instead is what caused this defect, so it stays visible.
      headline: 'Attendance is not open on this account yet',
      body: gate.reason + signedInAs,
      tone: 'muted',
    };
  }

  if (gate.code === 'ambiguous-record') {
    return { ok: false, href: null, cta: '', headline: gate.title, body: gate.reason + signedInAs, tone: 'warn' };
  }

  if (gate.code === 'lookup-failed') {
    return {
      ok: false,
      href: null,
      cta: '',
      headline: gate.title,
      // Said plainly: this is our fault and not a claim about their employment.
      body: gate.reason + ' This is a fault at our end, not a sign that you have no attendance to mark.',
      tone: 'warn',
    };
  }

  if (gate.code === 'inactive') {
    return { ok: false, href: null, cta: '', headline: gate.title, body: gate.reason, tone: 'muted' };
  }

  return {
    ok: false,
    href: null,
    cta: '',
    headline: gate.title || 'Attendance is not available on this account',
    body: gate.reason || 'We could not work out whether you have attendance to mark.',
    tone: 'muted',
  };
}

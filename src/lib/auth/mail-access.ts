// src/lib/auth/mail-access.ts — MAY THIS PERSON USE THE COMPANY MAILBOX?
//
// WHY THIS EXISTS. The real mail system (own SMTP/IMAP, folders, groups, rules, templates,
// tracking — src/lib/mail.ts + mail-transport.ts + mail-groups.ts) had exactly ONE UI mount:
// src/components/MailClient.astro at /admin/mail. Its three write endpoints
// (/api/mail/send, /api/mail/draft, /api/mail/action) were therefore gated on denyAdminApi(),
// which runs canOpenAdmin() — "may you open the ADMIN CONSOLE". That is the correct question for
// a console and the WRONG question for a mailbox: an employee who will never see /admin still
// has a work address, still receives inbound mail through the IMAP poller, and could not open,
// read or answer any of it. The product answered that by growing a SECOND mailbox at
// /portal/mail on portal_mail_* tables with no SMTP path at all — mail sent there never left the
// building and external mail never arrived.
//
// This module asks the mailbox question instead, so ONE mail system can serve both surfaces.
// It does not create a second RBAC: it composes three answers that already exist.
//
// IT FAILS CLOSED. Every arm it consults fails closed — canOpenAdmin() denies when the employee
// lookup throws, requireEmployee() returns 'lookup-failed' rather than a guess, and
// holdsCapability() needs no database at all. A database hiccup refuses to send a message; it
// never sends one on behalf of somebody who should not have.
//
// IT AUTHORISES BEFORE THE HANDLER RUNS. Call denyMailApi() on the first line, before reading the
// body and before any SELECT — a query that ran for an unauthorised principal has already
// happened whatever the response says.
import { canOpenAdmin } from '@/lib/auth/admin-access';
import { holdsCapability } from '@/lib/auth/capability';
import { requireEmployee, type WorkspaceUser } from '@/lib/auth/workspace-access';
import { logEvent } from '@/lib/logger';

// Declared at the very top: `const` is not hoisted, and a handler reaching a later declaration has
// taken pages down on this project.
const json = (d: any, status: number): Response =>
  new Response(JSON.stringify(d), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * DOES AN INTERNSHIP ENGAGEMENT KEEP ITS MAILBOX? Yes, and it is a POLICY decision written as one
 * flippable line rather than buried in an expression.
 *
 * canOpenAdmin() refuses an internship record WHATEVER the role, because the 2026 escalation was an
 * intern reaching the applicant pipeline and every employee record. That refusal is about a
 * CONSOLE. A mailbox is not a console: it shows the holder their own mail and nobody else's, every
 * read in src/lib/mail.ts is keyed by mail_box.user_id, and an intern with no way to answer a
 * message is an intern who cannot do the work they were hired for.
 *
 * The refusal is also not enforced anywhere else in this module today: /api/mail/test.ts sends REAL
 * mail from the company mailbox and gates on can(user, 'mail.manage') with no internship check at
 * all, so an intern holding an internal role can already send. Reproducing a refusal here that its
 * sibling endpoint does not apply would be a half-closed door, which is worse than either state.
 *
 * Set this to true to refuse interns and the employee arm below narrows in one line. Doing so is a
 * policy change and belongs to a human, which is why it is a named constant and not a comment.
 */
export const MAILBOX_REFUSES_INTERNS = false;

export type MailAccessReason =
  | 'ok'
  | 'not-signed-in'
  /** Signed in, no internal role and no active employee record. An applicant, essentially. */
  | 'no-mailbox'
  /** An internship record, and MAILBOX_REFUSES_INTERNS is on. */
  | 'internship'
  /** The employee lookup did not run. Denied — see the fail-closed note at the top. */
  | 'lookup-failed';

export interface MailAccess {
  /** The only field that may be used to decide. Never infer access from `via` or `reason`. */
  allowed: boolean;
  reason: MailAccessReason;
  /** Which arm admitted them, for the log line and for a diagnostics screen. Null on a denial. */
  via: 'capability' | 'admin' | 'employee' | null;
  /** A heading and a sentence a person can act on. Null when allowed. Render it — a blank mailbox
   *  with no explanation reads as "you have no mail". */
  denial: { title: string; reason: string } | null;
}

const ALLOW = (via: NonNullable<MailAccess['via']>): MailAccess => ({ allowed: true, reason: 'ok', via, denial: null });

/**
 * MAY THIS ACCOUNT OPEN AND USE THE COMPANY MAILBOX?
 *
 * Three arms, cheapest first, and each one is an answer that already exists elsewhere:
 *
 *   1. `mail.manage` through can() — the compiled matrix only, NO database. Granted in
 *      PERMS_BY_ROLE to exactly the ten non-applicant built-in roles, which is the population
 *      /api/mail/{test,verify,imap-poll,imap-test} already admit to the company mailbox today. So
 *      this arm adds nobody who cannot already send from it, and it costs no query for the roles
 *      that make up most of the traffic.
 *
 *   2. canOpenAdmin() — kept even though the ten roles above are a superset of the seven
 *      admin-capable ones, because it is the ONLY arm that sees a CUSTOM role granted admin.access
 *      through src/lib/auth/registry.ts. Dropping it would silently REMOVE the mailbox from a
 *      custom role that has it today, which is a narrowing dressed up as a simplification.
 *
 *   3. An ACTIVE employee record — requireEmployee(). This is the arm this module was written for:
 *      the person works here, has a work address, and receives mail whether or not anyone gave
 *      them a console. It is the same fact the workforce navigation calls `worksHere` and the same
 *      lookup composeWorkspace() already ran, so the two surfaces cannot disagree about who works
 *      here.
 *
 * WHAT THIS WIDENS, stated plainly rather than left to be discovered. Before: /api/mail/send and
 * /api/mail/draft admitted canOpenAdmin() only — seven built-in roles plus registry grants, never
 * an internship. After: those seven, plus partner / teacher / technical_moderator (who already
 * send company mail through /api/mail/test), plus anyone with an active hr_employees record
 * including interns (see MAILBOX_REFUSES_INTERNS). It does NOT admit an applicant with no employee
 * record, which is the account type the original `if (!user) return 401` let through.
 */
export async function canUseMailbox(user: WorkspaceUser | null | undefined): Promise<MailAccess> {
  if (!user?.id) {
    return {
      allowed: false,
      reason: 'not-signed-in',
      via: null,
      denial: {
        title: 'Please sign in',
        reason: 'Your mailbox shows your own messages, so it needs you signed in.',
      },
    };
  }

  // 1. No database. The ten internal roles.
  if (holdsCapability(user, 'mail.manage')) return ALLOW('capability');

  // 2. One indexed query, and the only arm that sees a registry grant of admin.access.
  const admin = await canOpenAdmin(user);
  if (admin.allowed) return ALLOW('admin');

  // 3. Do they work here? requireEmployee fails closed on its own errors and distinguishes "no
  //    record" from "the lookup did not run" — two different screens, never collapsed into one.
  let gate: Awaited<ReturnType<typeof requireEmployee>>;
  try {
    gate = await requireEmployee(user, '/portal/employee/mail');
  } catch (e: any) {
    // requireEmployee already fails closed; this catches anything it could not. Logged with the
    // real Postgres reason — e.message is only the failed SQL.
    logEvent('error', 'mail.access.lookup-failed', {
      userId: user.id,
      message: String(e?.cause?.message || e?.message || 'unknown error'),
    });
    gate = {
      ok: false, workspace: null, scopeDepartmentId: null, code: 'lookup-failed',
      title: 'We could not check your mailbox just now',
      reason: 'Something went wrong reading your employee record. No message has been lost. Try again in a moment, and tell HR if it keeps happening.',
      redirect: null,
    };
  }

  if (gate.ok) {
    if (MAILBOX_REFUSES_INTERNS && gate.workspace.isIntern) {
      return {
        allowed: false,
        reason: 'internship',
        via: null,
        denial: {
          title: 'This mailbox is not open to internship engagements',
          reason: 'Your engagement is recorded as an internship. Ask HR if you should have a company mailbox.',
        },
      };
    }
    return ALLOW('employee');
  }

  if (gate.code === 'lookup-failed') {
    return { allowed: false, reason: 'lookup-failed', via: null, denial: { title: gate.title, reason: gate.reason } };
  }

  // 'no-employee-record', 'inactive' and 'ambiguous-record' all mean the same thing HERE: there is
  // no mailbox to open. The gate's own sentence is used, because it names what is missing and who
  // fixes it — which a bare "access denied" never does.
  return {
    allowed: false,
    reason: 'no-mailbox',
    via: null,
    denial: { title: gate.title, reason: gate.reason },
  };
}

export interface MailApiGuardOptions {
  /** Included verbatim in the refusal log line, so a denial names the endpoint. */
  label?: string;
}

/**
 * Refuse, or return null and let the handler run.
 *
 *   const denied = await denyMailApi(locals, { label: 'mail.send' });
 *   if (denied) return denied;
 *
 * 401 when nobody is signed in (the caller can sign in and retry), 403 for everything else. The
 * body is a bare `{ ok: false, error }` on purpose: a refusal that explains which capability was
 * missing tells an unauthorised caller what to go looking for.
 */
export async function denyMailApi(locals: any, opts: MailApiGuardOptions = {}): Promise<Response | null> {
  const user = locals?.user;
  const verdict = await canUseMailbox(user);
  if (verdict.allowed) return null;

  logEvent('warn', 'mail.api.refused', {
    label: opts.label || null,
    userId: user?.id || null,
    role: String(user?.role || '') || null,
    reason: verdict.reason,
  });
  return json({ ok: false, error: verdict.reason === 'not-signed-in' ? 'unauthorized' : 'forbidden' },
    verdict.reason === 'not-signed-in' ? 401 : 403);
}

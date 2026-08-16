// src/lib/mailgov/deletion-plan.ts — WHAT "DELETE" ACTUALLY REMOVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// PURE. No database. ./deletion.ts executes these plans; this file decides what a plan IS, so the
// blast radius of every scope is a value a test can assert and a screen can print BEFORE anybody
// presses the button.
//
// THE THREE CONTROLS ON IRREVERSIBLE WORK, and each one exists because the others are insufficient:
//
//   1. A TYPED CONFIRMATION derived from the target. Not "type DELETE" — type the thing you are
//      deleting. A confirmation you can satisfy without reading it is a click-through.
//   2. APPROVALS, and for an organization TWO DIFFERENT PEOPLE. The requester cannot be an approver
//      of their own organization deletion; see approvalsSatisfied().
//   3. A GRACE WINDOW during which the job is visible and cancellable. Most catastrophic deletions
//      are noticed within minutes by the person who ran them, and a window is the difference between
//      an incident and a story.
//
// WHAT IS NEVER DELETED, and why refusing to delete it is the correct behaviour rather than a gap:
//
//   THE AUDIT LOG. Deleting an organization deletes its data; the record of who deleted it, when and
//   under what authority survives. An erasure system that erases the evidence of erasure cannot
//   demonstrate compliance with anything — it can only assert it.
//
//   SUPPRESSION ENTRIES, by default. An address on the suppression list asked (or its mail server
//   said) never to receive mail again. Deleting that row is not privacy: it is the platform
//   forgetting a refusal and mailing them again. The entry is minimal by construction — address,
//   reason, date — and it is kept for exactly the purpose the person's own action created. An
//   operator may override with `alsoRemoveSuppression`, and the plan then says out loud that mail to
//   that address becomes possible again.

export const DELETION_SCOPES = ['contact', 'mailbox', 'organization'] as const;
export type DeletionScope = (typeof DELETION_SCOPES)[number];

export type DeletionStatus =
  | 'pending_approval'
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'blocked'
  | 'failed';

/** One statement the engine will run, in order. `table` is checked to exist before it is touched. */
export interface DeletionStep {
  table: string;
  /** What this step does in words, printed on the confirmation screen. */
  describes: string;
  /** 'delete' removes rows; 'redact' overwrites identifying columns and keeps the row. */
  mode: 'delete' | 'redact';
  /** True when a missing table is expected on this deployment rather than an error. */
  optional?: boolean;
}

export interface DeletionPlan {
  scope: DeletionScope;
  /** The address, mailbox owner id, or organization id. */
  target: string;
  /** Human name for the confirmation screen. */
  targetLabel: string;
  steps: DeletionStep[];
  /** Stated on the screen, and repeated in the completion record. */
  retained: string[];
  approvalsRequired: number;
  graceHours: number;
  confirmationPhrase: string;
  reversible: false;
}

/**
 * The phrase the requester must type. Derived from the target so it cannot be muscle-memoried, and
 * short enough that a tired operator will actually read it rather than paste it.
 */
export function confirmationPhraseFor(scope: DeletionScope, target: string): string {
  const t = (target || '').trim().toLowerCase();
  switch (scope) {
    case 'contact': return 'erase ' + t;
    case 'mailbox': return 'delete mailbox ' + t.slice(0, 8);
    case 'organization': return 'delete organization ' + t.slice(0, 8);
  }
}

/**
 * How many approvals a scope needs BEYOND the request itself.
 *
 * A contact erasure is one person's routine work and often a legal obligation with a deadline —
 * putting a second signature in front of it makes the platform slower at the thing it is required to
 * be prompt about. An organization is the opposite: it is rare, irreversible, and takes a tenant
 * offline permanently.
 */
export function requiredApprovals(scope: DeletionScope): number {
  switch (scope) {
    case 'contact': return 0;
    case 'mailbox': return 1;
    case 'organization': return 2;
  }
}

/** How long the job sits visible and cancellable before it runs. */
export function graceHours(scope: DeletionScope): number {
  switch (scope) {
    case 'contact': return 0;
    case 'mailbox': return 24;
    case 'organization': return 72;
  }
}

export interface Approval {
  userId: string;
  at: string;
}

/**
 * Are the approvals in? DISTINCT people, and never the requester.
 *
 * "Two approvals" that one person can supply twice, or that the requester can supply themselves, is
 * a counter rather than a control. This is the function that makes the number mean something.
 */
export function approvalsSatisfied(
  scope: DeletionScope,
  requestedBy: string,
  approvals: Approval[],
): { ok: boolean; have: number; need: number; error?: string } {
  const need = requiredApprovals(scope);
  const distinct = new Set(
    (approvals || []).map((a) => a.userId).filter((u) => !!u && u !== requestedBy),
  );
  const have = distinct.size;
  if (have < need) {
    return {
      ok: false, have, need,
      error: need === 0
        ? undefined
        : 'Needs ' + need + ' approval' + (need === 1 ? '' : 's') + ' from people other than the requester; has ' + have + '.',
    };
  }
  return { ok: true, have, need };
}

/**
 * THE PLANS.
 *
 * Ordered children-first so a foreign key never refuses a step, and every table is named explicitly
 * rather than discovered — a deletion engine that works out for itself what to drop is one schema
 * change away from dropping something else.
 */
export function deletionPlan(input: {
  scope: DeletionScope;
  target: string;
  targetLabel?: string;
  alsoRemoveSuppression?: boolean;
}): DeletionPlan {
  const { scope, target } = input;
  const targetLabel = input.targetLabel || target;
  const base = {
    scope, target, targetLabel,
    approvalsRequired: requiredApprovals(scope),
    graceHours: graceHours(scope),
    confirmationPhrase: confirmationPhraseFor(scope, target),
    reversible: false as const,
  };

  if (scope === 'contact') {
    // TENANT TABLES ONLY. An erasure requested by one organization must not reach into EduRankAI's
    // own internal mailbox store (mail_messages, mail_recipients, email_logs) — those rows are our
    // correspondence, not this tenant's data, and deleting them on a customer's request would be one
    // customer erasing another party's records. Erasing somebody from the internal mailbox store is
    // the `mailbox` scope, which is platform-only.
    const steps: DeletionStep[] = [
      { table: 'mailapi_consent', mode: 'delete', describes: 'Every consent and unsubscribe record this organization holds for the address.' },
      { table: 'mailapi_message_events', mode: 'delete', describes: 'Delivery, bounce, open and click events naming the address.' },
      { table: 'mailapi_ai_records', mode: 'delete', optional: true, describes: 'AI processing records for messages addressed only to this address.' },
      { table: 'mailapi_messages', mode: 'redact', describes: 'Messages addressed to it: the address is removed from the recipient lists. A message addressed to nobody else is deleted outright.' },
    ];
    const retained = [
      'The audit record of this erasure, including who requested it and when.',
      'EduRankAI’s own internal mailbox records. They are not this organization’s data and are not touched by a tenant erasure.',
    ];
    if (input.alsoRemoveSuppression) {
      steps.push({ table: 'mailapi_suppressions', mode: 'delete', describes: 'The suppression entry. REMOVING THIS MAKES MAIL TO THIS ADDRESS POSSIBLE AGAIN, including mail it previously bounced or complained about.' });
    } else {
      retained.push('The suppression entry, if any. It holds the address, a reason and a date, and it is what stops this platform mailing them again.');
    }
    return { ...base, steps, retained };
  }

  if (scope === 'mailbox') {
    return {
      ...base,
      steps: [
        { table: 'mail_box', mode: 'delete', optional: true, describes: 'This mailbox holder’s copy of every message: folder, read state, stars and labels.' },
        { table: 'mail_message_labels', mode: 'delete', optional: true, describes: 'Label assignments belonging to this mailbox.' },
        { table: 'mail_labels', mode: 'delete', optional: true, describes: 'Labels this holder created.' },
        { table: 'mail_rules', mode: 'delete', optional: true, describes: 'Filing and forwarding rules.' },
        { table: 'mail_settings', mode: 'delete', optional: true, describes: 'Signature, display name and vacation settings.' },
        { table: 'mail_user_prefs', mode: 'delete', optional: true, describes: 'Mailbox preferences.' },
        { table: 'mail_scheduled', mode: 'delete', optional: true, describes: 'Messages this holder had scheduled and not yet sent.' },
        { table: 'mail_messages', mode: 'delete', optional: true, describes: 'Message bodies left with no holder at all once the rows above are gone. A message another mailbox still holds is kept — it is their copy too.' },
      ],
      retained: [
        'Messages any other mailbox still holds. Deleting one person’s mailbox does not delete the other side of their conversations.',
        'The audit record of this deletion.',
        'Send logs, which record that a message left the platform and to which domain.',
      ],
    };
  }

  return {
    ...base,
    steps: [
      { table: 'mailapi_webhook_deliveries', mode: 'delete', describes: 'Every webhook delivery attempt and its payload.' },
      { table: 'mailapi_webhooks', mode: 'delete', describes: 'Webhook endpoints and their signing secrets.' },
      { table: 'mailapi_message_events', mode: 'delete', describes: 'Every delivery event for every message.' },
      { table: 'mailapi_messages', mode: 'delete', describes: 'Every message the organization sent through the API, bodies included.' },
      { table: 'mailapi_template_versions', mode: 'delete', describes: 'Every template version.' },
      { table: 'mailapi_templates', mode: 'delete', describes: 'Every template.' },
      { table: 'mailapi_idempotency', mode: 'delete', describes: 'Stored idempotent responses.' },
      { table: 'mailapi_consent', mode: 'delete', describes: 'Every consent and unsubscribe record the organization held.' },
      { table: 'mailapi_domains', mode: 'delete', describes: 'Sending domains and their verification state.' },
      { table: 'mailapi_keys', mode: 'delete', describes: 'Every API key. They stop working the moment this runs.' },
      { table: 'mailapi_suppressions', mode: 'delete', describes: 'The suppression list. It belongs to this organization and has no meaning once the organization is gone.' },
      { table: 'mailapi_org_members', mode: 'delete', describes: 'Every membership. The people keep their EduRankAI accounts; they lose this organization.' },
      { table: 'mailapi_retention_policies', mode: 'delete', describes: 'Retention settings.' },
      { table: 'mailapi_export_jobs', mode: 'delete', describes: 'Export jobs and their download tokens. Any export still inside its download window stops being downloadable.' },
      { table: 'mailapi_support_grants', mode: 'delete', describes: 'Support content authorisations for this organization. The audit events recording that content WAS read under them survive.' },
      { table: 'mailapi_orgs', mode: 'delete', describes: 'The organization row itself.' },
    ],
    retained: [
      'The audit log, in full. Who deleted this organization, when, on whose approval, and what the deletion removed.',
      'Security events, which are the platform’s own record of abuse and incidents rather than the tenant’s data.',
      'Legal holds and their matters. A hold outliving the organization is the point of a hold.',
    ],
  };
}

export type DeletionBlockReason = 'legal-hold' | 'confirmation-mismatch' | 'approvals-missing' | 'grace-not-elapsed' | 'org-not-suspended';

export interface DeletionGate {
  ok: boolean;
  code?: DeletionBlockReason;
  error?: string;
}

/**
 * Everything that must be true at the moment the engine is about to run — checked AGAIN at execution
 * time, not only when the job was created.
 *
 * The re-check is the point. A hold placed during the grace window, or a matter opened an hour after
 * the request, has to stop the job; a gate evaluated once at request time would let a deletion that
 * was lawful on Monday run on Thursday when it no longer is.
 */
export function deletionGate(input: {
  scope: DeletionScope;
  target: string;
  requestedBy: string;
  typedPhrase: string;
  approvals: Approval[];
  scheduledFor: string | null;
  now: Date;
  activeHolds: number;
  /** For organization scope: is the tenant already suspended? */
  orgSuspended?: boolean;
}): DeletionGate {
  if (input.activeHolds > 0) {
    return {
      ok: false, code: 'legal-hold',
      error: input.activeHolds + ' legal hold' + (input.activeHolds === 1 ? '' : 's')
        + ' cover this target. Release the hold, or close the matter, before anything is deleted.',
    };
  }

  const expected = confirmationPhraseFor(input.scope, input.target);
  if ((input.typedPhrase || '').trim().toLowerCase() !== expected) {
    return { ok: false, code: 'confirmation-mismatch', error: 'Type exactly: ' + expected };
  }

  const appr = approvalsSatisfied(input.scope, input.requestedBy, input.approvals);
  if (!appr.ok) return { ok: false, code: 'approvals-missing', error: appr.error };

  if (input.scheduledFor) {
    const due = new Date(input.scheduledFor).getTime();
    if (Number.isFinite(due) && input.now.getTime() < due) {
      return {
        ok: false, code: 'grace-not-elapsed',
        error: 'Scheduled for ' + input.scheduledFor + '. It can be cancelled until then.',
      };
    }
  }

  // An organization is suspended first, always. Suspension is reversible and stops the tenant sending
  // while somebody works out whether the deletion was really meant; deleting a live, sending tenant
  // outright removes that step for no gain.
  if (input.scope === 'organization' && input.orgSuspended === false) {
    return {
      ok: false, code: 'org-not-suspended',
      error: 'Suspend the organization first. A live tenant is not deleted in one step.',
    };
  }

  return { ok: true };
}

/** When the job becomes eligible to run. Pure so the screen and the engine agree on the minute. */
export function scheduledFor(scope: DeletionScope, requestedAt: Date): string | null {
  const h = graceHours(scope);
  if (h <= 0) return null;
  return new Date(requestedAt.getTime() + h * 60 * 60 * 1000).toISOString();
}

/** A one-line summary for the audit event and the console list. */
export function planSummary(plan: DeletionPlan): string {
  const deletes = plan.steps.filter((s) => s.mode === 'delete').length;
  const redacts = plan.steps.length - deletes;
  return plan.scope + ' ' + plan.targetLabel + ': ' + deletes + ' table' + (deletes === 1 ? '' : 's')
    + ' cleared' + (redacts ? ', ' + redacts + ' redacted' : '') + ', ' + plan.retained.length + ' thing'
    + (plan.retained.length === 1 ? '' : 's') + ' deliberately kept.';
}

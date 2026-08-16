// src/lib/mailgov/support-policy.ts — WHAT A SUPPORT ENGINEER SEES BEFORE ANYBODY AUTHORISES MORE.
//
// PURE. No database. ./support.ts stores grants and does the reads; this decides the SHAPE of what
// comes back, so "can support see the subject line?" is answered by a test and not by reading four
// query call sites and hoping they agree.
//
// THE PROBLEM THIS SOLVES. Support work is legitimate and specific: "my confirmation never arrived",
// "this campaign bounced for half our list", "why did that webhook fail". Every one of those is
// answerable from METADATA — status, timestamps, SMTP response, attempt count, the recipient domain.
// None of them requires reading what the message said. But the easiest thing to build is a screen
// that shows the row, and the row has body_html in it.
//
// So there are two tiers, and the difference between them is a decision somebody made and signed:
//
//   TIER 1, METADATA — the default, no approval, audited as an ordinary read. The local part of the
//   recipient address is masked, the subject is withheld, the body is not fetched. Enough to answer
//   every question above.
//
//   TIER 2, CONTENT — requires an approved grant, from a different person (support.content.approve is
//   not a capability support holds), scoped to ONE subject, time-limited, use-limited, and audited on
//   every single read with the grant id attached. It is not a mode the console can be left in.
//
// MASKING IS NOT SECURITY AND IS NOT SOLD AS ANY. A support engineer who was given the address by the
// customer already knows it; masking stops the console being a place to BROWSE addresses, and stops a
// screenshot in a ticket carrying somebody's mail address into a system with different access rules.
// The real control is the grant, the audit, and the fact that bodies are never selected without one.

export const SUPPORT_SUBJECT_TYPES = ['message', 'mailbox', 'organization'] as const;
export type SupportSubjectType = (typeof SUPPORT_SUBJECT_TYPES)[number];

export type GrantStatus = 'requested' | 'approved' | 'denied' | 'expired' | 'revoked' | 'exhausted';

export interface ContentGrant {
  id: string;
  orgId: string;
  subjectType: SupportSubjectType;
  subjectId: string;
  requestedBy: string;
  reason: string;
  /** The numbered matter this sits under, when there is one. Free text: an incident or ticket id. */
  matterRef: string | null;
  status: GrantStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  uses: number;
  maxUses: number;
  createdAt: string;
}

/** Default life of an approved grant. Short: a support conversation is minutes, not days. */
export const GRANT_HOURS = 4;
export const GRANT_MAX_USES = 25;

export interface GrantValidation { ok: boolean; error?: string }

/**
 * Is this a request worth approving? Checked at REQUEST time so the approver is reading something
 * substantive rather than being asked to rubber-stamp "investigating".
 *
 * The 30-character floor is the same idea as the one in src/lib/legal-hold.ts, and for the same
 * reason: the answer to "why did you read that person's mail" has to exist in writing, and it has to
 * have been written before the reading rather than reconstructed afterwards.
 */
export function validateGrantRequest(input: {
  subjectType: string;
  subjectId: string;
  reason: string;
  matterRef?: string | null;
}): GrantValidation {
  if (!(SUPPORT_SUBJECT_TYPES as readonly string[]).includes(String(input.subjectType))) {
    return { ok: false, error: 'Subject must be a message, a mailbox or an organization.' };
  }
  if (!String(input.subjectId || '').trim()) {
    return { ok: false, error: 'Name the exact record. A grant is never for "everything in this organization".' };
  }
  const reason = String(input.reason || '').trim();
  if (reason.length < 30) {
    return {
      ok: false,
      error: 'Give a specific reason of at least 30 characters: what was reported, by whom, and what reading the content will establish. This is the record of why the access was justified.',
    };
  }
  return { ok: true };
}

export interface GrantUsability {
  usable: boolean;
  code: 'ok' | 'not-approved' | 'expired' | 'exhausted' | 'revoked' | 'wrong-subject';
  reason: string;
}

/**
 * May this grant be used, right now, for THIS record?
 *
 * Every clause is checked at USE time rather than at approval time — an approved grant is a key, and
 * a key that is not re-examined at the door is a key that works forever. `now` is a parameter for the
 * same reason it is everywhere else in this module: an expiry nobody can fix in a test is an expiry
 * nobody has tested.
 */
export function grantUsable(
  grant: ContentGrant | null,
  want: { orgId: string; subjectType: SupportSubjectType; subjectId: string },
  now: Date,
): GrantUsability {
  if (!grant) return { usable: false, code: 'not-approved', reason: 'No approved authorisation covers this record.' };
  if (grant.status === 'revoked') return { usable: false, code: 'revoked', reason: 'That authorisation was revoked.' };
  if (grant.status !== 'approved') {
    return { usable: false, code: 'not-approved', reason: 'That authorisation is ' + grant.status + ', not approved.' };
  }
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return { usable: false, code: 'expired', reason: 'That authorisation expired at ' + grant.expiresAt + '.' };
  }
  if (grant.uses >= grant.maxUses) {
    return { usable: false, code: 'exhausted', reason: 'That authorisation has been used its full ' + grant.maxUses + ' times.' };
  }
  if (grant.orgId !== want.orgId || grant.subjectType !== want.subjectType || grant.subjectId !== want.subjectId) {
    return { usable: false, code: 'wrong-subject', reason: 'That authorisation covers a different record.' };
  }
  return { usable: true, code: 'ok', reason: 'Authorised.' };
}

/**
 * Mask the local part, keep the domain.
 *
 *   siddharth@edurankai.in -> s*******@edurankai.in
 *   a@b.com               -> *@b.com
 *
 * The domain stays because it is what support actually reasons about — which provider is bouncing,
 * whether the whole customer domain is affected — and because it is the part that is not personal.
 */
export function maskEmail(email: string | null | undefined): string {
  const raw = String(email || '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return raw ? '***' : '';
  const local = raw.slice(0, at);
  const domain = raw.slice(at);
  if (local.length <= 1) return '*' + domain;
  return local[0] + '*'.repeat(Math.max(1, Math.min(8, local.length - 1))) + domain;
}

export function maskEmailList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => maskEmail(typeof x === 'string' ? x : (x as any)?.email));
}

/** The metadata view. Every field here is safe to put in a ticket. */
export interface MessageMetadataView {
  id: string;
  orgId: string;
  environment: string;
  status: string;
  from: string;
  to: string[];
  recipientDomains: string[];
  subjectWithheld: true;
  templateKey: string | null;
  attempts: number;
  lastError: string | null;
  rfcMessageId: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  createdAt: string | null;
  /** True when an approved grant would reveal a subject and body. Shown so support can ask for one. */
  contentAvailable: boolean;
}

/**
 * Project a raw message row down to the metadata view.
 *
 * Takes `any` and returns a NAMED shape, deliberately: the row comes from a driver, and a function
 * that spreads `...row` and deletes two keys is one schema change away from leaking the third.
 * Building the result field by field means a new column is invisible here until somebody adds it.
 */
export function toMetadataView(row: any): MessageMetadataView {
  const to = Array.isArray(row?.to_emails) ? row.to_emails : [];
  const domains = Array.from(new Set(to.map((x: any) => {
    const s = String(typeof x === 'string' ? x : x?.email || '');
    const at = s.lastIndexOf('@');
    return at === -1 ? '' : s.slice(at + 1).toLowerCase();
  }).filter(Boolean))) as string[];

  return {
    id: String(row?.id || ''),
    orgId: String(row?.org_id || ''),
    environment: String(row?.environment || ''),
    status: String(row?.status || 'unknown'),
    from: maskEmail(row?.from_email),
    to: maskEmailList(to),
    recipientDomains: domains,
    subjectWithheld: true,
    templateKey: row?.template_key ?? null,
    attempts: Number(row?.attempts) || 0,
    lastError: row?.last_error ?? null,
    rfcMessageId: row?.rfc_message_id ?? null,
    queuedAt: row?.queued_at ? String(row.queued_at) : null,
    sentAt: row?.sent_at ? String(row.sent_at) : null,
    deliveredAt: row?.delivered_at ? String(row.delivered_at) : null,
    failedAt: row?.failed_at ? String(row.failed_at) : null,
    createdAt: row?.created_at ? String(row.created_at) : null,
    // The metadata query never selects a body; it selects a BOOLEAN, `has_content`, computed in SQL.
    // That is the difference between "we know there is a body" and "we fetched the body and chose not
    // to show it" — only the first is safe to compute on a screen support can open unaided.
    contentAvailable: row?.has_content === true,
  };
}

export interface MessageContentView extends Omit<MessageMetadataView, 'subjectWithheld'> {
  subjectWithheld: false;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  /** The authorisation this view was produced under. Rendered on screen, not just logged. */
  grantId: string;
  approvedBy: string | null;
}

/**
 * The content view, which may ONLY be produced with a usable grant.
 *
 * The grant is a required parameter rather than a flag: there is no way to call this function and get
 * content without holding one, and no default that quietly means "yes". Addresses are unmasked here —
 * whoever authorised reading the message authorised reading who it was to.
 */
export function toContentView(row: any, grant: ContentGrant): MessageContentView {
  const meta = toMetadataView(row);
  const to = Array.isArray(row?.to_emails) ? row.to_emails : [];
  return {
    ...meta,
    subjectWithheld: false,
    from: String(row?.from_email || ''),
    to: to.map((x: any) => String(typeof x === 'string' ? x : x?.email || '')),
    subject: String(row?.subject || ''),
    bodyText: row?.body_text ?? null,
    bodyHtml: row?.body_html ?? null,
    grantId: grant.id,
    approvedBy: grant.approvedBy,
  };
}

/**
 * Which messages may support retry?
 *
 * Retry re-sends a message the platform already accepted and failed to deliver. It reveals nothing,
 * but it does put mail in somebody's inbox, so: only a message that actually failed, only while it
 * has attempts left, and never a message that was suppressed — a suppressed message was refused on
 * purpose and retrying it would mail an address that asked not to be mailed.
 */
export function retryEligible(row: any): { ok: boolean; reason: string } {
  const status = String(row?.status || '');
  if (status === 'suppressed') {
    return { ok: false, reason: 'This message was suppressed. Retrying it would mail an address that is on the suppression list.' };
  }
  if (status === 'delivered' || status === 'sent') {
    return { ok: false, reason: 'This message was already delivered. Resending it would deliver a duplicate.' };
  }
  if (status !== 'failed' && status !== 'deferred' && status !== 'queued') {
    return { ok: false, reason: 'Only failed, deferred or queued messages can be retried. This one is ' + (status || 'in an unknown state') + '.' };
  }
  const attempts = Number(row?.attempts) || 0;
  const max = Number(row?.max_attempts) || 5;
  if (attempts >= max) {
    return { ok: false, reason: 'This message has used all ' + max + ' delivery attempts. Retrying needs the send to be re-created, not retried.' };
  }
  return { ok: true, reason: 'Eligible: ' + attempts + ' of ' + max + ' attempts used.' };
}

/** When an approved grant runs out. */
export function grantExpiry(approvedAt: Date, hours = GRANT_HOURS): string {
  return new Date(approvedAt.getTime() + hours * 3600 * 1000).toISOString();
}

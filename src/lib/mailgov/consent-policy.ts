// src/lib/mailgov/consent-policy.ts — MAY THIS ADDRESS BE SENT THIS KIND OF MESSAGE?
//
// PURE. No database. ./consent.ts stores the records; this decides what they mean, so the decision
// can be tested against every combination rather than observed in production one send at a time.
//
// THE RULE THE BRIEF SINGLES OUT, AND WHY IT IS THE IMPORTANT ONE: A TRANSACTIONAL MESSAGE DOES NOT
// INHERIT MARKETING CONSENT RULES. Two failures follow from getting this wrong, and they are
// opposite:
//
//   Someone unsubscribes from a newsletter and then stops receiving their password reset, their
//   receipt, their interview confirmation. The system looks broken and the person is genuinely
//   harmed — this is the more common failure and the more damaging one.
//
//   Someone accepts a service email and is thereby treated as having opted in to marketing. That is
//   the failure regulators are actually looking for, and it is the one every "we'll just use one
//   consent flag" design produces.
//
// So consent is stored PER CATEGORY, decided per category, and there is no path in this file where a
// record in one category changes the answer in another. maySend() takes the whole per-category state
// and reads exactly one entry of it.
//
// SUPPRESSION IS NOT CONSENT AND IS TRACKED SEPARATELY. Consent is what the person chose;
// suppression is what the mail system learned (the address bounced, someone reported spam, an
// operator said stop). Both can refuse a send and they refuse for different reasons, which is why
// the refusal carries a code rather than a boolean.

/**
 * The five categories the brief names.
 *
 * `system` is separated from `transactional` deliberately. A receipt is transactional and belongs to
 * a transaction the person initiated; a security alert or a forced password reset is neither
 * optional nor initiated by them, and telling someone they can unsubscribe from a breach
 * notification would be a lie. Keeping them apart is what makes UNSUBSCRIBABLE below honest.
 */
export const CONSENT_CATEGORIES = ['transactional', 'marketing', 'product', 'recruitment', 'system'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export interface CategorySpec {
  key: ConsentCategory;
  label: string;
  /** Shown to the recipient on the preference screen. Written for them, not for us. */
  describes: string;
  /**
   * True when the platform requires a recorded opt-in BEFORE the first send. False does not mean
   * "send whatever you like" — it means the lawful basis is the transaction or the account itself,
   * and the other controls (suppression, unsubscribe, purpose) still apply.
   */
  requiresOptIn: boolean;
  /** True when a recipient may switch it off. See the note about `system` above. */
  unsubscribable: boolean;
  /** Whether a List-Unsubscribe header belongs on a send in this category. */
  listUnsubscribeHeader: boolean;
}

export const CATEGORY_SPECS: Record<ConsentCategory, CategorySpec> = {
  transactional: {
    key: 'transactional', label: 'Transactional',
    describes: 'Messages about something you did: a receipt, a confirmation, a password reset, the result of a request you made.',
    requiresOptIn: false, unsubscribable: false, listUnsubscribeHeader: false,
  },
  marketing: {
    key: 'marketing', label: 'Marketing',
    describes: 'Promotional messages about programmes, offers and events.',
    requiresOptIn: true, unsubscribable: true, listUnsubscribeHeader: true,
  },
  product: {
    key: 'product', label: 'Product updates',
    describes: 'News about features and changes to services you use.',
    requiresOptIn: true, unsubscribable: true, listUnsubscribeHeader: true,
  },
  recruitment: {
    key: 'recruitment', label: 'Recruitment',
    describes: 'Roles, openings and hiring updates.',
    requiresOptIn: true, unsubscribable: true, listUnsubscribeHeader: true,
  },
  system: {
    key: 'system', label: 'Security and account',
    describes: 'Security alerts, account notices, and legally required notifications. These cannot be switched off while the account exists.',
    requiresOptIn: false, unsubscribable: false, listUnsubscribeHeader: false,
  },
};

export const CONSENT_STATUSES = ['subscribed', 'unsubscribed', 'pending', 'never'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export interface ConsentRecord {
  orgId: string;
  environment: string;
  email: string;
  category: ConsentCategory;
  status: ConsentStatus;
  /** When they said yes. Null unless status has been 'subscribed' at some point. */
  consentAt: string | null;
  /** Where it came from: a form id, an import file, an API call, a paper form reference. */
  source: string | null;
  /** What they were told it was for. Free text, and it belongs in the record rather than in a policy PDF. */
  purpose: string | null;
  unsubscribedAt: string | null;
  unsubscribeSource: string | null;
  ip: string | null;
  /** Anything that would be produced if the consent were ever questioned. */
  evidence: Record<string, unknown>;
  updatedAt: string | null;
}

/**
 * The reasons a suppression entry blocks a send, and WHICH categories each one blocks.
 *
 * This table is the considered part of the file. A blanket "suppressed means never send anything"
 * is wrong in one direction and "suppression only affects marketing" is wrong in the other:
 *
 *   hard_bounce / invalid_address  the mailbox does not exist. Nothing can be delivered to it, so
 *                                  every category is blocked. Continuing to send damages the sending
 *                                  domain's reputation for every other tenant on it.
 *   complaint                      they marked us as spam. Marketing, product and recruitment stop
 *                                  immediately. Their receipts and security alerts do NOT — cutting
 *                                  those off punishes the person for objecting to something else.
 *   unsubscribe                    the same shape as a complaint, without the reputational damage.
 *   manual                         an operator said stop, for a reason the platform cannot see.
 *                                  Blocks everything, because the operator may know something the
 *                                  system does not.
 */
export const SUPPRESSION_BLOCKS: Record<string, ConsentCategory[]> = {
  hard_bounce: [...CONSENT_CATEGORIES],
  invalid_address: [...CONSENT_CATEGORIES],
  repeated_soft_bounce: [...CONSENT_CATEGORIES],
  complaint: ['marketing', 'product', 'recruitment'],
  unsubscribe: ['marketing', 'product', 'recruitment'],
  manual: [...CONSENT_CATEGORIES],
};

export interface SuppressionState {
  reason: string;
  createdAt?: string | null;
  detail?: string | null;
}

export type SendRefusalCode =
  | 'ok'
  | 'no-consent-recorded'
  | 'unsubscribed'
  | 'consent-pending'
  | 'suppressed'
  | 'unknown-category';

export interface SendDecision {
  allowed: boolean;
  code: SendRefusalCode;
  /** A sentence for the operator looking at why a campaign skipped 4,000 people. */
  reason: string;
  /** True when the refusal came from suppression rather than from the person's own choice. */
  fromSuppression: boolean;
}

const yes = (): SendDecision => ({ allowed: true, code: 'ok', reason: 'Permitted.', fromSuppression: false });
const no = (code: SendRefusalCode, reason: string, fromSuppression = false): SendDecision =>
  ({ allowed: false, code, reason, fromSuppression });

/**
 * THE DECISION.
 *
 * `consent` is the record FOR THIS CATEGORY ONLY. The caller looks it up by category; there is
 * deliberately no signature here that takes a bag of every category's records, because that is the
 * shape in which one category's answer leaks into another's.
 */
export function maySend(input: {
  category: string;
  consent: ConsentRecord | null;
  suppression?: SuppressionState | null;
}): SendDecision {
  const spec = CATEGORY_SPECS[input.category as ConsentCategory];
  if (!spec) return no('unknown-category', 'Unknown message category: ' + String(input.category) + '.');

  // Suppression first: it is a fact about the address, and it outranks anything the person chose.
  const supp = input.suppression;
  if (supp && supp.reason) {
    const blocked = SUPPRESSION_BLOCKS[supp.reason] || [...CONSENT_CATEGORIES];
    if (blocked.includes(spec.key)) {
      return no('suppressed', 'The address is suppressed (' + supp.reason + '), which blocks ' + spec.label.toLowerCase() + ' mail.', true);
    }
  }

  // An explicit unsubscribe in THIS category always wins, even where opt-in was not required.
  // Someone who asks to stop receiving product updates has asked, and "you never had to opt in" is
  // not an answer to that.
  if (input.consent && input.consent.status === 'unsubscribed') {
    if (!spec.unsubscribable) {
      // The record exists but the category cannot be switched off. Sending is still permitted, and
      // the honest thing is to say so out loud rather than pretend the record was not there.
      return { allowed: true, code: 'ok', reason: spec.label + ' cannot be unsubscribed from while the account exists.', fromSuppression: false };
    }
    return no('unsubscribed', 'They unsubscribed from ' + spec.label.toLowerCase() + ' on ' + (input.consent.unsubscribedAt || 'an unrecorded date') + '.');
  }

  if (!spec.requiresOptIn) return yes();

  if (!input.consent || input.consent.status === 'never') {
    return no('no-consent-recorded', 'No ' + spec.label.toLowerCase() + ' consent is recorded for this address.');
  }
  if (input.consent.status === 'pending') {
    return no('consent-pending', 'Consent is pending confirmation and has not been completed.');
  }
  return yes();
}

/**
 * Applying an unsubscribe.
 *
 * PURE, and it returns the WHOLE next record rather than mutating — so the caller writes one row and
 * the test asserts one value. Unsubscribing from a category that cannot be unsubscribed from is
 * refused rather than silently accepted, because a preference screen that accepts a choice it will
 * not honour is worse than one that explains why.
 */
export function applyUnsubscribe(
  current: ConsentRecord,
  at: string,
  source: string,
): { ok: boolean; record?: ConsentRecord; error?: string } {
  const spec = CATEGORY_SPECS[current.category];
  if (!spec) return { ok: false, error: 'Unknown category.' };
  if (!spec.unsubscribable) {
    return { ok: false, error: spec.label + ' cannot be switched off while the account exists. ' + spec.describes };
  }
  return {
    ok: true,
    record: { ...current, status: 'unsubscribed', unsubscribedAt: at, unsubscribeSource: source, updatedAt: at },
  };
}

/** Applying a consent. Symmetrical with applyUnsubscribe, and it never clears the unsubscribe history. */
export function applyConsent(
  current: ConsentRecord,
  at: string,
  input: { source: string; purpose?: string | null; ip?: string | null; evidence?: Record<string, unknown> },
): ConsentRecord {
  return {
    ...current,
    status: 'subscribed',
    consentAt: at,
    source: input.source,
    purpose: input.purpose ?? current.purpose,
    ip: input.ip ?? current.ip,
    // The previous unsubscribedAt is KEPT. "Subscribed, previously unsubscribed on the 3rd" is a
    // materially different record from "subscribed, never unsubscribed", and clearing it would erase
    // the more interesting of the two facts.
    evidence: { ...(current.evidence || {}), ...(input.evidence || {}) },
    updatedAt: at,
  };
}

/** A blank record, so a lookup miss and a stored row have the same shape at every call site. */
export function emptyConsent(orgId: string, environment: string, email: string, category: ConsentCategory): ConsentRecord {
  return {
    orgId, environment, email: normalizeEmail(email), category,
    status: 'never', consentAt: null, source: null, purpose: null,
    unsubscribedAt: null, unsubscribeSource: null, ip: null, evidence: {}, updatedAt: null,
  };
}

/**
 * Addresses are compared lowercased and trimmed, and that is the ONLY normalisation applied.
 *
 * Deliberately no dot-stripping or plus-tag removal. Those are one particular mail provider's local
 * rules, they are not true of addresses generally, and a consent system that decides
 * `a.b@example.com` and `ab@example.com` are the same person will eventually decide two different
 * people are one — in the direction of sending mail to somebody who never agreed to it.
 */
export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

/** Just the domain, for the aggregate views. Empty string when the address is malformed. */
export function emailDomain(email: string): string {
  const at = normalizeEmail(email).lastIndexOf('@');
  return at === -1 ? '' : normalizeEmail(email).slice(at + 1);
}

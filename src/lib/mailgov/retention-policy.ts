// src/lib/mailgov/retention-policy.ts — HOW LONG THINGS ARE KEPT, AND WHAT MAY NOT BE SHORTENED.
//
// PURE. No database. The sweep that actually deletes rows is ./retention.ts; everything it decides
// is decided here, so "would this policy delete last week's audit trail?" is answerable in a test
// rather than by watching production.
//
// RETENTION IS A TECHNICAL CONTROL, NOT A LEGAL OPINION. This file does not know what any statute
// requires of any organization. It gives an operator a dial per data class per tenant, refuses the
// settings that would break the platform's own guarantees, and records who moved it. Which number is
// correct for a given customer is a decision their counsel makes and their administrator enters —
// see docs/mail-governance.md, which says so in the same words to the customer.
//
// THE FLOORS ARE THE OPINIONATED PART, and they are opinions about THIS SYSTEM rather than about the
// law:
//
//   - An audit log a tenant can set to seven days is not an audit log. If somebody can shorten the
//     record of what they did to less than the time it takes anyone to ask, the record is decoration.
//     Floor: one year, and only a platform role may set a tenant below the platform default.
//   - Consent records outlive the messages they authorise, always. "Prove they agreed" is asked
//     after the campaign is long deleted, and a consent record that expired first cannot answer it.
//   - Security events keep three months minimum because that is shorter than most intrusions take to
//     be noticed, and anything less makes the security screen an ornament.
//
// Everything else genuinely is the tenant's call, and the defaults are deliberately unremarkable.

/**
 * The data classes a policy can be written for.
 *
 * These are exactly the six the brief names, plus `security_events` — which is retained data by
 * every definition the other six use, and leaving it un-policied would have meant one table quietly
 * growing forever while the screen claimed to govern retention. It is called out in the docs as an
 * addition rather than smuggled in.
 */
export const RETENTION_CLASSES = [
  'messages',
  'attachments',
  'delivery_events',
  'campaign_events',
  'audit_logs',
  'ai_records',
  'security_events',
  'consent_records',
] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export interface RetentionClassSpec {
  key: RetentionClass;
  label: string;
  /** What is actually deleted when this class is swept, in a sentence an operator can act on. */
  describes: string;
  /** Days kept when a tenant has never set a policy. */
  defaultDays: number;
  /** Shortest a tenant may set. Below this the platform refuses — see the note at the top. */
  floorDays: number;
  /** Longest anyone may set. A "keep forever" dial is how a data-minimisation promise dies. */
  ceilingDays: number;
  /** True when a legal hold can pin individual rows of this class out of the sweep. */
  holdable: boolean;
}

export const RETENTION_SPECS: Record<RetentionClass, RetentionClassSpec> = {
  messages: {
    key: 'messages', label: 'Messages',
    describes: 'Message rows and their bodies, including anything the platform stored to render them.',
    defaultDays: 365, floorDays: 7, ceilingDays: 3650, holdable: true,
  },
  attachments: {
    key: 'attachments', label: 'Attachments',
    describes: 'Stored attachment objects and the rows pointing at them. Links a sender pasted are not stored and are not deleted by this.',
    defaultDays: 365, floorDays: 7, ceilingDays: 3650, holdable: true,
  },
  delivery_events: {
    key: 'delivery_events', label: 'Delivery events',
    describes: 'Per-recipient delivery, bounce, open and click events. Deleting these deletes the evidence behind deliverability reporting.',
    defaultDays: 180, floorDays: 7, ceilingDays: 1825, holdable: true,
  },
  campaign_events: {
    key: 'campaign_events', label: 'Campaign events',
    describes: 'Campaign-level send and engagement records.',
    defaultDays: 365, floorDays: 7, ceilingDays: 1825, holdable: true,
  },
  audit_logs: {
    key: 'audit_logs', label: 'Audit log',
    describes: 'Administrative and governance actions. Pruning writes a checkpoint so the hash chain stays verifiable across the gap.',
    defaultDays: 2555, floorDays: 365, ceilingDays: 3650, holdable: false,
  },
  ai_records: {
    key: 'ai_records', label: 'AI processing records',
    describes: 'Records of AI-assisted processing performed on message content: what was processed, when, by which model, and the result kept.',
    defaultDays: 90, floorDays: 1, ceilingDays: 1825, holdable: true,
  },
  security_events: {
    key: 'security_events', label: 'Security events',
    describes: 'Failed logins, abuse signals, credential anomalies, permission and domain changes.',
    defaultDays: 730, floorDays: 90, ceilingDays: 3650, holdable: false,
  },
  consent_records: {
    key: 'consent_records', label: 'Consent records',
    describes: 'Subscription state, when consent was given, where it came from, and when it was withdrawn.',
    defaultDays: 2555, floorDays: 365, ceilingDays: 3650, holdable: false,
  },
};

/** What a sweep does when a row falls past its cutoff. */
export type RetentionAction = 'delete' | 'redact';

export interface RetentionPolicy {
  orgId: string;
  environment: string;
  dataClass: RetentionClass;
  retainDays: number;
  action: RetentionAction;
  /** False parks the policy without deleting it, so a sweep can be stopped without losing the number. */
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface PolicyValidation {
  ok: boolean;
  error?: string;
  /** The value that would actually be stored. Never silently different from what was asked for. */
  retainDays?: number;
}

/**
 * Is this a policy the platform will accept?
 *
 * REFUSES rather than clamps. A form that asks for 30 days on the audit log and silently stores 365
 * has told the operator something untrue about their own system, and they will find out when they
 * need the log they thought they had deleted — or when they are asked to prove they deleted it.
 */
export function validatePolicy(
  dataClass: string,
  retainDays: unknown,
  action: string = 'delete',
): PolicyValidation {
  const spec = RETENTION_SPECS[dataClass as RetentionClass];
  if (!spec) return { ok: false, error: 'Unknown data class: ' + String(dataClass) + '.' };

  const days = Number(retainDays);
  if (!Number.isFinite(days) || !Number.isInteger(days)) {
    return { ok: false, error: 'Retention must be a whole number of days.' };
  }
  if (days < spec.floorDays) {
    return {
      ok: false,
      error: spec.label + ' cannot be kept for less than ' + spec.floorDays + ' days on this platform. '
        + 'Asked for ' + days + '.',
    };
  }
  if (days > spec.ceilingDays) {
    return {
      ok: false,
      error: spec.label + ' cannot be kept for more than ' + spec.ceilingDays + ' days. Asked for ' + days + '. '
        + 'Keeping personal data indefinitely is a decision this platform does not offer as a checkbox.',
    };
  }
  if (action !== 'delete' && action !== 'redact') {
    return { ok: false, error: 'Retention action must be delete or redact.' };
  }
  // Redaction only means something where there is content to redact. Everywhere else the row IS the
  // record, and "redacting" it would leave a row that says nothing while claiming the data is kept.
  if (action === 'redact' && dataClass !== 'messages' && dataClass !== 'attachments') {
    return { ok: false, error: 'Only messages and attachments can be redacted in place. Everything else is delete or keep.' };
  }
  return { ok: true, retainDays: days };
}

/** The policy in force when a tenant has never written one. Not stored — resolved. */
export function defaultPolicy(orgId: string, environment: string, dataClass: RetentionClass): RetentionPolicy {
  return {
    orgId,
    environment,
    dataClass,
    retainDays: RETENTION_SPECS[dataClass].defaultDays,
    action: 'delete',
    enabled: true,
    updatedBy: null,
    updatedAt: null,
  };
}

/**
 * Fill the gaps: every class always has an answer, and the caller can see which ones are the tenant's
 * choice and which are the platform default (updatedAt === null).
 */
export function resolvePolicies(
  orgId: string,
  environment: string,
  stored: RetentionPolicy[],
): RetentionPolicy[] {
  const byClass = new Map(stored.map((p) => [p.dataClass, p]));
  return RETENTION_CLASSES.map((c) => byClass.get(c) || defaultPolicy(orgId, environment, c));
}

/**
 * The instant before which rows of this class are due for the sweep.
 *
 * `now` is a parameter, never Date.now() read inside — a retention engine whose cutoff cannot be
 * fixed in a test is a retention engine nobody can test.
 */
export function cutoffFor(policy: RetentionPolicy, now: Date): Date {
  return new Date(now.getTime() - policy.retainDays * 24 * 60 * 60 * 1000);
}

export interface SweepTask {
  orgId: string;
  environment: string;
  dataClass: RetentionClass;
  action: RetentionAction;
  cutoff: string;
  /** Rows touched per statement, so one tenant's backlog cannot hold a transaction open for minutes. */
  batchSize: number;
}

/**
 * Turn policies into work.
 *
 * Disabled policies produce no task at all — not a task with a cutoff far in the past, which is the
 * kind of shortcut that deletes a year of somebody's mail the day a default changes.
 */
export function sweepPlan(policies: RetentionPolicy[], now: Date, batchSize = 500): SweepTask[] {
  return policies
    .filter((p) => p.enabled)
    .map((p) => ({
      orgId: p.orgId,
      environment: p.environment,
      dataClass: p.dataClass,
      action: p.action,
      cutoff: cutoffFor(p, now).toISOString(),
      batchSize: Math.max(50, Math.min(5000, batchSize)),
    }));
}

/**
 * Consent must outlive what it authorised.
 *
 * Checked as a CROSS-CLASS rule rather than a floor, because the number that is wrong depends on
 * another number: keeping messages for three years and consent for one leaves two years of sends
 * nobody can justify. The platform refuses the combination and says which pair is the problem.
 */
export function crossClassConflicts(policies: RetentionPolicy[]): string[] {
  const by = new Map(policies.map((p) => [p.dataClass, p]));
  const out: string[] = [];
  const consent = by.get('consent_records');
  const messages = by.get('messages');
  const campaign = by.get('campaign_events');
  if (consent && messages && consent.retainDays < messages.retainDays) {
    out.push(
      'Consent records (' + consent.retainDays + ' days) would be deleted before the messages they authorised ('
      + messages.retainDays + ' days). Keep consent at least as long as messages.',
    );
  }
  if (consent && campaign && consent.retainDays < campaign.retainDays) {
    out.push(
      'Consent records (' + consent.retainDays + ' days) would be deleted before the campaign events they authorised ('
      + campaign.retainDays + ' days).',
    );
  }
  const audit = by.get('audit_logs');
  if (audit && messages && audit.retainDays < messages.retainDays) {
    out.push(
      'The audit log (' + audit.retainDays + ' days) would be shorter than message retention ('
      + messages.retainDays + ' days), so there would be messages nobody can account for.',
    );
  }
  return out;
}

/**
 * A record of what a prune removed, written BEFORE the rows go, so the audit chain can be verified
 * across the gap it is about to create.
 *
 * Pruning the audit log is the one sweep that damages the evidence it is part of. The checkpoint is
 * what keeps that honest: it names the range, the count, and the hash the surviving chain should link
 * back to, and it is itself an audit event — so removing the checkpoint is as detectable as removing
 * anything else.
 */
export interface PruneCheckpoint {
  fromSeq: number;
  toSeq: number;
  removed: number;
  /** The hash of the last row REMOVED. The first surviving row must carry this as its prev_hash. */
  lastRemovedHash: string;
  cutoff: string;
  by: string | null;
}

export function checkpointSummary(c: PruneCheckpoint): string {
  return 'Pruned ' + c.removed + ' audit events (seq ' + c.fromSeq + '-' + c.toSeq + ') older than '
    + c.cutoff + '. Surviving chain links back to ' + c.lastRemovedHash.slice(0, 16) + '.';
}

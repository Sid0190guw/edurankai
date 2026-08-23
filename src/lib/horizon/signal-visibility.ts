// src/lib/horizon/signal-visibility.ts — PATCH 08 · HORIZON Signal Engine · WHO IS TOLD WHAT.
//
// =================================================================================================
// TWO QUESTIONS, KEPT APART
// =================================================================================================
//
//   WHICH SIGNALS may this person see at all?     a capability, resolved per USER from their role
//   WHICH PEOPLE'S signals may they see?          a relationship, resolved per ROW from the org graph
//
// Merging those two is the mistake this codebase has already paid for once: a per-row relationship
// turned into a per-user grant is every manager seeing every person. So a role decides the BAND and
// the DEPTH of what is legible, and src/lib/org-graph.ts decides WHOSE row it is, one row at a time.
// Neither answer is allowed to stand in for the other.
//
// THIS IS NOT THE PROFILE ACCESS MODEL. src/lib/horizon/access.ts owns who may open which SECTION of
// somebody's record, and it is not reimplemented here. This module answers a narrower question the
// signal engine has to answer for itself: who is TOLD when something is raised, and how much of the
// engine's own working travels with it.
//
// =================================================================================================
// WHY A WATCH DOES NOT GO TO EVERYBODY WHO CAN SEE AN OPPORTUNITY
// =================================================================================================
//
// The four bands are not four shades of the same thing. An Opportunity is a good thing being noticed
// and it can be said out loud. An Attention is a machine asking a human to look at something BEFORE
// any human has looked — and a machine's request routed to six inboxes is, in practice, a finding
// about a person circulated on nobody's authority.
//
// So Attention goes to HR first, because HR is the reviewer admit() assigns to every Attention
// signal. A line manager is not cut out: HR routes it to them the moment they have looked, which is
// one screen and puts a person's name against the routing. That ordering is the whole control, and
// it costs a few hours on a signal that is by construction never an emergency — nothing here is a
// safety channel, and incidents have their own.
//
// =================================================================================================
// AND WHY THE PERSON THEMSELVES SEES TWO OF THE FOUR
// =================================================================================================
//
// Somebody should be able to see the good things this system noticed about their work — that is what
// makes it a record rather than a file kept on them. What they must not receive is an automated
// Watch or Attention that no human has read yet. An observation delivered to its subject before a
// person has looked at it is an accusation with nobody's name on it, and this system will not send
// one. After a human has reviewed it, telling them is a conversation — which is what the recommended
// action asks for anyway.
import { BAND_LABELS, type AttentionBand } from '@/lib/horizon/signal-contract';

// =================================================================================================
// SCOPE
// =================================================================================================

export type SignalScope = 'all' | 'department' | 'reports' | 'self' | 'none';

export const SCOPE_LABELS: Record<SignalScope, string> = {
  all: 'Everybody',
  department: 'Their department',
  reports: 'Their direct reports',
  self: 'Themselves only',
  none: 'Nothing',
};

export interface SignalPolicy {
  scope: SignalScope;
  bands: readonly AttentionBand[];
  /** May they acknowledge, review and resolve a signal? */
  mayResolve: boolean;
  /**
   * May they see HOW the signal was computed — the inputs, the processing rule, the arithmetic
   * behind the confidence figure and any downgrade? Internal computation is not exposed to a role
   * with no explicit permission for it.
   */
  maySeeComputation: boolean;
  /** May they see the evidence rows themselves, or only that evidence exists? */
  maySeeEvidence: boolean;
  note: string;
}

const NOTHING: SignalPolicy = {
  scope: 'none',
  bands: [],
  mayResolve: false,
  maySeeComputation: false,
  maySeeEvidence: false,
  note: 'This role has no business with employee signals and is shown none.',
};

/**
 * WHAT EACH ROLE MAY SEE. Anything not listed gets NOTHING — the default fails closed, the same
 * direction src/lib/notify-audience.ts settled on after an audit found eleven live notification
 * types quietly broadcasting to marketing and partners.
 *
 * `recruiter` and `reviewer` are absent deliberately. Both hold HR-adjacent permissions for the
 * hiring funnel; neither has a reason to read a continuing employee's signals, and giving them the
 * queue "because they are nearly HR" is how a queue becomes a file on people.
 */
export const ROLE_SIGNAL_POLICY: Record<string, SignalPolicy> = {
  super_admin: {
    scope: 'all',
    bands: ['green', 'blue', 'yellow', 'red'],
    mayResolve: true,
    maySeeComputation: true,
    maySeeEvidence: true,
    note: 'The owner sees everything, including how each signal was computed.',
  },
  hr: {
    scope: 'all',
    bands: ['green', 'blue', 'yellow', 'red'],
    mayResolve: true,
    maySeeComputation: true,
    maySeeEvidence: true,
    note: 'HR is the assigned reviewer for every Attention signal and sees the full working.',
  },
  department_head: {
    scope: 'department',
    bands: ['green', 'blue', 'yellow'],
    mayResolve: true,
    maySeeComputation: true,
    maySeeEvidence: true,
    note: 'A department head sees their own people, and sees Attention signals once HR has reviewed and routed them.',
  },
};

export function policyForRole(role: string | null | undefined): SignalPolicy {
  const key = String(role || '').trim();
  return Object.prototype.hasOwnProperty.call(ROLE_SIGNAL_POLICY, key) ? ROLE_SIGNAL_POLICY[key] : NOTHING;
}

/**
 * WHAT A RELATIONSHIP GRANTS, which is separate from what a role grants and is resolved per row.
 *
 * A reporting manager may hold no admin role at all — "manager" is not a value of users.role in this
 * system and must never become one. These are reached by asking the organisation graph about THIS
 * person and THIS subject.
 */
export const RELATIONSHIP_SIGNAL_POLICY: Record<'reporting_manager' | 'self', SignalPolicy> = {
  reporting_manager: {
    scope: 'reports',
    bands: ['green', 'blue', 'yellow'],
    mayResolve: true,
    maySeeComputation: true,
    maySeeEvidence: true,
    note: 'A reporting manager sees their own reports. Attention signals reach them through HR, the assigned reviewer.',
  },
  self: {
    scope: 'self',
    bands: ['green', 'blue'],
    mayResolve: false,
    maySeeComputation: false,
    maySeeEvidence: false,
    note: 'A person sees the opportunities and growth this system recorded about their own work. A Watch or an Attention reaches them through a conversation with a human, never as an automated message.',
  },
};

/** The strongest of several policies, used when somebody is both HR and somebody's manager. */
export function mergePolicies(policies: readonly SignalPolicy[]): SignalPolicy {
  const live = policies.filter(Boolean);
  if (!live.length) return NOTHING;
  const rank: Record<SignalScope, number> = { none: 0, self: 1, reports: 2, department: 3, all: 4 };
  let best = live[0];
  for (const p of live) if (rank[p.scope] > rank[best.scope]) best = p;
  const bands: AttentionBand[] = [];
  for (const p of live) for (const b of p.bands) if (bands.indexOf(b) < 0) bands.push(b);
  return {
    scope: best.scope,
    bands,
    mayResolve: live.some((p) => p.mayResolve),
    maySeeComputation: live.some((p) => p.maySeeComputation),
    maySeeEvidence: live.some((p) => p.maySeeEvidence),
    note: best.note,
  };
}

export function seesBand(policy: SignalPolicy, band: AttentionBand): boolean {
  return policy.bands.indexOf(band) >= 0;
}

/** A one-line description of what somebody is looking at, for the top of a screen. */
export function scopeSentence(policy: SignalPolicy): string {
  if (policy.scope === 'none') return 'You do not have access to employee signals.';
  const names = policy.bands.map((b) => BAND_LABELS[b]).join(', ');
  return 'Showing ' + names + ' signals for: ' + SCOPE_LABELS[policy.scope].toLowerCase() + '.';
}

// =================================================================================================
// REDACTION
// =================================================================================================

/**
 * The shape redaction operates on. Declared structurally rather than imported from the engine, so
 * this module has no dependency on storage at all — a stored row satisfies it, and so does a
 * candidate that has never been written.
 */
export interface VisibleSignal {
  band: AttentionBand;
  title: string;
  [k: string]: unknown;
}

/**
 * Strip what a viewer has no permission to see, and SAY that something was stripped.
 *
 * A redaction that leaves no trace is indistinguishable from a system that had nothing to show, and
 * the difference matters to somebody trying to work out whether they are seeing everything. So the
 * fields go and `redacted` lists what went.
 *
 * THE CONFIDENCE VALUE GOES WITH THE WORKING. A number without its basis is the most persuasive and
 * least answerable thing that can be put in front of somebody; this system does not show one.
 */
export function redactForPolicy<T extends VisibleSignal>(signal: T, policy: SignalPolicy): T & { redacted: string[] } {
  const out: any = { ...signal };
  const redacted: string[] = [];
  const drop = (field: string) => {
    if (out[field] !== undefined) {
      delete out[field];
      redacted.push(field);
    }
  };

  if (!policy.maySeeComputation) {
    for (const f of ['inputs', 'processing', 'confidence', 'downgradeReason', 'downgradedFrom', 'detectorKey', 'detectorVersion', 'dedupeKey']) {
      drop(f);
    }
  }

  if (!policy.maySeeEvidence) {
    if (Array.isArray(out.evidenceRefs)) {
      out.evidenceCount = out.evidenceRefs.length;
      drop('evidenceRefs');
    }
    drop('sourceTypes');
  }

  out.redacted = redacted;
  return out as T & { redacted: string[] };
}

// =================================================================================================
// NOTIFICATION AUDIENCE
// =================================================================================================
//
// The keys below are registered in src/lib/notify-audience.ts, which is the single source of truth
// for who receives what across the whole platform. They are NOT redefined here — this module names
// them, that module routes them, and notify-audience.test.ts fails the build if a key is broadcast
// without an entry there.

export const SIGNAL_AUDIENCE_KEYS: Record<AttentionBand, string> = {
  green: 'horizon_signal_opportunity',
  blue: 'horizon_signal_growth',
  yellow: 'horizon_signal_watch',
  red: 'horizon_signal_attention',
};

export function audienceKeyFor(band: AttentionBand): string {
  return SIGNAL_AUDIENCE_KEYS[band] || SIGNAL_AUDIENCE_KEYS.yellow;
}

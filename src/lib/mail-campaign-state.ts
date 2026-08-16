// src/lib/mail-campaign-state.ts — THE CAMPAIGN STATE MACHINE, THE SAFETY GATE, AND THE A/B SPLIT.
//
// Pure. No database. These are the three places a campaign system does irreversible damage, so all
// three are decided by functions that can be exercised without a connection and without sending
// anything:
//
//   1. WHICH TRANSITIONS EXIST. A campaign that can go from `completed` back to `sending` will one
//      day send twice. The table below is the whole answer, and the DB layer never writes a status
//      it did not get from campaignTransition().
//   2. WHAT BLOCKS A SEND. preflight() returns BLOCKERS (which refuse) and WARNINGS (which do not).
//      An empty audience, a segment that matches everyone, copy with unresolved variables, no
//      unsubscribe link, no transport — each is a specific sentence, never a generic "cannot send".
//   3. HOW THE A/B SPLIT IS DRAWN. Deterministically from the address, so re-resolving an audience
//      cannot move somebody from variant A to variant B and mail them twice.

// ── states and transitions ─────────────────────────────────────────────────────────────────────

export const CAMPAIGN_STATES = [
  'draft', 'scheduled', 'queued', 'sending', 'paused', 'completed', 'cancelled', 'failed',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export type CampaignAction =
  | 'schedule'    // draft -> scheduled (an instant is set)
  | 'unschedule'  // scheduled -> draft
  | 'queue'       // draft/scheduled -> queued (recipients materialised, confirmed if large)
  | 'start'       // queued -> sending (a worker took it)
  | 'pause'       // queued/sending -> paused
  | 'resume'      // paused -> sending
  | 'complete'    // sending -> completed
  | 'fail'        // queued/sending -> failed
  | 'cancel'      // anything not terminal -> cancelled
  | 'reopen';     // failed/cancelled -> draft (edit and try again)

interface Transition { from: CampaignState; action: CampaignAction; to: CampaignState }

const TRANSITIONS: ReadonlyArray<Transition> = [
  { from: 'draft', action: 'schedule', to: 'scheduled' },
  { from: 'draft', action: 'queue', to: 'queued' },
  { from: 'draft', action: 'cancel', to: 'cancelled' },

  { from: 'scheduled', action: 'unschedule', to: 'draft' },
  { from: 'scheduled', action: 'schedule', to: 'scheduled' },   // move the time
  { from: 'scheduled', action: 'queue', to: 'queued' },
  { from: 'scheduled', action: 'pause', to: 'paused' },
  { from: 'scheduled', action: 'cancel', to: 'cancelled' },

  { from: 'queued', action: 'start', to: 'sending' },
  { from: 'queued', action: 'pause', to: 'paused' },
  { from: 'queued', action: 'cancel', to: 'cancelled' },
  { from: 'queued', action: 'fail', to: 'failed' },

  { from: 'sending', action: 'pause', to: 'paused' },
  { from: 'sending', action: 'complete', to: 'completed' },
  { from: 'sending', action: 'cancel', to: 'cancelled' },
  { from: 'sending', action: 'fail', to: 'failed' },
  // A worker that claims an already-sending campaign is not an error — the previous run died and
  // this one is taking over. It must stay `sending` rather than being refused.
  { from: 'sending', action: 'start', to: 'sending' },

  { from: 'paused', action: 'resume', to: 'sending' },
  { from: 'paused', action: 'cancel', to: 'cancelled' },
  { from: 'paused', action: 'fail', to: 'failed' },

  { from: 'failed', action: 'reopen', to: 'draft' },
  { from: 'cancelled', action: 'reopen', to: 'draft' },
];

export const TERMINAL_STATES: ReadonlySet<CampaignState> = new Set(['completed']);

export interface TransitionResult {
  ok: boolean;
  to?: CampaignState;
  error?: string;
}

/**
 * May this campaign take this action, and what does it become?
 *
 * The refusal sentence names both states, because "invalid transition" on a screen is useless: an
 * operator hitting Pause on a campaign that finished thirty seconds ago needs to be told it
 * finished, not that they did something invalid.
 */
export function campaignTransition(from: string, action: string): TransitionResult {
  const f = String(from || '') as CampaignState;
  const a = String(action || '') as CampaignAction;
  if (!(CAMPAIGN_STATES as readonly string[]).includes(f)) return { ok: false, error: 'Unknown campaign status "' + from + '".' };
  const hit = TRANSITIONS.find((t) => t.from === f && t.action === a);
  if (hit) return { ok: true, to: hit.to };
  if (f === 'completed') return { ok: false, error: 'This campaign has already finished sending, so it cannot be ' + pastTense(a) + '.' };
  if (f === 'cancelled') return { ok: false, error: 'This campaign was cancelled. Reopen it as a draft to work on it again.' };
  return { ok: false, error: 'A ' + f + ' campaign cannot be ' + pastTense(a) + '.' };
}

function pastTense(a: string): string {
  const map: Record<string, string> = {
    schedule: 'scheduled', unschedule: 'unscheduled', queue: 'queued', start: 'started',
    pause: 'paused', resume: 'resumed', complete: 'completed', fail: 'failed',
    cancel: 'cancelled', reopen: 'reopened',
  };
  return map[a] || a + 'd';
}

/** Statuses whose content may still be edited. Everything else is frozen. */
export function canEditContent(state: string): boolean {
  return state === 'draft' || state === 'failed';
}

/** Statuses where recipients have been materialised and must not be regenerated. */
export function recipientsFrozen(state: string): boolean {
  return ['queued', 'sending', 'paused', 'completed'].includes(String(state));
}

export function stateLabel(state: string): string {
  const map: Record<string, string> = {
    draft: 'Draft', scheduled: 'Scheduled', queued: 'Queued', sending: 'Sending',
    paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed',
  };
  return map[String(state)] || String(state);
}

export function stateTone(state: string): 'ok' | 'warn' | 'bad' | 'muted' | 'live' {
  if (state === 'completed') return 'ok';
  if (state === 'sending' || state === 'queued') return 'live';
  if (state === 'paused' || state === 'scheduled') return 'warn';
  if (state === 'failed') return 'bad';
  return 'muted';
}

// ── the safety gate ────────────────────────────────────────────────────────────────────────────

/** Above this many recipients a send needs an explicit typed confirmation of the exact count. */
export const LARGE_CAMPAIGN_THRESHOLD = 500;

/** Two campaigns with the same subject to the same audience inside this window look like a mistake. */
export const DUPLICATE_WINDOW_HOURS = 24;

export interface PreflightInput {
  state: string;
  subject: string;
  bodyHtml: string;
  fromAddress: string;
  /** Recipients that survived the resolver. */
  recipientCount: number;
  /** Contacts removed by suppression / unsubscribe / invalid checks. Reported, never a blocker. */
  skipped?: { suppressed?: number; unsubscribed?: number; invalid?: number; duplicate?: number };
  audienceDescribed: boolean;
  segmentErrors?: string[];
  /** Segment(s) that place no restriction at all. */
  matchesEveryone?: boolean;
  /** Variables in the copy with no default declared. */
  variablesWithoutFallback?: string[];
  hasUnsubscribeLink: boolean;
  transportReady: boolean;
  /** The recipient count the operator typed to confirm, or null if they have not confirmed. */
  confirmedCount?: number | null;
  /** A campaign with the same subject sent recently — the duplicate-send guard. */
  recentDuplicate?: { id: string; name: string; hoursAgo: number } | null;
  threshold?: number;
}

export interface PreflightResult {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  needsConfirmation: boolean;
  /** The number the operator must type back. */
  confirmCount: number;
}

/**
 * Everything checked before a campaign may be queued.
 *
 * The split between blocker and warning is a policy statement, not a detail:
 *
 *   BLOCKS — no recipients, no subject, no body, no from address, a broken segment, no transport,
 *            no unsubscribe link on a bulk send, an unconfirmed large send, wrong state.
 *   WARNS  — a segment that matches every contact, copy with undefaulted variables, a near-identical
 *            campaign sent hours ago, a large number of skipped addresses.
 *
 * A warning that blocked would train operators to click through; a blocker that only warned would
 * one day post a blank template to the whole contact book. The unsubscribe link is a BLOCKER
 * because a bulk mail without one is both a deliverability failure and a consent failure.
 */
export function preflight(input: PreflightInput): PreflightResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const threshold = input.threshold ?? LARGE_CAMPAIGN_THRESHOLD;

  const t = campaignTransition(input.state, 'queue');
  if (!t.ok) blockers.push(t.error || 'This campaign cannot be sent from its current status.');

  if (!String(input.subject || '').trim()) blockers.push('The subject line is empty.');
  if (!String(input.bodyHtml || '').trim()) blockers.push('The message body is empty.');
  if (!String(input.fromAddress || '').trim()) blockers.push('No sending address is set for this campaign.');
  if (!input.audienceDescribed) blockers.push('No audience is selected. Choose at least one list, segment or contact.');
  for (const e of input.segmentErrors || []) blockers.push('Audience segment: ' + e);
  if (!input.transportReady) blockers.push('No outbound mail server is configured, so nothing can be sent. Set it up in Mail Settings.');
  if (!input.hasUnsubscribeLink) blockers.push('The body has no unsubscribe link. Add {{unsubscribe_url}} — a bulk send without one is not sendable here.');
  if (input.recipientCount <= 0) blockers.push('This campaign resolved to zero recipients, so there is nothing to send.');

  if (input.matchesEveryone) {
    warnings.push('This audience places no restriction at all — it is every contact in the book.');
  }
  const noFallback = input.variablesWithoutFallback || [];
  if (noFallback.length) {
    warnings.push(
      'These variables have no default and will be blank for anyone missing them: '
      + noFallback.join(', ') + '. Write e.g. {{first_name | default:"there"}}.',
    );
  }
  if (input.recentDuplicate) {
    warnings.push(
      'A campaign with this subject ("' + input.recentDuplicate.name + '") went out '
      + input.recentDuplicate.hoursAgo + ' hours ago. Check you are not sending it twice.',
    );
  }
  const sk = input.skipped || {};
  const totalSkipped = (sk.suppressed || 0) + (sk.unsubscribed || 0) + (sk.invalid || 0) + (sk.duplicate || 0);
  if (totalSkipped > 0 && input.recipientCount > 0 && totalSkipped >= input.recipientCount) {
    warnings.push(totalSkipped + ' addresses were removed before sending — more than are left in the audience. Check the audience is the one you meant.');
  }

  const needsConfirmation = input.recipientCount >= threshold;
  if (needsConfirmation && input.confirmedCount !== input.recipientCount) {
    blockers.push(
      'This sends to ' + input.recipientCount.toLocaleString('en-IN')
      + ' people. Type that exact number into the confirmation box to proceed.',
    );
  }

  return { ok: blockers.length === 0, blockers, warnings, needsConfirmation, confirmCount: input.recipientCount };
}

export function requiresConfirmation(recipientCount: number, threshold = LARGE_CAMPAIGN_THRESHOLD): boolean {
  return recipientCount >= threshold;
}

// ── A/B testing ────────────────────────────────────────────────────────────────────────────────

export type AbDimension = 'subject' | 'content' | 'cta';
export type AbMetric = 'open' | 'click' | 'conversion';

export interface AbVariant {
  key: string;            // 'a', 'b', 'c' …
  label?: string;
  subject?: string;
  bodyHtml?: string;
  ctaText?: string;
  ctaUrl?: string;
}

export interface AbConfig {
  enabled: boolean;
  dimension: AbDimension;
  variants: AbVariant[];
  /** Share of the audience used for the test, 1-100. 100 means no hold-back: everyone is split. */
  testPercent: number;
  winnerMetric: AbMetric;
  /** Set once a winner is promoted; the hold-back then receives this variant. */
  winnerKey?: string | null;
}

/** The variant given to the hold-back group until a winner is promoted. */
export const HOLDBACK = 'hold';

export function abErrors(ab: AbConfig | null | undefined): string[] {
  if (!ab || !ab.enabled) return [];
  const out: string[] = [];
  if (!['subject', 'content', 'cta'].includes(ab.dimension)) out.push('Choose what the test varies: subject, content or call to action.');
  const variants = Array.isArray(ab.variants) ? ab.variants : [];
  if (variants.length < 2) out.push('An A/B test needs at least two variants.');
  if (variants.length > 4) out.push('At most four variants.');
  const keys = variants.map((v) => String(v.key || ''));
  if (keys.some((k) => !/^[a-z]$/.test(k))) out.push('Variant keys must be single letters (a, b, c, d).');
  if (new Set(keys).size !== keys.length) out.push('Two variants share the same key.');
  const pct = Number(ab.testPercent);
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) out.push('Test share must be between 1 and 100 percent.');
  if (!['open', 'click', 'conversion'].includes(ab.winnerMetric)) out.push('Choose how the winner is decided.');
  if (ab.dimension === 'subject' && variants.some((v) => !String(v.subject || '').trim())) out.push('Every variant needs its own subject line.');
  if (ab.dimension === 'content' && variants.some((v) => !String(v.bodyHtml || '').trim())) out.push('Every variant needs its own body.');
  if (ab.dimension === 'cta' && variants.some((v) => !String(v.ctaText || '').trim())) out.push('Every variant needs its own call-to-action text.');
  return out;
}

/**
 * FNV-1a over the address. Deterministic, uniform enough for a split, and — the point — STABLE:
 * re-resolving an audience puts everybody back in the bucket they were in, so a resumed or retried
 * campaign cannot mail one person variant A and then variant B.
 *
 * The salt is the campaign id, so the same contact does not sit in the same arm of every test.
 */
export function hashBucket(seed: string, buckets: number): number {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return buckets > 0 ? h % buckets : 0;
}

/**
 * Assign each address a variant.
 *
 * With `testPercent` below 100 the audience splits into a test group (evenly divided across the
 * variants) and a HOLD-BACK that receives nothing until a winner is promoted. Membership of the
 * hold-back is drawn from the same stable hash, so it does not move between runs.
 */
export function assignVariants(emails: string[], ab: AbConfig | null | undefined, salt = ''): { email: string; variant: string }[] {
  const list = (emails || []).map((e) => String(e || '').toLowerCase());
  if (!ab || !ab.enabled || !Array.isArray(ab.variants) || ab.variants.length < 2) {
    return list.map((email) => ({ email, variant: 'a' }));
  }
  const keys = ab.variants.map((v) => String(v.key));
  const pct = Math.min(100, Math.max(1, Math.floor(Number(ab.testPercent) || 100)));
  return list.map((email) => {
    const inTest = pct >= 100 || hashBucket(salt + ':hold:' + email, 100) < pct;
    if (!inTest) return { email, variant: ab.winnerKey || HOLDBACK };
    return { email, variant: keys[hashBucket(salt + ':var:' + email, keys.length)] };
  });
}

export interface VariantStat {
  key: string;
  sent: number;
  opened: number;
  clicked: number;
  converted: number;
}

export interface WinnerResult {
  key: string;
  rate: number;
  runnerUpKey: string | null;
  runnerUpRate: number;
  /** True when a two-proportion z-test separates the top two at ~95%. */
  confident: boolean;
  z: number;
  reason: string;
}

/** Smallest per-variant sample we will call a winner from at all. Below this, `confident` is false. */
export const MIN_VARIANT_SAMPLE = 50;

function metricCount(s: VariantStat, m: AbMetric): number {
  return m === 'open' ? s.opened : m === 'click' ? s.clicked : s.converted;
}

/**
 * The leading variant, and whether the lead is real.
 *
 * `key` is always the highest rate — an operator looking at the dashboard should see which one is
 * ahead. `confident` is the separate, honest question, and the promote-winner path requires it:
 * calling a winner off eleven opens is how A/B testing becomes superstition.
 */
export function pickWinner(stats: VariantStat[], metric: AbMetric): WinnerResult | null {
  const usable = (stats || []).filter((s) => s && s.sent > 0);
  if (usable.length < 2) return null;
  const scored = usable
    .map((s) => ({ key: s.key, rate: metricCount(s, metric) / s.sent, n: s.sent, x: metricCount(s, metric) }))
    .sort((a, b) => b.rate - a.rate || b.n - a.n);
  const top = scored[0];
  const second = scored[1];

  const pooled = (top.x + second.x) / (top.n + second.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / top.n + 1 / second.n));
  const z = se > 0 ? (top.rate - second.rate) / se : 0;
  const bigEnough = top.n >= MIN_VARIANT_SAMPLE && second.n >= MIN_VARIANT_SAMPLE;
  const confident = bigEnough && Math.abs(z) >= 1.96;

  const reason = !bigEnough
    ? 'Too few recipients per variant to call this — at least ' + MIN_VARIANT_SAMPLE + ' each is needed.'
    : confident
      ? 'Variant ' + top.key.toUpperCase() + ' leads by ' + ((top.rate - second.rate) * 100).toFixed(1) + ' points, which is outside the margin of error.'
      : 'Variant ' + top.key.toUpperCase() + ' is ahead but the difference is inside the margin of error.';

  return { key: top.key, rate: top.rate, runnerUpKey: second.key, runnerUpRate: second.rate, confident, z, reason };
}

// ── rate presentation ──────────────────────────────────────────────────────────────────────────

export interface CampaignTotals {
  recipients: number;
  sent: number;
  delivered: number;
  deferred: number;
  bounced: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  complained: number;
  failed: number;
}

export const EMPTY_TOTALS: CampaignTotals = {
  recipients: 0, sent: 0, delivered: 0, deferred: 0, bounced: 0,
  opened: 0, clicked: 0, unsubscribed: 0, complained: 0, failed: 0,
};

/**
 * A rate as a percentage, or null when the denominator is zero.
 *
 * NULL, NOT ZERO. "0.0% open rate" on a campaign that has sent nothing yet reads as a catastrophe;
 * the dashboard must draw a dash. This project has shipped that exact confusion before on
 * /admin/mail/analytics, where a failed read and an empty mailbox rendered identically.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (!denominator || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

export function formatRate(r: number | null): string {
  return r === null ? '—' : r.toFixed(1) + '%';
}

/**
 * The dashboard rows. Denominators are stated because they are genuinely arguable: open and click
 * rates here are over DELIVERED (not sent), which is the industry reading and the only one that
 * does not punish a campaign for the bounces it already reports separately.
 */
export function campaignRates(t: CampaignTotals): { label: string; value: string; rate: number | null; over: string }[] {
  const delivered = t.delivered || 0;
  return [
    { label: 'Recipients', value: String(t.recipients), rate: null, over: 'in the resolved audience' },
    { label: 'Delivered', value: String(delivered), rate: rate(delivered, t.sent), over: 'of messages accepted by the server' },
    { label: 'Bounces', value: String(t.bounced), rate: rate(t.bounced, t.sent), over: 'of sent' },
    { label: 'Opens', value: String(t.opened), rate: rate(t.opened, delivered), over: 'of delivered' },
    { label: 'Clicks', value: String(t.clicked), rate: rate(t.clicked, delivered), over: 'of delivered' },
    { label: 'Unsubscribes', value: String(t.unsubscribed), rate: rate(t.unsubscribed, delivered), over: 'of delivered' },
    { label: 'Complaints', value: String(t.complained), rate: rate(t.complained, delivered), over: 'of delivered' },
  ];
}

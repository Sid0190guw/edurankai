// src/lib/mail-recipients.ts — WHO ACTUALLY RECEIVES A CAMPAIGN.
//
// NEVER SEND TO THE RAW AUDIENCE. Between "these lists and segments" and "these envelopes" sits a
// pipeline that has to run every time, in this order:
//
//     audience → deduplication → suppression → unsubscribe → invalid address → recipients → queue
//
// The order is not arbitrary. Deduplication comes FIRST so that a person on three lists is counted
// against suppression once, not three times — otherwise the skip counts on the confirmation screen
// are inflated and an operator cannot tell 900 real people from 300 people listed three times.
// Suppression comes before the per-contact status check because suppression is keyed by ADDRESS and
// survives the contact record (see mail-contacts.ts); a contact deleted and re-imported is caught
// there and nowhere else. The address shape check is last because it is the cheapest to explain and
// the least likely to be contentious.
//
// resolveRecipients() is PURE. It takes candidates and a suppression set and returns the split. The
// database work — reading the audience, writing the queue — is the second half of this file.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { uuidIn } from '@/lib/pg-array';
import { isValidEmail, normalizeEmailValue } from '@/lib/mail-csv';
import { segmentSql, type SegmentNode } from '@/lib/mail-segments';
import { ensureContactSchema, isUuid, suppressedAmong, dbReason } from '@/lib/mail-contacts';
import { assignVariants, type AbConfig } from '@/lib/mail-campaign-state';

function rows<T = any>(r: any): T[] { return (Array.isArray(r) ? r : (r?.rows || [])) as T[]; }

// ── the pure pipeline ──────────────────────────────────────────────────────────────────────────

export type SkipReason =
  | 'duplicate'      // the same address appeared earlier in the audience
  | 'suppressed'     // on the suppression list (bounce / complaint / manual)
  | 'unsubscribed'   // the contact record says they opted out
  | 'complained'
  | 'bounced'
  | 'pending'        // consent not confirmed
  | 'invalid'        // not a usable address
  | 'excluded';      // in an audience the operator explicitly excluded

export interface Candidate {
  contactId: string | null;
  email: string;
  status?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  organization?: string | null;
  phone?: string | null;
  role_title?: string | null;
  custom?: Record<string, unknown> | null;
  application_stage?: string | null;
  application_number?: string | null;
  unsub_token?: string | null;
}

export interface SkippedRecipient {
  email: string;
  contactId: string | null;
  reason: SkipReason;
}

export interface ResolveResult {
  accepted: Candidate[];
  skipped: SkippedRecipient[];
  counts: Record<SkipReason | 'accepted' | 'candidates', number>;
}

export interface ResolveOptions {
  /** Addresses on the suppression list. Lower-cased. */
  suppressed?: Set<string>;
  /** Addresses from an explicitly excluded list/segment. Lower-cased. */
  excluded?: Set<string>;
  /**
   * Statuses allowed through. Defaults to `subscribed` only.
   *
   * A TRANSACTIONAL send may widen this — an offer letter goes to the candidate whether or not they
   * subscribed to the newsletter, because it is not marketing. That is a decision the CALLER makes
   * explicitly; the default here is the safe one.
   */
  allowStatuses?: string[];
  /** Skip the suppression list too. Only a transactional send may do this, and it is logged. */
  ignoreSuppression?: boolean;
}

const emptyCounts = (): ResolveResult['counts'] => ({
  candidates: 0, accepted: 0, duplicate: 0, suppressed: 0, unsubscribed: 0,
  complained: 0, bounced: 0, pending: 0, invalid: 0, excluded: 0,
});

/**
 * Run the pipeline. Pure: no database, no clock, no randomness.
 *
 * The FIRST occurrence of an address wins, so a contact record reached through a list keeps its
 * merge fields even if the same address also arrives from a segment with nothing filled in.
 */
export function resolveRecipients(candidates: Candidate[], opts: ResolveOptions = {}): ResolveResult {
  const suppressed = opts.suppressed || new Set<string>();
  const excluded = opts.excluded || new Set<string>();
  const allow = new Set(opts.allowStatuses && opts.allowStatuses.length ? opts.allowStatuses : ['subscribed']);

  const accepted: Candidate[] = [];
  const skipped: SkippedRecipient[] = [];
  const counts = emptyCounts();
  const seen = new Set<string>();

  for (const raw of candidates || []) {
    counts.candidates++;
    const email = normalizeEmailValue(raw?.email || '');
    const contactId = raw?.contactId || null;

    if (!email) { skipped.push({ email: '', contactId, reason: 'invalid' }); counts.invalid++; continue; }

    // 1. deduplication
    if (seen.has(email)) { skipped.push({ email, contactId, reason: 'duplicate' }); counts.duplicate++; continue; }
    seen.add(email);

    // 2. explicit exclusion
    if (excluded.has(email)) { skipped.push({ email, contactId, reason: 'excluded' }); counts.excluded++; continue; }

    // 3. suppression (address-level; outlives the contact record)
    if (!opts.ignoreSuppression && suppressed.has(email)) {
      skipped.push({ email, contactId, reason: 'suppressed' }); counts.suppressed++; continue;
    }

    // 4. subscription status
    const status = String(raw?.status || 'subscribed');
    if (!allow.has(status)) {
      const reason: SkipReason =
        status === 'complained' ? 'complained'
          : status === 'bounced' ? 'bounced'
            : status === 'pending' ? 'pending'
              : 'unsubscribed';
      skipped.push({ email, contactId, reason });
      counts[reason]++;
      continue;
    }

    // 5. address shape
    if (!isValidEmail(email)) { skipped.push({ email, contactId, reason: 'invalid' }); counts.invalid++; continue; }

    accepted.push({ ...raw, email });
    counts.accepted++;
  }

  return { accepted, skipped, counts };
}

/** A sentence per non-zero skip bucket. What the confirmation screen prints under the count. */
export function describeSkips(counts: ResolveResult['counts']): string[] {
  const lines: string[] = [];
  const say = (n: number, one: string, many: string) => { if (n > 0) lines.push(n + ' ' + (n === 1 ? one : many)); };
  say(counts.duplicate, 'duplicate address was removed', 'duplicate addresses were removed');
  say(counts.excluded, 'address was in an excluded audience', 'addresses were in an excluded audience');
  say(counts.suppressed, 'address is on the suppression list', 'addresses are on the suppression list');
  say(counts.unsubscribed, 'contact has unsubscribed', 'contacts have unsubscribed');
  say(counts.bounced, 'address has hard-bounced before', 'addresses have hard-bounced before');
  say(counts.complained, 'address reported mail as spam', 'addresses reported mail as spam');
  say(counts.pending, 'contact has not confirmed consent', 'contacts have not confirmed consent');
  say(counts.invalid, 'address is not usable', 'addresses are not usable');
  return lines;
}

// ── the audience ───────────────────────────────────────────────────────────────────────────────

export interface Audience {
  listIds?: string[];
  segmentIds?: string[];
  /** An unsaved segment tree, for "send to this filter" straight from the contacts screen. */
  segment?: SegmentNode | null;
  contactIds?: string[];
  excludeListIds?: string[];
  excludeSegmentIds?: string[];
}

export function audienceIsEmpty(a: Audience | null | undefined): boolean {
  if (!a) return true;
  return !(
    (a.listIds || []).length ||
    (a.segmentIds || []).length ||
    (a.contactIds || []).length ||
    (a.segment && a.segment.type === 'group' && (a.segment.children || []).length)
  );
}

/**
 * Everyone the audience names, before any filtering.
 *
 * ONE QUERY, not one per list. A UNION over the include arms with a LEFT JOIN onto the applications
 * table for the recruitment merge fields, capped so a mis-typed audience cannot pull the whole
 * database into memory. The cap is REPORTED, never silent — a truncated audience that looks
 * complete is how a campaign quietly reaches two thirds of its list.
 */
export async function loadAudience(a: Audience, cap = 100000): Promise<{ candidates: Candidate[]; truncated: boolean }> {
  await ensureContactSchema();
  const arms: any[] = [];

  const listIds = (a.listIds || []).filter(isUuid);
  if (listIds.length) {
    arms.push(sql`SELECT c.id FROM mail_contacts c WHERE EXISTS (SELECT 1 FROM mail_list_members m WHERE m.contact_id = c.id AND m.list_id IN ${uuidIn(listIds)})`);
  }
  const segmentIds = (a.segmentIds || []).filter(isUuid);
  for (const sid of segmentIds) {
    const seg = rows(await db.execute(sql`SELECT definition FROM mail_segments WHERE id = ${sid} AND definition IS NOT NULL LIMIT 1`))[0];
    if (seg?.definition) arms.push(sql`SELECT c.id FROM mail_contacts c WHERE ${segmentSql(seg.definition as SegmentNode)}`);
  }
  if (a.segment && a.segment.type === 'group' && (a.segment.children || []).length) {
    arms.push(sql`SELECT c.id FROM mail_contacts c WHERE ${segmentSql(a.segment)}`);
  }
  const contactIds = (a.contactIds || []).filter(isUuid);
  if (contactIds.length) arms.push(sql`SELECT c.id FROM mail_contacts c WHERE c.id IN ${uuidIn(contactIds)}`);

  if (!arms.length) return { candidates: [], truncated: false };
  const include = sql.join(arms, sql` UNION `);

  const list = rows(await db.execute(sql`
    WITH inc AS (${include})
    SELECT c.id AS contact_id, c.email, c.status, c.first_name, c.last_name, c.organization, c.phone,
           c.role_title, c.fields, c.unsub_token,
           app.stage AS application_stage, app.application_number
    FROM inc JOIN mail_contacts c ON c.id = inc.id
    LEFT JOIN LATERAL (
      SELECT a.stage, a.application_number FROM applications a
      WHERE lower(a.email) = c.email ORDER BY a.created_at DESC LIMIT 1
    ) app ON TRUE
    ORDER BY c.created_at ASC
    LIMIT ${cap + 1}
  `));

  const truncated = list.length > cap;
  const candidates: Candidate[] = list.slice(0, cap).map((r: any) => ({
    contactId: r.contact_id,
    email: String(r.email),
    status: r.status,
    first_name: r.first_name,
    last_name: r.last_name,
    organization: r.organization,
    phone: r.phone,
    role_title: r.role_title,
    custom: r.fields || {},
    application_stage: r.application_stage,
    application_number: r.application_number,
    unsub_token: r.unsub_token,
  }));
  return { candidates, truncated };
}

/** The addresses in the excluded arms of an audience. */
export async function loadExclusions(a: Audience): Promise<Set<string>> {
  await ensureContactSchema();
  const arms: any[] = [];
  const listIds = (a.excludeListIds || []).filter(isUuid);
  if (listIds.length) {
    arms.push(sql`SELECT c.email FROM mail_contacts c WHERE EXISTS (SELECT 1 FROM mail_list_members m WHERE m.contact_id = c.id AND m.list_id IN ${uuidIn(listIds)})`);
  }
  for (const sid of (a.excludeSegmentIds || []).filter(isUuid)) {
    const seg = rows(await db.execute(sql`SELECT definition FROM mail_segments WHERE id = ${sid} AND definition IS NOT NULL LIMIT 1`))[0];
    if (seg?.definition) arms.push(sql`SELECT c.email FROM mail_contacts c WHERE ${segmentSql(seg.definition as SegmentNode)}`);
  }
  if (!arms.length) return new Set();
  const r = rows(await db.execute(sql.join(arms, sql` UNION `)));
  return new Set(r.map((x: any) => String(x.email)));
}

export interface ResolvedAudience extends ResolveResult {
  truncated: boolean;
  /** Address -> variant, once an A/B split has been drawn. */
  variants: Map<string, string>;
}

/**
 * The whole pipeline against the database: load, exclude, suppress, filter, split.
 *
 * This is what BOTH the preview and the send call, so the number an operator confirms is computed
 * by the same code that later generates the queue. A preview that uses a different query from the
 * send is a preview that lies.
 */
export async function resolveAudience(
  a: Audience,
  opts: { ab?: AbConfig | null; salt?: string; allowStatuses?: string[]; ignoreSuppression?: boolean; cap?: number } = {},
): Promise<ResolvedAudience> {
  const { candidates, truncated } = await loadAudience(a, opts.cap ?? 100000);
  const excluded = await loadExclusions(a);
  const suppressed = opts.ignoreSuppression ? new Set<string>() : await suppressedAmong(candidates.map((c) => c.email));
  const result = resolveRecipients(candidates, {
    suppressed,
    excluded,
    allowStatuses: opts.allowStatuses,
    ignoreSuppression: opts.ignoreSuppression,
  });
  const variants = new Map<string, string>();
  for (const v of assignVariants(result.accepted.map((c) => c.email), opts.ab, opts.salt || '')) {
    variants.set(v.email, v.variant);
  }
  return { ...result, truncated, variants };
}

// ── the queue ──────────────────────────────────────────────────────────────────────────────────

export interface MaterializeResult {
  inserted: number;
  alreadyThere: number;
  skippedRecorded: number;
  error?: string;
}

/**
 * Write the resolved audience into `mail_campaign_recipients`.
 *
 * `ON CONFLICT (campaign_id, email) DO NOTHING` is the RACE GUARD and the duplicate-send guard at
 * once: two operators pressing Send, a cron overlapping a manual run, or a retry after a timeout
 * all converge on the same set of rows instead of doubling it. The unique index is what enforces
 * it — not the application, which cannot be trusted across two processes.
 *
 * Skipped addresses are recorded too, with their reason, so the campaign report can answer "why
 * didn't X get this?" months later. They are inserted as `skipped` and never claimed by a worker.
 */
export async function materializeRecipients(
  campaignId: string,
  resolved: ResolvedAudience,
  mergeFor: (c: Candidate) => Record<string, unknown>,
): Promise<MaterializeResult> {
  if (!isUuid(campaignId)) return { inserted: 0, alreadyThere: 0, skippedRecorded: 0, error: 'That campaign id is not valid.' };
  let inserted = 0;
  let alreadyThere = 0;
  let skippedRecorded = 0;

  try {
    for (const c of resolved.accepted) {
      const variant = resolved.variants.get(c.email) || 'a';
      const r = rows(await db.execute(sql`
        INSERT INTO mail_campaign_recipients (campaign_id, contact_id, email, variant, merge, status)
        VALUES (${campaignId}, ${c.contactId}, ${c.email}, ${variant}, ${JSON.stringify(mergeFor(c))}::jsonb, 'pending')
        ON CONFLICT (campaign_id, email) DO NOTHING
        RETURNING id
      `));
      if (r.length) inserted++; else alreadyThere++;
    }
    for (const s of resolved.skipped) {
      if (!s.email) continue;
      const r = rows(await db.execute(sql`
        INSERT INTO mail_campaign_recipients (campaign_id, contact_id, email, variant, merge, status, skip_reason)
        VALUES (${campaignId}, ${s.contactId}, ${s.email}, 'a', '{}'::jsonb, 'skipped', ${s.reason})
        ON CONFLICT (campaign_id, email) DO NOTHING
        RETURNING id
      `));
      if (r.length) skippedRecorded++;
    }
    return { inserted, alreadyThere, skippedRecorded };
  } catch (e: any) {
    console.error('[mail-recipients] materialize:', dbReason(e));
    return { inserted, alreadyThere, skippedRecorded, error: dbReason(e) };
  }
}

/**
 * Atomically take the next batch of pending recipients for sending.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes two workers safe: each claims a
 * disjoint batch instead of both sending to the same people. The same idiom the job queue uses
 * (src/lib/job-queue.ts claimBatch), for the same reason.
 *
 * The hold-back arm of an A/B test is deliberately NOT claimable — `variant <> 'hold'` — because
 * those recipients are waiting for a winner that has not been promoted yet.
 */
export async function claimRecipientBatch(campaignId: string, limit = 50): Promise<any[]> {
  if (!isUuid(campaignId)) return [];
  return rows(await db.execute(sql`
    UPDATE mail_campaign_recipients SET status = 'sending', updated_at = now()
    WHERE id IN (
      SELECT id FROM mail_campaign_recipients
      WHERE campaign_id = ${campaignId} AND status = 'pending' AND variant <> 'hold'
      ORDER BY created_at ASC
      LIMIT ${Math.min(500, Math.max(1, limit))}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, contact_id, email, variant, merge
  `));
}

/**
 * Return recipients stuck in `sending` to `pending`.
 *
 * A worker killed mid-batch (a serverless timeout, a deploy) leaves rows claimed and nobody sending
 * them. Without this they sit in `sending` for ever and the campaign never completes — it just
 * stops, which looks identical to "finished" on a dashboard that only counts sent.
 */
export async function releaseStaleClaims(campaignId: string, olderThanMinutes = 15): Promise<number> {
  if (!isUuid(campaignId)) return 0;
  const r = rows(await db.execute(sql`
    UPDATE mail_campaign_recipients SET status = 'pending', updated_at = now()
    WHERE campaign_id = ${campaignId} AND status = 'sending'
      AND updated_at < now() - make_interval(mins => ${Math.max(1, olderThanMinutes)}::int)
    RETURNING id
  `));
  return r.length;
}

export async function markRecipient(
  id: string,
  status: 'sent' | 'delivered' | 'deferred' | 'bounced' | 'failed',
  p: { messageRef?: string | null; error?: string | null } = {},
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE mail_campaign_recipients
      SET status = ${status},
          message_id = coalesce(${p.messageRef || null}, message_id),
          error = ${p.error ? String(p.error).slice(0, 500) : null},
          sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END,
          updated_at = now()
      WHERE id = ${id}
    `);
  } catch (e: any) {
    console.error('[mail-recipients] markRecipient:', dbReason(e));
  }
}

/** Pending recipients that are not held back — i.e. is there work left for this campaign? */
export async function pendingCount(campaignId: string): Promise<number> {
  if (!isUuid(campaignId)) return 0;
  const r = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM mail_campaign_recipients
    WHERE campaign_id = ${campaignId} AND status IN ('pending','sending') AND variant <> 'hold'
  `));
  return Number(r[0]?.n || 0);
}

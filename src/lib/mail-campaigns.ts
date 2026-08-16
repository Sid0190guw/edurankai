// src/lib/mail-campaigns.ts — CAMPAIGN LIFECYCLE, SENDING AND ANALYTICS.
//
// The state machine, the safety gate and the A/B maths live in mail-campaign-state.ts (pure); the
// recipient pipeline lives in mail-recipients.ts (pure core + queue); the scheduling arithmetic
// lives in mail-schedule.ts (pure). THIS file is the part that touches the database and the SMTP
// transport, and it is deliberately the only part that does.
//
// TWO REPUTATIONAL STREAMS, NOT ONE MAILBOX. A bounce on a marketing blast must not cost a password
// reset its delivery. What this layer can enforce — and does — is a separate From address and
// subdomain per stream, a `X-ERA-Stream` header, List-Unsubscribe on bulk only, campaign traffic
// logged to its own tables rather than email_logs, and suppression that applies to campaigns while
// leaving transactional mail alone. What it CANNOT do from here is put the two streams on different
// IPs: that is a mail-server change and belongs to the infrastructure stream. docs/mail-campaigns.md
// says so plainly rather than letting the header imply an isolation that does not exist yet.
//
// EVERY STATUS WRITE GOES THROUGH campaignTransition(). No function in this file writes a status it
// invented; a campaign that could go from `completed` back to `sending` would send twice.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { uuidIn } from '@/lib/pg-array';
import { getMailConfig, MAIL_DOMAIN } from '@/lib/mail';
import { sendExternal } from '@/lib/mail-transport';
import { ensureContactSchema, isUuid, dbReason, logContactEvent, suppress, touchActivity, type Actor } from '@/lib/mail-contacts';
import { logEvent } from '@/lib/logger';
import {
  campaignTransition, preflight, canEditContent, abErrors, pickWinner,
  EMPTY_TOTALS, HOLDBACK, LARGE_CAMPAIGN_THRESHOLD, DUPLICATE_WINDOW_HOURS,
  type CampaignState, type CampaignAction, type AbConfig, type CampaignTotals, type VariantStat,
} from '@/lib/mail-campaign-state';
import {
  resolveAudience, materializeRecipients, claimRecipientBatch, releaseStaleClaims, markRecipient,
  pendingCount, audienceIsEmpty, describeSkips, type Audience, type Candidate, type ResolvedAudience,
} from '@/lib/mail-recipients';
import { mergeVarsForContact, renderHtml, renderSubject, renderText, variablesWithoutFallback } from '@/lib/mail-personalize';
import { segmentErrors, matchesEveryone, type SegmentNode } from '@/lib/mail-segments';
import { isDue, nextOccurrence, zonedTimeToUtc, isValidTimeZone, recurrenceErrors, type Recurrence } from '@/lib/mail-schedule';

function rows<T = any>(r: any): T[] { return (Array.isArray(r) ? r : (r?.rows || [])) as T[]; }

export const SITE_BASE = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.edurankai.in').replace(/\/+$/, '');

/** The From address a campaign uses when none is set. A separate mailbox from transactional mail. */
export const DEFAULT_CAMPAIGN_FROM = 'campaigns@' + MAIL_DOMAIN;

// ── schema ─────────────────────────────────────────────────────────────────────────────────────

let ready: Promise<void> | null = null;

/**
 * Which engine owns a campaign row.
 *
 * A SAFETY BOUNDARY, NOT BOOKKEEPING. Two campaign engines now write to `mail_campaigns`: the core
 * one (dispatched per campaign from its own API, recipients in status `queued`) and this one (swept
 * by a cron, recipients in status `pending`). Without a marker, drainDueCampaigns() would pick up a
 * core campaign, find no `pending` recipients, and mark it COMPLETED while its real audience had
 * never been sent to. Every sweep below is narrowed to this value; existing rows and anything the
 * core creates default to 'core' and are never touched here.
 */
export const ENGINE = 'p5';

/**
 * Bootstrap — ADDITIVE ONLY, over the core mail schema.
 *
 * `mail_campaigns`, `mail_campaign_recipients` and `mail_campaign_events` are created by
 * src/lib/mail-product/schema.ts. A second `CREATE TABLE IF NOT EXISTS` here would NOT error — it
 * would no-op against the existing shape, and every query in one of the two engines would then fail
 * at runtime on a column that was never created. So the core schema is called first and this only
 * adds to it.
 */
export function ensureCampaignSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await ensureContactSchema();   // which calls ensureMailProductSchema() first

      const campaignCols = [
        "engine text NOT NULL DEFAULT 'core'",
        "stream text NOT NULL DEFAULT 'campaign'",
        "audience jsonb NOT NULL DEFAULT '{}'::jsonb",
        'ab jsonb',
        "time_zone text NOT NULL DEFAULT 'Asia/Kolkata'",
        'recurrence jsonb',
        'recurrence_parent_id uuid',
        'occurrence_no integer NOT NULL DEFAULT 1',
        'confirmed_count integer',
        'confirmed_by uuid',
        'confirmed_at timestamptz',
        'claimed_at timestamptz',
      ];
      for (const col of campaignCols) {
        await db.execute(sql.raw('ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS ' + col));
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_campaigns_engine_idx ON mail_campaigns(engine, status, scheduled_at)`);

      const recipientCols = [
        "variant text NOT NULL DEFAULT 'a'",
        "merge jsonb NOT NULL DEFAULT '{}'::jsonb",
        'skip_reason text',
        'updated_at timestamptz NOT NULL DEFAULT now()',
      ];
      for (const col of recipientCols) {
        await db.execute(sql.raw('ALTER TABLE mail_campaign_recipients ADD COLUMN IF NOT EXISTS ' + col));
      }
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_campaign_recipients_claim_idx ON mail_campaign_recipients(campaign_id, status, created_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_campaign_recipients_contact_idx ON mail_campaign_recipients(contact_id)`);

      for (const col of ['recipient_id uuid', 'variant text', 'ip text', 'user_agent text']) {
        await db.execute(sql.raw('ALTER TABLE mail_campaign_events ADD COLUMN IF NOT EXISTS ' + col));
      }
      // One row per recipient per type for the RATE denominators — a person who opens six times is
      // six events but one opener, and conflating them produces open rates above 100%.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_campaign_events_unique_recipient
        ON mail_campaign_events(campaign_id, recipient_id, type)
        WHERE recipient_id IS NOT NULL AND type IN ('opened','unsubscribed','complained','delivered','sent','bounced')`);

      // Click targets get ids so the redirect endpoint never takes a URL from the query string —
      // that would be an open redirect on a domain we ask people to trust. Owned only here.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS mail_campaign_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id uuid NOT NULL,
        url text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS mail_campaign_links_unique ON mail_campaign_links(campaign_id, md5(url))`);
    } catch (e: any) {
      ready = null;
      console.error('[mail-campaigns] schema bootstrap failed:', dbReason(e));
      throw e;
    }
  })();
  return ready;
}

// ── types ──────────────────────────────────────────────────────────────────────────────────────

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  body_html: string;
  body_text: string | null;
  status: CampaignState;
  stream: 'campaign' | 'transactional';
  audience: Audience;
  ab: AbConfig | null;
  scheduled_at: string | null;
  time_zone: string;
  recurrence: Recurrence | null;
  recurrence_parent_id: string | null;
  occurrence_no: number;
  confirmed_count: number | null;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WriteResult { ok: boolean; id?: string; error?: string }

// ── CRUD ───────────────────────────────────────────────────────────────────────────────────────

export async function createCampaign(p: { name: string; subject?: string; bodyHtml?: string; stream?: 'campaign' | 'transactional' }, actor?: Actor): Promise<WriteResult> {
  await ensureCampaignSchema();
  const name = String(p.name || '').trim();
  if (!name) return { ok: false, error: 'A campaign needs a name.' };
  const cfg = await getMailConfig().catch(() => null);
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mail_campaigns (name, subject, body_html, engine, stream, from_name, from_email, created_by)
      VALUES (${name}, ${p.subject || ''}, ${p.bodyHtml || ''}, ${ENGINE}, ${p.stream === 'transactional' ? 'transactional' : 'campaign'},
              ${cfg?.fromName || 'EduRankAI'}, ${DEFAULT_CAMPAIGN_FROM}, ${actor?.userId || null})
      RETURNING id
    `));
    return r[0]?.id ? { ok: true, id: r[0].id } : { ok: false, error: 'The campaign was not created. Nothing has been saved.' };
  } catch (e: any) {
    console.error('[mail-campaigns] createCampaign:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  await ensureCampaignSchema();
  if (!isUuid(id)) return null;
  const c = rows(await db.execute(sql`SELECT * FROM mail_campaigns WHERE id = ${id} AND engine = ${ENGINE} LIMIT 1`))[0];
  if (!c) return null;
  return { ...(c as any), audience: c.audience || {}, ab: c.ab || null, recurrence: c.recurrence || null } as Campaign;
}

export async function listCampaigns(p: { status?: string; limit?: number } = {}): Promise<(Campaign & { recipient_count: number; sent_count: number })[]> {
  await ensureCampaignSchema();
  const limit = Math.min(200, Math.max(1, p.limit || 100));
  const where = p.status && p.status !== 'any'
    ? sql`WHERE c.engine = ${ENGINE} AND c.status = ${p.status}`
    : sql`WHERE c.engine = ${ENGINE}`;
  return rows(await db.execute(sql`
    SELECT c.*,
      coalesce(r.total, 0)::int AS recipient_count,
      coalesce(r.sent, 0)::int AS sent_count
    FROM mail_campaigns c
    LEFT JOIN (
      SELECT campaign_id,
             count(*) FILTER (WHERE status <> 'skipped') AS total,
             count(*) FILTER (WHERE status IN ('sent','delivered')) AS sent
      FROM mail_campaign_recipients GROUP BY campaign_id
    ) r ON r.campaign_id = c.id
    ${where}
    ORDER BY c.created_at DESC LIMIT ${limit}
  `)) as any;
}

export interface CampaignPatch {
  name?: string;
  subject?: string;
  preheader?: string | null;
  fromName?: string | null;
  fromAddress?: string | null;
  replyTo?: string | null;
  bodyHtml?: string;
  bodyText?: string | null;
  audience?: Audience;
  ab?: AbConfig | null;
  stream?: 'campaign' | 'transactional';
}

/**
 * Edit a campaign.
 *
 * REFUSES ONCE RECIPIENTS EXIST. Changing the subject of a campaign that is half sent produces two
 * different mails under one report, and changing the audience of a queued campaign silently
 * contradicts the count an operator already confirmed. Reopen it as a draft to edit.
 */
export async function updateCampaign(id: string, p: CampaignPatch): Promise<WriteResult> {
  await ensureCampaignSchema();
  const before = await getCampaign(id);
  if (!before) return { ok: false, error: 'That campaign no longer exists. Reload the list.' };
  if (!canEditContent(before.status)) {
    return {
      ok: false,
      error: 'A ' + before.status + ' campaign cannot be edited. '
        + (before.status === 'scheduled' ? 'Unschedule it first.' : 'Reopen it as a draft to make changes.'),
    };
  }
  if (p.ab) {
    const errs = abErrors(p.ab);
    if (errs.length) return { ok: false, error: errs.join(' ') };
  }
  try {
    const wrote = rows(await db.execute(sql`
      UPDATE mail_campaigns SET
        name = ${p.name !== undefined ? String(p.name).trim() : before.name},
        subject = ${p.subject !== undefined ? p.subject : before.subject},
        preheader = ${p.preheader !== undefined ? p.preheader : before.preheader},
        from_name = ${p.fromName !== undefined ? p.fromName : before.from_name},
        from_email = ${p.fromAddress !== undefined ? p.fromAddress : before.from_email},
        reply_to = ${p.replyTo !== undefined ? p.replyTo : before.reply_to},
        body_html = ${p.bodyHtml !== undefined ? p.bodyHtml : before.body_html},
        body_text = ${p.bodyText !== undefined ? p.bodyText : before.body_text},
        audience = ${JSON.stringify(p.audience !== undefined ? p.audience : before.audience)}::jsonb,
        ab = ${p.ab !== undefined ? (p.ab ? JSON.stringify(p.ab) : null) : (before.ab ? JSON.stringify(before.ab) : null)}::jsonb,
        stream = ${p.stream !== undefined ? p.stream : before.stream},
        updated_at = now()
      WHERE id = ${id} RETURNING id
    `));
    return wrote.length ? { ok: true, id } : { ok: false, error: 'Nothing was saved: that campaign no longer exists.' };
  } catch (e: any) {
    console.error('[mail-campaigns] updateCampaign:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function deleteCampaign(id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign is already gone.' };
  if (['sending', 'queued'].includes(c.status)) return { ok: false, error: 'This campaign is mid-send. Pause and cancel it before deleting.' };
  const gone = rows(await db.execute(sql`DELETE FROM mail_campaigns WHERE id = ${id} RETURNING id`));
  return gone.length ? { ok: true } : { ok: false, error: 'That campaign is already gone.' };
}

/** Copy a draft from an existing campaign. Never copies recipients, stats or schedule. */
export async function duplicateCampaign(id: string, actor?: Actor): Promise<WriteResult> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists, so nothing was copied.' };
  const r = rows(await db.execute(sql`
    INSERT INTO mail_campaigns (name, subject, preheader, from_name, from_email, reply_to, body_html, body_text, audience, ab, engine, stream, time_zone, created_by)
    VALUES (${c.name + ' (copy)'}, ${c.subject}, ${c.preheader}, ${c.from_name}, ${c.from_email}, ${c.reply_to},
            ${c.body_html}, ${c.body_text}, ${JSON.stringify(c.audience)}::jsonb,
            ${c.ab ? JSON.stringify(c.ab) : null}::jsonb, ${ENGINE}, ${c.stream}, ${c.time_zone}, ${actor?.userId || null})
    RETURNING id
  `));
  return r[0]?.id ? { ok: true, id: r[0].id } : { ok: false, error: 'The copy was not created.' };
}

// ── state changes ──────────────────────────────────────────────────────────────────────────────

async function setStatus(id: string, from: string, action: CampaignAction, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; to?: CampaignState; error?: string }> {
  const t = campaignTransition(from, action);
  if (!t.ok) return { ok: false, error: t.error };
  // The WHERE clause repeats the expected `from`, so two concurrent requests cannot both apply a
  // transition from the same starting state. The loser gets `false` and its own refusal sentence.
  const wrote = rows(await db.execute(sql`
    UPDATE mail_campaigns SET status = ${t.to!}, updated_at = now(),
      started_at = CASE WHEN ${t.to!} = 'sending' AND started_at IS NULL THEN now() ELSE started_at END,
      completed_at = CASE WHEN ${t.to!} = 'completed' THEN now() ELSE completed_at END,
      last_error = ${(extra.error as string) || null}
    WHERE id = ${id} AND status = ${from}
    RETURNING id, status
  `));
  if (!wrote.length) {
    const now = await getCampaign(id);
    return { ok: false, error: now ? 'This campaign is now ' + now.status + ' — somebody else changed it. Reload the page.' : 'That campaign no longer exists.' };
  }
  return { ok: true, to: t.to };
}

export async function pauseCampaign(id: string, actor?: Actor): Promise<{ ok: boolean; error?: string }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  const res = await setStatus(id, c.status, 'pause');
  // WHO stopped a live send is the first question asked afterwards. This was accepting `actor` and
  // dropping it on the floor.
  if (res.ok) logEvent('warn', 'mail.campaign.paused', { campaignId: id, from: c.status, actor: actor?.name || null, userId: actor?.userId || null });
  return res;
}

export async function resumeCampaign(id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  return setStatus(id, c.status, 'resume');
}

/**
 * Cancel.
 *
 * Pending recipients are marked `skipped` so a worker that is mid-batch cannot pick them up, and so
 * the report says exactly how many people did NOT get it. Anything already sent stays sent — a
 * cancellation is not a recall, and pretending otherwise on the dashboard would be a lie.
 */
export async function cancelCampaign(id: string, actor?: Actor): Promise<{ ok: boolean; error?: string; stopped?: number }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  const res = await setStatus(id, c.status, 'cancel');
  if (!res.ok) return res;
  logEvent('warn', 'mail.campaign.cancelled', { campaignId: id, from: c.status, actor: actor?.name || null, userId: actor?.userId || null });
  const stopped = rows(await db.execute(sql`
    UPDATE mail_campaign_recipients SET status = 'skipped', skip_reason = 'cancelled', updated_at = now()
    WHERE campaign_id = ${id} AND status IN ('pending','sending') RETURNING id
  `)).length;
  return { ok: true, stopped };
}

export async function reopenCampaign(id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  const res = await setStatus(id, c.status, 'reopen');
  if (!res.ok) return res;
  // Reopening returns it to draft, so the frozen recipient set must go too — otherwise the next
  // send would reuse an audience resolved against yesterday's contact book.
  await db.execute(sql`DELETE FROM mail_campaign_recipients WHERE campaign_id = ${id}`);
  await db.execute(sql`UPDATE mail_campaigns SET confirmed_count = NULL, confirmed_at = NULL, scheduled_at = NULL WHERE id = ${id}`);
  return { ok: true };
}

// ── scheduling ─────────────────────────────────────────────────────────────────────────────────

export interface ScheduleInput {
  /** `YYYY-MM-DDTHH:MM` wall clock. */
  localTime: string;
  timeZone: string;
  recurrence?: Recurrence | null;
}

/**
 * Set (or move) a campaign's send time.
 *
 * The wall clock is resolved to a UTC instant HERE, on the server, using the operator's chosen
 * zone — see the header of mail-schedule.ts for why a browser cannot be trusted with this.
 */
export async function scheduleCampaign(id: string, p: ScheduleInput, actor?: Actor): Promise<{ ok: boolean; at?: Date; error?: string }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  if (!isValidTimeZone(p.timeZone)) return { ok: false, error: 'That time zone is not one the server recognises.' };
  const at = zonedTimeToUtc(p.localTime, p.timeZone);
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'That is not a date and time we can read.' };
  if (at.getTime() < Date.now() - 60000) return { ok: false, error: 'That time has already passed. Pick a future time, or send now.' };
  if (p.recurrence) {
    const errs = recurrenceErrors(p.recurrence);
    if (errs.length) return { ok: false, error: errs.join(' ') };
  }
  const res = await setStatus(id, c.status, 'schedule');
  if (!res.ok) return { ok: false, error: res.error };
  await db.execute(sql`
    UPDATE mail_campaigns SET scheduled_at = ${at}, time_zone = ${p.timeZone},
      recurrence = ${p.recurrence ? JSON.stringify(p.recurrence) : null}::jsonb, updated_at = now()
    WHERE id = ${id}
  `);
  logEvent('info', 'mail.campaign.scheduled', { campaignId: id, at: at.toISOString(), timeZone: p.timeZone, repeats: !!p.recurrence, actor: actor?.name || null });
  return { ok: true, at };
}

export async function unscheduleCampaign(id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  const res = await setStatus(id, c.status, 'unschedule');
  if (!res.ok) return res;
  await db.execute(sql`UPDATE mail_campaigns SET scheduled_at = NULL, recurrence = NULL WHERE id = ${id}`);
  return { ok: true };
}

// ── preview and preflight ──────────────────────────────────────────────────────────────────────

export interface CampaignPreview {
  campaign: Campaign;
  resolved: ResolvedAudience;
  recipientCount: number;
  skipLines: string[];
  preflight: ReturnType<typeof preflight>;
  sampleRendered: { email: string; subject: string; html: string; missing: string[] }[];
  transportReady: boolean;
  recentDuplicate: { id: string; name: string; hoursAgo: number } | null;
}

function hasUnsubscribeLink(html: string): boolean {
  return /\{\{\s*unsubscribe_url\s*\}\}/i.test(html) || /\/mail\/unsubscribe/i.test(html);
}

async function findRecentDuplicate(c: Campaign): Promise<{ id: string; name: string; hoursAgo: number } | null> {
  const subject = String(c.subject || '').trim();
  if (!subject) return null;
  const r = rows(await db.execute(sql`
    SELECT id, name, EXTRACT(EPOCH FROM (now() - coalesce(started_at, created_at)))/3600 AS hours
    FROM mail_campaigns
    WHERE id <> ${c.id} AND engine = ${ENGINE} AND lower(btrim(subject)) = lower(${subject})
      AND status IN ('sending','completed')
      AND coalesce(started_at, created_at) > now() - make_interval(hours => ${DUPLICATE_WINDOW_HOURS}::int)
    ORDER BY coalesce(started_at, created_at) DESC LIMIT 1
  `).catch(() => []));
  if (!r.length) return null;
  return { id: r[0].id, name: r[0].name, hoursAgo: Math.round(Number(r[0].hours) || 0) };
}

/** Everything the confirmation screen needs. Read-only: nothing here writes a recipient row. */
export async function previewCampaign(id: string, opts: { sampleSize?: number } = {}): Promise<CampaignPreview | null> {
  await ensureCampaignSchema();
  const campaign = await getCampaign(id);
  if (!campaign) return null;

  const resolved = await resolveAudience(campaign.audience, { ab: campaign.ab, salt: campaign.id });
  const cfg = await getMailConfig().catch(() => null);
  const transportReady = !!cfg?.smtpHost;
  const recentDuplicate = await findRecentDuplicate(campaign);

  const segErrs: string[] = [];
  let everyone = false;
  for (const sid of campaign.audience.segmentIds || []) {
    const seg = rows(await db.execute(sql`SELECT name, definition FROM mail_segments WHERE id = ${sid} AND definition IS NOT NULL LIMIT 1`))[0];
    if (!seg) { segErrs.push('A saved segment on this campaign no longer exists.'); continue; }
    for (const e of segmentErrors(seg.definition as SegmentNode)) segErrs.push(seg.name + ': ' + e);
    if (matchesEveryone(seg.definition as SegmentNode)) everyone = true;
  }
  if (campaign.audience.segment) {
    for (const e of segmentErrors(campaign.audience.segment)) segErrs.push(e);
    if (matchesEveryone(campaign.audience.segment)) everyone = true;
  }

  const pf = preflight({
    state: campaign.status,
    subject: campaign.subject,
    bodyHtml: campaign.body_html,
    fromAddress: campaign.from_email || '',
    recipientCount: resolved.counts.accepted,
    skipped: {
      suppressed: resolved.counts.suppressed,
      unsubscribed: resolved.counts.unsubscribed + resolved.counts.bounced + resolved.counts.complained + resolved.counts.pending,
      invalid: resolved.counts.invalid,
      duplicate: resolved.counts.duplicate,
    },
    audienceDescribed: !audienceIsEmpty(campaign.audience),
    segmentErrors: segErrs,
    matchesEveryone: everyone,
    variablesWithoutFallback: [
      ...variablesWithoutFallback(campaign.subject),
      ...variablesWithoutFallback(campaign.body_html),
    ].filter((v, i, a) => a.indexOf(v) === i),
    hasUnsubscribeLink: campaign.stream === 'transactional' ? true : hasUnsubscribeLink(campaign.body_html),
    transportReady,
    confirmedCount: campaign.confirmed_count,
    recentDuplicate,
  });

  const sampleSize = Math.min(5, Math.max(0, opts.sampleSize ?? 3));
  const sampleRendered = resolved.accepted.slice(0, sampleSize).map((c) => {
    const vars = mergeVarsForContact(c as any, {
      unsubscribe_url: unsubscribeUrl(c.contactId, c.unsub_token, campaign.id),
      view_in_browser_url: SITE_BASE + '/mail/view/' + campaign.id,
    });
    const variant = resolved.variants.get(c.email) || 'a';
    const copy = copyForVariant(campaign, variant);
    return {
      email: c.email,
      subject: renderSubject(copy.subject, vars),
      html: renderHtml(copy.bodyHtml, vars),
      missing: [...variablesWithoutFallback(copy.subject), ...variablesWithoutFallback(copy.bodyHtml)]
        .filter((v) => !vars[v])
        .filter((v, i, a) => a.indexOf(v) === i),
    };
  });

  return {
    campaign,
    resolved,
    recipientCount: resolved.counts.accepted,
    skipLines: describeSkips(resolved.counts),
    preflight: pf,
    sampleRendered,
    transportReady,
    recentDuplicate,
  };
}

/** The subject / body for one A/B variant, falling back to the campaign's own copy. */
export function copyForVariant(c: Campaign, variant: string): { subject: string; bodyHtml: string } {
  const base = { subject: c.subject, bodyHtml: c.body_html };
  if (!c.ab?.enabled || variant === HOLDBACK) return base;
  const v = (c.ab.variants || []).find((x) => x.key === variant);
  if (!v) return base;
  if (c.ab.dimension === 'subject') return { subject: v.subject || base.subject, bodyHtml: base.bodyHtml };
  if (c.ab.dimension === 'content') return { subject: base.subject, bodyHtml: v.bodyHtml || base.bodyHtml };
  // CTA: substitute the button text and href into the shared body.
  const html = base.bodyHtml
    .replace(/\{\{\s*cta_text\s*\}\}/gi, v.ctaText || '')
    .replace(/\{\{\s*cta_url\s*\}\}/gi, v.ctaUrl || '');
  return { subject: base.subject, bodyHtml: html };
}

// ── queueing ───────────────────────────────────────────────────────────────────────────────────

export interface QueueResult {
  ok: boolean;
  error?: string;
  blockers?: string[];
  warnings?: string[];
  recipientCount?: number;
  inserted?: number;
}

/**
 * Move a campaign to `queued`, materialising its recipients.
 *
 * The order matters and is the whole safety story: PREFLIGHT first (which refuses on an empty
 * audience, missing copy, a broken segment, no transport, no unsubscribe link, or an unconfirmed
 * large send), THEN the status transition (which fails if somebody else moved the campaign in the
 * meantime), THEN the recipient rows behind a unique index. A double click loses at step two or
 * three, never at step four.
 */
export async function queueCampaign(id: string, opts: { confirmedCount?: number | null; actor?: Actor; force?: boolean } = {}): Promise<QueueResult> {
  await ensureCampaignSchema();
  const pv = await previewCampaign(id);
  if (!pv) return { ok: false, error: 'That campaign no longer exists.' };

  if (opts.confirmedCount !== undefined && opts.confirmedCount !== null) {
    await db.execute(sql`UPDATE mail_campaigns SET confirmed_count = ${opts.confirmedCount}, confirmed_by = ${opts.actor?.userId || null}, confirmed_at = now() WHERE id = ${id}`);
    pv.preflight = preflight({ ...preflightInputFrom(pv), confirmedCount: opts.confirmedCount });
  }
  if (!pv.preflight.ok) {
    return { ok: false, error: pv.preflight.blockers[0], blockers: pv.preflight.blockers, warnings: pv.preflight.warnings };
  }

  const res = await setStatus(id, pv.campaign.status, 'queue');
  if (!res.ok) return { ok: false, error: res.error };

  const mat = await materializeRecipients(id, pv.resolved, (c: Candidate) => mergeVarsForContact(c as any, {
    unsubscribe_url: unsubscribeUrl(c.contactId, c.unsub_token, id),
    view_in_browser_url: SITE_BASE + '/mail/view/' + id,
  }));
  if (mat.error) {
    await setStatus(id, 'queued', 'fail', { error: mat.error });
    return { ok: false, error: 'The audience could not be written: ' + mat.error };
  }
  await logContactEvent({ kind: 'sent', campaignId: id, actor: opts.actor, detail: { queued: mat.inserted, skipped: mat.skippedRecorded } });
  return { ok: true, recipientCount: pv.recipientCount, inserted: mat.inserted, warnings: pv.preflight.warnings };
}

function preflightInputFrom(pv: CampaignPreview) {
  return {
    state: pv.campaign.status,
    subject: pv.campaign.subject,
    bodyHtml: pv.campaign.body_html,
    fromAddress: pv.campaign.from_email || '',
    recipientCount: pv.recipientCount,
    audienceDescribed: !audienceIsEmpty(pv.campaign.audience),
    hasUnsubscribeLink: pv.campaign.stream === 'transactional' ? true : hasUnsubscribeLink(pv.campaign.body_html),
    transportReady: pv.transportReady,
    recentDuplicate: pv.recentDuplicate,
  };
}

// ── the sender ─────────────────────────────────────────────────────────────────────────────────

export function unsubscribeUrl(contactId: string | null | undefined, token: string | null | undefined, campaignId?: string | null): string {
  if (!contactId || !token) return SITE_BASE + '/mail/unsubscribe';
  const q = new URLSearchParams({ c: String(contactId), t: String(token) });
  if (campaignId) q.set('k', String(campaignId));
  return SITE_BASE + '/mail/unsubscribe?' + q.toString();
}

const linkCache = new Map<string, string>();

/** A stable id for a click target, so the redirect never trusts a URL from the query string. */
async function registerLink(campaignId: string, url: string): Promise<string | null> {
  const key = campaignId + '|' + url;
  const hit = linkCache.get(key);
  if (hit) return hit;
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mail_campaign_links (campaign_id, url) VALUES (${campaignId}, ${url})
      ON CONFLICT (campaign_id, md5(url)) DO UPDATE SET url = EXCLUDED.url RETURNING id
    `));
    const id = r[0]?.id as string;
    if (id) linkCache.set(key, id);
    return id || null;
  } catch (e: any) {
    console.error('[mail-campaigns] registerLink:', dbReason(e));
    return null;
  }
}

/**
 * Rewrite trackable links and append the open pixel.
 *
 * The unsubscribe link is NEVER rewritten. Routing an opt-out through a click tracker means a
 * tracker outage becomes an inability to unsubscribe, and that is not a trade this system makes.
 */
export async function instrumentHtml(html: string, campaignId: string, recipientId: string): Promise<string> {
  let out = String(html || '');
  const hrefs = [...out.matchAll(/href\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  for (const href of [...new Set(hrefs)]) {
    if (!/^https?:\/\//i.test(href)) continue;
    if (href.includes('/mail/unsubscribe')) continue;
    const linkId = await registerLink(campaignId, href);
    if (!linkId) continue;
    const tracked = SITE_BASE + '/api/mail/c/click?r=' + encodeURIComponent(recipientId) + '&l=' + encodeURIComponent(linkId);
    out = out.split('href="' + href + '"').join('href="' + tracked + '"');
  }
  const pixel = '<img src="' + SITE_BASE + '/api/mail/c/open?r=' + encodeURIComponent(recipientId)
    + '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />';
  return out + pixel;
}

function htmlToText(h: string): string {
  return String(h || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export interface SendBatchResult {
  claimed: number;
  sent: number;
  failed: number;
  remaining: number;
  finished: boolean;
  error?: string;
}

/**
 * Send one batch for a campaign.
 *
 * The CAMPAIGN-level claim is the outer race guard: `WHERE status IN ('queued','sending') AND
 * (claimed_at IS NULL OR claimed_at < now() - 10 minutes)`. Two crons overlapping means the second
 * finds nothing to claim and returns, rather than both walking the same recipient table. The
 * recipient-level claim (FOR UPDATE SKIP LOCKED) is the inner guard for the case where a long batch
 * outlives the ten minutes.
 */
export async function sendCampaignBatch(id: string, limit = 50): Promise<SendBatchResult> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { claimed: 0, sent: 0, failed: 0, remaining: 0, finished: false, error: 'That campaign no longer exists.' };
  if (!['queued', 'sending'].includes(c.status)) {
    return { claimed: 0, sent: 0, failed: 0, remaining: 0, finished: false, error: 'This campaign is ' + c.status + ', so nothing was sent.' };
  }

  const claimed = rows(await db.execute(sql`
    UPDATE mail_campaigns SET claimed_at = now(), status = 'sending',
      started_at = coalesce(started_at, now()), updated_at = now()
    WHERE id = ${id} AND status IN ('queued','sending')
      AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')
    RETURNING id
  `));
  if (!claimed.length) {
    return { claimed: 0, sent: 0, failed: 0, remaining: await pendingCount(id), finished: false, error: 'Another run is already sending this campaign.' };
  }

  await releaseStaleClaims(id);
  const batch = await claimRecipientBatch(id, limit);
  if (!batch.length) {
    const remaining = await pendingCount(id);
    if (remaining === 0) await finishCampaign(id);
    await db.execute(sql`UPDATE mail_campaigns SET claimed_at = NULL WHERE id = ${id}`);
    return { claimed: 0, sent: 0, failed: 0, remaining, finished: remaining === 0 };
  }

  const cfg = await getMailConfig().catch(() => null);
  const fromName = c.from_name || cfg?.fromName || 'EduRankAI';
  const fromAddr = c.from_email || DEFAULT_CAMPAIGN_FROM;
  const listUnsubMailto = 'unsubscribe@' + MAIL_DOMAIN;

  let sent = 0;
  let failed = 0;
  for (const r of batch) {
    const merge = { ...(r.merge || {}) };
    const copy = copyForVariant(c, String(r.variant || 'a'));
    const subject = renderSubject(copy.subject, merge);
    const bodyHtml = renderHtml(copy.bodyHtml, merge);
    const instrumented = await instrumentHtml(bodyHtml, id, r.id);
    const text = c.body_text ? renderText(c.body_text, merge) : htmlToText(bodyHtml);
    const unsub = String(merge.unsubscribe_url || unsubscribeUrl(r.contact_id, null, id));

    const res = await sendExternal({
      from: fromName + ' <' + fromAddr + '>',
      to: r.email,
      subject,
      html: instrumented,
      text,
      replyTo: c.reply_to || undefined,
      // Campaign traffic is logged to mail_campaign_recipients / mail_campaign_events, not
      // email_logs — mixing bulk into the transactional log doubles every count on
      // /admin/mail/analytics, which is the fault that file's own header warns about.
      logToDb: false,
      headers: c.stream === 'transactional' ? { 'X-ERA-Stream': 'transactional' } : {
        'X-ERA-Stream': 'campaign',
        'X-ERA-Campaign': id,
        'List-Unsubscribe': '<' + unsub + '>, <mailto:' + listUnsubMailto + '?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Precedence': 'bulk',
      },
    });

    if (res.ok) {
      await markRecipient(r.id, 'sent', { messageRef: res.id || null });
      await recordCampaignEvent({ campaignId: id, recipientId: r.id, contactId: r.contact_id, email: r.email, kind: 'sent', variant: r.variant });
      sent++;
    } else {
      const permanent = /5\d\d|no such user|mailbox unavailable|does not exist|invalid recipient/i.test(res.error || '');
      await markRecipient(r.id, permanent ? 'bounced' : 'failed', { error: res.error || 'send failed' });
      await recordCampaignEvent({ campaignId: id, recipientId: r.id, contactId: r.contact_id, email: r.email, kind: permanent ? 'bounced' : 'deferred', variant: r.variant });
      if (permanent) await suppress(r.email, 'bounced', res.error || 'Hard bounce during campaign', id);
      failed++;
    }
  }

  await touchActivity(batch.map((b: any) => b.email));
  const remaining = await pendingCount(id);
  let finished = false;
  if (remaining === 0) {
    finished = await finishCampaign(id);
  }
  await db.execute(sql`UPDATE mail_campaigns SET claimed_at = NULL WHERE id = ${id}`);
  return { claimed: batch.length, sent, failed, remaining, finished };
}

/**
 * Close a campaign out.
 *
 * A campaign with an unpromoted A/B hold-back is NOT complete — its hold-back recipients are still
 * waiting for a winner. Marking it completed there would hide a third of the audience that never
 * received anything.
 */
async function finishCampaign(id: string): Promise<boolean> {
  const held = Number(rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM mail_campaign_recipients WHERE campaign_id = ${id} AND variant = 'hold' AND status = 'pending'
  `))[0]?.n || 0);
  if (held > 0) return false;
  const c = await getCampaign(id);
  if (!c) return false;
  const res = await setStatus(id, c.status, 'complete');
  if (res.ok && c.recurrence) await scheduleNextOccurrence(c);
  return res.ok;
}

/**
 * A recurring campaign creates its NEXT RUN as a new campaign rather than resetting itself.
 *
 * Each occurrence keeps its own recipients and its own numbers. Reusing one row would overwrite
 * last week's report every week, and "the newsletter" would have no history at all.
 */
async function scheduleNextOccurrence(c: Campaign): Promise<void> {
  if (!c.recurrence) return;
  const next = nextOccurrence(c.recurrence, new Date(), c.occurrence_no);
  if (!next) return;
  try {
    await db.execute(sql`
      INSERT INTO mail_campaigns (name, subject, preheader, from_name, from_email, reply_to, body_html, body_text,
                                  audience, ab, engine, stream, status, scheduled_at, time_zone, recurrence,
                                  recurrence_parent_id, occurrence_no, created_by)
      VALUES (${c.name}, ${c.subject}, ${c.preheader}, ${c.from_name}, ${c.from_email}, ${c.reply_to},
              ${c.body_html}, ${c.body_text}, ${JSON.stringify(c.audience)}::jsonb,
              ${c.ab ? JSON.stringify(c.ab) : null}::jsonb, ${ENGINE}, ${c.stream}, 'scheduled', ${next}, ${c.time_zone},
              ${JSON.stringify(c.recurrence)}::jsonb, ${c.recurrence_parent_id || c.id}, ${c.occurrence_no + 1}, NULL)
    `);
  } catch (e: any) {
    console.error('[mail-campaigns] could not schedule the next occurrence of ' + c.id + ':', dbReason(e));
  }
}

export interface DrainResult {
  promoted: number;
  campaignsSent: string[];
  batches: { id: string; sent: number; failed: number; remaining: number }[];
  errors: { id: string; error: string }[];
}

/**
 * The cron entry point: promote everything due, then send a batch for everything in flight.
 *
 * Deliberately does a BOUNDED amount of work per invocation — a serverless function has a wall
 * clock, and a run that is killed mid-loop must leave the queue in a state the next run can pick
 * up. It can, because both claims are in the database and stale ones are released.
 */
export async function drainDueCampaigns(opts: { batchSize?: number; maxCampaigns?: number } = {}): Promise<DrainResult> {
  await ensureCampaignSchema();
  const out: DrainResult = { promoted: 0, campaignsSent: [], batches: [], errors: [] };

  const due = rows(await db.execute(sql`
    SELECT id, scheduled_at FROM mail_campaigns
    WHERE engine = ${ENGINE} AND status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now()
    ORDER BY scheduled_at ASC LIMIT 20
  `));
  for (const d of due) {
    if (!isDue(d.scheduled_at)) continue;
    // A scheduled send is confirmed by the act of scheduling it — the operator saw and confirmed
    // the count on the schedule screen. `force` is not used: the preflight still runs and can
    // refuse (an empty audience, a transport that has since been switched off), which fails the
    // campaign loudly instead of sending something wrong on a timer.
    const cur = await getCampaign(d.id);
    const res = await queueCampaign(d.id, { confirmedCount: cur?.confirmed_count ?? null });
    if (res.ok) out.promoted++;
    else {
      out.errors.push({ id: d.id, error: res.error || 'could not be queued' });
      const c = await getCampaign(d.id);
      if (c) await setStatus(d.id, c.status, 'fail', { error: res.error });
    }
  }

  const inFlight = rows(await db.execute(sql`
    SELECT id FROM mail_campaigns WHERE engine = ${ENGINE} AND status IN ('queued','sending')
    ORDER BY coalesce(started_at, updated_at) ASC LIMIT ${Math.max(1, opts.maxCampaigns || 5)}
  `));
  for (const c of inFlight) {
    const r = await sendCampaignBatch(c.id, opts.batchSize || 50);
    if (r.error && !r.claimed) { out.errors.push({ id: c.id, error: r.error }); continue; }
    out.campaignsSent.push(c.id);
    out.batches.push({ id: c.id, sent: r.sent, failed: r.failed, remaining: r.remaining });
  }
  return out;
}

// ── events and analytics ───────────────────────────────────────────────────────────────────────

export type CampaignEventKind = 'sent' | 'delivered' | 'deferred' | 'bounced' | 'opened' | 'clicked' | 'unsubscribed' | 'complained';

export async function recordCampaignEvent(p: {
  campaignId: string;
  recipientId?: string | null;
  contactId?: string | null;
  email?: string | null;
  kind: CampaignEventKind;
  variant?: string | null;
  url?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mail_campaign_events (campaign_id, recipient_id, contact_id, email, type, variant, url, ip, user_agent)
      VALUES (${p.campaignId}, ${p.recipientId || null}, ${p.contactId || null}, ${p.email || null}, ${p.kind},
              ${p.variant || null}, ${p.url || null}, ${p.ip || null}, ${(p.userAgent || '').slice(0, 300) || null})
      ON CONFLICT DO NOTHING
    `);
  } catch (e: any) {
    console.error('[mail-campaigns] recordCampaignEvent (' + p.kind + '):', dbReason(e));
  }
}

/**
 * The dashboard numbers.
 *
 * Distinct RECIPIENTS per kind, not raw events — one person opening six times is one open. Clicks
 * count distinct recipients too, with the per-URL breakdown reported separately.
 */
export async function campaignTotals(id: string): Promise<CampaignTotals> {
  await ensureCampaignSchema();
  if (!isUuid(id)) return { ...EMPTY_TOTALS };
  const r = rows(await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM mail_campaign_recipients WHERE campaign_id = ${id} AND status <> 'skipped') AS recipients,
      (SELECT count(*)::int FROM mail_campaign_recipients WHERE campaign_id = ${id} AND status IN ('sent','delivered')) AS sent,
      (SELECT count(*)::int FROM mail_campaign_recipients WHERE campaign_id = ${id} AND status = 'delivered') AS delivered_only,
      (SELECT count(*)::int FROM mail_campaign_recipients WHERE campaign_id = ${id} AND status = 'bounced') AS bounced,
      (SELECT count(*)::int FROM mail_campaign_recipients WHERE campaign_id = ${id} AND status = 'failed') AS failed,
      (SELECT count(DISTINCT recipient_id)::int FROM mail_campaign_events WHERE campaign_id = ${id} AND type = 'opened') AS opened,
      (SELECT count(DISTINCT recipient_id)::int FROM mail_campaign_events WHERE campaign_id = ${id} AND type = 'clicked') AS clicked,
      (SELECT count(DISTINCT recipient_id)::int FROM mail_campaign_events WHERE campaign_id = ${id} AND type = 'unsubscribed') AS unsubscribed,
      (SELECT count(DISTINCT recipient_id)::int FROM mail_campaign_events WHERE campaign_id = ${id} AND type = 'complained') AS complained,
      (SELECT count(DISTINCT recipient_id)::int FROM mail_campaign_events WHERE campaign_id = ${id} AND type = 'deferred') AS deferred
  `))[0] || {};
  const sent = Number(r.sent || 0);
  return {
    recipients: Number(r.recipients || 0),
    sent,
    // WITHOUT A DELIVERY WEBHOOK, "DELIVERED" IS "ACCEPTED BY THE SERVER". Our own SMTP returns an
    // acceptance, not a mailbox confirmation. Reporting `sent` as `delivered` would be inventing a
    // signal we do not have; reporting a 0 would be worse. The dashboard says which it is.
    delivered: Number(r.delivered_only || 0) || sent,
    deferred: Number(r.deferred || 0),
    bounced: Number(r.bounced || 0),
    opened: Number(r.opened || 0),
    clicked: Number(r.clicked || 0),
    unsubscribed: Number(r.unsubscribed || 0),
    complained: Number(r.complained || 0),
    failed: Number(r.failed || 0),
  };
}

export async function variantStats(id: string): Promise<VariantStat[]> {
  await ensureCampaignSchema();
  const r = rows(await db.execute(sql`
    SELECT rp.variant,
      count(*)::int AS sent,
      count(DISTINCT ev_open.recipient_id)::int AS opened,
      count(DISTINCT ev_click.recipient_id)::int AS clicked
    FROM mail_campaign_recipients rp
    LEFT JOIN mail_campaign_events ev_open ON ev_open.recipient_id = rp.id AND ev_open.type = 'opened'
    LEFT JOIN mail_campaign_events ev_click ON ev_click.recipient_id = rp.id AND ev_click.type = 'clicked'
    WHERE rp.campaign_id = ${id} AND rp.status IN ('sent','delivered') AND rp.variant <> 'hold'
    GROUP BY rp.variant ORDER BY rp.variant
  `));
  return r.map((v: any) => ({
    key: String(v.variant),
    sent: Number(v.sent || 0),
    opened: Number(v.opened || 0),
    clicked: Number(v.clicked || 0),
    converted: Number(v.clicked || 0),
  }));
}

export async function clickBreakdown(id: string, limit = 20): Promise<{ url: string; clicks: number; recipients: number }[]> {
  await ensureCampaignSchema();
  return rows(await db.execute(sql`
    SELECT url, count(*)::int AS clicks, count(DISTINCT recipient_id)::int AS recipients
    FROM mail_campaign_events WHERE campaign_id = ${id} AND type = 'clicked' AND url IS NOT NULL
    GROUP BY url ORDER BY clicks DESC LIMIT ${limit}
  `));
}

/**
 * Send the winning variant to the held-back audience.
 *
 * REFUSES AN UNCONFIDENT RESULT unless a human overrides it explicitly. pickWinner() will always
 * name a leader — that is what the dashboard shows — but promoting a leader that sits inside the
 * margin of error is how a team spends a year "optimising" noise.
 */
export async function promoteWinner(id: string, opts: { variant?: string; override?: boolean } = {}): Promise<{ ok: boolean; error?: string; promoted?: number; key?: string }> {
  await ensureCampaignSchema();
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'That campaign no longer exists.' };
  if (!c.ab?.enabled) return { ok: false, error: 'This campaign is not an A/B test.' };

  const stats = await variantStats(id);
  const winner = pickWinner(stats, c.ab.winnerMetric);
  const key = opts.variant || winner?.key;
  if (!key) return { ok: false, error: 'No variant has been sent yet, so there is nothing to compare.' };
  if (!opts.variant && winner && !winner.confident && !opts.override) {
    return { ok: false, error: winner.reason + ' Wait for more results, or choose a variant by hand.' };
  }
  if (!(c.ab.variants || []).some((v) => v.key === key)) return { ok: false, error: 'Variant "' + key + '" is not part of this test.' };

  const promoted = rows(await db.execute(sql`
    UPDATE mail_campaign_recipients SET variant = ${key}, updated_at = now()
    WHERE campaign_id = ${id} AND variant = 'hold' AND status = 'pending' RETURNING id
  `)).length;
  await db.execute(sql`UPDATE mail_campaigns SET ab = jsonb_set(ab, '{winnerKey}', ${JSON.stringify(key)}::jsonb, true), updated_at = now() WHERE id = ${id}`);
  // The campaign may have been closed out while the hold-back waited; put it back to work.
  if (promoted > 0 && ['completed', 'paused'].includes(c.status)) {
    await db.execute(sql`UPDATE mail_campaigns SET status = 'sending', completed_at = NULL WHERE id = ${id} AND status IN ('completed','paused')`);
  }
  return { ok: true, promoted, key };
}

// ── unsubscribe ────────────────────────────────────────────────────────────────────────────────

export interface UnsubscribeResult { ok: boolean; email?: string; error?: string; already?: boolean }

/**
 * One-click unsubscribe.
 *
 * The token is the contact's own `unsub_token` — a random uuid stored on the row, checked against
 * the contact id. It carries no signature because it needs none: it is unguessable, scoped to one
 * person, and grants exactly one power (stop mailing me). A link that fails to unsubscribe somebody
 * is a compliance failure, so this path is deliberately the simplest one in the system.
 */
export async function unsubscribeByToken(contactId: string, token: string, campaignId?: string | null, meta: { ip?: string; userAgent?: string } = {}): Promise<UnsubscribeResult> {
  await ensureContactSchema();
  if (!isUuid(contactId) || !isUuid(token)) return { ok: false, error: 'That unsubscribe link is not valid. Reply to any message and we will remove you by hand.' };
  const c = rows(await db.execute(sql`SELECT id, email, status FROM mail_contacts WHERE id = ${contactId} AND unsub_token = ${token} LIMIT 1`))[0];
  if (!c) return { ok: false, error: 'That unsubscribe link is not valid. Reply to any message and we will remove you by hand.' };
  if (c.status === 'unsubscribed') return { ok: true, email: c.email, already: true };

  await suppress(c.email, 'unsubscribed', 'One-click unsubscribe' + (campaignId ? ' from a campaign' : ''), campaignId || null);
  if (campaignId && isUuid(campaignId)) {
    const rec = rows(await db.execute(sql`SELECT id, variant FROM mail_campaign_recipients WHERE campaign_id = ${campaignId} AND contact_id = ${contactId} LIMIT 1`))[0];
    await recordCampaignEvent({
      campaignId, recipientId: rec?.id || null, contactId, email: c.email,
      kind: 'unsubscribed', variant: rec?.variant || null, ip: meta.ip, userAgent: meta.userAgent,
    });
  }
  // Every other campaign that has this person queued must stop now, not at the end of the batch.
  await db.execute(sql`
    UPDATE mail_campaign_recipients SET status = 'skipped', skip_reason = 'unsubscribed', updated_at = now()
    WHERE contact_id = ${contactId} AND status = 'pending'
  `).catch((e: any) => console.error('[mail-campaigns] could not clear queued sends after unsubscribe:', dbReason(e)));
  return { ok: true, email: c.email };
}

/** Resolve a click token to its campaign, recipient and destination. Never trusts a URL parameter. */
export async function resolveClick(recipientId: string, linkId: string): Promise<{ url: string; campaignId: string; contactId: string | null; email: string; variant: string } | null> {
  await ensureCampaignSchema();
  if (!isUuid(recipientId) || !isUuid(linkId)) return null;
  const r = rows(await db.execute(sql`
    SELECT rp.campaign_id, rp.contact_id, rp.email, rp.variant, l.url
    FROM mail_campaign_recipients rp
    JOIN mail_campaign_links l ON l.id = ${linkId} AND l.campaign_id = rp.campaign_id
    WHERE rp.id = ${recipientId} LIMIT 1
  `))[0];
  if (!r) return null;
  return { url: String(r.url), campaignId: r.campaign_id, contactId: r.contact_id, email: r.email, variant: r.variant };
}

/**
 * Where a click token points, WITHOUT a recipient.
 *
 * The fallback for a recipient row that has been deleted (a campaign purged, a contact removed)
 * while the mail is still in somebody's inbox. The reader wanted the page; losing our analytics is
 * not a reason to show them an error. Still id-based, so it is still not an open redirect.
 */
export async function linkDestination(linkId: string): Promise<string | null> {
  await ensureCampaignSchema();
  if (!isUuid(linkId)) return null;
  const r = rows(await db.execute(sql`SELECT url FROM mail_campaign_links WHERE id = ${linkId} LIMIT 1`))[0];
  return r ? String(r.url) : null;
}

export async function recipientForTracking(recipientId: string): Promise<{ campaignId: string; contactId: string | null; email: string; variant: string } | null> {
  await ensureCampaignSchema();
  if (!isUuid(recipientId)) return null;
  const r = rows(await db.execute(sql`SELECT campaign_id, contact_id, email, variant FROM mail_campaign_recipients WHERE id = ${recipientId} LIMIT 1`))[0];
  return r ? { campaignId: r.campaign_id, contactId: r.contact_id, email: r.email, variant: r.variant } : null;
}

// ── recipient report ───────────────────────────────────────────────────────────────────────────

export async function campaignRecipients(id: string, p: { status?: string; limit?: number; offset?: number } = {}): Promise<{ rows: any[]; total: number }> {
  await ensureCampaignSchema();
  if (!isUuid(id)) return { rows: [], total: 0 };
  const where = p.status && p.status !== 'any'
    ? sql`campaign_id = ${id} AND status = ${p.status}`
    : sql`campaign_id = ${id}`;
  const total = Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM mail_campaign_recipients WHERE ${where}`))[0]?.n || 0);
  const list = rows(await db.execute(sql`
    SELECT id, email, contact_id, variant, status, skip_reason, error, sent_at
    FROM mail_campaign_recipients WHERE ${where}
    ORDER BY created_at ASC LIMIT ${Math.min(500, p.limit || 100)} OFFSET ${Math.max(0, p.offset || 0)}
  `));
  return { rows: list, total };
}

/** Contacts a campaign is about to reach, for the confirmation screen's "who exactly?" link. */
export async function campaignAudienceSummary(a: Audience): Promise<string[]> {
  await ensureContactSchema();
  const out: string[] = [];
  const listIds = (a.listIds || []).filter(isUuid);
  if (listIds.length) {
    const names = rows(await db.execute(sql`SELECT name FROM mail_lists WHERE id IN ${uuidIn(listIds)}`)).map((r: any) => r.name);
    if (names.length) out.push('Lists: ' + names.join(', '));
  }
  const segIds = (a.segmentIds || []).filter(isUuid);
  if (segIds.length) {
    const names = rows(await db.execute(sql`SELECT name FROM mail_segments WHERE id IN ${uuidIn(segIds)}`)).map((r: any) => r.name);
    if (names.length) out.push('Segments: ' + names.join(', '));
  }
  if ((a.contactIds || []).length) out.push((a.contactIds || []).length + ' individually chosen contacts');
  const exList = (a.excludeListIds || []).filter(isUuid);
  if (exList.length) {
    const names = rows(await db.execute(sql`SELECT name FROM mail_lists WHERE id IN ${uuidIn(exList)}`)).map((r: any) => r.name);
    if (names.length) out.push('Excluding lists: ' + names.join(', '));
  }
  return out;
}

export { LARGE_CAMPAIGN_THRESHOLD };

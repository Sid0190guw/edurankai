// src/lib/mail-product/campaigns.ts — campaign lifecycle, audience materialisation and dispatch.
//
// WHERE THE LINE IS. This module does NOT own delivery. It builds the per-recipient rows, holds the
// state machine, and hands each message to sendExternal() in src/lib/mail-transport.ts — the existing
// transport, unchanged, still the only thing in this repository that opens an SMTP connection.
// Nothing here reconfigures a transport, retries at the protocol level, or writes email_logs itself.
//
// THE STATUS ON SCREEN IS THE STATUS OF THE BYTES. A campaign is 'completed' only when every
// recipient row has left 'queued'. A recipient is 'sent' only when sendExternal() returned ok. When
// there is no transport configured at all, dispatch REFUSES and says so, and the campaign goes to
// 'failed' — it does not sit in 'sending' looking busy, and it never reports 'completed' with zero
// messages out. This project has already shipped one screen that claimed a status it never sent.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { sendExternal } from '@/lib/mail-transport';
import { getMailConfig } from '@/lib/mail';
import { ensureMailProductSchema, canTransition, CAMPAIGN_STATUSES, type CampaignStatus } from './schema';
import { audienceSql, coerceRules, type SegmentRules } from './contacts';
import { renderDocument, coerceDocument } from './blocks';
import { personalizeMessage } from './personalize';
import { rowsOf, reasonOf, isUuid, str, clampInt, htmlToText } from './common';

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  template_id: string | null;
  blocks: unknown;
  body_html: string;
  body_text: string | null;
  status: CampaignStatus;
  list_ids: string[];
  segment_id: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  recipients_total: number;
  sent_count: number;
  failed_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The label and tone for each state. One table, so the list badge and the detail header agree. */
export const STATUS_WORDING: Record<CampaignStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; detail: string }> = {
  draft: { label: 'Draft', tone: 'muted', detail: 'Not scheduled and not sent. Nobody has received this.' },
  scheduled: { label: 'Scheduled', tone: 'info', detail: 'Waiting for its send time. Cancel or edit until then.' },
  queued: { label: 'Queued', tone: 'info', detail: 'The recipient list is built and dispatch has not started yet.' },
  sending: { label: 'Sending', tone: 'warn', detail: 'Messages are going out now. The counts below update as they do.' },
  completed: { label: 'Completed', tone: 'ok', detail: 'Every recipient has been attempted. Failures, if any, are counted separately.' },
  paused: { label: 'Paused', tone: 'warn', detail: 'Dispatch stopped part-way. Nobody already sent to will be sent to again.' },
  cancelled: { label: 'Cancelled', tone: 'muted', detail: 'Stopped for good. Anything already sent has still been sent.' },
  failed: { label: 'Failed', tone: 'bad', detail: 'Dispatch could not run. The reason is recorded on the campaign.' },
};

export async function listCampaigns(opts: { status?: string; q?: string; limit?: number } = {}): Promise<Campaign[]> {
  await ensureMailProductSchema();
  let where = sql`TRUE`;
  if (opts.status && CAMPAIGN_STATUSES.includes(opts.status as CampaignStatus)) {
    where = sql`${where} AND status = ${opts.status}`;
  }
  if (opts.q) {
    const like = '%' + opts.q.toLowerCase().slice(0, 120) + '%';
    where = sql`${where} AND (lower(name) LIKE ${like} OR lower(subject) LIKE ${like})`;
  }
  const r = await db.execute(sql`
    SELECT * FROM mail_campaigns WHERE ${where}
    ORDER BY updated_at DESC LIMIT ${clampInt(opts.limit, 1, 200, 60)}`);
  return rowsOf<Campaign>(r);
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  if (!isUuid(id)) return null;
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT * FROM mail_campaigns WHERE id = ${id} LIMIT 1`);
  return rowsOf<Campaign>(r)[0] || null;
}

export async function createCampaign(input: { name: string; subject?: string; createdBy?: string | null }): Promise<string | null> {
  await ensureMailProductSchema();
  const cfg = await getMailConfig().catch(() => null);
  const r = await db.execute(sql`
    INSERT INTO mail_campaigns (name, subject, from_name, from_email, created_by)
    VALUES (${str(input.name, 160) || 'Untitled campaign'}, ${str(input.subject, 300)},
            ${cfg?.fromName || null}, ${cfg?.fromAddress || null},
            ${isUuid(input.createdBy || '') ? input.createdBy : null})
    RETURNING id`);
  return rowsOf(r)[0]?.id ?? null;
}

export interface CampaignPatch {
  name?: string; subject?: string; preheader?: string;
  fromName?: string; fromEmail?: string; replyTo?: string;
  templateId?: string | null; listIds?: string[]; segmentId?: string | null;
  blocks?: unknown; scheduledAt?: string | null;
}

/**
 * Edit a campaign.
 *
 * ONLY WHILE IT IS EDITABLE. Once a campaign is queued, sending, completed or cancelled its content
 * is frozen: a subject line that changed half-way through a send means two different messages went
 * out under one report, and the report would be describing neither of them.
 */
export async function updateCampaign(id: string, p: CampaignPatch): Promise<{ ok: boolean; error?: string }> {
  if (!isUuid(id)) return { ok: false, error: 'Unknown campaign.' };
  await ensureMailProductSchema();
  const current = await getCampaign(id);
  if (!current) return { ok: false, error: 'Unknown campaign.' };
  if (!['draft', 'scheduled', 'failed'].includes(current.status)) {
    return { ok: false, error: `A ${STATUS_WORDING[current.status].label.toLowerCase()} campaign cannot be edited. Duplicate it instead — the report has to keep describing what actually went out.` };
  }

  // Blocks and the rendered HTML are written together, from the ONE renderer, so the stored HTML is
  // never a stale copy of a document somebody has since edited.
  let bodyHtml = current.body_html;
  let bodyText = current.body_text;
  let blocksJson: string | null = null;
  if (p.blocks !== undefined) {
    const doc = coerceDocument(p.blocks);
    if (p.preheader !== undefined) doc.settings = { ...(doc.settings || {}), preheader: str(p.preheader, 200) };
    const out = renderDocument(doc);
    bodyHtml = out.html;
    bodyText = out.text;
    blocksJson = JSON.stringify(doc);
  }

  const sched = p.scheduledAt ? new Date(p.scheduledAt) : null;
  if (p.scheduledAt && (!sched || Number.isNaN(sched.getTime()))) return { ok: false, error: 'That send time could not be read.' };

  try {
    await db.execute(sql`
      UPDATE mail_campaigns SET
        name = COALESCE(${p.name !== undefined ? str(p.name, 160) : null}, name),
        subject = COALESCE(${p.subject !== undefined ? str(p.subject, 300) : null}, subject),
        preheader = COALESCE(${p.preheader !== undefined ? str(p.preheader, 200) : null}, preheader),
        from_name = COALESCE(${p.fromName !== undefined ? str(p.fromName, 120) : null}, from_name),
        from_email = COALESCE(${p.fromEmail !== undefined ? str(p.fromEmail, 200) : null}, from_email),
        reply_to = COALESCE(${p.replyTo !== undefined ? str(p.replyTo, 200) : null}, reply_to),
        template_id = ${p.templateId !== undefined ? (isUuid(p.templateId || '') ? p.templateId : null) : sql`template_id`},
        segment_id = ${p.segmentId !== undefined ? (isUuid(p.segmentId || '') ? p.segmentId : null) : sql`segment_id`},
        list_ids = ${p.listIds !== undefined
          ? sql`(SELECT COALESCE(array_agg(t.x::uuid), '{}') FROM jsonb_array_elements_text(${JSON.stringify((p.listIds || []).filter(isUuid))}::jsonb) AS t(x))`
          : sql`list_ids`},
        blocks = ${blocksJson !== null ? sql`${blocksJson}::jsonb` : sql`blocks`},
        body_html = ${blocksJson !== null ? bodyHtml : sql`body_html`},
        body_text = ${blocksJson !== null ? bodyText : sql`body_text`},
        scheduled_at = ${p.scheduledAt !== undefined ? (sched ? sched.toISOString() : null) : sql`scheduled_at`},
        updated_at = now()
      WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    console.error('[mail-product] campaign update failed:', reasonOf(e));
    return { ok: false, error: 'This campaign was NOT saved: ' + reasonOf(e) };
  }
}

/** Who this campaign would go to, right now. The number the confirmation screen shows. */
export async function campaignAudienceCount(c: Campaign): Promise<number> {
  const rules = await loadSegmentRules(c.segment_id);
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM mail_contacts c WHERE ${audienceSql(c.list_ids || [], rules)}`);
  return Number(rowsOf(r)[0]?.n ?? 0);
}

async function loadSegmentRules(segmentId: string | null): Promise<SegmentRules | null> {
  if (!segmentId || !isUuid(segmentId)) return null;
  const r = await db.execute(sql`SELECT rules FROM mail_segments WHERE id = ${segmentId} LIMIT 1`);
  const row = rowsOf(r)[0];
  return row ? coerceRules(row.rules) : null;
}

/**
 * Freeze the audience into mail_campaign_recipients.
 *
 * THE LIST IS TAKEN ONCE, AT QUEUE TIME. A campaign that re-evaluated its segment on every dispatch
 * batch would mail people who joined half-way through and skip people who were removed, and neither
 * the operator nor the report could say who it actually went to. The UNIQUE index on
 * (campaign_id, lower(email)) makes this re-runnable: a retried queue adds nobody twice.
 */
export async function materialiseRecipients(campaignId: string): Promise<{ total: number; error?: string }> {
  const c = await getCampaign(campaignId);
  if (!c) return { total: 0, error: 'Unknown campaign.' };
  const rules = await loadSegmentRules(c.segment_id);
  try {
    await db.execute(sql`
      INSERT INTO mail_campaign_recipients (campaign_id, contact_id, email)
      SELECT ${campaignId}::uuid, c.id, c.email FROM mail_contacts c
      WHERE ${audienceSql(c.list_ids || [], rules)}
      ON CONFLICT (campaign_id, lower(email)) DO NOTHING`);
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM mail_campaign_recipients WHERE campaign_id = ${campaignId}`);
    const total = Number(rowsOf(r)[0]?.n ?? 0);
    await db.execute(sql`UPDATE mail_campaigns SET recipients_total = ${total}, updated_at = now() WHERE id = ${campaignId}`);
    return { total };
  } catch (e: any) {
    console.error('[mail-product] materialise failed:', reasonOf(e));
    return { total: 0, error: reasonOf(e) };
  }
}

/** Move a campaign through the state machine, refusing anything the machine does not allow. */
export async function setStatus(id: string, to: CampaignStatus, extra: { error?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const c = await getCampaign(id);
  if (!c) return { ok: false, error: 'Unknown campaign.' };
  if (c.status === to) return { ok: true };
  if (!canTransition(c.status, to)) {
    return { ok: false, error: `A ${STATUS_WORDING[c.status].label.toLowerCase()} campaign cannot become ${STATUS_WORDING[to].label.toLowerCase()}.` };
  }
  try {
    await db.execute(sql`
      UPDATE mail_campaigns SET status = ${to},
        started_at = CASE WHEN ${to} = 'sending' AND started_at IS NULL THEN now() ELSE started_at END,
        completed_at = CASE WHEN ${to} IN ('completed','cancelled') THEN now() ELSE completed_at END,
        last_error = ${extra.error ? str(extra.error, 1000) : null},
        updated_at = now()
      WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

export interface DispatchResult {
  ok: boolean;
  attempted: number;
  sent: number;
  failed: number;
  remaining: number;
  status: CampaignStatus;
  error?: string;
}

/**
 * Send ONE BATCH and return. The caller (the sending screen, or a cron) calls again while
 * `remaining > 0`.
 *
 * BATCHED ON PURPOSE. A serverless request has a wall-clock limit; a loop over fifty thousand
 * recipients inside one request is a loop that gets killed part-way with no record of where it got
 * to. Each recipient row is claimed with UPDATE … RETURNING before its message is built, so two
 * concurrent dispatchers cannot both claim the same person.
 */
export async function dispatchBatch(campaignId: string, batchSize = 25): Promise<DispatchResult> {
  await ensureMailProductSchema();
  const c = await getCampaign(campaignId);
  if (!c) return { ok: false, attempted: 0, sent: 0, failed: 0, remaining: 0, status: 'failed', error: 'Unknown campaign.' };

  if (!['queued', 'sending'].includes(c.status)) {
    return { ok: false, attempted: 0, sent: 0, failed: 0, remaining: 0, status: c.status,
      error: `This campaign is ${STATUS_WORDING[c.status].label.toLowerCase()}, so nothing was dispatched.` };
  }

  // REFUSE BEFORE CLAIMING ANYTHING. Without a transport, every message would fail and the recipient
  // rows would be burnt: they are marked 'failed' and a retry would skip them. Checked first, so a
  // misconfigured system leaves the queue exactly as it was.
  const cfg = await getMailConfig().catch(() => null);
  if (!cfg?.smtpHost) {
    await setStatus(campaignId, 'failed', { error: 'No SMTP transport is configured, so no message could be sent. Nothing has been dispatched and every recipient is still queued. Set the mail server in Mail Settings and queue this campaign again.' });
    return { ok: false, attempted: 0, sent: 0, failed: 0, remaining: c.recipients_total - c.sent_count, status: 'failed',
      error: 'No SMTP transport is configured. Nothing was sent and the queue is untouched.' };
  }

  if (c.status === 'queued') await setStatus(campaignId, 'sending');

  const size = clampInt(batchSize, 1, 100, 25);
  // Claim, then send. SKIP LOCKED so a second dispatcher takes different rows instead of blocking.
  const claimed = rowsOf(await db.execute(sql`
    UPDATE mail_campaign_recipients SET status = 'sending'
    WHERE id IN (
      SELECT r.id FROM mail_campaign_recipients r
      WHERE r.campaign_id = ${campaignId} AND r.status = 'queued'
      ORDER BY r.created_at ASC LIMIT ${size} FOR UPDATE SKIP LOCKED
    )
    RETURNING id, contact_id, email`));

  const from = c.from_email
    ? (c.from_name ? `${c.from_name} <${c.from_email}>` : c.from_email)
    : (cfg.fromName ? `${cfg.fromName} <${cfg.fromAddress}>` : String(cfg.fromAddress || ''));

  let sent = 0;
  let failed = 0;

  for (const row of claimed) {
    const contact = row.contact_id
      ? rowsOf(await db.execute(sql`SELECT email, first_name, last_name, fields FROM mail_contacts WHERE id = ${row.contact_id} LIMIT 1`))[0]
      : { email: row.email, first_name: null, last_name: null, fields: {} };

    const merged = personalizeMessage(
      { subject: c.subject, html: c.body_html, text: c.body_text || htmlToText(c.body_html) },
      {
        contact,
        campaignName: c.name,
        // A one-click opt-out that actually resolves. /mail/unsubscribe is a public route.
        unsubscribeUrl: `https://edurankai.in/mail/unsubscribe?c=${encodeURIComponent(String(row.contact_id || ''))}&k=${encodeURIComponent(campaignId)}`,
        missing: 'blank',
      },
    );

    let ok = false;
    let error: string | null = null;
    let messageId: string | null = null;
    try {
      const res = await sendExternal({
        from,
        to: row.email,
        subject: merged.subject,
        html: merged.html,
        text: merged.text,
        replyTo: c.reply_to || undefined,
        // One email_logs row per recipient would double every count on /admin/mail/analytics, which
        // reads that table for the transactional path. Campaign delivery is recorded in
        // mail_campaign_events, which is what the campaign report reads.
        logToDb: false,
      });
      ok = !!res.ok;
      error = res.error || null;
      messageId = res.id || null;
    } catch (e: any) {
      ok = false;
      error = reasonOf(e);
    }

    if (ok) sent++; else failed++;

    await db.execute(sql`
      UPDATE mail_campaign_recipients
      SET status = ${ok ? 'sent' : 'failed'}, message_id = ${messageId}, error = ${error ? str(error, 500) : null},
          sent_at = ${ok ? sql`now()` : sql`NULL`}
      WHERE id = ${row.id}`).catch((e: any) => console.error('[mail-product] recipient update:', reasonOf(e)));

    await db.execute(sql`
      INSERT INTO mail_campaign_events (campaign_id, contact_id, email, type, meta)
      VALUES (${campaignId}, ${row.contact_id || null}, ${row.email}, ${ok ? 'sent' : 'failed'},
              ${JSON.stringify(error ? { error: str(error, 300) } : {})}::jsonb)
    `).catch((e: any) => console.error('[mail-product] event insert:', reasonOf(e)));
  }

  await db.execute(sql`
    UPDATE mail_campaigns SET sent_count = sent_count + ${sent}, failed_count = failed_count + ${failed}, updated_at = now()
    WHERE id = ${campaignId}`).catch(() => {});

  const remaining = Number(rowsOf(await db.execute(sql`
    SELECT count(*)::int AS n FROM mail_campaign_recipients
    WHERE campaign_id = ${campaignId} AND status IN ('queued','sending')`))[0]?.n ?? 0);

  let status: CampaignStatus = 'sending';
  if (remaining === 0) {
    // 'completed' means every row was attempted — it does not mean every row succeeded, and the
    // report says so with a separate failed count rather than folding the two together.
    await setStatus(campaignId, 'completed');
    status = 'completed';
  }

  return { ok: true, attempted: claimed.length, sent, failed, remaining, status };
}

/** Per-campaign counts for the report screen — one grouped statement, never a per-event read. */
export async function campaignStats(campaignId: string): Promise<Record<string, number>> {
  if (!isUuid(campaignId)) return {};
  await ensureMailProductSchema();
  const r = await db.execute(sql`
    SELECT type, count(*)::int AS n FROM mail_campaign_events WHERE campaign_id = ${campaignId} GROUP BY type`);
  const out: Record<string, number> = {};
  for (const row of rowsOf(r)) out[String(row.type)] = Number(row.n) || 0;
  return out;
}

/** Sent / opened / clicked per day, for the report's chart. Aggregated in Postgres. */
export async function campaignSeries(campaignId: string, days = 14): Promise<{ day: string; type: string; n: number }[]> {
  if (!isUuid(campaignId)) return [];
  const r = await db.execute(sql`
    SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
           type, count(*)::int AS n
    FROM mail_campaign_events
    WHERE campaign_id = ${campaignId} AND created_at > now() - (${clampInt(days, 1, 90, 14)} || ' days')::interval
    GROUP BY 1, 2 ORDER BY 1 ASC`);
  return rowsOf(r);
}

/**
 * A test send: the real renderer, the real transport, one address, and NO campaign rows written.
 * That last part matters — a test that counted towards the report would corrupt the report.
 */
export async function sendTest(campaignId: string, to: string): Promise<{ ok: boolean; error?: string }> {
  const c = await getCampaign(campaignId);
  if (!c) return { ok: false, error: 'Unknown campaign.' };
  const cfg = await getMailConfig().catch(() => null);
  if (!cfg?.smtpHost) return { ok: false, error: 'No SMTP transport is configured, so the test could not be sent. Nothing left this system.' };

  const merged = personalizeMessage(
    { subject: '[TEST] ' + c.subject, html: c.body_html, text: c.body_text || htmlToText(c.body_html) },
    { contact: { email: to, first_name: 'Test', last_name: 'Recipient', fields: {} }, campaignName: c.name,
      unsubscribeUrl: 'https://edurankai.in/mail/unsubscribe', missing: 'sample' },
  );

  const from = c.from_email
    ? (c.from_name ? `${c.from_name} <${c.from_email}>` : c.from_email)
    : String(cfg.fromAddress || '');

  try {
    const res = await sendExternal({ from, to, subject: merged.subject, html: merged.html, text: merged.text, replyTo: c.reply_to || undefined });
    return res.ok ? { ok: true } : { ok: false, error: res.error || 'The transport refused it and gave no reason.' };
  } catch (e: any) {
    return { ok: false, error: reasonOf(e) };
  }
}

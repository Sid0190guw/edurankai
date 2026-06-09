// Advanced mail features layered on top of the core self-hosted stack:
// per-user signatures, scheduled send, labels, inbound rules/filters, and
// link-click tracking for campaign analytics. Isolated here so the large
// mail.ts stays untouched. All tables self-bootstrap.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }
async function ex(q: any) { try { await db.execute(q); } catch (_) { /* idempotent */ } }

let ready: Promise<void> | null = null;
export function ensureMailAdvancedSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await ex(sql`CREATE TABLE IF NOT EXISTS mail_user_prefs (
      user_id UUID PRIMARY KEY,
      signature_html TEXT,
      signature_on BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await ex(sql`CREATE TABLE IF NOT EXISTS mail_scheduled (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      to_list TEXT, cc_list TEXT, bcc_list TEXT,
      subject TEXT, body_html TEXT, body_text TEXT,
      thread_id UUID, in_reply_to TEXT,
      scheduled_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'scheduled',
      sent_message_id UUID, error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await ex(sql`CREATE INDEX IF NOT EXISTS mail_sched_due_idx ON mail_scheduled(status, scheduled_at)`);
    await ex(sql`CREATE TABLE IF NOT EXISTS mail_labels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      name VARCHAR(80) NOT NULL,
      color VARCHAR(16) NOT NULL DEFAULT '#67e8f9',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, name)
    )`);
    await ex(sql`CREATE TABLE IF NOT EXISTS mail_message_labels (
      message_id UUID NOT NULL,
      label_id UUID NOT NULL,
      user_id UUID NOT NULL,
      PRIMARY KEY (message_id, label_id)
    )`);
    await ex(sql`CREATE TABLE IF NOT EXISTS mail_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      match_field VARCHAR(16) NOT NULL DEFAULT 'from',   -- from | to | subject | body
      match_op VARCHAR(16) NOT NULL DEFAULT 'contains',  -- contains | equals | startswith | endswith
      match_value TEXT NOT NULL,
      action VARCHAR(16) NOT NULL DEFAULT 'label',        -- label | folder | star | read
      action_value TEXT,                                  -- label name / folder key
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await ex(sql`CREATE TABLE IF NOT EXISTS mail_link_clicks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id UUID NOT NULL,
      url TEXT NOT NULL,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip VARCHAR(64), user_agent VARCHAR(300)
    )`);
    await ex(sql`CREATE INDEX IF NOT EXISTS mail_click_msg_idx ON mail_link_clicks(message_id)`);
  })();
  return ready;
}

// ---------- signatures ----------
export async function getSignature(userId: string): Promise<{ html: string; on: boolean }> {
  await ensureMailAdvancedSchema();
  const r = rows(await db.execute(sql`SELECT signature_html, signature_on FROM mail_user_prefs WHERE user_id = ${userId} LIMIT 1`))[0];
  return { html: r?.signature_html || '', on: r ? r.signature_on !== false : true };
}
export async function setSignature(userId: string, html: string, on: boolean): Promise<void> {
  await ensureMailAdvancedSchema();
  await db.execute(sql`
    INSERT INTO mail_user_prefs (user_id, signature_html, signature_on, updated_at)
    VALUES (${userId}, ${html}, ${on}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET signature_html = EXCLUDED.signature_html, signature_on = EXCLUDED.signature_on, updated_at = NOW()
  `);
}

// ---------- scheduled send ----------
export async function scheduleMessage(opts: {
  userId: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string;
  bodyHtml: string; bodyText: string; threadId?: string | null; inReplyTo?: string | null; scheduledAt: Date;
}): Promise<string> {
  await ensureMailAdvancedSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO mail_scheduled (user_id, to_list, cc_list, bcc_list, subject, body_html, body_text, thread_id, in_reply_to, scheduled_at)
    VALUES (${opts.userId}, ${(opts.to || []).join(', ')}, ${(opts.cc || []).join(', ')}, ${(opts.bcc || []).join(', ')},
      ${opts.subject}, ${opts.bodyHtml}, ${opts.bodyText}, ${opts.threadId || null}, ${opts.inReplyTo || null}, ${opts.scheduledAt.toISOString()})
    RETURNING id`));
  return r[0]?.id;
}
export async function dueScheduled(limit = 50): Promise<any[]> {
  await ensureMailAdvancedSchema();
  return rows(await db.execute(sql`
    SELECT * FROM mail_scheduled WHERE status = 'scheduled' AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC LIMIT ${limit}`));
}
export async function markScheduled(id: string, status: 'sent' | 'failed', sentMessageId?: string, error?: string): Promise<void> {
  await db.execute(sql`UPDATE mail_scheduled SET status = ${status}, sent_message_id = ${sentMessageId || null}, error = ${error || null} WHERE id = ${id}`);
}
export async function listScheduled(userId: string): Promise<any[]> {
  await ensureMailAdvancedSchema();
  return rows(await db.execute(sql`SELECT id, to_list, subject, scheduled_at, status, error FROM mail_scheduled WHERE user_id = ${userId} ORDER BY scheduled_at DESC LIMIT 100`));
}
export async function cancelScheduled(userId: string, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM mail_scheduled WHERE id = ${id} AND user_id = ${userId} AND status = 'scheduled'`);
}

// ---------- labels ----------
export async function listLabels(userId: string): Promise<any[]> {
  await ensureMailAdvancedSchema();
  return rows(await db.execute(sql`SELECT id, name, color FROM mail_labels WHERE user_id = ${userId} ORDER BY name ASC`));
}
export async function createLabel(userId: string, name: string, color: string): Promise<void> {
  await ensureMailAdvancedSchema();
  await db.execute(sql`INSERT INTO mail_labels (user_id, name, color) VALUES (${userId}, ${name.slice(0, 80)}, ${color || '#67e8f9'}) ON CONFLICT (user_id, name) DO UPDATE SET color = EXCLUDED.color`);
}
export async function deleteLabel(userId: string, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM mail_message_labels WHERE label_id = ${id} AND user_id = ${userId}`).catch(() => {});
  await db.execute(sql`DELETE FROM mail_labels WHERE id = ${id} AND user_id = ${userId}`);
}
export async function setMessageLabel(userId: string, messageId: string, labelId: string, on: boolean): Promise<void> {
  await ensureMailAdvancedSchema();
  if (on) await db.execute(sql`INSERT INTO mail_message_labels (message_id, label_id, user_id) VALUES (${messageId}, ${labelId}, ${userId}) ON CONFLICT DO NOTHING`).catch(() => {});
  else await db.execute(sql`DELETE FROM mail_message_labels WHERE message_id = ${messageId} AND label_id = ${labelId} AND user_id = ${userId}`).catch(() => {});
}

// ---------- inbound rules ----------
export async function listRules(userId: string): Promise<any[]> {
  await ensureMailAdvancedSchema();
  return rows(await db.execute(sql`SELECT id, match_field, match_op, match_value, action, action_value, is_active, sort_order FROM mail_rules WHERE user_id = ${userId} ORDER BY sort_order ASC, created_at ASC`));
}
export async function createRule(userId: string, r: { matchField: string; matchOp: string; matchValue: string; action: string; actionValue: string }): Promise<void> {
  await ensureMailAdvancedSchema();
  await db.execute(sql`INSERT INTO mail_rules (user_id, match_field, match_op, match_value, action, action_value)
    VALUES (${userId}, ${r.matchField}, ${r.matchOp}, ${r.matchValue}, ${r.action}, ${r.actionValue || null})`);
}
export async function deleteRule(userId: string, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM mail_rules WHERE id = ${id} AND user_id = ${userId}`);
}
function ruleMatches(op: string, hay: string, needle: string): boolean {
  hay = (hay || '').toLowerCase(); needle = (needle || '').toLowerCase();
  if (op === 'equals') return hay === needle;
  if (op === 'startswith') return hay.indexOf(needle) === 0;
  if (op === 'endswith') return needle.length > 0 && hay.lastIndexOf(needle) === hay.length - needle.length;
  return hay.indexOf(needle) !== -1; // contains
}
// Apply a recipient's rules to a newly-delivered inbound message. Returns the
// actions taken (label names / folder / flags) so the caller can persist them.
export async function applyRules(userId: string, msg: { from: string; to: string; subject: string; body: string; messageId: string }): Promise<{ labels: string[]; folder?: string; star?: boolean; read?: boolean }> {
  const out: { labels: string[]; folder?: string; star?: boolean; read?: boolean } = { labels: [] };
  let rls: any[] = [];
  try { rls = await listRules(userId); } catch (_) { return out; }
  for (const r of rls) {
    if (!r.is_active) continue;
    const field = r.match_field === 'to' ? msg.to : r.match_field === 'subject' ? msg.subject : r.match_field === 'body' ? msg.body : msg.from;
    if (!ruleMatches(r.match_op, field || '', r.match_value)) continue;
    if (r.action === 'folder' && r.action_value) out.folder = r.action_value;
    else if (r.action === 'star') out.star = true;
    else if (r.action === 'read') out.read = true;
    else if (r.action === 'label' && r.action_value) {
      out.labels.push(r.action_value);
      try {
        await createLabel(userId, r.action_value, '#a78bfa');
        const lid = rows(await db.execute(sql`SELECT id FROM mail_labels WHERE user_id = ${userId} AND name = ${r.action_value} LIMIT 1`))[0]?.id;
        if (lid) await setMessageLabel(userId, msg.messageId, lid, true);
      } catch (_) {}
    }
  }
  return out;
}

// ---------- click tracking ----------
// Rewrite every http(s) link in the HTML through the click redirector so opens
// AND clicks are measurable. The pixel (added elsewhere) covers opens.
export function rewriteLinksForTracking(html: string, messageId: string, base = 'https://edurankai.in'): string {
  if (!html || !messageId) return html;
  return html.replace(/href\s*=\s*("|')(https?:\/\/[^"']+)\1/gi, (_m, q, url) => {
    const enc = encodeURIComponent(url);
    return 'href=' + q + base + '/api/mail/click/' + messageId + '?u=' + enc + q;
  });
}
export async function recordClick(messageId: string, url: string, ip?: string, ua?: string): Promise<void> {
  await ensureMailAdvancedSchema();
  await db.execute(sql`INSERT INTO mail_link_clicks (message_id, url, ip, user_agent) VALUES (${messageId}, ${(url || '').slice(0, 2000)}, ${(ip || '').slice(0, 64) || null}, ${(ua || '').slice(0, 300) || null})`).catch(() => {});
}

// ---------- campaign analytics ----------
// Opens come from mail_reads (the tracking pixel); clicks from mail_link_clicks.
export async function campaignStats(messageIds: string[]): Promise<{ opens: number; clicks: number; openedMsgs: number; clickedMsgs: number }> {
  await ensureMailAdvancedSchema();
  if (!messageIds.length) return { opens: 0, clicks: 0, openedMsgs: 0, clickedMsgs: 0 };
  const opens = rows(await db.execute(sql`SELECT COUNT(*)::int AS c, COUNT(DISTINCT message_id)::int AS d FROM mail_reads WHERE message_id = ANY(${messageIds})`).catch(() => [] as any))[0] || { c: 0, d: 0 };
  const clicks = rows(await db.execute(sql`SELECT COUNT(*)::int AS c, COUNT(DISTINCT message_id)::int AS d FROM mail_link_clicks WHERE message_id = ANY(${messageIds})`).catch(() => [] as any))[0] || { c: 0, d: 0 };
  return { opens: opens.c || 0, clicks: clicks.c || 0, openedMsgs: opens.d || 0, clickedMsgs: clicks.d || 0 };
}

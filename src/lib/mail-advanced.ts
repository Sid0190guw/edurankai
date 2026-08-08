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
/**
 * Put a label on (or take it off) one message in one person's mailbox.
 *
 * IT USED TO WRITE TO A TABLE NOTHING READS. The old body inserted into `mail_message_labels`
 * keyed by label ID. The mail client does not read that table and never has: listFolder() in
 * src/lib/mail.ts filters on `b.labels @> ARRAY[...]::text[]` — the TEXT[] column on mail_box,
 * keyed by label NAME. So a label could be created, stored and "applied" and the rail's ?label=
 * filter would still return an empty folder, forever. The function also had zero callers, so
 * nothing ever exercised the mismatch.
 *
 * It now writes mail_box.labels, which is the column the reader reads, and takes the label NAME
 * for the same reason. mail_message_labels is left in place (never DROP) but is no longer the
 * label store; nothing reads or writes it.
 *
 * Throws on failure, deliberately. A label the caller believes it applied and which silently was
 * not applied is precisely the defect being repaired here.
 */
export async function setMessageLabel(userId: string, messageId: string, labelName: string, on: boolean): Promise<void> {
  await ensureMailAdvancedSchema();
  const name = (labelName || '').trim().slice(0, 80);
  if (!name) return;
  if (on) {
    await db.execute(sql`
      UPDATE mail_box SET labels = array_append(labels, ${name})
      WHERE user_id = ${userId}::uuid AND message_id = ${messageId}::uuid
        AND NOT (labels @> ARRAY[${name}]::text[])`);
  } else {
    await db.execute(sql`
      UPDATE mail_box SET labels = array_remove(labels, ${name})
      WHERE user_id = ${userId}::uuid AND message_id = ${messageId}::uuid`);
  }
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
/** The folder keys a rule is allowed to move a message into — src/lib/mail.ts FOLDERS. */
const RULE_FOLDERS = ['inbox', 'archive', 'spam', 'trash'];

export type RuleOutcome = { labels: string[]; folder?: string; star?: boolean; read?: boolean };

/**
 * Evaluate a person's rules against one message and return what should happen to it.
 *
 * PURE DECISION, NO WRITES. It used to half-persist: the label arm wrote `mail_message_labels`
 * (a table nothing reads — see setMessageLabel above) inside a `catch (_) {}`, while the folder,
 * star and read arms only ever ended up in the return value for a caller to apply. So the one
 * action that appeared to persist itself was the one that persisted nowhere visible.
 *
 * Persisting is now applyRulesToMessage()'s job and this function's job is to decide. The rule
 * read is no longer swallowed either: "your rules could not be read" and "you have no rules" are
 * the same empty list, and quietly filing nothing under the second when it was the first is how a
 * filing system silently stops running.
 */
export async function applyRules(userId: string, msg: { from: string; to: string; subject: string; body: string; messageId: string }): Promise<RuleOutcome> {
  const out: RuleOutcome = { labels: [] };
  const rls = await listRules(userId);
  for (const r of rls) {
    if (!r.is_active) continue;
    const field = r.match_field === 'to' ? msg.to : r.match_field === 'subject' ? msg.subject : r.match_field === 'body' ? msg.body : msg.from;
    if (!ruleMatches(r.match_op, field || '', r.match_value)) continue;
    if (r.action === 'folder' && r.action_value) {
      // An unrecognised folder key would file the message into a folder no view renders, which is
      // indistinguishable from deleting it. Rules are typed by hand on /admin/mail/rules.
      if (RULE_FOLDERS.includes(String(r.action_value))) out.folder = String(r.action_value);
    } else if (r.action === 'star') out.star = true;
    else if (r.action === 'read') out.read = true;
    else if (r.action === 'label' && r.action_value) {
      const name = String(r.action_value).trim().slice(0, 80);
      if (name && !out.labels.includes(name)) out.labels.push(name);
    }
  }
  return out;
}

/**
 * Evaluate the rules against one message ALREADY in a person's mailbox and write the result.
 *
 * This is the half that never existed. applyRules() returned a decision object and had no callers
 * at all, so no message in this product has ever been filed by a rule: an admin could build a full
 * set of filters on /admin/mail/rules, see them save and list back correctly, and none of them
 * would ever run against anything.
 *
 * Returns what actually changed, so the caller can report a real number rather than "done". A
 * message already in the target folder, already starred or already carrying the label is NOT
 * counted as changed — re-running the rules must be safe and must be honest about doing nothing.
 */
export async function applyRulesToMessage(
  userId: string,
  box: { message_id: string; folder: string; is_read: boolean; is_starred: boolean; labels: string[] | null },
  msg: { from: string; to: string; subject: string; body: string },
): Promise<{ changed: boolean; actions: string[] }> {
  const decision = await applyRules(userId, { ...msg, messageId: box.message_id });
  const actions: string[] = [];
  const have = new Set((box.labels || []).map((l) => String(l)));

  for (const name of decision.labels) {
    if (have.has(name)) continue;
    // The label has to exist in mail_labels for the rail to offer it as a filter, and on the
    // message for the filter to find anything. Both, or neither is any use.
    await createLabel(userId, name, '#a78bfa');
    await setMessageLabel(userId, box.message_id, name, true);
    have.add(name);
    actions.push('labelled "' + name + '"');
  }

  const sets: any[] = [];
  if (decision.folder && decision.folder !== box.folder) {
    sets.push(sql`folder = ${decision.folder}`);
    actions.push('moved to ' + decision.folder);
  }
  if (decision.star && !box.is_starred) {
    sets.push(sql`is_starred = true`);
    actions.push('starred');
  }
  if (decision.read && !box.is_read) {
    sets.push(sql`is_read = true`);
    actions.push('marked read');
  }
  if (sets.length > 0) {
    let assign = sets[0];
    for (let i = 1; i < sets.length; i++) assign = sql`${assign}, ${sets[i]}`;
    await db.execute(sql`
      UPDATE mail_box SET ${assign}
      WHERE user_id = ${userId}::uuid AND message_id = ${box.message_id}::uuid`);
  }
  return { changed: actions.length > 0, actions };
}

/**
 * Run the rules over mail already sitting in a person's mailbox.
 *
 * WHY A BACKFILL AND NOT ARRIVAL-TIME FILTERING. Filing a message as it lands belongs in the
 * inbound delivery path (src/pages/api/mail/inbound.ts), which this run does not own — it is
 * reported instead. This gives the rules a real execution path today: they run, against real rows,
 * and the mailbox visibly changes. Every failure is thrown to the caller so the page can say which
 * message it stopped on rather than reporting a filing that did not happen.
 */
export async function runRulesOnMailbox(
  userId: string,
  opts: { scope: 'inbox' | 'all'; limit?: number } = { scope: 'inbox' },
): Promise<{ scanned: number; changed: number; actions: string[]; capped: boolean }> {
  await ensureMailAdvancedSchema();
  const limit = Math.min(Math.max(opts.limit || 300, 1), 1000);
  const scopeWhere = opts.scope === 'all'
    ? sql`b.folder NOT IN ('trash', 'drafts')`
    : sql`b.folder = 'inbox'`;
  // One row per message with everything both halves need: the mailbox flags to compare against and
  // the message text to match on. body_text rather than body_html so a rule matching on "body"
  // matches words the person actually read, not markup.
  const box = rows(await db.execute(sql`
    SELECT b.message_id, b.folder, b.is_read, b.is_starred, b.labels,
           m.from_email, m.subject, m.body_text,
           COALESCE((SELECT string_agg(r.email, ', ') FROM mail_recipients r WHERE r.message_id = b.message_id), '') AS to_list
    FROM mail_box b
    JOIN mail_messages m ON m.id = b.message_id
    WHERE b.user_id = ${userId}::uuid AND ${scopeWhere} AND m.is_draft = false
    ORDER BY m.created_at DESC
    LIMIT ${limit}`));

  let changed = 0;
  const actions: string[] = [];
  for (const b of box) {
    const res = await applyRulesToMessage(userId, {
      message_id: String(b.message_id),
      folder: String(b.folder),
      is_read: b.is_read === true,
      is_starred: b.is_starred === true,
      labels: Array.isArray(b.labels) ? b.labels : [],
    }, {
      from: String(b.from_email || ''),
      to: String(b.to_list || ''),
      subject: String(b.subject || ''),
      body: String(b.body_text || ''),
    });
    if (res.changed) {
      changed++;
      // A sample, not the whole run — enough for the operator to see the rules did what they meant.
      if (actions.length < 6) actions.push('"' + String(b.subject || '(no subject)').slice(0, 60) + '" — ' + res.actions.join(', '));
    }
  }
  return { scanned: box.length, changed, actions, capped: box.length >= limit };
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

/**
 * Open + click counts PER MESSAGE for a whole batch of messages, in exactly two statements.
 *
 * WHY THIS EXISTS. /admin/mail/analytics grouped up to 400 sends into up to 30 campaigns and then
 * called campaignStats() once per campaign, sequentially — 60 round-trips in a single page render,
 * each one waiting on the last. Every number that loop produced is a sum over per-message counts,
 * so the two GROUP BY message_id reads below carry all of it and the roll-up happens in memory:
 * 60 statements become 2, whatever the campaign count is. Both tables are already indexed on
 * message_id (mail_reads_msg_idx in mail.ts, mail_click_msg_idx above).
 *
 * Maps are keyed by message id and a message with no opens/clicks is simply ABSENT — which is what
 * makes "how many messages in this campaign were opened" the count of keys present, with no second
 * DISTINCT query.
 *
 * `= ANY(${ids})` is the parameter form campaignStats() below and the recipient/delivery reads on
 * that page already use. It is kept rather than "improved": this is a performance repair, and
 * changing how the array binds would be an unverified behaviour change riding along with it.
 */
export async function campaignStatsByMessage(messageIds: string[]): Promise<{ opens: Record<string, number>; clicks: Record<string, number> }> {
  await ensureMailAdvancedSchema();
  const ids = (messageIds || []).filter((x) => typeof x === 'string' && x.length > 0);
  const opens: Record<string, number> = {};
  const clicks: Record<string, number> = {};
  if (!ids.length) return { opens, clicks };
  for (const r of rows(await db.execute(sql`SELECT message_id, COUNT(*)::int AS c FROM mail_reads WHERE message_id = ANY(${ids}) GROUP BY message_id`).catch(() => [] as any))) {
    opens[String(r.message_id)] = Number(r.c) || 0;
  }
  for (const r of rows(await db.execute(sql`SELECT message_id, COUNT(*)::int AS c FROM mail_link_clicks WHERE message_id = ANY(${ids}) GROUP BY message_id`).catch(() => [] as any))) {
    clicks[String(r.message_id)] = Number(r.c) || 0;
  }
  return { opens, clicks };
}

export async function campaignStats(messageIds: string[]): Promise<{ opens: number; clicks: number; openedMsgs: number; clickedMsgs: number }> {
  await ensureMailAdvancedSchema();
  if (!messageIds.length) return { opens: 0, clicks: 0, openedMsgs: 0, clickedMsgs: 0 };
  const opens = rows(await db.execute(sql`SELECT COUNT(*)::int AS c, COUNT(DISTINCT message_id)::int AS d FROM mail_reads WHERE message_id = ANY(${messageIds})`).catch(() => [] as any))[0] || { c: 0, d: 0 };
  const clicks = rows(await db.execute(sql`SELECT COUNT(*)::int AS c, COUNT(DISTINCT message_id)::int AS d FROM mail_link_clicks WHERE message_id = ANY(${messageIds})`).catch(() => [] as any))[0] || { c: 0, d: 0 };
  return { opens: opens.c || 0, clicks: clicks.c || 0, openedMsgs: opens.d || 0, clickedMsgs: clicks.d || 0 };
}

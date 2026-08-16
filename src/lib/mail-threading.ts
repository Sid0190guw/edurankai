// src/lib/mail-threading.ts — WHICH CONVERSATION DOES THIS MESSAGE BELONG TO, AND WHAT SHAPE IS IT?
//
// WHAT WAS HERE BEFORE. findThreadForInbound() in src/lib/mail.ts tried In-Reply-To against
// rfc_message_id and then fell back to "same normalised subject, same counterpart, inside 30 days".
// That is two of the four signals RFC 5322 gives you, and the missing one is the one that matters
// most in practice: REFERENCES. In-Reply-To names only the immediate parent, and it is the header
// clients drop most often — on a forward, on a reply typed in a webmail that lost the context, on
// anything that has been through a mailing list. References carries the WHOLE ancestry, so a
// message whose parent is missing from this mailbox still lands in the right conversation as long
// as ANY ancestor is here. Without it, a five-message exchange arrives as five separate threads and
// the subject fallback quietly staples in whatever else shares the words.
//
// THE ORDER OF RESOLUTION IS DELIBERATE, STRONGEST EVIDENCE FIRST:
//
//   1. This exact Message-ID is already stored     -> it is a duplicate; reuse that thread.
//   2. In-Reply-To names a message we hold          -> that thread. The direct parent is the best
//                                                      single answer there is.
//   3. References names a message we hold           -> that thread, walking the chain from the
//                                                      NEAREST ancestor backwards, because the tail
//                                                      of the chain is the closest relative.
//   4. Same normalised subject, same counterpart,   -> that thread. Narrow on purpose.
//      inside the window
//
// WHY 4 STAYS NARROW. Merging on subject alone would staple every "Hello" and every "Invoice" in
// the building into one conversation. It requires the counterpart address AND a recency window AND
// a subject that survived normalisation as non-empty, and it will not fire for a bare "Re:".
//
// THE SHAPE HALF. assembleConversation() turns a flat list into the tree the reading pane draws —
// original, reply, reply-all, forward, nested replies — and splitQuoted() finds the part of a
// message that is a repetition of what is already on screen. Both are PURE, so they are tested
// against fixtures rather than against a database.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

// Declared before anything that uses them — `const` is not hoisted.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) ? r : (r?.rows || [])) as T[];

/**
 * How far back the subject fallback will look. Long enough for a slow conversation, short enough
 * that next year's "Invoice" does not join last year's.
 */
export const SUBJECT_FALLBACK_DAYS = 30;

/**
 * RFC 5322 says a References header should not be truncated, and every real MTA truncates it
 * anyway because the line has a practical length limit. The convention is to keep the FIRST id
 * (the root, which is what identifies the conversation) and the most recent ones.
 */
export const MAX_REFERENCES = 20;

// =================================================================================================
// HEADER PARSING — pure
// =================================================================================================

/**
 * Every `<id@host>` in a header value, in order, de-duplicated.
 *
 * References is space- or comma-separated in the wild, folded across lines, and sometimes contains
 * commentary. Matching the angle-bracket form is the only reading that survives all of that. A bare
 * id with no brackets is accepted too, because plenty of senders emit one.
 */
export function parseMessageIds(header: string | null | undefined): string[] {
  const s = String(header || '').trim();
  if (!s) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const bracketed = s.match(/<[^<>\s]+>/g);
  if (bracketed) {
    for (const id of bracketed) {
      const v = id.trim();
      if (v.length > 2 && !seen.has(v)) { seen.add(v); out.push(v); }
    }
  }
  if (!out.length) {
    // No brackets at all: treat the whole value as one id if it looks like one.
    for (const part of s.split(/[\s,]+/)) {
      const v = part.trim();
      if (v && v.includes('@') && !seen.has(v)) { seen.add(v); out.push('<' + v.replace(/^<|>$/g, '') + '>'); }
    }
  }
  return out;
}

/** The immediate parent: In-Reply-To if present, otherwise the LAST entry of References. */
export function parentIdOf(inReplyTo: string | null | undefined, references: string | null | undefined): string | null {
  const direct = parseMessageIds(inReplyTo);
  if (direct.length) return direct[direct.length - 1];
  const refs = parseMessageIds(references);
  return refs.length ? refs[refs.length - 1] : null;
}

/**
 * Reply and forward prefixes, in the languages that actually reach this mailbox, plus the mailing
 * list tag form `[list-name]`. Applied repeatedly, because "Re: Fwd: Re: X" is ordinary.
 *
 * `Re[2]:` and `Re(2):` are the numbered forms Outlook and some Russian clients emit.
 */
const PREFIX_RE = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|vb|res|rif|odp|ynt|antwort|antw|doorst)\s*(?:\[\d+\]|\(\d+\))?\s*[:\-]\s*|\[[^\]]{1,40}\]\s*)/i;

/**
 * The conversation-identifying form of a subject: prefixes stripped, whitespace collapsed, folded
 * to lower case. `"Re: [ops] Fwd:  Invoice 42 "` and `"Invoice 42"` normalise to the same string.
 */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = String(subject || '').replace(/\s+/g, ' ').trim();
  // TERMINATION IS BY CONSTRUCTION, NOT BY AN ARBITRARY COUNT. Every iteration that changes the
  // string removes at least one character, so the loop is bounded by the subject's own length —
  // and a subject is at most a few hundred characters here (mail_messages.subject is written by
  // /api/mail/send with a 500-character cap).
  //
  // This used to stop after twelve passes. That looked like a safety measure and was really a
  // correctness bug: a long mailing-list thread accumulates prefixes, and a subject carrying more
  // than twelve of them normalised to something still full of "re:" — so it matched nothing, and
  // the conversation it belonged to scattered at exactly the point it had become long enough to
  // matter. The guard that was actually needed is "each pass must shorten the string", which is a
  // property of PREFIX_RE (it never matches empty), and it is asserted below.
  const limit = s.length + 1;
  for (let i = 0; i < limit; i++) {
    const next = s.replace(PREFIX_RE, '').trim();
    if (next === s || next.length >= s.length) break;
    s = next;
  }
  return s.toLowerCase().trim();
}

/** True when the subject carried a reply or forward prefix — a weak hint, used only as a tiebreak. */
export function subjectIsReply(subject: string | null | undefined): boolean {
  const s = String(subject || '').trim();
  return !!s && PREFIX_RE.test(s) && normalizeSubject(s) !== s.toLowerCase();
}

/**
 * The References header a REPLY should carry: the parent's chain, then the parent's own id.
 *
 * Truncation keeps the first id and the most recent ones — the root is what identifies the
 * conversation to everyone else's client, so it is the one entry that must never be dropped.
 */
export function buildReferences(parentReferences: string | null | undefined, parentMessageId: string | null | undefined): string {
  const chain = parseMessageIds(parentReferences);
  const parent = String(parentMessageId || '').trim();
  if (parent && !chain.includes(parent)) chain.push(parent);
  if (chain.length <= MAX_REFERENCES) return chain.join(' ');
  return [chain[0], ...chain.slice(chain.length - (MAX_REFERENCES - 1))].join(' ');
}

// =================================================================================================
// SCHEMA — additive
// =================================================================================================
//
// `references_header`, not `references`: REFERENCES is a reserved word in SQL and an unquoted column
// of that name is a parse error on every statement that touches it. Naming it once, correctly, is
// cheaper than quoting it forever.
let threadSchemaReady: Promise<void> | null = null;

export function ensureThreadingSchema(): Promise<void> {
  if (!threadSchemaReady) threadSchemaReady = bootstrapThreadingSchema();
  return threadSchemaReady;
}

async function bootstrapThreadingSchema(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS references_header TEXT`);
  } catch (e: any) {
    console.error('[mail-threading] references column:', reasonOf(e));
  }
  try {
    await db.execute(sql`ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS normalized_subject TEXT`);
  } catch (e: any) {
    console.error('[mail-threading] normalized subject column:', reasonOf(e));
  }
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_msg_inreplyto_idx ON mail_messages(in_reply_to) WHERE in_reply_to IS NOT NULL`);
  } catch (e: any) {
    console.error('[mail-threading] in-reply-to index:', reasonOf(e));
  }
  try {
    await db.execute(sql`CREATE INDEX IF NOT EXISTS mail_msg_normsubj_idx ON mail_messages(normalized_subject, created_at DESC) WHERE normalized_subject IS NOT NULL`);
  } catch (e: any) {
    console.error('[mail-threading] normalized subject index:', reasonOf(e));
  }
}

/**
 * Record the threading headers for a message that has just been stored.
 *
 * Separate from the INSERT on purpose: the inbound doors in src/lib/mail.ts write the message row,
 * and this adds what they have without either of them needing to know the column list. Best-effort
 * and REPORTED — a message that is delivered but missing a References row still threads by
 * In-Reply-To and by subject; it does not stop being delivered.
 */
export async function recordThreadingHeaders(messageId: string, p: { references?: string | null; subject?: string | null }): Promise<void> {
  try {
    await ensureThreadingSchema();
    await db.execute(sql`
      UPDATE mail_messages
         SET references_header = COALESCE(${p.references || null}, references_header),
             normalized_subject = ${normalizeSubject(p.subject || '')}
       WHERE id = ${messageId}::uuid`);
  } catch (e: any) {
    console.error('[mail-threading] headers NOT recorded for message', messageId, '-', reasonOf(e));
  }
}

// =================================================================================================
// RESOLUTION — which thread
// =================================================================================================

export interface ThreadResolutionInput {
  /** The mailbox this is being threaded into. Resolution never crosses mailboxes. */
  userId: string;
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  subject?: string | null;
  /** The other party's address — sender for inbound, recipient for outbound. */
  counterpart?: string | null;
}

export interface ThreadResolution {
  threadId: string | null;
  /** Which signal answered. Stored in the log so a mis-thread can be explained afterwards. */
  via: 'duplicate' | 'in-reply-to' | 'references' | 'subject' | null;
  /** The ancestor that matched, when one did. */
  matchedId: string | null;
}

/**
 * THE ENGINE. Four questions, strongest evidence first, and it stops at the first answer.
 *
 * Every statement is scoped to this user's own mailbox rows EXCEPT the Message-ID lookups, which
 * are keyed on a globally unique identifier the sender minted — a message id collision across two
 * mailboxes is not a thing that happens, and requiring the ancestor to be in THIS mailbox would
 * break the ordinary case of being added to a conversation part-way through.
 *
 * Returns `{ threadId: null }` when nothing matched. That is a real answer — the caller mints a new
 * thread id — and it is not an error.
 */
export async function resolveThread(p: ThreadResolutionInput): Promise<ThreadResolution> {
  const none: ThreadResolution = { threadId: null, via: null, matchedId: null };
  try {
    await ensureThreadingSchema();

    // 1. Already stored under this exact Message-ID: a duplicate delivery, not a new message.
    const selfId = (parseMessageIds(p.rfcMessageId)[0] || '').trim();
    if (selfId) {
      const dup = rowsOf(await db.execute(sql`
        SELECT thread_id FROM mail_messages WHERE rfc_message_id = ${selfId} LIMIT 1`));
      if (dup[0]) return { threadId: String(dup[0].thread_id), via: 'duplicate', matchedId: selfId };
    }

    // 2. The direct parent.
    const direct = parseMessageIds(p.inReplyTo);
    for (let i = direct.length - 1; i >= 0; i--) {
      const hit = rowsOf(await db.execute(sql`
        SELECT thread_id FROM mail_messages WHERE rfc_message_id = ${direct[i]} LIMIT 1`));
      if (hit[0]) return { threadId: String(hit[0].thread_id), via: 'in-reply-to', matchedId: direct[i] };
    }

    // 3. The ancestry, NEAREST FIRST. One statement, not one per id: the chain can be twenty long
    //    and twenty round trips per arriving message is a real cost on an inbound burst. Ordering
    //    by position in the supplied chain is done in JS because the array order is the meaning.
    const refs = parseMessageIds(p.references).filter((r) => r !== selfId);
    if (refs.length) {
      const hits = rowsOf(await db.execute(sql`
        SELECT rfc_message_id, thread_id FROM mail_messages
        WHERE rfc_message_id = ANY((SELECT array_agg(t.x) FROM jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) AS t(x)))`));
      if (hits.length) {
        const byId: Record<string, string> = {};
        for (const h of hits) byId[String(h.rfc_message_id)] = String(h.thread_id);
        for (let i = refs.length - 1; i >= 0; i--) {
          if (byId[refs[i]]) return { threadId: byId[refs[i]], via: 'references', matchedId: refs[i] };
        }
      }
    }

    // 4. The narrow fallback. Requires a non-empty normalised subject AND the counterpart AND
    //    recency; a bare "Re:" normalises to '' and therefore cannot reach this branch at all.
    const base = normalizeSubject(p.subject || '');
    const other = String(p.counterpart || '').trim().toLowerCase();
    if (!base || !other) return none;
    const hit = rowsOf(await db.execute(sql`
      SELECT b.thread_id FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
      WHERE b.user_id = ${p.userId}
        AND m.created_at > NOW() - (${SUBJECT_FALLBACK_DAYS} || ' days')::interval
        AND lower(regexp_replace(coalesce(m.subject,''), '^((re|fw|fwd)\\s*:\\s*)+', '', 'i')) = ${base}
        AND (lower(coalesce(m.from_email,'')) = ${other}
             OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.message_id = m.id AND lower(coalesce(r.email,'')) = ${other}))
      ORDER BY m.created_at DESC LIMIT 1`));
    if (hit[0]) return { threadId: String(hit[0].thread_id), via: 'subject', matchedId: null };
    return none;
  } catch (e: any) {
    // A threading failure must never lose a message. The caller mints a new thread and the mail is
    // delivered; the reason is written down rather than swallowed into a silent mis-thread.
    console.error('[mail-threading] resolution failed, message will start a new conversation:', reasonOf(e));
    return none;
  }
}

// =================================================================================================
// SHAPE — pure
// =================================================================================================

/** The minimum a message must expose to be threaded and drawn. Structural, so tests use literals. */
export interface MessageLike {
  id: string;
  rfc_message_id?: string | null;
  in_reply_to?: string | null;
  references_header?: string | null;
  subject?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  from_user_id?: string | null;
  created_at: string | Date;
  is_read?: boolean;
  is_draft?: boolean;
  has_attachments?: boolean;
  body_text?: string | null;
  body_html?: string | null;
  recipients?: { kind: string; email: string; name?: string | null }[];
  attachments?: { filename: string; url: string; mime?: string | null; size_bytes?: number | null }[];
}

export interface ConversationNode<T extends MessageLike = MessageLike> {
  message: T;
  children: ConversationNode<T>[];
  /** Nesting level; 0 for a root. Capped for rendering by MAX_RENDER_DEPTH. */
  depth: number;
  /** How this message was attached to its parent. 'root' when it starts the conversation. */
  via: 'root' | 'in-reply-to' | 'references' | 'sequence';
}

/** Beyond this the reading pane stops indenting. Nesting is a hint, not a filing cabinet. */
export const MAX_RENDER_DEPTH = 6;

/**
 * Turn a flat conversation into the tree it actually is.
 *
 * A simplified JWZ: index by Message-ID, attach each message to its nearest KNOWN ancestor, and
 * make anything with no resolvable ancestor a root. Two departures from the classic algorithm, both
 * because this is a reading pane and not a news reader:
 *
 *   - NO EMPTY CONTAINERS. JWZ invents placeholder nodes for missing ancestors so the tree keeps
 *     its shape. A person reading their mail does not want a blank row where a message they never
 *     received would have been; a message whose parent is absent attaches to the newest earlier
 *     message instead ('sequence'), which is what the exchange looked like from here.
 *   - CYCLES ARE BROKEN, NOT TRUSTED. A forged or looping In-Reply-To must not produce infinite
 *     recursion in a render path. Any link that would make a message its own ancestor is dropped
 *     and the message becomes a root.
 *
 * Ordering is by date at every level, oldest first, which is how a conversation reads.
 */
export function assembleConversation<T extends MessageLike>(messages: T[]): ConversationNode<T>[] {
  const sorted = [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const nodes = new Map<string, ConversationNode<T>>();
  const byMessageId = new Map<string, ConversationNode<T>>();
  for (const m of sorted) {
    const node: ConversationNode<T> = { message: m, children: [], depth: 0, via: 'root' };
    nodes.set(m.id, node);
    const rid = (parseMessageIds(m.rfc_message_id)[0] || '').trim();
    if (rid && !byMessageId.has(rid)) byMessageId.set(rid, node);
  }

  const parentOf = new Map<string, { parent: ConversationNode<T>; via: ConversationNode<T>['via'] }>();
  let previous: ConversationNode<T> | null = null;
  for (const m of sorted) {
    const node = nodes.get(m.id)!;
    let attached: { parent: ConversationNode<T>; via: ConversationNode<T>['via'] } | null = null;

    for (const id of parseMessageIds(m.in_reply_to).reverse()) {
      const cand = byMessageId.get(id);
      if (cand && cand !== node) { attached = { parent: cand, via: 'in-reply-to' }; break; }
    }
    if (!attached) {
      const refs = parseMessageIds(m.references_header);
      for (let i = refs.length - 1; i >= 0; i--) {
        const cand = byMessageId.get(refs[i]);
        if (cand && cand !== node) { attached = { parent: cand, via: 'references' }; break; }
      }
    }
    if (!attached && previous && parseMessageIds(m.in_reply_to).length + parseMessageIds(m.references_header).length > 0) {
      // It claims an ancestor we do not hold. It is still a reply; hang it off what came before.
      attached = { parent: previous, via: 'sequence' };
    }
    if (attached && !createsCycle(attached.parent, node, parentOf)) {
      parentOf.set(m.id, attached);
      node.via = attached.via;
    }
    previous = node;
  }

  const roots: ConversationNode<T>[] = [];
  for (const m of sorted) {
    const node = nodes.get(m.id)!;
    const link = parentOf.get(m.id);
    if (link) link.parent.children.push(node);
    else roots.push(node);
  }
  const setDepth = (n: ConversationNode<T>, d: number) => {
    n.depth = Math.min(d, MAX_RENDER_DEPTH);
    n.children.sort((a, b) => new Date(a.message.created_at).getTime() - new Date(b.message.created_at).getTime());
    for (const c of n.children) setDepth(c, d + 1);
  };
  for (const r of roots) setDepth(r, 0);
  return roots;
}

function createsCycle<T extends MessageLike>(
  parent: ConversationNode<T>,
  child: ConversationNode<T>,
  parentOf: Map<string, { parent: ConversationNode<T>; via: any }>,
): boolean {
  let cur: ConversationNode<T> | undefined = parent;
  for (let i = 0; cur && i < 1000; i++) {
    if (cur === child) return true;
    cur = parentOf.get(cur.message.id)?.parent;
  }
  return false;
}

/** The tree flattened back to reading order, parents before their replies. */
export function flattenConversation<T extends MessageLike>(roots: ConversationNode<T>[]): ConversationNode<T>[] {
  const out: ConversationNode<T>[] = [];
  const walk = (n: ConversationNode<T>) => { out.push(n); for (const c of n.children) walk(c); };
  for (const r of roots) walk(r);
  return out;
}

// =================================================================================================
// QUOTED CONTENT — pure
// =================================================================================================

/**
 * Where the new writing stops and the repetition of what is already on screen begins.
 *
 * Four markers, all of them common and all of them ambiguous on their own, so the FIRST one wins
 * and everything after it is quoted:
 *   - a run of lines beginning with `>`   (the RFC 3676 form, every client)
 *   - "On <something> wrote:"             (Gmail, Apple Mail, most webmail)
 *   - "-----Original Message-----"        (Outlook)
 *   - "From: ... Sent: ... To: ..."       (Outlook's other form, header block)
 *
 * A signature after `-- ` is returned separately rather than as quoted text: it is the sender's own
 * writing and hiding it inside "show quoted text" loses their contact details.
 *
 * Conservative by design. When nothing matches, everything is visible — a reading pane that hides
 * text it merely suspects is a reading pane that eats messages.
 */
export interface SplitBody {
  visible: string;
  quoted: string;
  signature: string;
  /** How the quote was found, for a tooltip and for the tests. Null when nothing was hidden. */
  marker: 'chevron' | 'wrote' | 'original-message' | 'header-block' | null;
}

const WROTE_RE = /^\s*(?:on\b[\s\S]{0,200}?\bwrote\s*:|.{0,120}\bwrote\s*:)\s*$/i;
const ORIGINAL_RE = /^\s*-{2,}\s*original message\s*-{2,}\s*$/i;
const HEADER_BLOCK_RE = /^\s*(?:from|von|de)\s*:\s*.+$/i;

export function splitQuoted(text: string | null | undefined): SplitBody {
  const src = String(text || '');
  if (!src.trim()) return { visible: '', quoted: '', signature: '', marker: null };
  const lines = src.split(/\r?\n/);

  // The signature comes off first so a quote marker inside it cannot be mistaken for the quote.
  let sigAt = -1;
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 12; i--) {
    if (/^--\s?$/.test(lines[i])) { sigAt = i; break; }
  }
  const signature = sigAt >= 0 ? lines.slice(sigAt + 1).join('\n').trim() : '';
  const body = sigAt >= 0 ? lines.slice(0, sigAt) : lines;

  let cut = -1;
  let marker: SplitBody['marker'] = null;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (ORIGINAL_RE.test(line)) { cut = i; marker = 'original-message'; break; }
    if (WROTE_RE.test(line) && line.trim().length > 6) { cut = i; marker = 'wrote'; break; }
    if (/^\s*>/.test(line)) { cut = i; marker = 'chevron'; break; }
    // An Outlook header block only counts when the NEXT lines continue it — a message that merely
    // starts with the word "From:" is not a quote.
    if (HEADER_BLOCK_RE.test(line) && i + 1 < body.length && /^\s*(?:sent|to|subject|date|gesendet|an)\s*:/i.test(body[i + 1])) {
      cut = i; marker = 'header-block'; break;
    }
  }
  if (cut < 0) return { visible: body.join('\n').trim(), quoted: '', signature, marker: null };
  return {
    visible: body.slice(0, cut).join('\n').trim(),
    quoted: body.slice(cut).join('\n').trim(),
    signature,
    marker,
  };
}

// =================================================================================================
// SUMMARY — pure
// =================================================================================================

export interface Participant {
  email: string;
  name: string;
  /** How many messages in this conversation they wrote. */
  sent: number;
}

export interface ConversationSummary {
  subject: string;
  messageCount: number;
  unreadCount: number;
  draftCount: number;
  attachmentCount: number;
  latestActivity: string | null;
  participants: Participant[];
  /** Message ids that should be OPEN when the conversation is first drawn — see below. */
  expandedIds: string[];
}

/**
 * What the conversation header says, and which messages start open.
 *
 * THE COLLAPSE RULE, stated once so the UI cannot invent a different one: the LATEST message is
 * always open, every UNREAD message is open, and any DRAFT is open. Everything else starts
 * collapsed. That is the rule people already expect, and it has the property that opening a
 * conversation never hides something you have not read.
 */
export function summarizeConversation(messages: MessageLike[]): ConversationSummary {
  const sorted = [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const byEmail = new Map<string, Participant>();
  let unread = 0, drafts = 0, attachments = 0;

  for (const m of sorted) {
    const email = String(m.from_email || '').toLowerCase();
    if (email) {
      const p = byEmail.get(email) || { email, name: String(m.from_name || '') || email, sent: 0 };
      p.sent++;
      if (!p.name && m.from_name) p.name = String(m.from_name);
      byEmail.set(email, p);
    }
    for (const r of m.recipients || []) {
      const re = String(r.email || '').toLowerCase();
      if (re && !byEmail.has(re)) byEmail.set(re, { email: re, name: String(r.name || '') || re, sent: 0 });
    }
    if (m.is_read === false) unread++;
    if (m.is_draft) drafts++;
    attachments += (m.attachments || []).length || (m.has_attachments ? 1 : 0);
  }

  const latest = sorted[sorted.length - 1];
  const expanded = new Set<string>();
  if (latest) expanded.add(latest.id);
  for (const m of sorted) if (m.is_read === false || m.is_draft) expanded.add(m.id);

  return {
    subject: String(sorted[0]?.subject || '') || '(no subject)',
    messageCount: sorted.length,
    unreadCount: unread,
    draftCount: drafts,
    attachmentCount: attachments,
    latestActivity: latest ? new Date(latest.created_at).toISOString() : null,
    participants: Array.from(byEmail.values()).sort((a, b) => b.sent - a.sent),
    expandedIds: Array.from(expanded),
  };
}

/** "Anita, Ravi and 3 others" — the line above a collapsed conversation. */
export function participantLine(participants: Participant[], max = 3): string {
  const names = participants.map((p) => (p.name && p.name !== p.email ? p.name.split(/\s+/)[0] : p.email));
  if (names.length <= max) return names.join(', ');
  return names.slice(0, max).join(', ') + ' and ' + (names.length - max) + ' others';
}

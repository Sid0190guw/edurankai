// src/lib/mail-context.ts — WHO IS THIS PERSON, SHOWN BESIDE THEIR MESSAGE.
//
// WHAT THIS IS FOR. Reading a message tells you what somebody wrote and nothing about who they are.
// The reading pane can say "you have exchanged nine messages, the last one in June" and "they are
// on the partner-institutions list" without anybody leaving the mailbox to go and look it up.
//
// IT OWNS NO DATA, AND THAT IS THE POINT. Every field here is READ from a store that already
// exists — src/lib/mail-contacts.ts for the contact book, the users table for colleagues,
// mail_box/mail_messages for the correspondence. A fourth place to record who somebody is would be
// a fourth place for their name to be wrong.
//
// AUTHORISATION IS PER FIELD, NOT PER SCREEN.
//
//   - CORRESPONDENCE is always shown, because it is the viewer's OWN mailbox: the count comes from
//     rows keyed by `mail_box.user_id = <viewer>`. Nobody learns anything here they could not learn
//     by scrolling.
//   - THE CONTACT BOOK — organisation, tags, list and campaign membership, consent, suppression —
//     needs `mail.manage`. It is marketing data about a person, gathered under a consent record,
//     and an employee reading a support reply has no business being shown it.
//   - A COLLEAGUE'S RECORD is limited to what an internal directory already shows: name, work
//     address, whether the account is active. Nothing else.
//
// WHAT IS NEVER READ HERE, WRITTEN DOWN SO IT STAYS TRUE. No wellness or health data of any kind
// (src/lib/wellness.ts is women-only, gated server-side, and no admin surface may see one person's
// record — a contact card is exactly the sort of "helpful" panel that quietly becomes one). No
// legal-hold material, which requires an open numbered matter and a logged access before anything
// renders. No HR record beyond the directory fields above. If a future field is tempting, the test
// in this module's suite asserts the shape of what is returned, and adding to it is a decision
// somebody has to make on purpose.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { holdsCapability } from '@/lib/auth/capability';

// Declared before anything that uses them — `const` is not hoisted.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) ? r : (r?.rows || [])) as T[];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface RecentInteraction {
  threadId: string;
  subject: string;
  at: string;
  direction: 'in' | 'out';
}

export interface ContactContext {
  email: string;
  /** Best available display name. Falls back to the address, never to an empty string. */
  name: string;
  /** True when the address belongs to an account in this product. */
  isInternal: boolean;
  organization: string | null;
  title: string | null;
  tags: string[];
  lists: string[];
  campaigns: string[];
  /** Present only when the viewer holds mail.manage. */
  consent: { status: string; source: string | null; at: string | null } | null;
  suppressed: { reason: string; at: string } | null;
  exchanged: number;
  firstContactAt: string | null;
  lastContactAt: string | null;
  recent: RecentInteraction[];
  /**
   * Which fields the viewer was NOT shown, and why. Rendered as a line on the card: a panel that
   * silently omits half of itself teaches people the data does not exist.
   */
  withheld: string[];
  /** Set when a lookup failed. The card renders this instead of an empty, confident-looking panel. */
  error: string | null;
}

function emptyContext(email: string): ContactContext {
  return {
    email, name: email, isInternal: false, organization: null, title: null,
    tags: [], lists: [], campaigns: [], consent: null, suppressed: null,
    exchanged: 0, firstContactAt: null, lastContactAt: null, recent: [],
    withheld: [], error: null,
  };
}

/**
 * The card beside a message.
 *
 * `viewer` is the signed-in user; `email` is the counterpart. Every query below is either scoped to
 * the viewer's own mailbox or gated on a capability the viewer holds — there is no argument to this
 * function that widens what it returns.
 */
export async function contactContext(viewer: any, email: string): Promise<ContactContext> {
  const addr = String(email || '').trim().toLowerCase();
  const ctx = emptyContext(addr);
  if (!addr || !EMAIL_RE.test(addr)) {
    ctx.error = 'That is not an address this can look up.';
    return ctx;
  }
  if (!viewer?.id) {
    ctx.error = 'Not signed in.';
    return ctx;
  }

  const mayReadContactBook = holdsCapability(viewer, 'mail.manage');
  if (!mayReadContactBook) {
    ctx.withheld.push('Organisation, tags, list and campaign membership are part of the contact book, which needs mail permissions.');
  }

  // ---- The correspondence. The viewer's own mailbox, always shown. -----------------------------
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n,
             MIN(m.created_at) AS first_at,
             MAX(m.created_at) AS last_at
      FROM mail_box b
      JOIN mail_messages m ON m.id = b.message_id
      WHERE b.user_id = ${viewer.id}::uuid
        AND (lower(coalesce(m.from_email,'')) = ${addr}
             OR EXISTS (SELECT 1 FROM mail_recipients rr WHERE rr.message_id = m.id AND lower(coalesce(rr.email,'')) = ${addr}))`);
    const agg = rowsOf(r)[0];
    if (agg) {
      ctx.exchanged = Number(agg.n) || 0;
      ctx.firstContactAt = agg.first_at ? new Date(agg.first_at).toISOString() : null;
      ctx.lastContactAt = agg.last_at ? new Date(agg.last_at).toISOString() : null;
    }

    if (ctx.exchanged > 0) {
      const rec = await db.execute(sql`
        SELECT DISTINCT ON (b.thread_id) b.thread_id, m.subject, m.created_at, m.from_email
        FROM mail_box b
        JOIN mail_messages m ON m.id = b.message_id
        WHERE b.user_id = ${viewer.id}::uuid
          AND (lower(coalesce(m.from_email,'')) = ${addr}
               OR EXISTS (SELECT 1 FROM mail_recipients rr WHERE rr.message_id = m.id AND lower(coalesce(rr.email,'')) = ${addr}))
        ORDER BY b.thread_id, m.created_at DESC
        LIMIT 8`);
      ctx.recent = rowsOf(rec).map((x) => ({
        threadId: String(x.thread_id),
        subject: String(x.subject || '(no subject)'),
        at: new Date(x.created_at).toISOString(),
        direction: String(x.from_email || '').toLowerCase() === addr ? 'in' as const : 'out' as const,
      })).sort((a, b) => b.at.localeCompare(a.at));
    }
  } catch (e: any) {
    console.error('[mail-context] correspondence read failed:', reasonOf(e));
    ctx.error = 'The history with this address could not be read: ' + reasonOf(e);
  }

  // ---- A colleague. Directory fields only. -----------------------------------------------------
  try {
    const u = rowsOf(await db.execute(sql`
      SELECT id, name, email, is_active FROM users
      WHERE lower(coalesce(mailbox_address,'')) = ${addr} OR lower(coalesce(email,'')) = ${addr}
      LIMIT 1`))[0];
    if (u) {
      ctx.isInternal = true;
      ctx.name = String(u.name || '') || ctx.name;
      if (u.is_active === false) ctx.title = 'Account is no longer active';
    }
  } catch (e: any) {
    // Not fatal: the card still shows the correspondence.
    console.error('[mail-context] directory read failed:', reasonOf(e));
  }

  if (!mayReadContactBook) return ctx;

  // ---- The contact book. mail.manage only. -----------------------------------------------------
  try {
    const { ensureContactSchema } = await import('@/lib/mail-contacts');
    await ensureContactSchema();

    const c = rowsOf(await db.execute(sql`
      SELECT id, first_name, last_name, organization, role_title, status, consent_source, consent_at
      FROM mail_contacts WHERE email = ${addr} LIMIT 1`))[0];
    if (c) {
      const full = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
      if (full && (!ctx.name || ctx.name === addr)) ctx.name = full;
      ctx.organization = c.organization || null;
      ctx.title = c.role_title || ctx.title;
      ctx.consent = {
        status: String(c.status || 'unknown'),
        source: c.consent_source || null,
        at: c.consent_at ? new Date(c.consent_at).toISOString() : null,
      };

      const tags = rowsOf(await db.execute(sql`
        SELECT tag FROM mail_contact_tags WHERE contact_id = ${String(c.id)}::uuid ORDER BY tag ASC LIMIT 40`));
      ctx.tags = tags.map((t) => String(t.tag));

      const lists = rowsOf(await db.execute(sql`
        SELECT l.name FROM mail_list_members lm JOIN mail_lists l ON l.id = lm.list_id
        WHERE lm.contact_id = ${String(c.id)}::uuid AND l.is_archived = false
        ORDER BY l.name ASC LIMIT 20`));
      ctx.lists = lists.map((l) => String(l.name));
    }

    const sup = rowsOf(await db.execute(sql`
      SELECT reason, created_at FROM mail_suppression WHERE email = ${addr} LIMIT 1`))[0];
    if (sup) {
      ctx.suppressed = { reason: String(sup.reason || 'unsubscribed'), at: new Date(sup.created_at).toISOString() };
    }
  } catch (e: any) {
    // The contact book is a separate subsystem and may not be bootstrapped on every deployment.
    // Its absence is not an error on this card — it is simply a card with less on it, and the
    // reason is recorded rather than shown as a failure of the mailbox.
    console.error('[mail-context] contact book read failed:', reasonOf(e));
    ctx.withheld.push('The contact book could not be read just now.');
  }

  // Campaign membership is read separately: it lives in the campaigns subsystem, which another part
  // of this build owns, and a missing table there must not empty the rest of the card.
  try {
    const camps = rowsOf(await db.execute(sql`
      SELECT DISTINCT c.name
      FROM mail_campaign_recipients cr
      JOIN mail_campaigns c ON c.id = cr.campaign_id
      WHERE lower(cr.email) = ${addr}
      ORDER BY c.name ASC LIMIT 10`));
    ctx.campaigns = camps.map((x) => String(x.name));
  } catch {
    // No campaigns table on this deployment, or none for this address. Neither is worth a log line
    // on every message anybody opens.
  }

  return ctx;
}

/** "9 messages · last in June" — the one-line form for a collapsed header. */
export function contextLine(ctx: ContactContext): string {
  if (ctx.error) return '';
  const bits: string[] = [];
  if (ctx.organization) bits.push(ctx.organization);
  if (ctx.exchanged > 0) {
    bits.push(ctx.exchanged === 1 ? '1 message between you' : ctx.exchanged.toLocaleString('en-IN') + ' messages between you');
  } else {
    bits.push('first message from this address');
  }
  if (ctx.lastContactAt && ctx.exchanged > 1) {
    bits.push('last ' + new Date(ctx.lastContactAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', year: 'numeric' }));
  }
  if (ctx.suppressed) bits.push('unsubscribed — do not add to a campaign');
  return bits.join(' · ');
}

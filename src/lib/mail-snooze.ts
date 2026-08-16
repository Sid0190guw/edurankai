// src/lib/mail-snooze.ts — PUT THIS BACK IN FRONT OF ME LATER.
//
// THE COLUMN WAS ALREADY THERE AND NOTHING READ IT. `mail_box.snoozed_until` has existed since the
// schema was written (src/lib/mail.ts, bootstrapSchema) and not one statement in the repository
// consulted it: no listing filtered on it, nothing ever cleared it, and no screen offered to set
// it. A column with no reader is not a half-built feature, it is a place where a value can sit
// looking meaningful while changing nothing.
//
// THREE PARTS MAKE IT REAL, AND ALL THREE HAVE TO EXIST OR NONE OF THEM DO:
//
//   1. SETTING IT — src/lib/mail-bulk.ts 'snooze' / 'unsnooze', so it works on one conversation or
//      on a whole selection through the same path as every other mailbox operation.
//   2. HIDING IT — src/lib/mail-search.ts adds `(snoozed_until IS NULL OR snoozed_until <= NOW())`
//      to the INBOX predicate. This is the part that makes the feature mean anything: without it
//      the conversation stays on screen and "snooze" is decoration.
//   3. WAKING IT — wakeDueSnoozed() below, run by the server on a schedule. NOT by the browser: a
//      snooze that only ends when somebody happens to have the tab open is not a promise the
//      product can keep.
//
// TIME ZONE. Presets are computed in Asia/Kolkata, which is where the people using this work, and
// India has no daylight saving — so the offset is a constant +05:30 and the arithmetic is exact
// rather than approximately right twice a year. A caller in another zone passes its own offset.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';

// Declared before anything that uses them — `const` is not hoisted.
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) ? r : (r?.rows || [])) as T[];

/** Asia/Kolkata, in minutes ahead of UTC. Fixed: India observes no daylight saving. */
export const IST_OFFSET_MIN = 330;

/** The hour a "tomorrow" or "next week" snooze comes back. Start of the working day, not midnight. */
export const MORNING_HOUR = 8;
/** "Later today" lands here when the working day still has room for it. */
export const EVENING_HOUR = 18;

export interface SnoozePreset {
  key: 'later-today' | 'tomorrow' | 'this-weekend' | 'next-week' | 'custom';
  label: string;
  /** Null only for 'custom', which asks for a date and time. */
  at: Date | null;
  /** What the button says underneath — "Sat, 8:00 am". Empty for 'custom'. */
  when: string;
}

/** The local wall-clock parts of an instant, in a fixed-offset zone. */
function localParts(d: Date, offsetMin: number) {
  const shifted = new Date(d.getTime() + offsetMin * 60000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    min: shifted.getUTCMinutes(),
    dow: shifted.getUTCDay(), // 0 = Sunday
  };
}

/** An instant from local wall-clock parts, in a fixed-offset zone. */
function fromLocal(y: number, m: number, d: number, h: number, min: number, offsetMin: number): Date {
  return new Date(Date.UTC(y, m, d, h, min, 0, 0) - offsetMin * 60000);
}

function fmtWhen(d: Date, offsetMin: number): string {
  const p = localParts(d, offsetMin);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const ampm = p.h < 12 ? 'am' : 'pm';
  return days[p.dow] + ', ' + h12 + ':' + String(p.min).padStart(2, '0') + ' ' + ampm;
}

/**
 * The menu.
 *
 * "Later today" is dropped when there is no meaningful "later today" left — after the evening hour
 * it would mean "in a few minutes", which is not what anybody clicking it wants. A menu that offers
 * an option which does nothing useful is worse than a shorter menu.
 */
export function snoozePresets(now = new Date(), offsetMin = IST_OFFSET_MIN): SnoozePreset[] {
  const p = localParts(now, offsetMin);
  const out: SnoozePreset[] = [];

  if (p.h < EVENING_HOUR - 1) {
    const at = fromLocal(p.y, p.m, p.d, EVENING_HOUR, 0, offsetMin);
    out.push({ key: 'later-today', label: 'Later today', at, when: fmtWhen(at, offsetMin) });
  }

  const tomorrow = fromLocal(p.y, p.m, p.d + 1, MORNING_HOUR, 0, offsetMin);
  out.push({ key: 'tomorrow', label: 'Tomorrow', at: tomorrow, when: fmtWhen(tomorrow, offsetMin) });

  // Saturday morning. On a Saturday or Sunday this would be today or yesterday, so it is skipped.
  if (p.dow >= 1 && p.dow <= 4) {
    const daysToSat = 6 - p.dow;
    const sat = fromLocal(p.y, p.m, p.d + daysToSat, MORNING_HOUR, 0, offsetMin);
    out.push({ key: 'this-weekend', label: 'This weekend', at: sat, when: fmtWhen(sat, offsetMin) });
  }

  // Next Monday morning.
  const daysToMon = ((8 - p.dow) % 7) || 7;
  const mon = fromLocal(p.y, p.m, p.d + daysToMon, MORNING_HOUR, 0, offsetMin);
  out.push({ key: 'next-week', label: 'Next week', at: mon, when: fmtWhen(mon, offsetMin) });

  out.push({ key: 'custom', label: 'Pick a date and time', at: null, when: '' });
  return out;
}

/** Validation shared by every caller, so the API and the UI agree about what a snooze may be. */
export function validateSnoozeTime(iso: string, now = new Date()): { ok: true; at: Date } | { ok: false; error: string } {
  const t = Date.parse(String(iso || ''));
  if (!isFinite(t)) return { ok: false, error: 'That is not a time.' };
  const at = new Date(t);
  if (at.getTime() <= now.getTime()) {
    return { ok: false, error: 'That time has already passed, so the conversation would come straight back.' };
  }
  // Five years. Not a policy so much as a guard against a mistyped year putting mail out of reach
  // for a century with nothing on screen to explain where it went.
  if (at.getTime() > now.getTime() + 5 * 365 * 24 * 3600 * 1000) {
    return { ok: false, error: 'That is more than five years away. Pick something nearer.' };
  }
  return { ok: true, at };
}

export interface SnoozedRow {
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  snoozedUntil: string;
}

/** What is currently put away, so it is visible somewhere rather than simply gone. */
export async function listSnoozed(userId: string, limit = 100): Promise<SnoozedRow[]> {
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT ON (b.thread_id) b.thread_id, b.snoozed_until, m.subject, m.from_name, m.from_email
      FROM mail_box b JOIN mail_messages m ON m.id = b.message_id
      WHERE b.user_id = ${userId}::uuid AND b.snoozed_until IS NOT NULL AND b.snoozed_until > NOW()
      ORDER BY b.thread_id, b.created_at DESC
      LIMIT ${Math.min(Math.max(limit, 1), 500)}`);
    return rowsOf(r).map((x) => ({
      threadId: String(x.thread_id),
      subject: String(x.subject || '(no subject)'),
      fromName: String(x.from_name || ''),
      fromEmail: String(x.from_email || ''),
      snoozedUntil: new Date(x.snoozed_until).toISOString(),
    })).sort((a, b) => a.snoozedUntil.localeCompare(b.snoozedUntil));
  } catch (e: any) {
    console.error('[mail-snooze] list failed:', reasonOf(e));
    return [];
  }
}

/**
 * THE OPPORTUNISTIC SWEEP, AND WHY IT HAS TO EXIST HERE.
 *
 * The cron is the guarantee: /api/mail/snooze?action=wake runs on a schedule and brings back
 * everything due whether or not anybody is looking. On this deployment that schedule is DAILY —
 * Vercel's Hobby plan allows no finer — and a daily sweep would make "later today" mean "tomorrow
 * morning", which is a preset that lies about what it does.
 *
 * So the mailbox also sweeps when it is READ. This runs on the SERVER during the listing render,
 * not in a browser: it is bounded (200 rows), it is one indexed query when nothing is due, and it
 * is throttled per process so a burst of page loads cannot turn into a burst of writes. It does not
 * replace the cron — a mailbox nobody opens still wakes on schedule — it just means that in the
 * ordinary case, where the person snoozing something is the person who comes back to the inbox, the
 * conversation is there when they said it should be.
 */
let lastSweep = 0;
export const SWEEP_THROTTLE_MS = 60_000;

export async function maybeWakeDue(now = Date.now()): Promise<void> {
  if (now - lastSweep < SWEEP_THROTTLE_MS) return;
  lastSweep = now;
  try {
    await wakeDueSnoozed(200);
  } catch (e: any) {
    // Never allowed to break the listing it is attached to. The cron remains the guarantee.
    console.error('[mail-snooze] opportunistic sweep failed:', reasonOf(e));
  }
}

/**
 * WAKE EVERYTHING THAT IS DUE. Server-side, idempotent, and safe to run every minute.
 *
 * A woken conversation goes back to the INBOX and is marked UNREAD, because the whole point of
 * snoozing was to be shown it again — a message that comes back already read is a message you will
 * not notice coming back. It is not moved out of Trash or Spam: putting deleted mail back in the
 * inbox because of a snooze set before it was deleted would be the system overruling a later,
 * deliberate decision.
 *
 * Bounded per run so one enormous backlog cannot hold a transaction open; the next run picks up the
 * remainder, and the return value says whether there is a remainder.
 */
export async function wakeDueSnoozed(limit = 500): Promise<{ woken: number; more: boolean; error?: string }> {
  try {
    const r = await db.execute(sql`
      WITH due AS (
        SELECT user_id, message_id FROM mail_box
        WHERE snoozed_until IS NOT NULL AND snoozed_until <= NOW()
          AND folder NOT IN ('trash','spam')
        ORDER BY snoozed_until ASC
        LIMIT ${Math.min(Math.max(limit, 1), 5000)}
      )
      UPDATE mail_box b
         SET folder = 'inbox', is_read = false, snoozed_until = NULL
        FROM due
       WHERE b.user_id = due.user_id AND b.message_id = due.message_id
      RETURNING b.thread_id`);
    const woken = rowsOf(r).length;

    // A snoozed row sitting in Trash or Spam keeps its timestamp forever and would be re-counted on
    // every sweep. Clearing it is not a wake — the conversation stays where the person put it.
    await db.execute(sql`
      UPDATE mail_box SET snoozed_until = NULL
      WHERE snoozed_until IS NOT NULL AND snoozed_until <= NOW() AND folder IN ('trash','spam')`);

    if (woken) logEvent('info', 'mail.snooze.woken', { rows: woken });
    return { woken, more: woken >= Math.min(Math.max(limit, 1), 5000) };
  } catch (e: any) {
    // NOT SWALLOWED. A silent failure here means mail that was promised back never comes back, and
    // nothing on any screen would say so.
    const reason = reasonOf(e);
    console.error('[mail-snooze] wake sweep FAILED — snoozed mail has not come back:', reason);
    logEvent('error', 'mail.snooze.wake-failed', { message: reason });
    return { woken: 0, more: false, error: reason };
  }
}

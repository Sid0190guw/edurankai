// Founder page + direct line + booking. Everything here is admin-controlled
// (single settings row) and NOT linked from the public home/nav — reachable by
// its URL only until the founder decides to surface it. The "direct connect"
// deep-links to the founder's personal messaging number; the UI never names
// the messaging service.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

let ready: Promise<void> | null = null;
export function ensureFounderSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS founder_settings (
        id INT PRIMARY KEY DEFAULT 1,
        name TEXT, role TEXT, tagline TEXT, bio TEXT, photo_url TEXT,
        connect_number TEXT, connect_message TEXT, connect_label TEXT,
        calendar_url TEXT,
        is_public BOOLEAN NOT NULL DEFAULT true,
        show_in_nav BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`INSERT INTO founder_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      // Pricing + gating (added idempotently): direct text and consultancy are
      // paid by default (100 / 500 CHF). Set a price to 0 or turn a gate off to
      // make that channel free.
      await db.execute(sql`ALTER TABLE founder_settings ADD COLUMN IF NOT EXISTS text_price_chf NUMERIC NOT NULL DEFAULT 100`);
      await db.execute(sql`ALTER TABLE founder_settings ADD COLUMN IF NOT EXISTS consult_price_chf NUMERIC NOT NULL DEFAULT 500`);
      await db.execute(sql`ALTER TABLE founder_settings ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CHF'`);
      await db.execute(sql`ALTER TABLE founder_settings ADD COLUMN IF NOT EXISTS gate_text BOOLEAN NOT NULL DEFAULT true`);
      await db.execute(sql`ALTER TABLE founder_settings ADD COLUMN IF NOT EXISTS gate_consult BOOLEAN NOT NULL DEFAULT true`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS founder_bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT, email TEXT, phone TEXT,
        preferred TIMESTAMPTZ, duration_min INT DEFAULT 30, note TEXT,
        handled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db.execute(sql`ALTER TABLE founder_bookings ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'consult'`);
      await db.execute(sql`ALTER TABLE founder_bookings ADD COLUMN IF NOT EXISTS order_id TEXT`);
      await db.execute(sql`ALTER TABLE founder_bookings ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false`);
      await db.execute(sql`ALTER TABLE founder_bookings ADD COLUMN IF NOT EXISTS amount_paise INT`);
      await db.execute(sql`ALTER TABLE founder_bookings ADD COLUMN IF NOT EXISTS currency TEXT`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS founder_bookings_created_idx ON founder_bookings(created_at DESC)`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

export interface FounderSettings {
  name: string; role: string; tagline: string; bio: string; photoUrl: string;
  connectNumber: string; connectMessage: string; connectLabel: string;
  calendarUrl: string; isPublic: boolean; showInNav: boolean;
  textPriceChf: number; consultPriceChf: number; currency: string;
  gateText: boolean; gateConsult: boolean;
}

const DEFAULTS: FounderSettings = {
  name: '', role: 'Founder', tagline: '', bio: '', photoUrl: '',
  connectNumber: '', connectMessage: 'Hello — I found you via EduRankAI and would like to connect.',
  connectLabel: 'Message me directly', calendarUrl: '', isPublic: true, showInNav: false,
  textPriceChf: 100, consultPriceChf: 500, currency: 'CHF', gateText: true, gateConsult: true,
};

export async function getFounder(): Promise<FounderSettings> {
  try {
    await ensureFounderSchema();
    const r = rows(await db.execute(sql`SELECT * FROM founder_settings WHERE id = 1 LIMIT 1`))[0];
    if (!r) return { ...DEFAULTS };
    return {
      name: r.name || '', role: r.role || 'Founder', tagline: r.tagline || '', bio: r.bio || '',
      photoUrl: r.photo_url || '', connectNumber: r.connect_number || '',
      connectMessage: r.connect_message || DEFAULTS.connectMessage, connectLabel: r.connect_label || DEFAULTS.connectLabel,
      calendarUrl: r.calendar_url || '', isPublic: r.is_public !== false, showInNav: r.show_in_nav === true,
      textPriceChf: r.text_price_chf != null ? Number(r.text_price_chf) : 100,
      consultPriceChf: r.consult_price_chf != null ? Number(r.consult_price_chf) : 500,
      currency: r.currency || 'CHF', gateText: r.gate_text !== false, gateConsult: r.gate_consult !== false,
    };
  } catch { return { ...DEFAULTS }; }
}

export async function saveFounder(p: FounderSettings): Promise<void> {
  await ensureFounderSchema();
  await db.execute(sql`UPDATE founder_settings SET
    name=${p.name}, role=${p.role}, tagline=${p.tagline}, bio=${p.bio}, photo_url=${p.photoUrl},
    connect_number=${p.connectNumber}, connect_message=${p.connectMessage}, connect_label=${p.connectLabel},
    calendar_url=${p.calendarUrl}, is_public=${p.isPublic}, show_in_nav=${p.showInNav},
    text_price_chf=${p.textPriceChf}, consult_price_chf=${p.consultPriceChf}, currency=${p.currency},
    gate_text=${p.gateText}, gate_consult=${p.gateConsult}, updated_at=NOW()
    WHERE id = 1`);
}

// Create a pending service record (text or consult). Returns the booking id so
// the payment can be linked to it and finalised on verify.
export async function createServicePending(o: {
  kind: 'text' | 'consult'; name: string; email: string; phone?: string;
  preferred?: string | null; durationMin?: number; note?: string;
  orderId?: string | null; amountPaise?: number; currency?: string; paid?: boolean;
}): Promise<string> {
  await ensureFounderSchema();
  const r = rows(await db.execute(sql`
    INSERT INTO founder_bookings (kind, name, email, phone, preferred, duration_min, note, order_id, amount_paise, currency, paid)
    VALUES (${o.kind}, ${o.name}, ${o.email}, ${o.phone || null}, ${o.preferred || null}, ${o.durationMin || 30},
            ${o.note || null}, ${o.orderId || null}, ${o.amountPaise || null}, ${o.currency || null}, ${!!o.paid})
    RETURNING id`));
  return r[0]?.id;
}

export async function markServicePaid(orderId: string): Promise<any | null> {
  await ensureFounderSchema();
  const r = rows(await db.execute(sql`UPDATE founder_bookings SET paid = true WHERE order_id = ${orderId} RETURNING *`));
  return r[0] || null;
}

export interface FounderRevenue { textPaid: number; consultPaid: number; textRevenuePaise: number; consultRevenuePaise: number; requests: number; }
export async function getRevenue(): Promise<FounderRevenue> {
  try {
    await ensureFounderSchema();
    const r = rows(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE kind='text' AND paid) AS text_paid,
        COUNT(*) FILTER (WHERE kind='consult' AND paid) AS consult_paid,
        COALESCE(SUM(amount_paise) FILTER (WHERE kind='text' AND paid),0) AS text_rev,
        COALESCE(SUM(amount_paise) FILTER (WHERE kind='consult' AND paid),0) AS consult_rev,
        COUNT(*) AS requests
      FROM founder_bookings`))[0] || {};
    return { textPaid: Number(r.text_paid||0), consultPaid: Number(r.consult_paid||0),
      textRevenuePaise: Number(r.text_rev||0), consultRevenuePaise: Number(r.consult_rev||0), requests: Number(r.requests||0) };
  } catch { return { textPaid:0, consultPaid:0, textRevenuePaise:0, consultRevenuePaise:0, requests:0 }; }
}

// Build the direct-connect deep link. Number is stored as digits WITH country
// code (no plus). The messaging service is never named in the UI.
export function directConnectHref(number: string, message: string): string {
  const digits = (number || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  return 'https://wa.me/' + digits + (message ? '?text=' + encodeURIComponent(message) : '');
}

export async function addBooking(b: { name: string; email: string; phone?: string; preferred?: string | null; durationMin?: number; note?: string }): Promise<void> {
  await ensureFounderSchema();
  await db.execute(sql`INSERT INTO founder_bookings (name, email, phone, preferred, duration_min, note)
    VALUES (${b.name}, ${b.email}, ${b.phone || null}, ${b.preferred || null}, ${b.durationMin || 30}, ${b.note || null})`);
}

export async function listBookings(limit = 200): Promise<any[]> {
  try {
    await ensureFounderSchema();
    return rows(await db.execute(sql`SELECT * FROM founder_bookings ORDER BY created_at DESC LIMIT ${limit}`));
  } catch { return []; }
}

export async function setBookingHandled(id: string, handled: boolean): Promise<void> {
  await ensureFounderSchema();
  await db.execute(sql`UPDATE founder_bookings SET handled = ${handled} WHERE id = ${id}`);
}

export async function deleteBooking(id: string): Promise<void> {
  await ensureFounderSchema();
  await db.execute(sql`DELETE FROM founder_bookings WHERE id = ${id}`);
}

// Google Calendar "add event" link — lands the meeting on the founder's own
// calendar with one click. No API, no OAuth.
export function gcalLink(title: string, startISO: string, mins: number, details: string): string {
  try {
    const s = new Date(startISO); if (isNaN(s.getTime())) return '';
    const e = new Date(s.getTime() + (mins || 30) * 60000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title)
      + '&dates=' + fmt(s) + '/' + fmt(e) + '&details=' + encodeURIComponent(details || '');
  } catch { return ''; }
}

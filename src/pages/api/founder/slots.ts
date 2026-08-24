// GET /api/founder/slots?date=YYYY-MM-DD  -> live open consultation slots for
// that date in the founder's timezone (availability minus already-booked).
// GET /api/founder/slots?days=14  -> which of the next N dates have any opening
// (for the calendar strip). Public, read-only.
//
// ONE DATABASE CONTEXT FOR THE WHOLE REQUEST, WHATEVER IT ASKS FOR.
//
// This called getFounder() and then getAvailableSlots() once per day — and getAvailableSlots read
// the settings row and the booked-slot set itself, every time. Twenty-one days meant forty-two round
// trips for two answers that do not vary by date, and the endpoint answered in 5.1-5.2 SECONDS on
// the live site, reproducibly, four probes running.
//
// Neither read depends on the date, so both are lifted out. src/lib/founder.ts now exposes the pair
// as a context and the slot arithmetic as a pure function of it; the loop below is arithmetic only.
import type { APIRoute } from 'astro';
import { slotContext, slotsForDate } from '@/lib/founder';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }

export const GET: APIRoute = async ({ url }) => {
  const date = url.searchParams.get('date') || '';
  const ctx = await slotContext();
  const f = ctx.settings;
  if (date) {
    return json({ ok: true, tz: f.timezone, duration: f.slotMinutes, slots: slotsForDate(ctx, date) });
  }
  // Availability map for the next N days (which days are open at all).
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days') || 21)));
  const tz = f.timezone || 'Asia/Kolkata';
  const out: { date: string; label: string; weekday: string; open: number }[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const parts: any = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
    const ds = parts.year + '-' + parts.month + '-' + parts.day;
    const slots = slotsForDate(ctx, ds);
    const lbl: any = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d).forEach((p) => { lbl[p.type] = p.value; });
    out.push({ date: ds, label: lbl.month + ' ' + lbl.day, weekday: lbl.weekday, open: slots.length });
  }
  return json({ ok: true, tz, duration: f.slotMinutes, days: out });
};

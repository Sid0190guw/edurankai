// POST /api/founder/book — a visitor requests a call with the founder.
// No login required. Stored for the founder to action from /admin/founder,
// where each request carries a one-click "add to calendar" link.
import type { APIRoute } from 'astro';
import { addBooking } from '@/lib/founder';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request }) => {
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const name = (b.name || '').toString().trim().slice(0, 120);
  const email = (b.email || '').toString().trim().slice(0, 200);
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: 'Name and a valid email are required.' }, 400);
  const durationMin = [15, 30, 45, 60].includes(Number(b.durationMin)) ? Number(b.durationMin) : 30;
  let preferred: string | null = null;
  if (b.preferred) { const d = new Date(b.preferred); if (!isNaN(d.getTime())) preferred = d.toISOString(); }
  const rawDocs = (b.docsUrl || '').toString().trim().slice(0, 500);
  const docsUrl = /^https?:\/\/\S+\.\S+/.test(rawDocs) ? rawDocs : null;
  try {
    await addBooking({ name, email, phone: (b.phone || '').toString().slice(0, 40), preferred, durationMin, note: (b.note || '').toString().slice(0, 1000), docsUrl });
    return json({ ok: true });
  } catch (e: any) { return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500); }
};

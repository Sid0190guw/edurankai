// GET /api/mail/dns-check?domain=edurankai.in
// Looks up SPF (TXT @), DMARC (TXT _dmarc), DKIM common selectors, and MX,
// using Cloudflare DNS-over-HTTPS so we don't need a DNS lib on the server.
// Returns a verdict per record so the admin Mail Health page can show pass/fail.
import type { APIRoute } from 'astro';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

async function dohTxt(name: string): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=TXT', {
      headers: { Accept: 'application/dns-json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return [];
    const d = await r.json() as any;
    return (d?.Answer || []).map((a: any) => (a.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
  } catch (_) { return []; }
}
async function dohMx(name: string): Promise<{ priority: number; host: string }[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=MX', {
      headers: { Accept: 'application/dns-json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return [];
    const d = await r.json() as any;
    return (d?.Answer || []).map((a: any) => {
      const parts = (a.data || '').toString().split(/\s+/);
      return { priority: Number(parts[0] || 0), host: (parts[1] || '').replace(/\.$/, '') };
    });
  } catch (_) { return []; }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);
  const url = new URL(request.url);
  const domain = (url.searchParams.get('domain') || 'edurankai.in').trim();
  if (!/^[a-z0-9.\-]+$/i.test(domain) || domain.length > 200) return json({ ok: false, error: 'invalid domain' }, 400);

  // SPF
  const apexTxt = await dohTxt(domain);
  const spfRecords = apexTxt.filter(t => /^v=spf1\b/i.test(t));
  const spf = {
    present: spfRecords.length > 0,
    multiple: spfRecords.length > 1,
    record: spfRecords[0] || null,
    note: spfRecords.length > 1 ? 'Multiple SPF records found — providers will treat the domain as failing SPF. Merge them into ONE.' : null,
  };

  // DMARC
  const dmarcTxt = await dohTxt('_dmarc.' + domain);
  const dmarcRecords = dmarcTxt.filter(t => /^v=DMARC1\b/i.test(t));
  const dmarc = {
    present: dmarcRecords.length > 0,
    record: dmarcRecords[0] || null,
    policy: (dmarcRecords[0] || '').match(/\bp=(none|quarantine|reject)/i)?.[1]?.toLowerCase() || null,
  };

  // DKIM — try the four most common selectors so admins don't need to guess.
  const SELECTORS = ['default', 'google', 'k1', 's1', 'selector1', 'selector2', 'mail', 'smtp'];
  const dkimHits: { selector: string; record: string }[] = [];
  for (const sel of SELECTORS) {
    const recs = await dohTxt(sel + '._domainkey.' + domain);
    const hit = recs.find(t => /\bv=DKIM1\b/i.test(t) || /\bp=[A-Za-z0-9+/=]+/.test(t));
    if (hit) dkimHits.push({ selector: sel, record: hit });
  }
  const dkim = { present: dkimHits.length > 0, selectors: dkimHits };

  // MX
  const mx = await dohMx(domain);

  return json({ ok: true, domain, spf, dmarc, dkim, mx });
};

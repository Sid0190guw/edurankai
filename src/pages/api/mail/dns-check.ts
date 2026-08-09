// GET /api/mail/dns-check?domain=edurankai.in
// Looks up SPF (TXT @), DMARC (TXT _dmarc), DKIM common selectors, and MX,
// using Cloudflare DNS-over-HTTPS so we don't need a DNS lib on the server.
// Returns a verdict per record so the admin Mail Health page can show pass/fail.
import type { APIRoute } from 'astro';
import { can } from '@/lib/auth/permissions';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}

// A LOOKUP THAT DID NOT HAPPEN IS NOT AN ABSENT RECORD, AND HERE THAT DIFFERENCE IS DANGEROUS.
// Both helpers used to end in `catch (_) { return [] }`, and an empty array is exactly what a domain
// with no SPF record produces - so a resolver timeout, a 5xx from Cloudflare or an aborted request
// rendered "SPF - no v=spf1 record found" as a statement of fact about the operator's DNS. The
// documented next step on that screen is to ADD a record, and this file's own note says a SECOND
// SPF record makes providers treat the whole domain as failing SPF. A four-second timeout could
// therefore talk an operator into breaking mail delivery for the company.
//
// Each lookup now reports whether it RAN. `checked: false` must be rendered as "could not be
// checked", never as a verdict, and the reasons travel back to the caller in `unchecked`.
type Lookup<T> = { checked: boolean; values: T[]; error: string | null };

async function dohTxt(name: string): Promise<Lookup<string>> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=TXT', {
      headers: { Accept: 'application/dns-json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return { checked: false, values: [], error: 'the DNS resolver answered HTTP ' + r.status };
    const d = await r.json() as any;
    const values = (d?.Answer || []).map((a: any) => (a.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
    return { checked: true, values, error: null };
  } catch (e: any) {
    return { checked: false, values: [], error: e?.name === 'AbortError' ? 'the DNS lookup timed out' : String(e?.message || 'the DNS lookup failed') };
  }
}
async function dohMx(name: string): Promise<Lookup<{ priority: number; host: string }>> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=MX', {
      headers: { Accept: 'application/dns-json' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return { checked: false, values: [], error: 'the DNS resolver answered HTTP ' + r.status };
    const d = await r.json() as any;
    const values = (d?.Answer || []).map((a: any) => {
      const parts = (a.data || '').toString().split(/\s+/);
      return { priority: Number(parts[0] || 0), host: (parts[1] || '').replace(/\.$/, '') };
    });
    return { checked: true, values, error: null };
  } catch (e: any) {
    return { checked: false, values: [], error: e?.name === 'AbortError' ? 'the DNS lookup timed out' : String(e?.message || 'the DNS lookup failed') };
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  // The lowest-value of the mail routes (public DNS records for the sending domain), converted in the
  // same commit as the other four precisely BECAUSE it shares their gate: four routes asking one
  // question and a fifth asking another is how they drift apart.
  //
  // `mail.manage` is held by exactly the ten non-applicant built-in roles, which is who
  // `role !== 'applicant'` admitted. Population unchanged. 403 kept as-is — this route always
  // answered 403 rather than 401 and the status code is not part of this sprint.
  if (!can((locals as any).user, 'mail.manage')) return json({ ok: false, error: 'forbidden' }, 403);
  const url = new URL(request.url);
  const domain = (url.searchParams.get('domain') || 'edurankai.in').trim();
  if (!/^[a-z0-9.\-]+$/i.test(domain) || domain.length > 200) return json({ ok: false, error: 'invalid domain' }, 400);

  // Every reason a question could not be answered, so nothing below has to guess.
  const unchecked: string[] = [];

  // SPF
  const apexTxt = await dohTxt(domain);
  if (!apexTxt.checked) unchecked.push('SPF: ' + apexTxt.error);
  const spfRecords = apexTxt.values.filter((t) => /^v=spf1\b/i.test(t));
  const spf = {
    checked: apexTxt.checked,
    present: spfRecords.length > 0,
    multiple: spfRecords.length > 1,
    record: spfRecords[0] || null,
    note: spfRecords.length > 1 ? 'Multiple SPF records found - providers will treat the domain as failing SPF. Merge them into ONE.' : null,
  };

  // DMARC
  const dmarcTxt = await dohTxt('_dmarc.' + domain);
  if (!dmarcTxt.checked) unchecked.push('DMARC: ' + dmarcTxt.error);
  const dmarcRecords = dmarcTxt.values.filter((t) => /^v=DMARC1\b/i.test(t));
  const dmarc = {
    checked: dmarcTxt.checked,
    present: dmarcRecords.length > 0,
    record: dmarcRecords[0] || null,
    policy: (dmarcRecords[0] || '').match(/\bp=(none|quarantine|reject)/i)?.[1]?.toLowerCase() || null,
  };

  // DKIM - the most common selectors, so an admin does not have to guess. "Not found at these
  // selectors" is NOT "no DKIM": a provider using its own selector name is invisible to this list,
  // which is why the tried list travels back with the answer.
  const SELECTORS = ['default', 'google', 'k1', 's1', 'selector1', 'selector2', 'mail', 'smtp'];
  const dkimHits: { selector: string; record: string }[] = [];
  let dkimChecked = false;
  for (const sel of SELECTORS) {
    const recs = await dohTxt(sel + '._domainkey.' + domain);
    if (recs.checked) dkimChecked = true;
    const hit = recs.values.find((t) => /\bv=DKIM1\b/i.test(t) || /\bp=[A-Za-z0-9+/=]+/.test(t));
    if (hit) dkimHits.push({ selector: sel, record: hit });
  }
  if (!dkimChecked) unchecked.push('DKIM: not one selector lookup completed');
  const dkim = { checked: dkimChecked, present: dkimHits.length > 0, selectors: dkimHits, triedSelectors: SELECTORS };

  // MX
  const mxLookup = await dohMx(domain);
  if (!mxLookup.checked) unchecked.push('MX: ' + mxLookup.error);
  const mx = mxLookup.values;

  return json({ ok: true, domain, spf, dmarc, dkim, mx, mxChecked: mxLookup.checked, unchecked });
};

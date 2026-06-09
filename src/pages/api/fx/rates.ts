import type { APIRoute } from 'astro';
import { fxRateToInr } from '@/lib/fx';

// Live display-side FX. Returns how many units of each target currency equal one
// unit of the base (default CHF), so the client can show any CHF price in the
// learner's own currency at live ECB rates. Cross-rates are derived via INR
// using the existing frankfurter-backed fx lib (one cached fetch per code).
const TARGETS = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED', 'JPY', 'CHF', 'AUD', 'CAD'];

function json(b: any, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } });
}

export const GET: APIRoute = async ({ url }) => {
  const base = (url.searchParams.get('base') || 'CHF').toUpperCase();
  try {
    // rate-to-INR for base and every target; cross-rate(base->t) = inr(base)/inr(t)
    const baseToInr = (await fxRateToInr(base)).rate;
    const out: Record<string, number> = {};
    let live = true;
    for (const t of TARGETS) {
      if (t === base) { out[t] = 1; continue; }
      const r = await fxRateToInr(t);
      if (!r.live) live = false;
      // 1 base = baseToInr INR ; 1 t = r.rate INR ; so 1 base = baseToInr/r.rate units of t
      out[t] = r.rate > 0 ? baseToInr / r.rate : 0;
    }
    return json({ ok: true, base, rates: out, live, fetchedAt: new Date().toISOString() });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e).slice(0, 160) }, 500);
  }
};

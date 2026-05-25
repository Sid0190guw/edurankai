// Live foreign-exchange helper.
// Uses frankfurter.app (free, ECB data, no auth) to convert non-INR display
// prices to INR for Razorpay settlement. Caches the rate per-process for 1
// hour so we don't hit the API on every request.

interface CachedRate {
  rate: number;
  fetchedAt: number;
  date: string;
}

const cache = new Map<string, CachedRate>();
const TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Returns how many INR equal 1 unit of `from`. e.g. fxRate('CHF') -> ~95.34.
 * Falls back to a hardcoded sensible value if the API is unreachable so the
 * checkout doesn't hard-error.
 */
export async function fxRateToInr(from: string): Promise<{ rate: number; date: string; live: boolean }> {
  const code = (from || 'INR').toUpperCase();
  if (code === 'INR') return { rate: 1, date: new Date().toISOString().substring(0, 10), live: true };

  const cached = cache.get(code);
  if (cached && (Date.now() - cached.fetchedAt) < TTL_MS) {
    return { rate: cached.rate, date: cached.date, live: true };
  }

  try {
    const url = 'https://api.frankfurter.app/latest?from=' + encodeURIComponent(code) + '&to=INR';
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('fx http ' + r.status);
    const d = await r.json() as any;
    const rate = Number(d?.rates?.INR);
    const date = (d?.date || new Date().toISOString().substring(0, 10)).toString();
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('fx invalid rate');
    cache.set(code, { rate, fetchedAt: Date.now(), date });
    return { rate, date, live: true };
  } catch (e: any) {
    // Conservative fallbacks for the most common currencies we expect; chosen
    // slightly above mid-market so we under-charge rather than over-charge.
    const FALLBACK: Record<string, number> = {
      CHF: 95, USD: 84, EUR: 90, GBP: 106, SGD: 62, AED: 23, JPY: 0.56,
    };
    const rate = FALLBACK[code] || 1;
    return { rate, date: new Date().toISOString().substring(0, 10), live: false };
  }
}

/**
 * Convert a price expressed in the display currency's minor units (e.g. 100 =
 * 1 CHF in centimes) to INR paise at the current live rate.
 *
 * Returns the integer paise amount + the rate used + whether it was a live
 * fetch (false if the FX API failed and we fell back).
 */
export async function convertToInrPaise(
  fromCurrency: string,
  amountInMinorUnits: number,
): Promise<{ paise: number; rate: number; date: string; live: boolean }> {
  const code = (fromCurrency || 'INR').toUpperCase();
  if (code === 'INR') {
    return { paise: Math.max(0, Math.floor(amountInMinorUnits)), rate: 1, date: new Date().toISOString().substring(0, 10), live: true };
  }
  const { rate, date, live } = await fxRateToInr(code);
  // 100 minor units = 1 major unit of source currency
  // amount-in-INR = (amountInMinorUnits / 100) * rate (INR per source unit)
  // amount-in-paise = amount-in-INR * 100 = amountInMinorUnits * rate
  const paise = Math.max(100, Math.round(amountInMinorUnits * rate));
  return { paise, rate, date, live };
}

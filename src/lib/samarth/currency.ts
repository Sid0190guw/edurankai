// Currencies, money formatting and the booking-fee breakdown. PURE: no imports, no database, no
// Node built-ins, so the fee page, the applicant workspace and the admin fee editor all compute the
// same figures.
//
// WHICH CURRENCIES, AND WHY THESE. A fee may be PRICED in any currency listed here. Every one of
// them is a currency the European Central Bank publishes a daily reference rate for, which is the
// feed src/lib/fx.ts reads. A currency the feed does not carry could only ever be converted at a
// guessed rate, and a guessed rate on somebody's payment is not acceptable, so it is not offered.
//
// HOW IT IS CHARGED. The gateway charges the INR equivalent, converted at the live reference rate
// at the moment the order is created, and the applicant is shown that rate and the INR figure
// before they pay. Native charging in each currency is deliberately not used yet: /admin/finance
// adds payments.amount_paise together as rupees, so a USD amount in that column would silently
// corrupt every revenue total on that screen. See docs/samarth/PAYMENT_ARCHITECTURE.md.

export interface CurrencyDef {
  code: string;
  name: string;
  /** ISO 4217 minor-unit exponent: 2 for cents, 0 for currencies with no minor unit. */
  exponent: number;
}

export const CURRENCIES: readonly CurrencyDef[] = [
  { code: 'INR', name: 'Indian rupee', exponent: 2 },
  { code: 'USD', name: 'US dollar', exponent: 2 },
  { code: 'EUR', name: 'Euro', exponent: 2 },
  { code: 'GBP', name: 'Pound sterling', exponent: 2 },
  { code: 'AUD', name: 'Australian dollar', exponent: 2 },
  { code: 'CAD', name: 'Canadian dollar', exponent: 2 },
  { code: 'CHF', name: 'Swiss franc', exponent: 2 },
  { code: 'SGD', name: 'Singapore dollar', exponent: 2 },
  { code: 'JPY', name: 'Japanese yen', exponent: 0 },
  { code: 'CNY', name: 'Chinese yuan', exponent: 2 },
  { code: 'HKD', name: 'Hong Kong dollar', exponent: 2 },
  { code: 'KRW', name: 'South Korean won', exponent: 0 },
  { code: 'NZD', name: 'New Zealand dollar', exponent: 2 },
  { code: 'SEK', name: 'Swedish krona', exponent: 2 },
  { code: 'NOK', name: 'Norwegian krone', exponent: 2 },
  { code: 'DKK', name: 'Danish krone', exponent: 2 },
  { code: 'PLN', name: 'Polish zloty', exponent: 2 },
  { code: 'CZK', name: 'Czech koruna', exponent: 2 },
  { code: 'HUF', name: 'Hungarian forint', exponent: 2 },
  { code: 'RON', name: 'Romanian leu', exponent: 2 },
  { code: 'BGN', name: 'Bulgarian lev', exponent: 2 },
  { code: 'ISK', name: 'Icelandic krona', exponent: 0 },
  { code: 'ILS', name: 'Israeli new shekel', exponent: 2 },
  { code: 'MYR', name: 'Malaysian ringgit', exponent: 2 },
  { code: 'THB', name: 'Thai baht', exponent: 2 },
  { code: 'IDR', name: 'Indonesian rupiah', exponent: 2 },
  { code: 'PHP', name: 'Philippine peso', exponent: 2 },
  { code: 'MXN', name: 'Mexican peso', exponent: 2 },
  { code: 'BRL', name: 'Brazilian real', exponent: 2 },
  { code: 'ZAR', name: 'South African rand', exponent: 2 },
  { code: 'TRY', name: 'Turkish lira', exponent: 2 },
];

/** The currency the gateway settles in. */
export const SETTLEMENT_CURRENCY = 'INR';

export function currencyDef(code: unknown): CurrencyDef | null {
  const c = String(code || '').toUpperCase();
  return CURRENCIES.find((x) => x.code === c) || null;
}

export function isSupportedCurrency(code: unknown): boolean {
  return !!currencyDef(code);
}

const EURO_AREA = ['AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES'];
const COUNTRY_CURRENCY: Record<string, string> = {
  IN: 'INR', US: 'USD', GB: 'GBP', AU: 'AUD', CA: 'CAD', CH: 'CHF', LI: 'CHF', SG: 'SGD', JP: 'JPY', CN: 'CNY',
  HK: 'HKD', KR: 'KRW', NZ: 'NZD', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON',
  BG: 'BGN', IS: 'ISK', IL: 'ILS', MY: 'MYR', TH: 'THB', ID: 'IDR', PH: 'PHP', MX: 'MXN', BR: 'BRL', ZA: 'ZAR', TR: 'TRY',
};

/** A sensible default for a country: its own currency when supported, otherwise US dollars. */
export function suggestCurrency(country: unknown): string {
  const c = String(country || '').toUpperCase();
  if (EURO_AREA.includes(c)) return 'EUR';
  return COUNTRY_CURRENCY[c] || 'USD';
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) { parts.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) parts.unshift(rest);
  return parts.join(',') + ',' + last3;
}

/**
 * Minor units to a display string: "INR 2,50,000.00" style becomes "₹2,50,000" for rupees,
 * and "USD 1,250.00" for everything else. The ISO code is printed for every non-rupee currency on
 * purpose: "$" alone does not say which dollar.
 */
export function formatMoney(minor: number | string | null | undefined, code: string): string {
  const def = currencyDef(code);
  const n = Number(minor);
  if (!def || minor == null || !Number.isFinite(n)) return '';
  const neg = n < 0;
  const abs = Math.round(Math.abs(n));
  const div = Math.pow(10, def.exponent);
  const whole = String(Math.floor(abs / div));
  const frac = def.exponent ? String(abs % div).padStart(def.exponent, '0') : '';
  if (def.code === 'INR') {
    return (neg ? '-' : '') + '₹' + groupIndian(whole) + (frac && frac !== '00' ? '.' + frac : '');
  }
  return (neg ? '-' : '') + def.code + ' ' + groupWestern(whole) + (frac ? '.' + frac : '');
}

/** A typed amount ("1,250.50") in major units to minor units, refusing more decimals than the currency has. */
export function parseMajorToMinor(input: unknown, code: string): number | null {
  const def = currencyDef(code);
  if (!def) return null;
  const s = String(input ?? '').replace(/[,\s]/g, '').replace(/^₹/, '');
  const re = def.exponent ? new RegExp('^\\d+(\\.\\d{1,' + def.exponent + '})?$') : /^\d+$/;
  if (!re.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const minor = Number(w) * Math.pow(10, def.exponent) + (def.exponent ? Number((f + '0'.repeat(def.exponent)).slice(0, def.exponent)) : 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units back to a plain decimal string for an input field ("1250.50"). */
export function minorToMajorString(minor: number | string | null | undefined, code: string): string {
  const def = currencyDef(code);
  const n = Number(minor);
  if (!def || minor == null || !Number.isFinite(n)) return '';
  if (!def.exponent) return String(Math.round(n));
  const div = Math.pow(10, def.exponent);
  return Math.floor(n / div) + '.' + String(Math.round(n) % div).padStart(def.exponent, '0');
}

// -------------------------------------------------------------------------------------------------
// THE FEE BREAKDOWN
// -------------------------------------------------------------------------------------------------

/** none: no tax line. exclusive: tax is added on top. inclusive: the amount already contains it. */
export type TaxMode = 'none' | 'exclusive' | 'inclusive';
export const TAX_MODES: readonly { value: TaxMode; label: string }[] = [
  { value: 'none', label: 'No tax applies' },
  { value: 'exclusive', label: 'Tax is added to the amount' },
  { value: 'inclusive', label: 'The amount already includes tax' },
];

export interface FeeTerms {
  amountMinor: number;
  currency: string;
  taxMode: TaxMode | string;
  taxLabel?: string | null;
  /** Basis points: 1800 = 18%. */
  taxRateBp?: number | null;
  /** A payment-processing charge passed on to the payer, in basis points of the amount after tax. 0 = none. */
  processingBp?: number | null;
}

export interface BreakdownLine { label: string; minor: number }
export interface FeeBreakdown {
  currency: string;
  /** The amount before tax. */
  base: number;
  tax: number;
  processing: number;
  total: number;
  lines: BreakdownLine[];
}

export function feeBreakdown(t: FeeTerms, baseLabel = 'Consultation booking fee'): FeeBreakdown {
  const amount = Math.max(0, Math.round(Number(t.amountMinor) || 0));
  const rate = Math.max(0, Math.min(10000, Math.round(Number(t.taxRateBp) || 0)));
  const procBp = Math.max(0, Math.min(1000, Math.round(Number(t.processingBp) || 0)));
  const label = String(t.taxLabel || 'Tax').trim() || 'Tax';
  const pct = (bp: number) => (bp / 100).toFixed(bp % 100 === 0 ? 0 : 2) + '%';
  let base = amount;
  let tax = 0;
  if (t.taxMode === 'exclusive' && rate > 0) {
    tax = Math.round((amount * rate) / 10000);
  } else if (t.taxMode === 'inclusive' && rate > 0) {
    base = Math.round((amount * 10000) / (10000 + rate));
    tax = amount - base;
  }
  const afterTax = base + tax;
  const processing = procBp > 0 ? Math.round((afterTax * procBp) / 10000) : 0;
  const lines: BreakdownLine[] = [{ label: baseLabel, minor: base }];
  if (tax > 0) lines.push({ label: label + ' (' + pct(rate) + (t.taxMode === 'inclusive' ? ', included' : '') + ')', minor: tax });
  if (processing > 0) lines.push({ label: 'Payment processing charge (' + pct(procBp) + ')', minor: processing });
  return { currency: String(t.currency || '').toUpperCase(), base, tax, processing, total: afterTax + processing, lines };
}

/**
 * The INR paise the gateway will charge for `minor` units of `code` at `inrPerUnit`.
 * Rounded to the nearest paisa. Returns null when the inputs cannot produce a real charge.
 */
export function toSettlementPaise(minor: number, code: string, inrPerUnit: number): number | null {
  const def = currencyDef(code);
  if (!def || !Number.isFinite(minor) || minor <= 0) return null;
  if (def.code === 'INR') return Math.round(minor);
  if (!Number.isFinite(inrPerUnit) || inrPerUnit <= 0) return null;
  const major = minor / Math.pow(10, def.exponent);
  const paise = Math.round(major * inrPerUnit * 100);
  return paise >= 100 ? paise : null;
}

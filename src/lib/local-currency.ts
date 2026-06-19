// Maps a country (name or ISO code) to its currency, and converts an INR-paise
// amount into both the platform base currency (CHF) and the applicant's local
// currency at the live FX rate. The wallet ledger is stored in INR paise (that
// is what Razorpay settles), so every display is derived from that single
// source of truth.
import { fxRateToInr } from '@/lib/fx';

export interface Currency { code: string; symbol: string; name: string; }

// Currency by ISO-3166 alpha-2. Covers the vast majority of applicant countries;
// anything not listed falls back to USD so a value is always shown.
const BY_ISO: Record<string, Currency> = {
  IN: { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  US: { code: 'USD', symbol: '$', name: 'US Dollar' }, GB: { code: 'GBP', symbol: '£', name: 'Pound Sterling' },
  CH: { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc' }, CA: { code: 'CAD', symbol: 'CA$', name: 'Canadian Dollar' },
  AU: { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' }, NZ: { code: 'NZD', symbol: 'NZ$', name: 'NZ Dollar' },
  SG: { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' }, AE: { code: 'AED', symbol: 'AED', name: 'UAE Dirham' },
  SA: { code: 'SAR', symbol: 'SAR', name: 'Saudi Riyal' }, QA: { code: 'QAR', symbol: 'QAR', name: 'Qatari Riyal' },
  JP: { code: 'JPY', symbol: '¥', name: 'Japanese Yen' }, CN: { code: 'CNY', symbol: 'CN¥', name: 'Chinese Yuan' },
  HK: { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' }, KR: { code: 'KRW', symbol: '₩', name: 'Korean Won' },
  MY: { code: 'MYR', symbol: 'RM', name: 'Ringgit' }, ID: { code: 'IDR', symbol: 'Rp', name: 'Rupiah' },
  TH: { code: 'THB', symbol: '฿', name: 'Thai Baht' }, PH: { code: 'PHP', symbol: '₱', name: 'Philippine Peso' },
  VN: { code: 'VND', symbol: '₫', name: 'Dong' }, PK: { code: 'PKR', symbol: 'Rs', name: 'Pakistani Rupee' },
  BD: { code: 'BDT', symbol: '৳', name: 'Taka' }, LK: { code: 'LKR', symbol: 'Rs', name: 'Sri Lankan Rupee' },
  NP: { code: 'NPR', symbol: 'Rs', name: 'Nepalese Rupee' }, BT: { code: 'BTN', symbol: 'Nu.', name: 'Ngultrum' },
  EU: { code: 'EUR', symbol: '€', name: 'Euro' },
  DE: { code: 'EUR', symbol: '€', name: 'Euro' }, FR: { code: 'EUR', symbol: '€', name: 'Euro' },
  IT: { code: 'EUR', symbol: '€', name: 'Euro' }, ES: { code: 'EUR', symbol: '€', name: 'Euro' },
  NL: { code: 'EUR', symbol: '€', name: 'Euro' }, IE: { code: 'EUR', symbol: '€', name: 'Euro' },
  PT: { code: 'EUR', symbol: '€', name: 'Euro' }, BE: { code: 'EUR', symbol: '€', name: 'Euro' },
  AT: { code: 'EUR', symbol: '€', name: 'Euro' }, FI: { code: 'EUR', symbol: '€', name: 'Euro' },
  GR: { code: 'EUR', symbol: '€', name: 'Euro' },
  SE: { code: 'SEK', symbol: 'kr', name: 'Swedish Krona' }, NO: { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone' },
  DK: { code: 'DKK', symbol: 'kr', name: 'Danish Krone' }, PL: { code: 'PLN', symbol: 'zł', name: 'Złoty' },
  CZ: { code: 'CZK', symbol: 'Kč', name: 'Czech Koruna' }, RO: { code: 'RON', symbol: 'lei', name: 'Leu' },
  RU: { code: 'RUB', symbol: '₽', name: 'Russian Ruble' }, TR: { code: 'TRY', symbol: '₺', name: 'Turkish Lira' },
  ZA: { code: 'ZAR', symbol: 'R', name: 'Rand' }, NG: { code: 'NGN', symbol: '₦', name: 'Naira' },
  KE: { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling' }, EG: { code: 'EGP', symbol: 'E£', name: 'Egyptian Pound' },
  GH: { code: 'GHS', symbol: 'GH₵', name: 'Ghana Cedi' }, MA: { code: 'MAD', symbol: 'MAD', name: 'Dirham' },
  BR: { code: 'BRL', symbol: 'R$', name: 'Real' }, MX: { code: 'MXN', symbol: 'Mex$', name: 'Mexican Peso' },
  AR: { code: 'ARS', symbol: 'AR$', name: 'Argentine Peso' }, CL: { code: 'CLP', symbol: 'CLP$', name: 'Chilean Peso' },
  CO: { code: 'COP', symbol: 'COP$', name: 'Colombian Peso' }, PE: { code: 'PEN', symbol: 'S/', name: 'Sol' },
  IL: { code: 'ILS', symbol: '₪', name: 'Shekel' }, KW: { code: 'KWD', symbol: 'KWD', name: 'Kuwaiti Dinar' },
  BH: { code: 'BHD', symbol: 'BHD', name: 'Bahraini Dinar' }, OM: { code: 'OMR', symbol: 'OMR', name: 'Omani Rial' },
};

// A few common country NAMES → ISO, since users.country stores a display name.
const NAME_TO_ISO: Record<string, string> = {
  india: 'IN', 'united states': 'US', usa: 'US', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB',
  switzerland: 'CH', canada: 'CA', australia: 'AU', 'new zealand': 'NZ', singapore: 'SG',
  'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA', qatar: 'QA', japan: 'JP', china: 'CN',
  'hong kong': 'HK', 'south korea': 'KR', korea: 'KR', malaysia: 'MY', indonesia: 'ID', thailand: 'TH',
  philippines: 'PH', vietnam: 'VN', pakistan: 'PK', bangladesh: 'BD', 'sri lanka': 'LK', nepal: 'NP', bhutan: 'BT',
  germany: 'DE', france: 'FR', italy: 'IT', spain: 'ES', netherlands: 'NL', ireland: 'IE', portugal: 'PT',
  belgium: 'BE', austria: 'AT', finland: 'FI', greece: 'GR', sweden: 'SE', norway: 'NO', denmark: 'DK',
  poland: 'PL', 'czech republic': 'CZ', czechia: 'CZ', romania: 'RO', russia: 'RU', turkey: 'TR',
  'south africa': 'ZA', nigeria: 'NG', kenya: 'KE', egypt: 'EG', ghana: 'GH', morocco: 'MA',
  brazil: 'BR', mexico: 'MX', argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE',
  israel: 'IL', kuwait: 'KW', bahrain: 'BH', oman: 'OM',
};

const USD: Currency = { code: 'USD', symbol: '$', name: 'US Dollar' };

export function currencyFor(countryOrIso: string | null | undefined): Currency {
  const v = (countryOrIso || '').trim();
  if (!v) return BY_ISO.IN;
  const up = v.toUpperCase();
  if (BY_ISO[up]) return BY_ISO[up];
  const iso = NAME_TO_ISO[v.toLowerCase()];
  if (iso && BY_ISO[iso]) return BY_ISO[iso];
  return USD;
}

// Convert an INR-paise amount to CHF and the applicant's local currency.
export async function walletAmounts(inrPaise: number, country: string | null | undefined): Promise<{
  inr: number; chf: number; chfLabel: string; local: number; localLabel: string; localCode: string; localSymbol: string; baseChf: boolean;
}> {
  const inr = (Number(inrPaise) || 0) / 100;
  const cur = currencyFor(country);
  let chfRate = 95; // sensible fallback (INR per CHF)
  try { chfRate = (await fxRateToInr('CHF')).rate || 95; } catch (_) {}
  const chf = inr / (chfRate || 95);
  let local = inr;
  if (cur.code !== 'INR') {
    try { const r = (await fxRateToInr(cur.code)).rate; if (r > 0) local = inr / r; } catch (_) { local = inr; }
  }
  const nf = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return {
    inr, chf,
    chfLabel: 'CHF ' + nf(chf),
    local, localCode: cur.code, localSymbol: cur.symbol,
    localLabel: cur.symbol + nf(local, cur.code === 'JPY' || cur.code === 'KRW' || cur.code === 'VND' || cur.code === 'IDR' ? 0 : 2),
    baseChf: true,
  };
}

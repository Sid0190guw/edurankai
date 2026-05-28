// Lightweight per-country phone validation (no external lib). We validate the
// national-number length (and a leading-digit rule where it's simple) so people
// can't submit "10" or other junk. Returns an E.164 string when valid.

export interface Country { iso: string; dial: string; label: string; lengths: number[]; lead?: RegExp }

// Common countries; national significant number lengths. 'lead' constrains the
// first national digit where that meaningfully reduces junk (e.g. Indian mobiles 6-9).
export const COUNTRIES: Country[] = [
  { iso: 'IN', dial: '91', label: 'India (+91)', lengths: [10], lead: /^[6-9]/ },
  { iso: 'US', dial: '1', label: 'USA / Canada (+1)', lengths: [10], lead: /^[2-9]/ },
  { iso: 'GB', dial: '44', label: 'UK (+44)', lengths: [10] },
  { iso: 'AE', dial: '971', label: 'UAE (+971)', lengths: [9] },
  { iso: 'SG', dial: '65', label: 'Singapore (+65)', lengths: [8] },
  { iso: 'AU', dial: '61', label: 'Australia (+61)', lengths: [9] },
  { iso: 'DE', dial: '49', label: 'Germany (+49)', lengths: [10, 11] },
  { iso: 'FR', dial: '33', label: 'France (+33)', lengths: [9] },
  { iso: 'ES', dial: '34', label: 'Spain (+34)', lengths: [9] },
  { iso: 'IT', dial: '39', label: 'Italy (+39)', lengths: [9, 10] },
  { iso: 'NL', dial: '31', label: 'Netherlands (+31)', lengths: [9] },
  { iso: 'BR', dial: '55', label: 'Brazil (+55)', lengths: [10, 11] },
  { iso: 'CN', dial: '86', label: 'China (+86)', lengths: [11] },
  { iso: 'JP', dial: '81', label: 'Japan (+81)', lengths: [10] },
  { iso: 'KR', dial: '82', label: 'South Korea (+82)', lengths: [9, 10] },
  { iso: 'RU', dial: '7', label: 'Russia (+7)', lengths: [10] },
  { iso: 'ZA', dial: '27', label: 'South Africa (+27)', lengths: [9] },
  { iso: 'NG', dial: '234', label: 'Nigeria (+234)', lengths: [10] },
  { iso: 'KE', dial: '254', label: 'Kenya (+254)', lengths: [9] },
  { iso: 'PK', dial: '92', label: 'Pakistan (+92)', lengths: [10] },
  { iso: 'BD', dial: '880', label: 'Bangladesh (+880)', lengths: [10] },
  { iso: 'LK', dial: '94', label: 'Sri Lanka (+94)', lengths: [9] },
  { iso: 'NP', dial: '977', label: 'Nepal (+977)', lengths: [10] },
  { iso: 'SA', dial: '966', label: 'Saudi Arabia (+966)', lengths: [9] },
  { iso: 'QA', dial: '974', label: 'Qatar (+974)', lengths: [8] },
  { iso: 'MY', dial: '60', label: 'Malaysia (+60)', lengths: [9, 10] },
  { iso: 'ID', dial: '62', label: 'Indonesia (+62)', lengths: [9, 10, 11] },
  { iso: 'PH', dial: '63', label: 'Philippines (+63)', lengths: [10] },
  { iso: 'OTHER', dial: '', label: 'Other (enter full international)', lengths: [] },
];

export function findCountry(iso: string): Country | undefined {
  return COUNTRIES.find((c) => c.iso === iso);
}

export interface PhoneCheck { valid: boolean; reason?: string; e164?: string }

export function validatePhone(iso: string, raw: string): PhoneCheck {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return { valid: false, reason: 'Phone number is required' };
  const c = findCountry(iso);
  if (!c || c.iso === 'OTHER') {
    // E.164 allows 8-15 digits total including country code.
    if (digits.length < 8 || digits.length > 15) return { valid: false, reason: 'Enter a full international number (8-15 digits)' };
    return { valid: true, e164: '+' + digits };
  }
  // Allow the user to optionally include the country/trunk prefix; strip a
  // leading country code if present.
  let national = digits;
  if (national.startsWith(c.dial) && national.length > Math.max(...c.lengths)) {
    national = national.slice(c.dial.length);
  }
  national = national.replace(/^0+/, ''); // drop a national trunk 0
  if (!c.lengths.includes(national.length)) {
    return { valid: false, reason: `${c.label.split(' (')[0]} numbers must be ${c.lengths.join(' or ')} digits (you entered ${national.length})` };
  }
  if (c.lead && !c.lead.test(national)) {
    return { valid: false, reason: `That doesn't look like a valid ${c.label.split(' (')[0]} number` };
  }
  return { valid: true, e164: '+' + c.dial + national };
}

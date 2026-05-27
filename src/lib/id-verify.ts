// Government ID number format verification. We can't call government APIs, so
// "verification" here = the number must structurally match the chosen ID type
// (length, character classes, and a checksum where one exists). This blocks
// junk/empty IDs at signup while staying privacy-preserving.

export type IdType = 'aadhaar' | 'pan' | 'passport' | 'voter' | 'driving' | 'other';

export const ID_TYPES: { value: IdType; label: string; placeholder: string }[] = [
  { value: 'aadhaar', label: 'Aadhaar', placeholder: '12-digit number' },
  { value: 'pan', label: 'PAN', placeholder: 'ABCDE1234F' },
  { value: 'passport', label: 'Passport', placeholder: 'A1234567' },
  { value: 'voter', label: 'Voter ID (EPIC)', placeholder: 'ABC1234567' },
  { value: 'driving', label: 'Driving Licence', placeholder: 'DL14 20110012345' },
  { value: 'other', label: 'Other government ID', placeholder: 'ID number' },
];

// Verhoeff checksum (used by Aadhaar) - rejects most typo/fake 12-digit strings.
const VERHOEFF_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
];
const VERHOEFF_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
function verhoeffValid(num: string): boolean {
  let c = 0;
  const digits = num.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
  return c === 0;
}

export function normaliseIdNumber(type: IdType, raw: string): string {
  const s = (raw || '').toUpperCase().replace(/[\s-]/g, '');
  return s;
}

export interface IdCheck { valid: boolean; reason?: string; normalised: string }

export function verifyIdNumber(type: IdType, raw: string): IdCheck {
  const n = normaliseIdNumber(type, raw);
  if (!n) return { valid: false, reason: 'ID number is required', normalised: n };
  switch (type) {
    case 'aadhaar': {
      if (!/^\d{12}$/.test(n)) return { valid: false, reason: 'Aadhaar must be 12 digits', normalised: n };
      if (/^(\d)\1{11}$/.test(n)) return { valid: false, reason: 'Aadhaar looks invalid', normalised: n };
      if (n[0] === '0' || n[0] === '1') return { valid: false, reason: 'Aadhaar cannot start with 0 or 1', normalised: n };
      if (!verhoeffValid(n)) return { valid: false, reason: 'Aadhaar checksum failed', normalised: n };
      return { valid: true, normalised: n };
    }
    case 'pan':
      return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(n)
        ? { valid: true, normalised: n }
        : { valid: false, reason: 'PAN must be 5 letters, 4 digits, 1 letter (ABCDE1234F)', normalised: n };
    case 'passport':
      return /^[A-Z][0-9]{7,8}$/.test(n)
        ? { valid: true, normalised: n }
        : { valid: false, reason: 'Passport must be a letter followed by 7-8 digits', normalised: n };
    case 'voter':
      return /^[A-Z]{3}[0-9]{7}$/.test(n)
        ? { valid: true, normalised: n }
        : { valid: false, reason: 'Voter ID (EPIC) must be 3 letters then 7 digits', normalised: n };
    case 'driving':
      return /^[A-Z]{2}[0-9]{2}[0-9]{4}[0-9]{7}$/.test(n) || /^[A-Z]{2}[0-9]{13}$/.test(n)
        ? { valid: true, normalised: n }
        : { valid: false, reason: 'Driving licence must be 2 letters + 13 digits (state, RTO, year, serial)', normalised: n };
    case 'other':
    default:
      return /^[A-Z0-9]{5,20}$/.test(n)
        ? { valid: true, normalised: n }
        : { valid: false, reason: 'ID number must be 5-20 letters/digits', normalised: n };
  }
}

export function isIdType(s: any): s is IdType {
  return ['aadhaar', 'pan', 'passport', 'voter', 'driving', 'other'].includes(s);
}

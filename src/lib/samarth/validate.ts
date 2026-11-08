// Input normalisation, references, access tokens and time-zone arithmetic for SAMARTH.
// Server-side (uses node:crypto) but free of any database, so it is unit-tested directly.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import COUNTRY_NAMES from '@/lib/country-codes.json';

const COUNTRIES = COUNTRY_NAMES as Record<string, string>;

/** Trim, drop control characters (keeping newlines in multi-line text), clip. Empty becomes ''. */
export function clean(v: unknown, max = 300, multiline = false): string {
  let s = String(v ?? '');
  s = multiline ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.trim();
  if (!multiline) s = s.replace(/\s{2,}/g, ' ');
  return s.slice(0, max);
}

export function cleanEmail(v: unknown): string | null {
  const s = clean(v, 254).toLowerCase();
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(s) ? s : null;
}

export function cleanPhone(v: unknown): string | null {
  const s = clean(v, 32);
  if (!s) return null;
  return /^\+?[0-9 ()\-.]{6,32}$/.test(s) && (s.match(/\d/g) || []).length >= 6 ? s : null;
}

/** An absolute http(s) URL, or null. Nothing else is ever stored as a link. */
export function cleanUrl(v: unknown): string | null {
  const s = clean(v, 800);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}

export function isCountryCode(v: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(COUNTRIES, String(v || '').toUpperCase());
}

export function countryName(v: unknown): string {
  return COUNTRIES[String(v || '').toUpperCase()] || String(v || '');
}

/** Every country, sorted by name, for a select. */
export function countryOptions(): { code: string; name: string }[] {
  return Object.entries(COUNTRIES).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function isTimeZone(v: unknown): boolean {
  const tz = String(v || '');
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

export interface DocLink { label: string; url: string }

/**
 * Supporting documents are LINKS, never uploads (platform rule: documents are shared as links, for
 * example a cloud-drive link with viewer access, and are not stored here). Up to `max` pairs are
 * read from label_i / url_i fields; a pair with an invalid URL is reported, not silently dropped.
 */
export function parseDocLinks(get: (name: string) => string, max = 6): { links: DocLink[]; invalid: number } {
  const links: DocLink[] = [];
  let invalid = 0;
  for (let i = 0; i < max; i++) {
    const rawUrl = clean(get('doc_url_' + i), 800);
    if (!rawUrl) continue;
    const url = cleanUrl(rawUrl);
    if (!url) { invalid++; continue; }
    links.push({ label: clean(get('doc_label_' + i), 120) || 'Document ' + (links.length + 1), url });
  }
  return { links, invalid };
}

// -------------------------------------------------------------------------------------------------
// REFERENCES AND ACCESS TOKENS
// -------------------------------------------------------------------------------------------------

/** Crockford base32 without I, L, O, U: readable aloud and over the phone. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RefKind = 'A' | 'E' | 'P' | 'X';

/** SAM-A-7K3P9XQ2 (application), SAM-E-... (engagement), SAM-P-... (partner), SAM-X-... (venture). */
export function newRef(kind: RefKind): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % 32];
  return 'SAM-' + kind + '-' + out;
}

export function isRef(v: unknown, kind?: RefKind): boolean {
  const s = String(v || '').toUpperCase();
  const re = /^SAM-([AEPX])-[0-9A-HJKMNP-TV-Z]{8}$/;
  const m = s.match(re);
  return !!m && (!kind || m[1] === kind);
}

export function normaliseRef(v: unknown): string {
  return String(v || '').trim().toUpperCase();
}

/** A private access token for an applicant's workspace. Only its hash is ever stored. */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update('samarth:' + String(token || '')).digest('hex');
}

export function tokenMatches(token: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!token || !storedHash || storedHash.length !== 64) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// -------------------------------------------------------------------------------------------------
// TIME ZONES
// -------------------------------------------------------------------------------------------------

/** The offset of `tz` from UTC at instant `at`, in minutes (positive east of Greenwich). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * A wall-clock time in a time zone ("2026-12-01T15:30" in "Europe/Berlin") to the UTC instant.
 * Two passes, so a time near a daylight-saving change resolves to the offset in force at that time.
 * Returns null for an unparseable input or an unknown zone.
 */
export function zonedLocalToUtc(local: string, tz: string): Date | null {
  const m = String(local || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m || !isTimeZone(tz)) return null;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(naive)) return null;
  let guess = naive - tzOffsetMinutes(tz, new Date(naive)) * 60000;
  guess = naive - tzOffsetMinutes(tz, new Date(guess)) * 60000;
  return new Date(guess);
}

/** "Tue, 1 Dec 2026, 15:30 (Europe/Berlin)" for display in the reader's zone. */
export function formatInZone(at: Date | string | null | undefined, tz: string): string {
  if (!at) return '';
  const d = at instanceof Date ? at : new Date(at);
  if (isNaN(d.getTime())) return '';
  const zone = isTimeZone(tz) ? tz : 'UTC';
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  return s + ' (' + zone + ')';
}

/** A list of common zones for selects, with the applicant's own zone added if it is not in it. */
export const COMMON_TIME_ZONES: readonly string[] = [
  'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Jakarta',
  'Asia/Riyadh', 'Asia/Dhaka', 'Asia/Karachi', 'Asia/Kathmandu', 'Asia/Colombo', 'Asia/Seoul', 'Australia/Sydney', 'Pacific/Auckland',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Zurich', 'Europe/Stockholm',
  'Europe/Warsaw', 'Europe/Istanbul', 'Europe/Moscow', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Cairo', 'Africa/Johannesburg',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Mexico_City',
  'America/Sao_Paulo', 'America/Bogota', 'America/Lima', 'America/Argentina/Buenos_Aires',
];

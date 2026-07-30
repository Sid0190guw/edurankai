// src/lib/applicant-location.ts — where an application was filed from.
//
// PURPOSE. Applications are a fraud surface: the same person applying under several identities,
// a "local" candidate applying from another country, an agency filing on someone's behalf. A
// location trail across the whole application makes that visible. It is also part of the
// due-diligence the intern programmes already declare.
//
// TWO SOURCES, and the difference matters:
//
//   ip   — derived server-side from the request. Coarse (city/region level, and the lat/long is the
//          centroid of a network block, NOT the person). Needs no permission and cannot be refused,
//          so it is present for every step. Wrong for VPN/proxy users by design — which is itself a
//          signal worth seeing.
//   gps  — navigator.geolocation. Precise (metres). CANNOT be obtained silently: every browser
//          requires an explicit permission prompt and the applicant may refuse. We record the
//          refusal too, because a decline on a security-cleared programme is information.
//
// Never present an `ip` point as the applicant's actual position. The admin view labels sources
// distinctly and shows the accuracy radius for exactly this reason.
//
// PRIVACY. This is personal data under India's DPDP Act 2023, so: capture is disclosed in the
// application flow, the trail is readable by super admins only (see requireLocationAccess), and
// nothing is sent to a third party — the admin map renders from our own coordinates with no
// external tile requests. Retention is the caller's policy decision; purgeLocationsFor() exists so
// an erasure request can actually be honoured.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export type LocationSource = 'ip' | 'gps';
export type GpsStatus = 'granted' | 'denied' | 'unavailable' | 'timeout';

export interface LocationPoint {
  id: string;
  applicationId: string | null;
  intentId: string | null;
  userId: string | null;
  email: string | null;
  step: string | null;
  source: LocationSource;
  gpsStatus: GpsStatus | null;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  timezone: string | null;          // timezone the NETWORK says (from IP)
  userAgent: string | null;
  browserTimezone: string | null;   // timezone the DEVICE says — a VPN does not change this
  utcOffsetMin: number | null;      // device clock offset, cross-check on the above
  browserLanguages: string | null;  // e.g. "zh-CN,zh,en"
  platform: string | null;
  screenWh: string | null;
  createdAt: string;
}

export function ensureLocationSchema(): Promise<void> {
  return ensureOnce('applicant_locations_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS applicant_locations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id UUID,
      intent_id TEXT,
      user_id UUID,
      email TEXT,
      step TEXT,
      source TEXT NOT NULL DEFAULT 'ip',
      gps_status TEXT,
      ip TEXT,
      country TEXT,
      region TEXT,
      city TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy_m DOUBLE PRECISION,
      timezone TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Device-side signals. These are what expose a VPN: a VPN reroutes the NETWORK, it does not
    // change the machine's clock, timezone, locale or GPS radio. Added via ALTER as well as in the
    // CREATE above so an already-deployed table picks them up.
    for (const [col, type] of [
      ['browser_timezone', 'TEXT'],
      ['utc_offset_min', 'INT'],
      ['browser_languages', 'TEXT'],
      ['platform', 'TEXT'],
      ['screen_wh', 'TEXT'],
    ] as [string, string][]) {
      await db.execute(sql.raw(`ALTER TABLE applicant_locations ADD COLUMN IF NOT EXISTS ${col} ${type}`));
    }
    await db.execute(sql`CREATE INDEX IF NOT EXISTS applicant_locations_app_idx ON applicant_locations (application_id, created_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS applicant_locations_intent_idx ON applicant_locations (intent_id, created_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS applicant_locations_email_idx ON applicant_locations (lower(email))`);
  });
}

/**
 * Read the coarse location the edge already knows about, from request headers.
 *
 * These are set by the platform in production and are simply absent locally, so every field is
 * optional and a missing header must never break an application step.
 */
export function coarseFromRequest(request: Request, clientAddress?: string) {
  const h = (k: string) => request.headers.get(k) || null;
  const num = (v: string | null) => {
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    ip: h('x-forwarded-for')?.split(',')[0]?.trim() || clientAddress || h('x-real-ip') || null,
    country: h('x-vercel-ip-country'),
    region: h('x-vercel-ip-country-region'),
    // Header values are URL-encoded (e.g. "New%20Delhi").
    city: (() => { const c = h('x-vercel-ip-city'); try { return c ? decodeURIComponent(c) : null; } catch { return c; } })(),
    latitude: num(h('x-vercel-ip-latitude')),
    longitude: num(h('x-vercel-ip-longitude')),
    timezone: h('x-vercel-ip-timezone'),
    userAgent: h('user-agent'),
  };
}

export interface RecordInput {
  applicationId?: string | null;
  intentId?: string | null;
  userId?: string | null;
  email?: string | null;
  step?: string | null;
  source: LocationSource;
  gpsStatus?: GpsStatus | null;
  ip?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  timezone?: string | null;
  userAgent?: string | null;
  browserTimezone?: string | null;
  utcOffsetMin?: number | null;
  browserLanguages?: string | null;
  platform?: string | null;
  screenWh?: string | null;
}

/**
 * Persist one point. Best-effort by contract: an applicant must never be blocked from applying
 * because location capture failed, so callers should not need their own try/catch.
 */
export async function recordLocation(p: RecordInput): Promise<void> {
  try {
    await ensureLocationSchema();
    // Coordinates outside the valid range mean a spoofed or broken client; store the row for the
    // audit trail but drop the impossible numbers rather than plotting them.
    const lat = typeof p.latitude === 'number' && Math.abs(p.latitude) <= 90 ? p.latitude : null;
    const lon = typeof p.longitude === 'number' && Math.abs(p.longitude) <= 180 ? p.longitude : null;
    await db.execute(sql`
      INSERT INTO applicant_locations
        (application_id, intent_id, user_id, email, step, source, gps_status, ip,
         country, region, city, latitude, longitude, accuracy_m, timezone, user_agent,
         browser_timezone, utc_offset_min, browser_languages, platform, screen_wh)
      VALUES (
        ${p.applicationId || null}, ${p.intentId || null}, ${p.userId || null},
        ${p.email ? p.email.toLowerCase().trim() : null}, ${p.step || null},
        ${p.source}, ${p.gpsStatus || null}, ${p.ip || null},
        ${p.country || null}, ${p.region || null}, ${p.city || null},
        ${lat}, ${lon},
        ${typeof p.accuracyM === 'number' && p.accuracyM >= 0 ? p.accuracyM : null},
        ${p.timezone || null}, ${p.userAgent ? String(p.userAgent).slice(0, 400) : null},
        ${p.browserTimezone ? String(p.browserTimezone).slice(0, 60) : null},
        ${typeof p.utcOffsetMin === 'number' ? p.utcOffsetMin : null},
        ${p.browserLanguages ? String(p.browserLanguages).slice(0, 120) : null},
        ${p.platform ? String(p.platform).slice(0, 60) : null},
        ${p.screenWh ? String(p.screenWh).slice(0, 24) : null}
      )`);
  } catch (_) {
    // Deliberately silent: this is observability, not a gate on the applicant's ability to apply.
  }
}

/** Convenience wrapper for an application step — reads the coarse data and stores it. */
export async function recordStep(
  request: Request,
  step: string,
  ids: { applicationId?: string | null; intentId?: string | null; userId?: string | null; email?: string | null },
  clientAddress?: string,
): Promise<void> {
  const c = coarseFromRequest(request, clientAddress);
  await recordLocation({ ...ids, step, source: 'ip', ...c });
}

/**
 * The full trail for one application, oldest first. Matches on application id, the pre-payment
 * intent id, OR the email — because points are captured before an application row exists, and
 * would otherwise be orphaned once it does.
 */
export async function getLocationTrail(opts: {
  applicationId?: string | null; intentId?: string | null; email?: string | null;
}): Promise<LocationPoint[]> {
  try {
    await ensureLocationSchema();
    const r = await db.execute(sql`
      SELECT * FROM applicant_locations
      WHERE (${opts.applicationId || null}::uuid IS NOT NULL AND application_id = ${opts.applicationId || null}::uuid)
         OR (${opts.intentId || null}::text IS NOT NULL AND intent_id = ${opts.intentId || null})
         OR (${opts.email || null}::text IS NOT NULL AND lower(email) = lower(${opts.email || null}))
      ORDER BY created_at ASC
      LIMIT 500`);
    return rows(r).map((x) => ({
      id: x.id, applicationId: x.application_id, intentId: x.intent_id, userId: x.user_id,
      email: x.email, step: x.step, source: x.source, gpsStatus: x.gps_status, ip: x.ip,
      country: x.country, region: x.region, city: x.city,
      latitude: x.latitude == null ? null : Number(x.latitude),
      longitude: x.longitude == null ? null : Number(x.longitude),
      accuracyM: x.accuracy_m == null ? null : Number(x.accuracy_m),
      timezone: x.timezone, userAgent: x.user_agent,
      browserTimezone: x.browser_timezone ?? null,
      utcOffsetMin: x.utc_offset_min == null ? null : Number(x.utc_offset_min),
      browserLanguages: x.browser_languages ?? null,
      platform: x.platform ?? null,
      screenWh: x.screen_wh ?? null,
      createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at),
    }));
  } catch { return []; }
}

// ── VPN / true-origin assessment ─────────────────────────────────────────────────────────────────
//
// HONEST SCOPE. A VPN cannot be defeated from a web page — but it only reroutes the NETWORK. It does
// not change the device's GPS radio, its OS timezone, its clock offset or its language list. So when
// the network says one country and the device says another, the DEVICE is almost always telling the
// truth about where the person is. That is what this reports.
//
// A determined adversary can still beat it: refuse GPS, set the OS to Asia/Kolkata, install English.
// This is therefore graded evidence for a human reviewer, never an automatic rejection — the same
// rule the proctoring system follows. Note too that a mismatch has innocent explanations: expats,
// travellers, corporate VPNs, and students on university networks.

/** IANA timezone -> ISO country. Only needs the cases we actually reason about. */
const TZ_COUNTRY: Record<string, string> = {
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN',
  'Asia/Shanghai': 'CN', 'Asia/Urumqi': 'CN', 'Asia/Chongqing': 'CN', 'Asia/Harbin': 'CN',
  'Asia/Hong_Kong': 'HK', 'Asia/Macau': 'MO', 'Asia/Taipei': 'TW',
  'Asia/Karachi': 'PK', 'Asia/Istanbul': 'TR', 'Europe/Istanbul': 'TR',
  'Asia/Dhaka': 'BD', 'Asia/Kathmandu': 'NP', 'Asia/Colombo': 'LK', 'Asia/Kabul': 'AF',
  'Asia/Tehran': 'IR', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Singapore': 'SG',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE',
  'Europe/Zurich': 'CH', 'Europe/Moscow': 'RU', 'Europe/Amsterdam': 'NL',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'Australia/Sydney': 'AU',
};

/** Language subtag -> the country it most strongly implies. Only used as weak corroboration. */
const LANG_COUNTRY: Record<string, string> = {
  'zh-cn': 'CN', 'zh-hans': 'CN', 'zh': 'CN', 'ur': 'PK', 'ur-pk': 'PK',
  'tr': 'TR', 'tr-tr': 'TR', 'fa': 'IR', 'ps': 'AF', 'ru': 'RU',
  'hi': 'IN', 'bn-in': 'IN', 'ta': 'IN', 'te': 'IN', 'mr': 'IN', 'gu': 'IN',
};

/** Countries the flagship programme excludes, so an origin match is called out explicitly. */
export const RESTRICTED_COUNTRIES: Record<string, string> = { PK: 'Pakistan', TR: 'Turkey', CN: 'China' };

export interface VpnAssessment {
  verdict: 'likely-vpn' | 'possible-vpn' | 'no-signal' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  networkCountry: string | null;   // what the IP claims
  deviceCountry: string | null;    // what the device's own settings imply
  trueOrigin: string | null;       // best guess at where they actually are
  restrictedHit: string | null;    // set when the true origin is an excluded country
  evidence: string[];
}

export function assessVpn(trail: LocationPoint[]): VpnAssessment {
  const out: VpnAssessment = {
    verdict: 'unknown', confidence: 'low', networkCountry: null,
    deviceCountry: null, trueOrigin: null, restrictedHit: null, evidence: [],
  };
  if (!trail.length) return out;

  const latest = [...trail].reverse();
  const networkCountry = latest.find((p) => p.country)?.country || null;
  const btz = latest.find((p) => p.browserTimezone)?.browserTimezone || null;
  const langs = latest.find((p) => p.browserLanguages)?.browserLanguages || null;
  const offset = latest.find((p) => p.utcOffsetMin != null)?.utcOffsetMin ?? null;
  out.networkCountry = networkCountry;

  // 1. Device timezone is the strongest non-GPS signal — a VPN never changes it.
  const tzCountry = btz ? TZ_COUNTRY[btz] || null : null;
  if (tzCountry) {
    out.deviceCountry = tzCountry;
    if (networkCountry && tzCountry !== networkCountry) {
      out.verdict = 'likely-vpn';
      out.confidence = 'high';
      out.trueOrigin = tzCountry;
      out.evidence.push(`Network says ${networkCountry} but the device timezone is ${btz} (${tzCountry}). A VPN changes the network route, not the machine's clock — the device is the more reliable of the two.`);
    }
  } else if (btz && networkCountry) {
    out.evidence.push(`Device timezone ${btz} is not in the reference table, so it could not be compared with the network country ${networkCountry}.`);
  }

  // 2. Clock offset, as an independent cross-check on a spoofed timezone name.
  if (offset != null && btz && TZ_COUNTRY[btz]) {
    // IST is UTC+5:30 => -330 in the JS getTimezoneOffset() convention.
    if (TZ_COUNTRY[btz] === 'IN' && offset !== -330) {
      out.evidence.push(`Device claims ${btz} but its clock offset is ${-offset} minutes from UTC, which is not IST (+330). The timezone name may have been changed manually.`);
      if (out.verdict === 'no-signal') out.verdict = 'possible-vpn';
    }
  }

  // 3. Language list, as weak corroboration only — never on its own.
  if (langs) {
    const first = langs.split(',')[0]?.trim().toLowerCase();
    const langCountry = first ? LANG_COUNTRY[first] || LANG_COUNTRY[first.split('-')[0]] || null : null;
    if (langCountry && networkCountry && langCountry !== networkCountry) {
      out.evidence.push(`Browser language list starts with "${first}", which is associated with ${langCountry}, while the network says ${networkCountry}.`);
      if (out.verdict === 'unknown' || out.verdict === 'no-signal') { out.verdict = 'possible-vpn'; out.confidence = 'low'; }
      if (!out.trueOrigin) out.trueOrigin = langCountry;
    }
  }

  // 4. GPS is decisive when granted: it is measured by the device, not inferred from the network.
  const gps = latest.find((p) => p.source === 'gps' && p.latitude != null && p.longitude != null);
  const ipPt = latest.find((p) => p.source === 'ip' && p.latitude != null && p.longitude != null);
  if (gps && ipPt) {
    const d = distanceKm(gps as any, ipPt as any);
    if (d > 500) {
      out.verdict = 'likely-vpn';
      out.confidence = 'high';
      out.evidence.push(`Precise device location is ${Math.round(d)} km from the network location. GPS is measured on the device and is unaffected by a VPN, so this is the real position.`);
    } else {
      out.evidence.push(`Precise device location agrees with the network location (within ${Math.round(d)} km), which argues against a VPN.`);
      if (out.verdict === 'unknown') { out.verdict = 'no-signal'; out.confidence = 'medium'; }
    }
  }

  // 5. Refusing the prompt is not proof of anything, but it removes the one decisive check.
  if (!gps) {
    const denied = trail.filter((p) => p.gpsStatus === 'denied').length;
    if (denied) {
      out.evidence.push(`Precise location was declined${denied > 1 ? ` (${denied} times)` : ''}, so the strongest check is unavailable. Not evidence of wrongdoing on its own.`);
      out.confidence = out.confidence === 'high' ? 'high' : 'low';
    }
  }

  if (out.verdict === 'unknown' && !out.evidence.length) {
    out.verdict = 'no-signal';
    out.evidence.push('No device-side signals were captured for this application, so VPN use can be neither shown nor ruled out.');
  }

  // 6. Call out an excluded origin explicitly — advisory, for a human to verify.
  const origin = out.trueOrigin || out.deviceCountry || networkCountry;
  if (origin && RESTRICTED_COUNTRIES[origin]) {
    out.restrictedHit = RESTRICTED_COUNTRIES[origin];
    out.evidence.push(`Apparent origin is ${RESTRICTED_COUNTRIES[origin]}, which the flagship programme excludes. Verify against the candidate's documents before acting — an origin signal is not proof of citizenship.`);
  }
  if (!out.trueOrigin) out.trueOrigin = origin || null;
  return out;
}

/** Distance in km between two points (haversine) — used for the movement flag. */
export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371;
  const dLat = (b.latitude - a.latitude) * Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * Math.PI / 180;
  const la1 = a.latitude * Math.PI / 180, la2 = b.latitude * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Things worth a human's attention. Deliberately advisory: these are prompts to look, never
 * automatic judgements about a candidate — consistent with the proctoring policy that automated
 * flags must not penalise anyone on their own.
 */
export function locationFlags(trail: LocationPoint[]): string[] {
  const out: string[] = [];
  if (!trail.length) return out;

  const countries = [...new Set(trail.map((p) => p.country).filter(Boolean))] as string[];
  if (countries.length > 1) out.push('Application touched more than one country: ' + countries.join(', '));
  if (countries.length === 1 && countries[0] !== 'IN') out.push('Filed entirely from outside India (' + countries[0] + ')');

  const ips = [...new Set(trail.map((p) => p.ip).filter(Boolean))];
  if (ips.length > 3) out.push(ips.length + ' distinct IP addresses across the application');

  const gps = trail.filter((p) => p.source === 'gps' && p.latitude != null);
  const denied = trail.filter((p) => p.gpsStatus === 'denied').length;
  if (!gps.length && denied) out.push('Precise location was requested and declined' + (denied > 1 ? ' (' + denied + ' times)' : ''));

  // A precise point far from where the network says they are is the classic VPN/proxy tell.
  for (const g of gps) {
    const near = trail.find((p) => p.source === 'ip' && p.latitude != null && p.longitude != null);
    if (near && g.latitude != null && g.longitude != null) {
      const d = distanceKm(g as any, near as any);
      if (d > 500) { out.push('Precise location is ' + Math.round(d) + ' km from the network location — possible VPN or proxy'); break; }
    }
  }

  // Genuine movement mid-application.
  const pts = trail.filter((p) => p.latitude != null && p.longitude != null);
  for (let i = 1; i < pts.length; i++) {
    if (distanceKm(pts[i - 1] as any, pts[i] as any) > 300) {
      out.push('Location moved more than 300 km during the application');
      break;
    }
  }
  return out;
}

/** Erasure support, so a deletion request can actually be honoured. */
export async function purgeLocationsFor(email: string): Promise<number> {
  await ensureLocationSchema();
  const r = await db.execute(sql`DELETE FROM applicant_locations WHERE lower(email) = lower(${email}) RETURNING id`);
  return rows(r).length;
}

/**
 * Super admin ONLY. This is precise personal location data about identifiable applicants, so it is
 * deliberately narrower than the rest of the applications screen: ordinary recruiters and HR staff
 * can review an application without needing to know which building someone sat in.
 */
export function canViewLocations(user: { role?: string | null } | null | undefined): boolean {
  return !!user && user.role === 'super_admin';
}

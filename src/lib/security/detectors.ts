// src/lib/security/detectors.ts — Block 11: PURE threat detectors over audit/session rows.
// No I/O — unit-testable with synthetic rows. Each returns zero or more DetectedSignals.
export type SignalKind =
  | 'login-burst'
  | 'privilege-escalation'
  | 'session-fanout'
  | 'impossible-travel'
  | 'unguarded-route';

export interface AuditRow { userId: string | null; action: string; entity: string; ipAddress: string | null; createdAt: Date; }
export interface RbacAuditRow { userId: string | null; capability: string; allow: boolean; reason: string; at: Date; }
export interface SessionRow { userId: string; ipAddress: string | null; createdAt: Date; }

export interface DetectedSignal {
  kind: SignalKind; severity: 'low' | 'medium' | 'high';
  subjectUserId: string | null; subjectIp: string | null;
  score: number; evidence: Record<string, unknown>;
  windowStart: Date; windowEnd: Date;
}

const inWindow = (t: Date, start: Date, now: Date) => t >= start && t <= now;

export function detectLoginBursts(rows: AuditRow[], now: Date): DetectedSignal[] {
  const start = new Date(now.getTime() - 15 * 60_000);
  const FAIL = new Set(['login.failed', '2fa.failed']);
  const groups = new Map<string, { count: number; userId: string | null; ip: string | null }>();
  for (const r of rows) {
    if (!inWindow(r.createdAt, start, now) || !FAIL.has(r.action)) continue;
    const key = r.userId ?? r.ipAddress ?? 'unknown';
    const g = groups.get(key) ?? { count: 0, userId: r.userId, ip: r.ipAddress };
    g.count++; groups.set(key, g);
  }
  const out: DetectedSignal[] = [];
  for (const g of groups.values()) {
    if (g.count < 5) continue;
    const severity = g.count >= 20 ? 'high' : g.count >= 10 ? 'medium' : 'low';
    out.push({ kind: 'login-burst', severity, subjectUserId: g.userId, subjectIp: g.ip, score: g.count, evidence: { count: g.count }, windowStart: start, windowEnd: now });
  }
  return out;
}

export function detectPrivilegeEscalation(rows: RbacAuditRow[], now: Date): DetectedSignal[] {
  const start = new Date(now.getTime() - 60 * 60_000);
  const CAPS = new Set(['administer', 'manage', 'delete']);
  const groups = new Map<string, { count: number; caps: Set<string> }>();
  for (const r of rows) {
    if (!inWindow(r.at, start, now) || r.allow || !CAPS.has(r.capability) || !r.userId) continue;
    const g = groups.get(r.userId) ?? { count: 0, caps: new Set() };
    g.count++; g.caps.add(r.capability); groups.set(r.userId, g);
  }
  const out: DetectedSignal[] = [];
  for (const [userId, g] of groups) {
    if (g.count < 3) continue;
    out.push({ kind: 'privilege-escalation', severity: g.count >= 8 ? 'high' : 'medium', subjectUserId: userId, subjectIp: null, score: g.count, evidence: { deniedCaps: [...g.caps], count: g.count }, windowStart: start, windowEnd: now });
  }
  return out;
}

export function detectSessionFanout(rows: SessionRow[], now: Date): DetectedSignal[] {
  const start = new Date(now.getTime() - 60 * 60_000);
  const groups = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!inWindow(r.createdAt, start, now) || !r.ipAddress) continue;
    if (!groups.has(r.userId)) groups.set(r.userId, new Set());
    groups.get(r.userId)!.add(r.ipAddress);
  }
  const out: DetectedSignal[] = [];
  for (const [userId, ips] of groups) {
    if (ips.size < 4) continue;
    out.push({ kind: 'session-fanout', severity: ips.size >= 8 ? 'high' : 'medium', subjectUserId: userId, subjectIp: null, score: ips.size, evidence: { distinctIps: ips.size }, windowStart: start, windowEnd: now });
  }
  return out;
}

export function detectImpossibleTravel(rows: SessionRow[], now: Date): DetectedSignal[] {
  const start = new Date(now.getTime() - 30 * 60_000);
  const groups = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!inWindow(r.createdAt, start, now) || !r.ipAddress) continue;
    if (!groups.has(r.userId)) groups.set(r.userId, new Set());
    groups.get(r.userId)!.add(r.ipAddress);
  }
  const out: DetectedSignal[] = [];
  for (const [userId, ips] of groups) {
    if (ips.size < 2) continue;   // distinct-IP proxy only; no geo-velocity (see spec §7)
    out.push({ kind: 'impossible-travel', severity: 'medium', subjectUserId: userId, subjectIp: null, score: ips.size, evidence: { ips: [...ips] }, windowStart: start, windowEnd: now });
  }
  return out;
}

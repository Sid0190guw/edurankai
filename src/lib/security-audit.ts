// src/lib/security-audit.ts — hardening audits (Prompt AP7). Pure scanners used by the test suite AND
// the admin ops view: detect hardcoded secrets, and flag API routes that lack an authorization guard.
// The scanners are conservative (specific secret formats; a broad set of guard signals) so findings
// are real, not noise.

// ---- hardcoded-secret detection (specific, high-confidence formats) ----
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'openai-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'razorpay-key', re: /rzp_(live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'db-url-with-password', re: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@/ },
  { name: 'bearer-literal', re: /(?:Authorization|Bearer)\s*[:=]\s*['"][A-Za-z0-9._\-]{20,}['"]/ },
];
export function scanForSecrets(text: string): { name: string; match: string }[] {
  const found: { name: string; match: string }[] = [];
  for (const p of SECRET_PATTERNS) { const m = text.match(p.re); if (m) found.push({ name: p.name, match: m[0].slice(0, 24) + '…' }); }
  return found;
}

// ---- authorization-guard detection for API routes ----
// A route is "guarded" if it authenticates/authorizes the caller by any of these signals.
const GUARD_SIGNALS = [
  'locals.user', 'locals as any)?.user', 'Astro.locals.user',
  'can(', 'isRoomHost', 'canDriveHuddle', 'isHost(', 'requireUser', 'requireCap',
  'CRON_SECRET', 'verifyWebhookSignature', 'verifyPaymentSignature', 'underRateLimit',
  'validateSessionToken', 'getSession',
];
export function isRouteGuarded(source: string): boolean {
  return GUARD_SIGNALS.some((s) => source.includes(s));
}
/** Audit a set of {path, source} route files. Returns which are guarded vs not. */
export function auditRoutes(files: { path: string; source: string }[]): { guarded: string[]; unguarded: string[] } {
  const guarded: string[] = [], unguarded: string[] = [];
  for (const f of files) (isRouteGuarded(f.source) ? guarded : unguarded).push(f.path);
  return { guarded, unguarded };
}

// Intentionally-public endpoints (no auth needed) — the allowlist the audit tolerates.
export const PUBLIC_ROUTE_ALLOW = [
  /login/, /logout/, /register|signup/, /\/health/, /webhook/, /public\//, /feed\.ics/, /manifest/, /sitemap/, /robots/, /\/status/,
  /contact/, /waitlist/, /subscribe/, /\/og\//, /csp-report/, /verify-email/, /reset-password/, /forgot/,
];
export function isAllowedPublic(path: string): boolean { return PUBLIC_ROUTE_ALLOW.some((re) => re.test(path)); }

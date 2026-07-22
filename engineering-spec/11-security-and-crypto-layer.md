# Engineering Block 11 — Security, Cryptography & Threat Detection

| Field | Value |
|---|---|
| **Spec source** | Vol III Part II pp 150–176 — "Constitutional Security Kernel, Zero Trust Defense & Cyber Resilience" (Ch 21) and "Cryptographic Infrastructure, Key Management & Post-Quantum Security" (Ch 22); Vol V Part II pp 177–195 — "Constitutional Security Doctrine / Autonomous Cyber Defense" (Ch 100) |
| **Repo target** | `src/lib/crypto/` (new: `envelope.ts`, `keys.ts`, `schema.ts`), `src/lib/security/` (new: `signals.ts`, `detectors.ts`, `trust.ts`, `schema.ts`), extend `src/lib/audit.ts`, `src/lib/security-audit.ts`; endpoints `src/pages/api/admin/security/*` + `src/pages/api/cron/security-scan.ts` |
| **Status** | partial — zero-trust authZ pipeline, session hashing, audit sinks, and blob storage already exist; data-at-rest encryption, a key registry, and audit-derived threat detection are greenfield |
| **Depends on** | Identity & Session Auth (`src/lib/auth`), RBAC / Capability Engine (`src/lib/rbac`), Kernel Object Store (`src/lib/kernel`), Audit & Observability (`src/lib/audit.ts`, `src/lib/observability.ts`) |

## 1. Purpose
Provide three concrete security services on top of the existing serverless stack: (1) **data-at-rest encryption** for sensitive fields and blobs using AES-256-GCM envelope encryption with a versioned key registry, where key material lives in Vercel environment variables and only key *metadata* lives in Postgres; (2) a **zero-trust request authN/Z contract** that re-verifies identity, session, and capability on every request (deny-by-default), formalising the pipeline already implemented in `src/lib/rbac/engine.ts`; (3) **threat detection** that derives security signals (login bursts, privilege-escalation attempts, session anomalies, unguarded routes) from `audit_log`, the RBAC `rbac_audit` table, and `sessions`, on a scheduled scan plus on-demand admin queries.

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- `src/lib/auth/session.ts` — session tokens are `randomBytes(20)` base32; the stored session id is `sha256(token)` hex (`@oslojs/crypto/sha2` + `@oslojs/encoding`). Sliding renewal, row-delete revocation (`invalidateSession` / `invalidateAllSessions` DELETE the `sessions` row; a deactivated `users.is_active=false` user is force-logged-out on next validation — there is no `sessions.isActive` column), `userAgent`/`ipAddress` capture already present.
- `src/lib/auth/cookie.ts` — `httpOnly`, `sameSite:'lax'`, `secure: import.meta.env.PROD` cookie.
- `src/lib/auth/twofactor.ts` — TOTP (RFC 6238) + hashed backup codes on `node:crypto` (`createHmac`, `timingSafeEqual`); self-bootstraps `user_totp` / `user_backup_codes`. WebAuthn passkeys live in `src/lib/auth/webauthn.ts` (self-built, `node:crypto`), self-bootstrapping `user_passkeys`.
- `src/lib/rbac/engine.ts` — the deterministic **zero-trust evaluation pipeline** (Resolve Identity → Verify Session → Verify Authorization → Validate Capability → Load Permission Context → Evaluate Rules → Apply Constraints → Return Decision), with explicit-deny-overrides-allow and security-label gating. This IS the spec's "Secure Execution Policies" / "Continuous Trust Evaluation".
- `src/lib/rbac/guard.ts` — `requireCapability()` / `can()` write one audit row per decision into the RBAC `rbac_audit` table via `writeAudit`.
- `src/lib/db/schema.ts` — `auditLog` (`audit_log`: userId, action, entity, entityId, diff jsonb, ipAddress, createdAt) and `sessions`.
- `src/lib/audit.ts` — `logAudit(...)` insert helper.
- `src/lib/security-audit.ts` — `scanForSecrets()` (hardcoded-secret detector), `auditRoutes()` (flags API routes lacking an authZ guard), `PUBLIC_ROUTE_ALLOW`.
- `src/lib/storage.ts` — swap-ready `BlobStore` over `@vercel/blob` (`BLOB_READ_WRITE_TOKEN`), memory fallback.
- `src/lib/observability.ts` — feature flags + admin audit console over `rbac_audit`.
- `kernel_objects.security_labels text[]` + `permissions jsonb` — carry per-object classification the crypto layer keys off.

**Build (new):**
- `src/lib/crypto/envelope.ts` — `encryptField` / `decryptField` (AES-256-GCM envelope) and `encryptBlob` / `decryptBlob`.
- `src/lib/crypto/keys.ts` — key registry: resolve the active KEK from env, select decryption key by `keyId`, rotation helpers.
- `src/lib/crypto/schema.ts` — `crypto_keys` metadata table (self-bootstrapping).
- `src/lib/security/detectors.ts` — pure detector functions over audit/session rows.
- `src/lib/security/signals.ts` — scan orchestrator + `security_signals` persistence.
- `src/lib/security/trust.ts` — `computeTrustScore(userId)` continuous-trust signal.
- `src/lib/security/schema.ts` — `security_signals` table.
- `src/pages/api/admin/security/{signals,keys}.ts` — superadmin read/rotate endpoints.
- `src/pages/api/cron/security-scan.ts` — `CRON_SECRET`-guarded scheduled scan.

## 3. Data model

### 3.1 Envelope ciphertext (stored inline in any jsonb/text column, or as a blob sidecar)

```ts
// src/lib/crypto/envelope.ts (types)
export interface EnvelopeCiphertext {
  v: 1;                 // envelope format version
  keyId: string;        // which registry key encrypted this (for rotation)
  alg: 'A256GCM';       // AES-256-GCM
  iv: string;           // base64, 12 bytes
  ct: string;           // base64 ciphertext
  tag: string;          // base64, 16-byte GCM auth tag
  aad?: string;         // optional additional-authenticated-data label (not secret)
}
```

```ts
import { z } from 'zod';
export const EnvelopeCiphertextSchema = z.object({
  v: z.literal(1),
  keyId: z.string().min(1).max(64),
  alg: z.literal('A256GCM'),
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
  aad: z.string().optional(),
});
```

### 3.2 Key registry — metadata ONLY (no key material in Postgres)

```ts
// src/lib/crypto/schema.ts
import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

// Key MATERIAL lives in Vercel env vars (DATA_ENCRYPTION_KEY_<keyId>); this table
// only tracks lifecycle/metadata so rotation and coverage are auditable.
export const cryptoKeys = pgTable('crypto_keys', {
  keyId: text('key_id').primaryKey(),                 // e.g. 'k1', 'k2' — suffix of the env var name
  purpose: text('purpose').notNull(),                 // 'data-at-rest' | 'blob' | 'field'
  alg: text('alg').notNull().default('A256GCM'),
  state: text('state').notNull().default('active'),   // 'active' | 'rotating' | 'retired'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  rotationDays: integer('rotation_days').notNull().default(365),
}, (t) => ({
  stateIdx: index('crypto_keys_state_idx').on(t.state),
}));

export type CryptoKey = typeof cryptoKeys.$inferSelect;
```

### 3.3 Derived threat signals

```ts
// src/lib/security/schema.ts
import { pgTable, uuid, varchar, jsonb, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const securitySignals = pgTable('security_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: varchar('kind', { length: 60 }).notNull(),     // see SignalKind
  severity: varchar('severity', { length: 10 }).notNull(), // 'low' | 'medium' | 'high'
  subjectUserId: uuid('subject_user_id'),              // nullable: not all signals are user-scoped
  subjectIp: varchar('subject_ip', { length: 64 }),
  score: integer('score').notNull().default(0),        // detector-specific magnitude
  evidence: jsonb('evidence').$type<Record<string, unknown>>(), // counts, window, sample ids
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('open'), // 'open' | 'ack' | 'dismissed'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindIdx: index('security_signals_kind_idx').on(t.kind),
  subjIdx: index('security_signals_subject_idx').on(t.subjectUserId),
  createdIdx: index('security_signals_created_idx').on(t.createdAt),
}));

export type SecuritySignal = typeof securitySignals.$inferSelect;
```

```ts
// src/lib/security/detectors.ts (shared types)
export type SignalKind =
  | 'login-burst'            // many failed auth events for one identity/IP
  | 'privilege-escalation'   // repeated DENIED administer/manage decisions
  | 'session-fanout'         // one user, many concurrent sessions / IPs
  | 'impossible-travel'      // same user, distinct IPs within a short window
  | 'unguarded-route';       // API route without an authZ guard signal

export interface AuditRow {                 // shape read from audit_log
  userId: string | null; action: string; entity: string;
  ipAddress: string | null; createdAt: Date;
}
export interface RbacAuditRow {             // shape read from rbac_audit (timestamp column is `at`, not created_at)
  userId: string | null; capability: string; allow: boolean;
  reason: string; at: Date;
}
export interface SessionRow {               // shape read from sessions
  userId: string; ipAddress: string | null; createdAt: Date;
}
export interface DetectedSignal {
  kind: SignalKind; severity: 'low' | 'medium' | 'high';
  subjectUserId: string | null; subjectIp: string | null;
  score: number; evidence: Record<string, unknown>;
  windowStart: Date; windowEnd: Date;
}
```

## 4. Interfaces & API contracts

### 4.1 Cryptographic library (in-process, no network)

```ts
// src/lib/crypto/keys.ts
/** Resolve raw 32-byte key material for a keyId from env (DATA_ENCRYPTION_KEY_<keyId>, base64). */
export function getKeyMaterial(keyId: string): Buffer;           // throws if unset/malformed
/** The keyId whose crypto_keys.state = 'active'. Cached per-invocation. */
export function activeKeyId(): string;                           // reads env ACTIVE_DATA_KEY_ID (default 'k1')
export function listKeyMetadata(): Promise<CryptoKey[]>;
export function markRotating(oldKeyId: string, newKeyId: string): Promise<void>;
export function retireKey(keyId: string): Promise<void>;

// src/lib/crypto/envelope.ts   (uses node:crypto createCipheriv('aes-256-gcm'))
export function encryptField(plaintext: string, aad?: string): EnvelopeCiphertext;
export function decryptField(env: EnvelopeCiphertext): string;   // selects key by env.keyId
export function encryptBlob(data: Uint8Array, aad?: string): { header: EnvelopeCiphertext; body: Uint8Array };
export function decryptBlob(header: EnvelopeCiphertext, body: Uint8Array): Uint8Array;
```

### 4.2 Zero-trust request contract (thin wrapper over existing rbac guard + session)

```ts
// src/lib/security/authz.ts  (new, wraps existing modules — no new policy engine)
import type { Capability } from '@/lib/rbac/capabilities';
import type { ResourceRef, EvalContext, Decision } from '@/lib/rbac/types';

/**
 * The single per-request gate. Verifies (1) a live session exists on locals.user,
 * (2) the capability decision from the RBAC engine allows the action. Deny-by-default:
 * a null user or a denied decision throws. Writes exactly one rbac_audit row (via guard).
 */
export async function authorizeRequest(
  locals: { user: unknown | null },
  cap: Capability,
  res?: ResourceRef,
  ctx?: EvalContext,
): Promise<Decision>;   // throws ForbiddenError (403) when denied
```

### 4.3 Threat detection

```ts
// src/lib/security/detectors.ts  (PURE — unit-testable, no DB)
export function detectLoginBursts(rows: AuditRow[], now: Date): DetectedSignal[];
export function detectPrivilegeEscalation(rows: RbacAuditRow[], now: Date): DetectedSignal[];
export function detectSessionFanout(rows: SessionRow[], now: Date): DetectedSignal[];
export function detectImpossibleTravel(rows: SessionRow[], now: Date): DetectedSignal[];

// src/lib/security/signals.ts  (orchestration + persistence)
export async function runSecurityScan(windowMinutes?: number): Promise<{ inserted: number; byKind: Record<string, number> }>;
export async function listSignals(opts?: { status?: string; limit?: number }): Promise<SecuritySignal[]>;
export async function setSignalStatus(id: string, status: 'ack' | 'dismissed'): Promise<void>;

// src/lib/security/trust.ts
export async function computeTrustScore(userId: string): Promise<{ score: number; factors: Record<string, number> }>; // 0..100
```

### 4.4 Astro endpoints

| Method | Path | Guard | Request | Response |
|---|---|---|---|---|
| GET  | `/api/admin/security/signals` | superadmin (`authorizeRequest(..,'audit',{type:'security'})`) | `?status&limit` | `{ signals: SecuritySignal[] }` |
| POST | `/api/admin/security/signals` | superadmin | `{ id, status:'ack'\|'dismissed' }` | `{ ok: true }` |
| GET  | `/api/admin/security/keys` | superadmin | — | `{ keys: CryptoKey[] }` (metadata only, never material) |
| POST | `/api/admin/security/keys` | superadmin | `{ op:'rotate', oldKeyId, newKeyId }` | `{ ok: true }` |
| POST | `/api/cron/security-scan` | `CRON_SECRET` header | — | `{ inserted, byKind }` |

## 5. Core logic / algorithms

### 5.1 Envelope encryption (AES-256-GCM, `node:crypto`)

```ts
// src/lib/crypto/envelope.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { activeKeyId, getKeyMaterial } from './keys';
import { EnvelopeCiphertextSchema, type EnvelopeCiphertext } from './schema';

export function encryptField(plaintext: string, aad?: string): EnvelopeCiphertext {
  const keyId = activeKeyId();
  const key = getKeyMaterial(keyId);                       // 32 bytes, base64-decoded from env
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));        // MUST precede update()
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();                         // 16 bytes
  return {
    v: 1, keyId, alg: 'A256GCM',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
    ...(aad ? { aad } : {}),
  };
}

export function decryptField(env: EnvelopeCiphertext): string {
  EnvelopeCiphertextSchema.parse(env);                     // reject malformed/tampered structure
  const key = getKeyMaterial(env.keyId);                   // selected by keyId — resolvable during/after rotation
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));     // set before final()
  if (env.aad) decipher.setAAD(Buffer.from(env.aad, 'utf8')); // set before update()
  // decipher.final() THROWS on tag mismatch => tamper / wrong-key detection is automatic
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
}
```

Rotation is non-destructive: `decryptField` always selects the key by the stored `keyId`, so ciphertext written under `k1` keeps decrypting after `k2` becomes active. Re-encryption is a lazy background pass (read → `decryptField` → `encryptField` under new active key) — not a blocking migration.

### 5.2 Zero-trust per-request evaluation (already deterministic in `rbac/engine.ts`)

```
authorizeRequest(locals, cap, res, ctx):
  1. if !locals.user -> ForbiddenError('no identity')          // deny-by-default
  2. requireCapability(locals.user, cap, res, ctx):            // -> rbac/guard.ts
       a. resolvePrincipal(user)  // loads roles, sessionValid, grants
       b. evaluate(...) runs the 8-stage pipeline:
          resolve-identity -> verify-session -> verify-authorization ->
          validate-capability -> load-permission-context -> evaluate-rules ->
          apply-constraints -> return-decision
       c. explicit DENY grant overrides any ALLOW  (spec: deny overrides allow)
       d. security-label gating: every label on the resource must admit the principal
       e. writeAudit(decision)  // exactly one rbac_audit row
  3. if !decision.allow -> throw ForbiddenError (endpoint maps to 403)
```
No implicit trust is granted by network position, prior request, or cached decision: every request re-runs steps 1–3. This is the realistic serverless form of the spec's "Secure Execution Policies" and "Continuous Trust Evaluation".

### 5.3 Threat detectors (pure, over a rolling window)

```
detectLoginBursts(auditRows, now):
  window = now - 15min
  group failed-auth rows (action in {'login.failed','2fa.failed'}) by (userId ?? ipAddress)
  for each group with count >= 5:
      severity = count >= 20 ? 'high' : count >= 10 ? 'medium' : 'low'
      emit { kind:'login-burst', subject.., score:count, evidence:{count, sampleIds} }

detectPrivilegeEscalation(rbacRows, now):
  window = now - 60min
  group rbac_audit rows where allow=false AND capability in {'administer','manage','delete'} by userId
  for each group with count >= 3:
      severity = count >= 8 ? 'high' : 'medium'
      emit { kind:'privilege-escalation', subjectUserId, score:count, evidence:{deniedCaps} }

detectSessionFanout(sessionRows, now):
  window = now - 60min
  group sessions by userId; distinctIps = |unique ipAddress|
  if distinctIps >= 4: emit { kind:'session-fanout', severity: distinctIps>=8?'high':'medium', score:distinctIps }

detectImpossibleTravel(sessionRows, now):
  window = now - 30min
  for each userId with >=2 sessions from DISTINCT ipAddress inside window:
      emit { kind:'impossible-travel', severity:'medium', score:distinctIps, evidence:{ips} }
      // NOTE: distinct-IP proxy only; no geo-velocity (see §7)
```

### 5.4 `runSecurityScan` orchestration

```
runSecurityScan(windowMinutes = 60):
  1. ensureSecuritySchema()                     // CREATE TABLE IF NOT EXISTS security_signals
  2. now = new Date(); start = now - windowMinutes
  3. read audit_log WHERE created_at >= start (uses audit_created_idx),
     rbac_audit  WHERE at >= start         (uses rbac_audit_at_idx),   // rbac_audit's ts column is `at`
     sessions    WHERE created_at >= start  (small table; created_at not separately indexed)
  4. signals = [ ...detectLoginBursts, ...detectPrivilegeEscalation,
                 ...detectSessionFanout, ...detectImpossibleTravel ]
  5. de-dupe against existing OPEN signals with same (kind, subject, overlapping window)
  6. INSERT the survivors; return { inserted, byKind }
```

### 5.5 Continuous trust score (advisory)

```
computeTrustScore(userId): score starts at 50
  + 20 if user has confirmed TOTP or a WebAuthn passkey (user_totp.confirmed_at / user_passkeys)
  + 10 if email_verified
  + 10 if newest session ipAddress matches the previous session ipAddress (stable device)
  - 25 if >=1 OPEN high-severity security_signal for this user in last 24h
  - 10 per OPEN medium signal (cap -30)
  clamp 0..100 ; return { score, factors }
```
Advisory only: step-up-auth / block decisions are a human/config policy, not automated here (§7).

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20) — the crypto layer, the four threat detectors, the scan/trust/authz orchestration, and all three endpoints landed with tests; `crypto.test.ts` **12/12**, `security.test.ts` **14/14**, `astro check` **zero errors** in touched files (repo total unchanged at 184). The remaining items are call-site adoption / ops config (wire encryption into one PII path, register the cron in `vercel.json`, emit `login.failed` audit events, observability panel) — flagged deferred.

- [x] **Crypto env contract.** Documented: `DATA_ENCRYPTION_KEY_k1` (base64 32 bytes), `ACTIVE_DATA_KEY_ID=k1`, `CRON_SECRET`.
- [x] `src/lib/crypto/keys.ts` — `getKeyMaterial` (env + 32-byte assert), `activeKeyId`, self-bootstrapping `crypto_keys` (seeds active row) + `listKeyMetadata`/`markRotating`/`retireKey`.
- [x] `src/lib/crypto/envelope.ts` — `encryptField`/`decryptField`/`encryptBlob`/`decryptBlob` (AES-256-GCM). Tested: round-trip, AAD binding, tamper (flipped ct byte + flipped tag → throw), non-destructive rotation, blob byte-for-byte.
- [ ] **Deferred** — wire encryption into one real PII path (call-site adoption).
- [x] `src/lib/security/detectors.ts` — 4 pure detectors (login-burst, privilege-escalation, session-fanout, impossible-travel). Fully unit-tested.
- [x] `src/lib/security/{schema,signals}.ts` — `security_signals` self-bootstrap, `runSecurityScan` (dedupes vs open), `listSignals`, `setSignalStatus`. Reads `audit_log`/`rbac_audit`/`sessions`.
- [x] `src/lib/security/trust.ts` — advisory `computeTrustScore`.
- [x] `src/lib/security/authz.ts` — `authorizeRequest` deny-by-default wrapper.
- [x] Endpoints: `admin/security/signals.ts`, `admin/security/keys.ts` (audited), `cron/security-scan.ts` (`CRON_SECRET`-guarded, GET+POST).
- [ ] **Deferred** — register cron in `vercel.json`; observability open-signals panel; emit `login.failed`/`2fa.failed` audit writes in the auth paths.

## 7. Reality checks & risks

**Kernel/OS metaphor that does NOT map to serverless — reframed:**
- "Constitutional Security Kernel", "Hardware Root of Trust", "Secure Boot", "Runtime Attestation" (firmware/bootloader/driver attestation), "Secure Enclave Runtime", "confidential inference", TPM/HSM/PCIe-HSM integration — **out of scope.** This is a Vercel serverless web app running managed functions; there is no boot chain, kernel, or hardware we control to attest. The realistic equivalent already in place is: hashed session tokens, `secure`/`httpOnly` cookies, TLS terminated by the platform, and per-request capability checks. Hardware-backed keys would require a managed KMS/HSM (see below) — a paid infra + human decision.
- "Continuous Monitoring" / resident SIEM/XDR/SOAR daemon — there is no long-running process. Reframed as a **Vercel-cron-triggered `runSecurityScan`** over Postgres audit tables plus on-demand admin queries. Detection latency is bounded by the cron interval, not real-time.
- "Secure Enclave" for AI model protection / "confidential inference" — the LLM path (`src/lib/llm`) calls external providers; there is no enclave. Out of scope.

**Explicitly aspirational / out-of-scope (flagged per task):**
- **Post-quantum cryptography** (hybrid KEX, hybrid signatures, quantum-secure attestation, QKD) — out of scope. `@oslojs/crypto` and `node:crypto` ship no PQC primitives, and there is no PQC requirement for this product. The design keeps **crypto-agility** as the only realistic PQC concession: every ciphertext carries `keyId`+`alg`, so a future algorithm can be introduced by a new key/alg without re-touching call sites.
- **"Autonomous cyber defense" / self-healing / autonomous SOC / AI security agents** (Vol V Ch 100) — out of scope. Detection here **surfaces** signals to a human admin (`status: open|ack|dismissed`); it does not auto-remediate, auto-ban, or take unattended defensive action. `computeTrustScore` is advisory. Automated response is a deliberate non-goal and a human-policy decision.
- **PKI hierarchy / Certificate Authority runtime / certificate lifecycle automation** (Ch 22 §10) — out of scope. TLS certs are managed by Vercel; the app issues no certificates.

**External services / infra required:**
- Key material must be provisioned as Vercel env vars; treat env access as the trust boundary. `node:crypto` GCM runs only in the **Node serverless runtime** (this repo's adapter), **not** in edge middleware — encryption/decryption must stay in server endpoints/libs, never edge.
- Real durable object encryption for blobs depends on `BLOB_READ_WRITE_TOKEN` (`src/lib/storage.ts`); without it the memory fallback is dev-only.

**Decisions needing a human:**
- Whether to adopt a managed KMS (AWS KMS / GCP KMS / Vercel-integrated) instead of env-var-held KEKs — the env-var approach is simple and adequate for field/blob encryption but keeps key material reachable by any function; a managed KMS would give per-operation authz and hardware backing at added cost/complexity.
- Key rotation cadence and who runs the lazy re-encryption pass.
- Thresholds in the detectors (burst counts, fanout limits) and whether any signal should trigger step-up auth or session invalidation (currently manual).
- `impossible-travel` uses a distinct-IP proxy only; adding true geo-velocity needs a GeoIP dependency and a stored coordinate history — deferred until there is signal that IP-distinctness produces too many false positives.

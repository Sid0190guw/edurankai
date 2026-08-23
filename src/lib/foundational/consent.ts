// src/lib/foundational/consent.ts — NO CONSENT, NO COMPUTATION. The gate, and the seam.
//
// =================================================================================================
// WHY THIS IS AN INTERFACE AND NOT JUST A TABLE
// =================================================================================================
//
// Consent for personal data is an organisation-wide concern, and in a system built by several
// patches at once it is entirely likely that another one owns the consent register. This patch must
// not build that register a second time — a duplicate consent table is worse than none, because two
// answers to "did this person agree" is the same as no answer.
//
// So: ConsentGate is the contract, and the DEFAULT implementation is a small fpc_consent table that
// works on its own today. When the patch that owns consent arrives, it calls setConsentProvider()
// once at start-up and this engine reads its register instead, with nothing else changing and no
// migration needed. The default table stays as the fallback for an installation that has no central
// register at all.
//
// =================================================================================================
// WHAT THE GATE ACTUALLY ENFORCES
// =================================================================================================
//
//  1. PURPOSE LIMITATION. A grant is for CONSENT_PURPOSE and nothing else. Consent to a background
//     check is not consent to this, and the gate will not accept it as such.
//  2. AN EVIDENCE REFERENCE IS REQUIRED. `evidence_ref` points at where the person actually agreed —
//     a form submission, a signed record, a ticket. A consent row that cannot say where it came from
//     is not evidence of consent, it is an assertion by whoever inserted it.
//  3. REVOCATION IS IMMEDIATE AND IT WINS. The most recent grant for a purpose decides, and a
//     revoked grant refuses every read and every recomputation from the moment it is written.
//  4. NOTHING IS INFERRED. There is no "implied", no "legitimate interest" branch and no default of
//     true anywhere in this file.
import { logAudit } from '@/lib/audit';
import { CONSENT_PURPOSE, reasonOf, rowsOf, type SubjectRef } from './types';
import { ensureFoundationalSchema } from './schema';

const MOD = 'foundational-consent';

export interface ConsentState {
  granted: boolean;
  /** Where the agreement is recorded. Present on every granted state. */
  evidenceRef: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  /** Which register answered — the default table, or whoever replaced it. */
  source: string;
}

export interface ConsentGrantInput {
  subject: SubjectRef;
  evidenceRef: string;
  recordedBy: string | null;
  notes?: string | null;
}

/** The seam. Implement this to put the engine behind a central consent register. */
export interface ConsentGate {
  readonly name: string;
  check(subject: SubjectRef, purpose: string): Promise<ConsentState>;
  /** Optional: a central register may refuse to be written through this engine, which is correct. */
  grant?(input: ConsentGrantInput, purpose: string): Promise<{ ok: boolean; error?: string }>;
  revoke?(subject: SubjectRef, purpose: string, actorId: string | null): Promise<{ ok: boolean; error?: string }>;
}

// -------------------------------------------------------------------------------------------------
// THE DEFAULT IMPLEMENTATION
// -------------------------------------------------------------------------------------------------

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

const defaultGate: ConsentGate = {
  name: 'fpc_consent',

  async check(subject, purpose) {
    const miss: ConsentState = { granted: false, evidenceRef: null, grantedAt: null, revokedAt: null, source: 'fpc_consent' };
    try {
      await ensureFoundationalSchema();
      const { db, sql } = await ctx();
      const rows = rowsOf(await db.execute(sql`
        SELECT granted, evidence_ref, granted_at, revoked_at
          FROM fpc_consent
         WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id} AND purpose = ${purpose}
         ORDER BY granted_at DESC
         LIMIT 1
      `));
      const row = rows[0];
      if (!row) return miss;
      const revoked = !!row.revoked_at;
      return {
        granted: !!row.granted && !revoked,
        evidenceRef: row.evidence_ref || null,
        grantedAt: row.granted_at ? new Date(row.granted_at).toISOString() : null,
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        source: 'fpc_consent',
      };
    } catch (e: any) {
      // A consent check that cannot reach its register REFUSES. Failing open on this particular
      // question would compute a person's birth data because the database was busy.
      console.error('[' + MOD + '] check failed: ' + reasonOf(e));
      return miss;
    }
  },

  async grant(input, purpose) {
    const evidenceRef = String(input.evidenceRef || '').trim();
    if (!evidenceRef) return { ok: false, error: 'evidenceRef is required — a consent row without a source is not evidence' };
    try {
      await ensureFoundationalSchema();
      const { db, sql } = await ctx();
      await db.execute(sql`
        INSERT INTO fpc_consent (subject_kind, subject_id, purpose, granted, evidence_ref, recorded_by, notes)
        VALUES (${input.subject.kind}, ${input.subject.id}, ${purpose}, TRUE, ${evidenceRef},
                ${input.recordedBy}, ${input.notes ?? null})
      `);
      await logAudit({
        userId: input.recordedBy,
        action: 'foundational.consent.granted',
        entity: 'fpc_consent',
        entityId: input.subject.id,
        diff: { subjectKind: input.subject.kind, purpose, evidenceRef },
      });
      return { ok: true };
    } catch (e: any) {
      const error = reasonOf(e);
      console.error('[' + MOD + '] grant failed: ' + error);
      return { ok: false, error };
    }
  },

  async revoke(subject, purpose, actorId) {
    try {
      await ensureFoundationalSchema();
      const { db, sql } = await ctx();
      await db.execute(sql`
        UPDATE fpc_consent
           SET revoked_at = NOW()
         WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
           AND purpose = ${purpose} AND revoked_at IS NULL
      `);
      await logAudit({
        userId: actorId,
        action: 'foundational.consent.revoked',
        entity: 'fpc_consent',
        entityId: subject.id,
        diff: { subjectKind: subject.kind, purpose },
      });
      return { ok: true };
    } catch (e: any) {
      const error = reasonOf(e);
      console.error('[' + MOD + '] revoke failed: ' + error);
      return { ok: false, error };
    }
  },
};

/**
 * THE DEFAULT: ask HORIZON patch 01, and use this engine's own table only when patch 01 is genuinely
 * not installed.
 *
 * The order matters and the fallback condition is narrow. A deployment running the intake patch has
 * ONE consent ledger and this engine must read it, not keep a second opinion beside it. A deployment
 * running the computation engine on its own still needs a gate, so the local table stays — but it is
 * reached only when the import itself fails or the subject has no HORIZON identity space, never when
 * patch 01 is present and simply answered "no".
 *
 * `source` on the returned state always names which of the two answered, so a support question about
 * why a computation refused has a one-word answer instead of an investigation.
 */
const bridgedGate: ConsentGate = {
  name: 'horizon-intake, falling back to fpc_consent',
  async check(subject, purpose) {
    const { horizonConsentGate } = await import('./horizon-bridge');
    const upstream = await horizonConsentGate.check(subject, purpose);
    if (upstream.source !== 'unavailable') return upstream;
    return defaultGate.check(subject, purpose);
  },
  grant(input, purpose) { return defaultGate.grant!(input, purpose); },
  revoke(subject, purpose, actorId) { return defaultGate.revoke!(subject, purpose, actorId); },
};

let gate: ConsentGate = bridgedGate;

/**
 * Point this engine at a different consent register. Called ONCE at start-up by the patch that owns
 * consent; calling it per request is a race nobody will enjoy debugging.
 */
export function setConsentProvider(provider: ConsentGate): void {
  gate = provider;
}

export function consentProviderName(): string {
  return gate.name;
}

/** The only consent question this engine ever asks. */
export function checkConsent(subject: SubjectRef, purpose: string = CONSENT_PURPOSE): Promise<ConsentState> {
  return gate.check(subject, purpose);
}

export async function grantConsent(input: ConsentGrantInput, purpose: string = CONSENT_PURPOSE): Promise<{ ok: boolean; error?: string }> {
  if (!gate.grant) return { ok: false, error: `consent register '${gate.name}' does not accept grants through this engine` };
  return gate.grant(input, purpose);
}

export async function revokeConsent(subject: SubjectRef, actorId: string | null, purpose: string = CONSENT_PURPOSE): Promise<{ ok: boolean; error?: string }> {
  if (!gate.revoke) return { ok: false, error: `consent register '${gate.name}' does not accept revocations through this engine` };
  return gate.revoke(subject, purpose, actorId);
}

/** Restore the default (HORIZON patch 01, falling back to the local table). For tests. */
export function resetConsentProvider(): void {
  gate = bridgedGate;
}

/** The local table gate on its own, for a deployment that deliberately wants no upstream. */
export function localConsentGate(): ConsentGate {
  return defaultGate;
}

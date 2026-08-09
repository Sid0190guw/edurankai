// src/lib/aes/providers/types.ts — the AES provider contract (spec sections 41 + 42).
//
// THE POINT OF THIS FILE. AES must not be built on the assumption that an external model is
// permanently the intelligence. Every capability AES needs — language, sight, hearing, space,
// physics, rendering, pedagogy — is declared here as an INTERFACE. Today some of those interfaces
// are answered by a deterministic engine this repository already owns, one is answered by whatever
// model access happens to be configured, and several are answered by nothing at all. That is fine,
// and it is the reason the interface exists: when the foundation model arrives it is registered
// here, and not one module above this layer changes.
//
// THREE RULES THIS FILE ENFORCES, and the tests hold to:
//   1. UNAVAILABLE IS A FIRST-CLASS STATE WITH A REASON. A provider that needs configuration
//      nobody has supplied reports { state: 'unavailable', reason }. It does not throw, and it does
//      not return an empty success that a caller will mistake for an answer.
//   2. A MISSING CAPABILITY IS REFUSED, NEVER SILENTLY NO-OPED. Every call returns a discriminated
//      result; a refusal carries the sentence a teacher can read and, where one exists, the remedy.
//   3. NO VENDOR ABOVE THIS LINE. Nothing in src/lib/aes may import a vendor SDK, name a vendor, or
//      assume a particular model shape. The one adapter that reaches configured model access does
//      so through this project's own gateway, and reports neutral labels upward.
//
// The `cannot` list on every descriptor is not documentation politeness. Sections 20 and 172: the
// model decides INTENT, a deterministic engine computes the PHYSICS, and visual plausibility is
// never evidence of scientific correctness. A provider states out loud what it must never be
// trusted to do, so the console can show a teacher exactly where that line falls.

export type ProviderKind =
  | 'foundation' | 'vision' | 'speech' | 'spatial' | 'simulation' | 'rendering' | 'learning-policy';

export const PROVIDER_KINDS: ProviderKind[] = [
  'foundation', 'vision', 'speech', 'spatial', 'simulation', 'rendering', 'learning-policy',
];

/** Deterministic = the same input gives the same answer, and the answer is computed, not guessed.
 *  Stochastic = a model produced it; it is a PROPOSAL, and something else must validate it. */
export type Determinism = 'deterministic' | 'stochastic';

export interface Health {
  state: 'available' | 'unavailable';
  /** Always a full sentence, in BOTH states. "Available" with no explanation tells a teacher
   *  nothing about what is actually running behind it. */
  reason: string;
  /** What would make an unavailable provider available. Omitted when nothing here can be done. */
  remedy?: string;
  checkedAt: string;
}

export interface CapabilityDecl {
  /** Dotted lowercase, kind-prefixed: 'simulation.pendulum', 'foundation.intent'. */
  id: string;
  summary: string;
  determinism: Determinism;
  /** false = the INTERFACE declares this capability but THIS provider cannot answer it.
   *  A declared-but-unsupported capability must carry a reason; the tests assert that. */
  supported: boolean;
  reason?: string;
}

export interface ProviderDescriptor {
  /** Dotted lowercase: kind.implementation, e.g. 'simulation.rk4', 'foundation.null'. */
  id: string;
  kind: ProviderKind;
  title: string;
  /** Plain language, for the console. What this provider actually does. */
  does: string;
  /** Hard limits, stated out loud. Never empty — a provider that claims no limits is lying. */
  cannot: string[];
  /** Configuration this provider needs before it can be available. [] = it needs nothing. */
  requires: string[];
  capabilities: CapabilityDecl[];
}

export interface Ok<T> {
  ok: true;
  providerId: string;
  capability: string;
  determinism: Determinism;
  value: T;
  elapsedMs: number;
}

export interface Refusal {
  ok: false;
  providerId: string;
  capability: string;
  reason: string;
  remedy?: string;
}

export type AesResult<T> = Ok<T> | Refusal;

export interface AesProvider {
  readonly descriptor: ProviderDescriptor;
  /** Cheap, and side-effect free where possible. Never throws: a failed probe IS an unavailability. */
  health(): Promise<Health>;
  supports(capability: string): boolean;
}

export const nowIso = (): string => new Date().toISOString();

export function available(reason: string): Health {
  return { state: 'available', reason, checkedAt: nowIso() };
}

export function unavailable(reason: string, remedy?: string): Health {
  const h: Health = { state: 'unavailable', reason, checkedAt: nowIso() };
  if (remedy) h.remedy = remedy;
  return h;
}

export function refuse(providerId: string, capability: string, reason: string, remedy?: string): Refusal {
  const r: Refusal = { ok: false, providerId, capability, reason };
  if (remedy) r.remedy = remedy;
  return r;
}

/** The real driver reason lives on e.cause; e.message is often only the failed statement. */
export const errText = (e: any): string => String(e?.cause?.message || e?.message || e || 'unknown error');

/**
 * Every provider call goes through ONE funnel, so no implementation can invent its own way of
 * quietly doing nothing:
 *
 *   unknown capability   -> refused, naming the capability
 *   declared-unsupported -> refused, with the declared reason
 *   provider unavailable -> refused, with the health reason AND its remedy
 *   implementation threw -> refused, carrying the real message (never swallowed, never a fake ok)
 */
export abstract class BaseProvider implements AesProvider {
  abstract readonly descriptor: ProviderDescriptor;
  abstract health(): Promise<Health>;

  supports(capability: string): boolean {
    const c = this.descriptor.capabilities.find((x) => x.id === capability);
    return !!c && c.supported;
  }

  capability(id: string): CapabilityDecl | null {
    return this.descriptor.capabilities.find((x) => x.id === id) || null;
  }

  protected async guarded<T>(capability: string, fn: () => T | Promise<T>): Promise<AesResult<T>> {
    const id = this.descriptor.id;
    const decl = this.capability(capability);
    if (!decl) {
      return refuse(id, capability, 'The capability ' + capability + ' is not offered by ' + id + '. Nothing was done.');
    }
    if (!decl.supported) {
      return refuse(id, capability, decl.reason || (id + ' declares ' + capability + ' but does not implement it.'));
    }
    const h = await this.health();
    if (h.state !== 'available') return refuse(id, capability, h.reason, h.remedy);

    const t0 = Date.now();
    try {
      const value = await fn();
      return { ok: true, providerId: id, capability, determinism: decl.determinism, value, elapsedMs: Date.now() - t0 };
    } catch (e: any) {
      // Not swallowed: the caller gets the failure as a refusal with the real reason attached.
      return refuse(id, capability, id + ' failed while running ' + capability + ': ' + errText(e));
    }
  }
}

/** A null provider is honest about doing nothing: unavailable, with a reason, refusing every call.
 *  It exists so a surface can be wired to the interface before any backend exists — and so a caller
 *  cannot tell the difference between "not built yet" and "misconfigured": both are refusals with a
 *  sentence attached, and neither is an empty success. */
export abstract class NullProvider extends BaseProvider {
  protected constructor(private readonly why: string, private readonly how?: string) { super(); }
  async health(): Promise<Health> { return unavailable(this.why, this.how); }
}

/** Build a capability list for a null provider from an interface's declared capability set. */
export function unsupportedAll(
  decls: { id: string; summary: string; determinism: Determinism }[],
  reason: string,
): CapabilityDecl[] {
  return decls.map((d) => ({ ...d, supported: false, reason }));
}

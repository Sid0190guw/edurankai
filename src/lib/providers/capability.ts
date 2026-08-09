// src/lib/providers/capability.ts — the shared vocabulary behind the three provider interfaces:
// what an integration CAN do, what it CANNOT do and why, and the one registry shape that makes
// adding a provider a registration rather than an edit to the core.
//
// WHY THIS FILE EXISTS
// -------------------
// Section 51 (the core must never depend on one vendor) is only real if the core can ask a question
// it does not already know the answer to. Everywhere this product currently integrates something,
// the knowledge of what that something can do is spread across the screens: one page would render a
// quality selector because somebody assumed there were renditions, another would render an "End the
// class for everyone" button over a meeting held on a service we do not control. Both are the same
// defect — a surface ASSUMING a capability instead of ASKING for one.
//
// So every provider here declares its capabilities, INCLUDING the ones it does not have, each with
// the sentence that says why. An unavailable capability is a first-class state:
//   * it is NOT an error       — nothing has gone wrong; this integration simply does not do that;
//   * it is NOT a silent no-op — calling it returns a Refusal, never `undefined` and never `ok`;
//   * it is NOT a lie          — the reason is a complete sentence a person can act on, and the
//                                registry REFUSES to register a provider that omits one.
//
// THESE ARE NOT RBAC CAPABILITY KEYS.
// -----------------------------------
// src/lib/auth/permissions.ts owns dotted lowercase keys ('admin.access', 'hr.employee.read') that
// answer "MAY THIS PERSON do the thing", and a key outside that union is a permanent 403. The keys
// in this file answer a completely different question — "CAN THIS INTEGRATION do the thing" — and
// they are snake_case precisely so the two can never be confused, passed to the wrong checker, or
// swept into the permission union by somebody tidying up. A provider capability never grants
// anybody anything. Both checks belong at a call site: the person must be permitted, and the
// provider must be able.
//
// Pure: no database, no network, no Astro. Runs under `npx tsx`.

// ---------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------

/** One thing an integration either can or cannot do. */
export interface ProviderCapability {
  /** snake_case. Stable — a screen and a stored configuration both key off it. */
  key: string;
  /** Short admin-facing phrase for a capability table. */
  label: string;
  available: boolean;
  /**
   * REQUIRED when `available` is false, and it must be a sentence rather than a word. This is the
   * text a screen shows instead of the control it did not render, so "no" is not an acceptable
   * value: the reader needs to know whether to wait, to configure something, or to choose
   * differently. Null when the capability IS available.
   */
  reason: string | null;
}

/** Whether the provider as a whole can be used at all right now. */
export interface ProviderAvailability {
  available: boolean;
  /** REQUIRED when unavailable. Same rule as above: a sentence, not a code. */
  reason: string | null;
}

/** What every provider in every registry has in common. */
export interface Provider {
  /** Registration key. snake_case, stable, stored in configuration. Never rendered to a learner. */
  id: string;
  /**
   * The name an ADMINISTRATOR sees when choosing an integration. Naming a provider here is allowed
   * and is often necessary — you cannot choose between integrations whose names you are not allowed
   * to see. LEARNER-facing copy never carries this; see the learner labels in video.ts and live.ts.
   */
  adminLabel: string;
  /** One sentence describing what this integration is, for the same admin screen. */
  adminNote: string;
  availability: ProviderAvailability;
  capabilities: ProviderCapability[];
}

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

/**
 * What a capability-gated call returns when it will not run.
 *
 * It is a VALUE, not a thrown error, because "this provider does not do that" is an ordinary,
 * expected answer that a screen renders as a sentence — and because a throw at this boundary would
 * sooner or later be caught by somebody's `catch {}` and become the silent no-op this whole file
 * exists to prevent.
 */
export interface Refusal {
  ok: false;
  /** Which kind of thing was missing: the capability, or the provider itself. */
  refused: 'capability' | 'provider';
  /** Provider id, or the registry name when no provider was found. */
  provider: string;
  /** The capability key asked for. Empty when the provider itself was the problem. */
  capability: string;
  /** A complete sentence. Safe to show an administrator; never a stack trace and never a code. */
  reason: string;
  /**
   * True when the provider never declared this capability AT ALL — as opposed to declaring it
   * unavailable with a reason. Undeclared is its own fact: it usually means a caller invented a
   * capability key, or a provider was written before the capability existed, and either way the
   * answer is still "no", because nothing may assume a capability without asking.
   */
  undeclared: boolean;
}

export function isRefusal(x: unknown): x is Refusal {
  return !!x && typeof x === 'object' && (x as any).ok === false && 'refused' in (x as any);
}

// ---------------------------------------------------------------------------------------------
// Building a declaration
// ---------------------------------------------------------------------------------------------

/** Declare a capability this provider HAS. */
export function can(key: string, label: string): ProviderCapability {
  return { key, label, available: true, reason: null };
}

/** Declare a capability this provider does NOT have, with the sentence that says why. */
export function cannot(key: string, label: string, reason: string): ProviderCapability {
  return { key, label, available: false, reason };
}

/** Provider-level availability helpers. */
export const AVAILABLE: ProviderAvailability = { available: true, reason: null };
export function unavailable(reason: string): ProviderAvailability {
  return { available: false, reason };
}

// ---------------------------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------------------------

export function capabilityOf(p: Provider, key: string): ProviderCapability | null {
  return (p?.capabilities || []).find((c) => c.key === key) || null;
}

/**
 * Can this provider do this, right now?
 *
 * An UNKNOWN key is false. Not an exception, not true, not a warning that gets ignored — false.
 * "We have never heard of that capability" and "we do not have it" are the same answer to a screen
 * deciding whether to render a button.
 */
export function supports(p: Provider, key: string): boolean {
  if (!p || p.availability.available === false) return false;
  const c = capabilityOf(p, key);
  return !!c && c.available === true;
}

/** The sentence to show where the control would have been. Empty when the capability IS available. */
export function reasonFor(p: Provider, key: string): string {
  if (!p) return 'No integration is configured for this, so there is nothing to show.';
  if (p.availability.available === false) return p.availability.reason || 'This integration is not available on this server.';
  const c = capabilityOf(p, key);
  if (!c) return 'This integration has not said whether it can do that, so we will not act as though it can.';
  if (c.available) return '';
  return c.reason || 'This integration cannot do that here.';
}

/**
 * THE GUARD. Returns a Refusal when the call must not proceed, or null when it may.
 *
 * Written as "return the refusal" rather than "throw" so an async method can use it in one line
 * without a try/catch that a later edit turns into a swallow:
 *     const no = deny(provider, 'upload_original'); if (no) return no;
 */
export function deny(p: Provider, key: string): Refusal | null {
  if (!p) {
    return {
      ok: false, refused: 'provider', provider: '', capability: key, undeclared: true,
      reason: 'No integration is configured for this, so nothing was done.',
    };
  }
  if (p.availability.available === false) {
    return {
      ok: false, refused: 'provider', provider: p.id, capability: key, undeclared: false,
      reason: p.availability.reason || 'This integration is not available on this server, so nothing was done.',
    };
  }
  const c = capabilityOf(p, key);
  if (!c) {
    return {
      ok: false, refused: 'capability', provider: p.id, capability: key, undeclared: true,
      reason: 'This integration has not said whether it can do that, so nothing was done. Nothing may assume a capability it has not asked for.',
    };
  }
  if (!c.available) {
    return {
      ok: false, refused: 'capability', provider: p.id, capability: key, undeclared: false,
      reason: c.reason || 'This integration cannot do that here, so nothing was done.',
    };
  }
  return null;
}

/** The capability keys a screen may render a control for. Everything else stays off the screen. */
export function offered(p: Provider): string[] {
  if (!p || p.availability.available === false) return [];
  return (p.capabilities || []).filter((c) => c.available).map((c) => c.key);
}

/** The unavailable ones, for the honest "what this cannot do" block on an admin screen. */
export function withheld(p: Provider): ProviderCapability[] {
  return (p?.capabilities || []).filter((c) => !c.available);
}

// ---------------------------------------------------------------------------------------------
// Validation at registration time
// ---------------------------------------------------------------------------------------------

const ID_RE = /^[a-z][a-z0-9_]*$/;
/** Long enough that "no" and "n/a" cannot pass themselves off as an explanation. */
const MIN_REASON = 20;

/**
 * Reject a malformed declaration LOUDLY, at import, rather than in front of a learner.
 *
 * The failures this catches are exactly the ones that turn into the lies described at the top of
 * the file: an unavailable capability with no reason (a screen with nothing to say), a duplicate
 * key (two answers to one question), an id that will not round-trip through stored configuration.
 */
export function assertProvider(p: Provider): void {
  const bad = (m: string): never => { throw new Error('[providers] invalid provider declaration: ' + m); };
  if (!p || typeof p !== 'object') bad('not an object');
  if (!ID_RE.test(String(p.id || ''))) bad('id "' + p.id + '" must be snake_case starting with a letter');
  if (!String(p.adminLabel || '').trim()) bad(p.id + ' has no adminLabel');
  if (!String(p.adminNote || '').trim()) bad(p.id + ' has no adminNote');
  if (!p.availability || typeof p.availability.available !== 'boolean') bad(p.id + ' has no availability');
  if (p.availability.available === false && String(p.availability.reason || '').trim().length < MIN_REASON) {
    bad(p.id + ' is unavailable but gives no reason a person could act on');
  }
  if (!Array.isArray(p.capabilities) || !p.capabilities.length) bad(p.id + ' declares no capabilities');
  const seen = new Set<string>();
  for (const c of p.capabilities) {
    if (!ID_RE.test(String(c.key || ''))) bad(p.id + ' capability key "' + c.key + '" must be snake_case (these are NOT dotted permission keys)');
    if (seen.has(c.key)) bad(p.id + ' declares capability "' + c.key + '" twice');
    seen.add(c.key);
    if (!String(c.label || '').trim()) bad(p.id + ' capability "' + c.key + '" has no label');
    if (!c.available && String(c.reason || '').trim().length < MIN_REASON) {
      bad(p.id + ' declares "' + c.key + '" unavailable without a sentence saying why');
    }
    if (c.available && c.reason) bad(p.id + ' capability "' + c.key + '" is available but carries a refusal reason');
  }
}

/**
 * Every provider in one registry must answer the SAME set of questions, so an admin screen can put
 * them side by side and a caller can ask any of them anything. A provider that simply omitted the
 * capability it lacks would read as "not applicable" in a comparison table, which is the polite
 * version of hiding it.
 */
export function assertDeclaresAll(p: Provider, keys: readonly string[]): void {
  const have = new Set((p.capabilities || []).map((c) => c.key));
  const missing = keys.filter((k) => !have.has(k));
  if (missing.length) {
    throw new Error('[providers] ' + p.id + ' does not declare: ' + missing.join(', ') +
      ' - every provider in a registry answers the same questions, including the ones it answers "no" to');
  }
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

export interface ProviderDescription {
  id: string;
  adminLabel: string;
  adminNote: string;
  available: boolean;
  reason: string | null;
  can: string[];
  cannot: { key: string; label: string; reason: string }[];
}

export interface ProviderRegistry<P extends Provider> {
  /** The registry's own name, used in messages when no provider matched. */
  readonly name: string;
  /**
   * Add a provider. The factory is called once here to validate the declaration, and again on every
   * `get`, so a provider that reads its availability from the environment reports what is true NOW
   * rather than what was true when the module was first imported.
   */
  register(id: string, make: () => P): void;
  /** null when nothing is registered under that id. */
  get(id: string): P | null;
  /** A Refusal instead of null, for a call site that wants one sentence to show. */
  require(id: string): P | Refusal;
  list(): P[];
  /** Only those usable right now. */
  usable(): P[];
  ids(): string[];
  /** The preferred provider if it exists and is usable, else the first usable one, else null. */
  pick(preferred?: string | null): P | null;
  /** Registered providers in registration order — the shape an admin screen renders. */
  describe(): ProviderDescription[];
}

export function createRegistry<P extends Provider>(name: string, requiredCapabilities: readonly string[] = []): ProviderRegistry<P> {
  const makers = new Map<string, () => P>();
  const order: string[] = [];

  const build = (id: string): P | null => {
    const make = makers.get(id);
    if (!make) return null;
    const p = make();
    // The id under which it was registered is the id it must report; a mismatch would make every
    // stored configuration point at nothing.
    if (p.id !== id) throw new Error('[providers] ' + name + ': provider registered as "' + id + '" reports id "' + p.id + '"');
    return p;
  };

  const list = (): P[] => order.map((id) => build(id)).filter((p): p is P => !!p);

  return {
    name,
    register(id, make) {
      if (!ID_RE.test(id)) throw new Error('[providers] ' + name + ': "' + id + '" is not a valid provider id');
      // A SILENT OVERWRITE IS THE ONE THING A REGISTRY MUST NOT DO. Two modules registering the same
      // id is a mistake somewhere, and the version that loses would be chosen by import order —
      // which is how a payment integration gets swapped by an unrelated refactor and nobody notices.
      if (makers.has(id)) throw new Error('[providers] ' + name + ': "' + id + '" is already registered');
      const probe = make();
      assertProvider(probe);
      if (probe.id !== id) throw new Error('[providers] ' + name + ': provider registered as "' + id + '" reports id "' + probe.id + '"');
      if (requiredCapabilities.length) assertDeclaresAll(probe, requiredCapabilities);
      makers.set(id, make);
      order.push(id);
    },
    get(id) { return build(String(id || '')); },
    require(id) {
      const p = build(String(id || ''));
      if (p) return p;
      return {
        ok: false, refused: 'provider', provider: name, capability: '', undeclared: true,
        reason: 'No ' + name + ' integration is registered under "' + id + '", so nothing was done. ' +
          'Registered here: ' + (order.length ? order.join(', ') : 'none') + '.',
      };
    },
    list,
    usable() { return list().filter((p) => p.availability.available); },
    ids() { return order.slice(); },
    pick(preferred) {
      if (preferred) {
        const p = build(String(preferred));
        if (p && p.availability.available) return p;
      }
      return list().filter((x) => x.availability.available)[0] || null;
    },
    describe() {
      return list().map((p) => ({
        id: p.id,
        adminLabel: p.adminLabel,
        adminNote: p.adminNote,
        available: p.availability.available,
        reason: p.availability.reason,
        can: offered(p),
        cannot: withheld(p).map((c) => ({ key: c.key, label: c.label, reason: c.reason || '' })),
      }));
    },
  };
}

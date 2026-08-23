// src/lib/fusion/signals.ts — THE SEAM. HOW PATCHES 03, 04 AND 05 REACH THIS ENGINE.
//
// =================================================================================================
// THIS PATCH DOES NOT BUILD THE OTHER PATCHES' MODULES
// =================================================================================================
//
// Patch 06 consumes a professional interpretation (03), behavioural evidence (04) and feedback
// intelligence (05). None of those three exists in this repository yet. The rule for that case is to
// build the INTEGRATION BOUNDARY and stop — not to guess at somebody else's module and leave them a
// half-written one to argue with. So this file is the boundary, and it is the whole of it:
//
//   a TYPE           SignalProvider — what a patch registers.
//   a REGISTRY       registerSignalProvider() — one call, at module load, from the owning patch.
//   an HONEST EMPTY  EXPECTED_PROVIDERS — the three that are expected, so a profile can say
//                    "PATCH 04 has not registered a provider" instead of rendering a confident blank.
//
// AN UNREGISTERED PROVIDER IS NOT A ZERO. It appears in `FusionProfile.notConnected` and every
// screen prints it. A profile that silently omitted behavioural evidence would read exactly like a
// profile of somebody with none, and this project has already paid for that class of ambiguity on a
// screen that rendered a failed query as an empty result.
//
// =================================================================================================
// A PROVIDER CANNOT LIE ABOUT WHAT KIND OF EVIDENCE IT IS
// =================================================================================================
//
// The whole weighting rule rests on knowing which signals are demonstrated and which are inferred.
// So a provider declares its source class ONCE, at registration, and `gather()` output is checked
// against it: a signal whose class differs from its provider's is REFUSED BY NAME, not restamped.
// Restamping would let an interpretation module deliver its output as manager evidence by setting a
// field, which is the single most consequential thing anybody could do to this engine.
//
// =================================================================================================
// A FAILING PROVIDER MUST NOT TAKE THE PROFILE DOWN
// =================================================================================================
//
// Every provider runs inside its own try/catch and a failure becomes a NAMED unreadable entry. The
// person's other nine sources still render, and the screen says which one could not be read and why.
// Never a swallowed exception: the reason is logged with `e.cause` first, because on this project
// `e.message` is only ever the SQL that failed.
import {
  SOURCE_CLASS_LABELS,
  isSourceClass,
  type FusionDimension,
  type Signal,
  type SourceClass,
} from './types';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — above everything that reads them.
// -------------------------------------------------------------------------------------------------

/** One provider may not flood a profile. A provider offering more than this is truncated and SAID so. */
export const MAX_SIGNALS_PER_PROVIDER = 200;

/** How long a provider may take before the profile gives up on it and says which one it was. */
export const PROVIDER_TIMEOUT_MS = 8000;

export const logFail = (tag: string, e: any) =>
  console.error('[fusion/signals] ' + tag, e?.cause?.message || e?.message || e);

// -------------------------------------------------------------------------------------------------
// WHAT A PROVIDER IS ASKED, AND WHAT IT ANSWERS
// -------------------------------------------------------------------------------------------------

export interface GatherContext {
  /** hr_employees.id. The ONLY key a personal query may be filtered by in this codebase. */
  employeeId: string;
  /** users.id where the employee record carries one. Null is normal and must be handled. */
  userId: string | null;
  /** The role this person's alignment is being read against, where one is on record. */
  roleId: string | null;
  /** Nothing before this date needs reading. Null means "everything on record". */
  since: string | null;
  /** Time is an argument here too. A provider must not read the clock on its own. */
  now: Date;
}

export interface ProviderInput {
  /** What was read, for the explanation's INPUTS section. */
  source: string;
  ownerModule: string;
  rows: number;
  sentence: string;
}

export interface ProviderResult {
  signals: Signal[];
  inputs: ProviderInput[];
  /** Named, never silent. A thing that could not be read is not a thing that was not there. */
  unreadable: { what: string; because: string }[];
}

export const EMPTY_RESULT: ProviderResult = Object.freeze({
  signals: [],
  inputs: [],
  unreadable: [],
}) as ProviderResult;

export interface SignalProvider {
  /** Unique. Used in audit rows and printed on screen, so make it readable: 'patch04.behavioural'. */
  key: string;
  label: string;
  /**
   * DECLARED ONCE, AND ENFORCED. Every signal this provider returns must carry this class or be
   * refused. See the header for why this is not merely stamped on.
   */
  sourceClass: SourceClass;
  /** Which patch owns the module behind it. Printed, so a reader knows who to ask. */
  ownerPatch: string;
  /** The repo path of the module that owns the underlying records. */
  ownerModule: string;
  /** What it supplies, in a sentence. Printed when it is NOT connected, which is when it matters. */
  supplies: string;
  /** Which of the ten it can speak to. A signal outside this list is refused. */
  dimensions: readonly FusionDimension[];
  gather(ctx: GatherContext): Promise<ProviderResult>;
}

// -------------------------------------------------------------------------------------------------
// THE THREE THAT ARE EXPECTED AND NOT YET HERE
// -------------------------------------------------------------------------------------------------

export interface ExpectedProvider {
  key: string;
  ownerPatch: string;
  what: string;
}

/**
 * WHAT A COMPLETE PROFILE WOULD HAVE, SO AN INCOMPLETE ONE CAN SAY WHAT IT IS MISSING.
 *
 * These are declarations, not stubs. There is no fake implementation behind any of them and there
 * must never be one: a provider that returned invented signals would put fabricated evidence into a
 * record about a real person, which is the worst thing this module could do. Until the owning patch
 * calls registerSignalProvider(), the profile reports the absence.
 */
export const EXPECTED_PROVIDERS: readonly ExpectedProvider[] = Object.freeze([
  {
    key: 'patch03.interpretation',
    ownerPatch: 'PATCH 03',
    what: 'The professional interpretation layer. Supplies the inferred foundation — a starting '
      + 'hypothesis about disposition, capped by weight, inadmissible on three dimensions, and never '
      + 'a reading on its own.',
  },
  {
    key: 'patch04.behavioural',
    ownerPatch: 'PATCH 04',
    what: 'Behavioural evidence drawn from organisational records that already exist for their own '
      + 'purposes. Supplies observed evidence.',
  },
  {
    key: 'patch05.feedback',
    ownerPatch: 'PATCH 05',
    what: 'Feedback intelligence — aggregation across colleagues and managers with disagreement, '
      + 'outliers and source weighting preserved. Supplies peer evidence and manager evidence.',
  },
]);

// -------------------------------------------------------------------------------------------------
// THE REGISTRY
// -------------------------------------------------------------------------------------------------

const registry = new Map<string, SignalProvider>();

export interface RegisterResult {
  ok: boolean;
  error?: string;
}

/**
 * Register a provider. Called ONCE at module load by the patch that owns it.
 *
 * IT REFUSES A SECOND REGISTRATION OF THE SAME KEY rather than replacing it. Silent replacement is
 * how one agent's module quietly overwrites another's in a shared tree, and the whole point of this
 * boundary is that it cannot happen by accident.
 */
export function registerSignalProvider(p: SignalProvider): RegisterResult {
  if (!p || typeof p !== 'object') return { ok: false, error: 'No provider was given.' };
  const key = String(p.key || '').trim();
  if (!key) return { ok: false, error: 'A provider needs a key.' };
  if (!isSourceClass(p.sourceClass)) {
    return {
      ok: false,
      error: '"' + String(p.sourceClass) + '" is not one of the five kinds of evidence this engine '
        + 'listens to. Registration refused.',
    };
  }
  if (typeof p.gather !== 'function') {
    return { ok: false, error: 'Provider "' + key + '" has no gather().' };
  }
  const existing = registry.get(key);
  if (existing) {
    return {
      ok: false,
      error: 'A provider is already registered as "' + key + '" by ' + existing.ownerPatch
        + '. It was NOT replaced. Two modules answering to one key is how one patch silently '
        + 'overwrites another; pick a different key.',
    };
  }
  registry.set(key, p);
  return { ok: true };
}

/** Present only so a test can start from a known state. Not called by any surface. */
export function resetSignalProviders(): void {
  registry.clear();
}

export function signalProviders(): SignalProvider[] {
  return [...registry.values()];
}

export function providerByKey(key: string): SignalProvider | null {
  return registry.get(key) || null;
}

/** The expected providers that have not registered. What a profile prints under "not connected". */
export function notConnectedProviders(): { providerKey: string; ownerPatch: string; what: string }[] {
  return EXPECTED_PROVIDERS
    .filter((e) => !registry.has(e.key))
    .map((e) => ({ providerKey: e.key, ownerPatch: e.ownerPatch, what: e.what }));
}

// -------------------------------------------------------------------------------------------------
// RUNNING THEM
// -------------------------------------------------------------------------------------------------

export interface GatherReport {
  signals: Signal[];
  inputs: ProviderInput[];
  unreadable: { what: string; because: string }[];
  /** Signals a provider offered that its own declaration did not permit. Named, never dropped. */
  refused: { providerKey: string; because: string }[];
  notConnected: { providerKey: string; ownerPatch: string; what: string }[];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' did not answer within ' + ms + 'ms.')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Check one provider's output against its own declaration.
 *
 * THREE REFUSALS, ALL BY NAME:
 *   - a signal whose source class is not the provider's declared class
 *   - a signal on a dimension the provider did not declare
 *   - anything past MAX_SIGNALS_PER_PROVIDER
 *
 * The signals that pass are stamped with the provider's key and owner module, so the evidence chain
 * on screen names the module that is answerable rather than whatever the signal happened to carry.
 */
export function checkProviderOutput(
  p: SignalProvider,
  signals: readonly Signal[],
): { kept: Signal[]; refused: { providerKey: string; because: string }[] } {
  const kept: Signal[] = [];
  const refused: { providerKey: string; because: string }[] = [];
  const allowed = new Set<string>(p.dimensions);

  for (const s of signals || []) {
    if (kept.length >= MAX_SIGNALS_PER_PROVIDER) {
      refused.push({
        providerKey: p.key,
        because: 'It offered more than ' + MAX_SIGNALS_PER_PROVIDER + ' signals. The rest were not '
          + 'read. This is a cap being reported rather than a silent truncation.',
      });
      break;
    }
    if (s?.sourceClass !== p.sourceClass) {
      refused.push({
        providerKey: p.key,
        because: 'It returned a signal marked "' + String(s?.sourceClass) + '" while registered as "'
          + p.sourceClass + '" (' + SOURCE_CLASS_LABELS[p.sourceClass] + '). It was refused, not '
          + 're-labelled: a provider that could change its own class could turn an inference into '
          + 'manager evidence by setting a field.',
      });
      continue;
    }
    if (!allowed.has(String(s?.dimension))) {
      refused.push({
        providerKey: p.key,
        because: 'It returned a signal for "' + String(s?.dimension) + '", which it did not declare '
          + 'it speaks to.',
      });
      continue;
    }
    kept.push({ ...s, providerKey: p.key, ownerModule: s.ownerModule || p.ownerModule });
  }

  return { kept, refused };
}

/**
 * Ask every registered provider, in parallel, and assemble one report.
 *
 * NOTHING HERE THROWS. A provider that fails, times out or returns rubbish becomes a named line in
 * `unreadable` or `refused`, and the rest of the profile is built from what did answer.
 */
export async function gatherSignals(ctx: GatherContext): Promise<GatherReport> {
  const providers = signalProviders();
  const out: GatherReport = {
    signals: [],
    inputs: [],
    unreadable: [],
    refused: [],
    notConnected: notConnectedProviders(),
  };

  const results = await Promise.all(providers.map(async (p) => {
    try {
      const r = await withTimeout(Promise.resolve(p.gather(ctx)), PROVIDER_TIMEOUT_MS, p.label || p.key);
      return { p, r, error: null as string | null };
    } catch (e: any) {
      logFail('provider ' + p.key, e);
      return { p, r: null, error: e?.cause?.message || e?.message || 'It failed without saying why.' };
    }
  }));

  for (const { p, r, error } of results) {
    if (error || !r) {
      out.unreadable.push({
        what: p.label + ' (' + p.ownerPatch + ')',
        because: 'Could not be read: ' + (error || 'it returned nothing at all') + '. What it would '
          + 'have contributed is missing from every reading below, and that absence is this line '
          + 'rather than a lower number.',
      });
      continue;
    }
    const { kept, refused } = checkProviderOutput(p, r.signals || []);
    out.signals.push(...kept);
    out.refused.push(...refused);
    out.inputs.push(...(r.inputs || []));
    out.unreadable.push(...(r.unreadable || []));
  }

  return out;
}

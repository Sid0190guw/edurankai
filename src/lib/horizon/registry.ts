// src/lib/horizon/registry.ts — WHERE ANOTHER PATCH PLUGS ITS SECTION IN.
//
// =================================================================================================
// THE INTEGRATION BOUNDARY, AND WHY IT IS A REGISTRY RATHER THAN AN IMPORT
// =================================================================================================
//
// Patch 11 needs data from patches that do not exist in this tree yet. Rule 8 of the build brief
// says: create a typed interface, adapter or integration boundary rather than building the other
// agent's module. Rule 6 says never overwrite another agent's implementation.
//
// A direct `import { behaviourFor } from '@/lib/behaviour'` would break both. It fails the build the
// moment Patch 11 lands ahead of Patch 3, and it hard-codes a module path that the owning agent has
// every right to choose differently. So Patch 11 imports NOTHING from another patch. A producing
// patch calls `registerHorizonProvider()` once at module load and Patch 11 finds it at render time.
//
// =================================================================================================
// AN UNREGISTERED SECTION IS A STATED ABSENCE
// =================================================================================================
//
// `providerFor()` returning null is not an error and is not an empty result. The section renders
// `not_supplied`, names the patch that owes it, and reads nothing. This project has lost real time
// to screens that printed "no records" when the truth was "this was never wired up"; the two are
// different facts and this module keeps them different.
//
// =================================================================================================
// A PROVIDER CANNOT CLAIM A SECTION TWICE
// =================================================================================================
//
// Two patches answering for one tab is an ownership collision, not a merge, and Patch 11 has no
// business picking a winner. `registerHorizonProvider()` refuses the second claim, returns the
// refusal to the caller, and records it so the collision is visible on the page footer rather than
// resolved silently in whichever order the modules happened to load.
// =================================================================================================

import type {
  HorizonSectionKey,
  HorizonSectionProvider,
  MeirSubject,
  ProviderContext,
  SectionPayload,
} from './contracts';
import { HORIZON_SECTION_KEYS } from './contracts';

// -------------------------------------------------------------------------------------------------
// MODULE STATE. Declared above every function that touches it.
// -------------------------------------------------------------------------------------------------

const providers = new Map<HorizonSectionKey, HorizonSectionProvider>();

export interface RegistrationConflict {
  section: HorizonSectionKey;
  heldBy: string;
  refused: string;
}

const conflicts: RegistrationConflict[] = [];

export interface RegistrationResult {
  ok: boolean;
  /** Sections this call took ownership of. */
  claimed: HorizonSectionKey[];
  /** Sections refused because somebody else already holds them. */
  refused: RegistrationConflict[];
  /** Section keys the provider named that are not part of this view at all. */
  unknown: string[];
}

/**
 * Register a producing patch. Call once, at module load, from the owning patch's own module.
 *
 * Partial success is the normal outcome and is reported rather than thrown: a provider that claims
 * three sections and collides on one still owns the other two, and refusing all three because of one
 * collision would take working data off the screen to make a point.
 */
export function registerHorizonProvider(provider: HorizonSectionProvider): RegistrationResult {
  const claimed: HorizonSectionKey[] = [];
  const refused: RegistrationConflict[] = [];
  const unknown: string[] = [];

  const known = new Set<string>(HORIZON_SECTION_KEYS as readonly string[]);
  const wanted = Array.isArray(provider?.sections) ? provider.sections : [];

  for (const raw of wanted) {
    const key = String(raw) as HorizonSectionKey;
    if (!known.has(key)) {
      unknown.push(key);
      continue;
    }
    const holder = providers.get(key);
    if (holder && holder !== provider) {
      const c: RegistrationConflict = {
        section: key,
        heldBy: holder.identity?.patch + ' (' + holder.identity?.module + ')',
        refused: provider.identity?.patch + ' (' + provider.identity?.module + ')',
      };
      refused.push(c);
      conflicts.push(c);
      continue;
    }
    providers.set(key, provider);
    claimed.push(key);
  }

  return { ok: refused.length === 0 && unknown.length === 0, claimed, refused, unknown };
}

/** Withdraw a provider — used by tests, and by a patch that is being replaced deliberately. */
export function unregisterHorizonProvider(provider: HorizonSectionProvider): void {
  for (const [key, held] of Array.from(providers.entries())) {
    if (held === provider) providers.delete(key);
  }
}

/** Reset. Tests only; there is no product path that should ever need this. */
export function resetHorizonRegistry(): void {
  providers.clear();
  conflicts.length = 0;
}

export function providerFor(section: HorizonSectionKey): HorizonSectionProvider | null {
  return providers.get(section) || null;
}

export function registeredSections(): HorizonSectionKey[] {
  return Array.from(providers.keys());
}

export function registrationConflicts(): RegistrationConflict[] {
  return conflicts.slice();
}

/**
 * Ask a provider for one section, and never let it take the page down.
 *
 * A provider that throws returns `unreadable` with the reason on `e.cause` where postgres-js puts
 * it — `e.message` for that driver is the failed SQL, which tells an operator nothing. A provider
 * that returns something that is not a payload is treated the same way: a malformed answer is an
 * unreadable section, not a section rendered from a half-object.
 */
export async function fetchSection(
  section: HorizonSectionKey,
  subject: MeirSubject,
  ctx: ProviderContext,
  owedBy: string,
): Promise<SectionPayload<unknown> | null> {
  const p = providerFor(section);
  if (!p) return null;
  try {
    const payload = await p.fetch(section, subject, ctx);
    if (!payload || typeof payload !== 'object' || payload.key !== section) {
      return {
        key: section,
        status: 'unreadable',
        sentence:
          owedBy + ' answered for this section with something this view could not read, so nothing is shown. '
          + 'This is a wiring fault, not a statement about the person.',
        owedBy,
        signals: [],
        patterns: [],
        requiredCapability: null,
        accessLogged: false,
        accessLogNote: null,
      };
    }
    // Normalise the arrays so every consumer can iterate without guarding.
    return {
      ...payload,
      signals: Array.isArray(payload.signals) ? payload.signals : [],
      patterns: Array.isArray(payload.patterns) ? payload.patterns : [],
      owedBy: payload.owedBy || owedBy,
    };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message || String(e);
    return {
      key: section,
      status: 'unreadable',
      sentence:
        'This section could not be read just now, so it is missing rather than empty. Nothing here says the record does not exist. ('
        + String(reason).slice(0, 240) + ')',
      owedBy,
      signals: [],
      patterns: [],
      requiredCapability: null,
      accessLogged: false,
      accessLogNote: null,
    };
  }
}

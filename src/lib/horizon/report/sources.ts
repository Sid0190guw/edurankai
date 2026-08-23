// src/lib/horizon/report/sources.ts — THE INTEGRATION BOUNDARY BETWEEN THIS PATCH AND EVERY OTHER.
//
// This engine owns no employee data. It cannot: the records a report is built from belong to the
// hiring patch, the HR patch, the attendance patch and the org-graph patch, and a report engine that
// reached into their tables on its own authority would be four patches wide and would break every
// time one of them moved a column.
//
// So: a report asks for CAPABILITIES, and a provider ANSWERS them. The registry below is the only
// place the two meet.
//
// WHAT A PROVIDER MAY DO
// ---------------------------------------------------------------------------------------------
//   - return facts, derived metrics and human feedback (sections 1-3);
//   - declare which relations it reads and which patch owns them;
//   - fail, and say why in a sentence, without taking the report down with it.
//
// WHAT A PROVIDER MAY NOT DO
// ---------------------------------------------------------------------------------------------
//   - return an interpretation or a recommendation. SourceLoad has nowhere to put one. Sections 4
//     and 5 come from the interpreter, which sees everything at once; a provider that could emit its
//     own conclusion would be a second, invisible interpreter with a narrower view than the first.
//   - read a relation on the forbidden list. registerSourceProvider() refuses at registration and a
//     test asserts it again, because a registration-time check only fires if the code path runs.
//
// A MISSING CAPABILITY IS NOT AN ERROR. Several capability keys in registry.ts have no provider in
// this repository today, because the patches that own that data have not shipped one. The report
// still generates; the missing key lands in the coverage block and is rendered as an absence. That
// is the difference between "this person has no recorded feedback" and "no feedback source is
// wired", and printing the first when the second is true is how a report misleads somebody.
import { dbReason } from '@/lib/page-safety';
import { forbiddenTableIn } from './provenance';
import type { SourceLoad, SourceLoadContext, SourceProvider } from './types';

const registry = new Map<string, SourceProvider>();

/** Providers that were refused, kept so an operator can see WHY a capability is unanswered. */
const refused: { id: string; reason: string }[] = [];

/**
 * Register a provider. Idempotent by descriptor id: registering the same id twice replaces the
 * entry rather than adding a second, so a module that is imported twice does not double every fact
 * in every report.
 *
 * Returns the reason it was refused, or null.
 */
export function registerSourceProvider(provider: SourceProvider): string | null {
  const d = provider?.descriptor;
  if (!d || !d.id) return 'A provider must have a descriptor with an id.';
  if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) {
    return 'A provider that claims no capability can never be asked for anything.';
  }
  if (!Array.isArray(d.tables) || d.tables.length === 0) {
    return 'A provider must declare the relations it reads. That declaration is what makes a report auditable.';
  }
  const forbidden = forbiddenTableIn(d.tables);
  if (forbidden) {
    const reason = 'Refused: "' + forbidden + '" is not a relation any report may read.';
    refused.push({ id: d.id, reason });
    return reason;
  }
  registry.set(d.id, provider);
  return null;
}

export function registeredProviders(): SourceProvider[] {
  return Array.from(registry.values());
}

export function refusedProviders(): { id: string; reason: string }[] {
  return refused.slice();
}

/** Every capability some registered provider claims. */
export function answeredCapabilities(): string[] {
  const seen = new Set<string>();
  for (const p of registry.values()) for (const c of p.descriptor.capabilities) seen.add(c);
  return Array.from(seen).sort();
}

/**
 * Which providers to run for a set of capability keys, and which keys nothing answers.
 *
 * A provider is run ONCE even when it answers several of the keys a report asked for, and it is told
 * which ones — so a provider covering five capabilities does not run five times and issue five
 * copies of the same query. Round-trip count is the lever on this deployment; the function region
 * and the database region differ and every avoidable query is ~130ms of somebody waiting.
 */
export function planSources(capabilities: readonly string[]): {
  runs: { provider: SourceProvider; capabilities: string[] }[];
  missing: { capability: string; reason: string }[];
} {
  const byProvider = new Map<string, { provider: SourceProvider; capabilities: string[] }>();
  const missing: { capability: string; reason: string }[] = [];

  for (const cap of capabilities) {
    let answered = false;
    for (const p of registry.values()) {
      if (p.descriptor.capabilities.indexOf(cap) < 0) continue;
      answered = true;
      const existing = byProvider.get(p.descriptor.id);
      if (existing) existing.capabilities.push(cap);
      else byProvider.set(p.descriptor.id, { provider: p, capabilities: [cap] });
    }
    if (!answered) {
      const wasRefused = refused.find((r) => r.id === cap);
      missing.push({
        capability: cap,
        reason: wasRefused
          ? wasRefused.reason
          : 'No source is registered for this. The part of the report that needed it is blank, not empty.',
      });
    }
  }
  return { runs: Array.from(byProvider.values()), missing };
}

/** An empty load, used both as a failure result and as the starting value for a provider. */
export function emptyLoad(providerId: string, error: string | null = null): SourceLoad {
  return { ok: error === null, providerId, facts: [], derived: [], humanFeedback: [], notes: [], error };
}

/**
 * Run one provider with its faults contained.
 *
 * A provider that throws must not take the report with it. This project has already shipped a page
 * whose single unguarded query 500d a whole console, and a report drawing on six sources is six
 * times as likely to meet a missing table on a fresh environment. The failure becomes a note in the
 * coverage block, which is a report that says what it could not see — the honest outcome.
 */
export async function runSource(provider: SourceProvider, ctx: SourceLoadContext): Promise<SourceLoad> {
  const id = provider.descriptor.id;
  try {
    const load = await provider.load(ctx);
    if (!load) return emptyLoad(id, 'The provider returned nothing.');
    return load;
  } catch (e: any) {
    // dbReason() reads e.cause first, where postgres-js puts the actual reason. e.message is the
    // failed SQL and tells an operator nothing.
    return emptyLoad(id, dbReason(e));
  }
}

/** Test seam. Never called by application code. */
export function __resetSourceRegistryForTests(): void {
  registry.clear();
  refused.length = 0;
}

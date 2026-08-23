// src/lib/horizon/report/providers/index.ts — REGISTRATION, ONCE PER PROCESS.
//
// Called by engine.ts before it plans a run. Idempotent: registerSourceProvider() replaces by
// descriptor id, and the guard below means the loop does not run twice anyway.
//
// A PROVIDER THAT REFUSES TO REGISTER IS LOGGED, NOT SWALLOWED. The only reason registration fails
// is a declaration this engine will not accept — a relation on the forbidden list, or a provider
// claiming no capability at all. Both are programming errors that would otherwise show up as a
// report quietly missing a section, which is the failure mode this whole patch is built to avoid.
import { registerSourceProvider } from '../sources';
import { hrEmploymentProvider } from './hr';
import { meirRecordProvider } from './meir';
import { orgShapeProvider } from './org';
import { talentHiringProvider } from './talent';
import { timeProvider } from './time';

let registered = false;

export function registerBuiltInProviders(): void {
  if (registered) return;
  registered = true;
  // meirRecordProvider is first because it is the one that matters: it relays whatever the rest of
  // the HORIZON system has registered with src/lib/horizon/record.ts. The four below it read HR and
  // hiring tables directly, and exist because those records are needed by the nine reports and
  // nothing upstream supplies them yet.
  for (const p of [meirRecordProvider, hrEmploymentProvider, timeProvider, talentHiringProvider, orgShapeProvider]) {
    const refusal = registerSourceProvider(p);
    if (refusal) console.error('[horizon.report] provider ' + p.descriptor.id + ' refused: ' + refusal);
  }
}

/** Test seam, paired with __resetSourceRegistryForTests(). */
export function __resetRegistrationFlagForTests(): void {
  registered = false;
}

export { meirRecordProvider, hrEmploymentProvider, timeProvider, talentHiringProvider, orgShapeProvider };

// src/lib/mailplatform/index.ts — the automation ENGINE, in one import.
//
//   import { emit, pgStore, ORG_ID } from '@/lib/mailplatform';
//   await emit(pgStore, { type: 'application.stage.changed', orgId: ORG_ID,
//                         contactEmail: applicant.email, payload: { stage: '3' },
//                         eventId: 'stage:' + applicant.id + ':3' });
//
// That is the whole integration surface for the rest of the platform: announce what happened, and
// let the automations an operator drew at /mail/automations decide what follows. Nothing outside
// this folder should build a run, read the step ledger, or decide whether a send is a duplicate.
//
// THE BUILDER IS NOT HERE. src/lib/mail-product/automations.ts owns the graph shape, its validation
// and its CRUD; this folder is the runtime that executes it.
//
// THIS DIRECTORY IS SHARED, AND THIS BARREL IS NOT ALL OF IT.
//
// src/lib/mailplatform/ is written by more than one patch series. The modules re-exported below are
// the AUTOMATION EXECUTION ENGINE (graph adapter, conditions, delays, events, runs, steps, worker,
// channels). Its neighbours in the same folder — campaigns.ts, contacts.ts, domains.ts, metrics.ts,
// mta-pool.ts, rfc.ts, suppression.ts and the rest — belong to the mail platform series and are NOT
// exported here; import those directly by path.
//
// `errors.ts` is shared in both directions (suppression.ts already raises its TemporaryFailure), so
// treat it as a contract: extend it additively, never rewrite it.
export * from './conditions';
export * from './delay';
export * from './triggers';
export * from './errors';
export * from './store';
export * from './engine';
export * from './router';
export * from './worker';
export * from './examples';
export * from './service';
export {
  coerceGraph, validateGraph, describeForBuilder, checkAgainstPlatform,
  conditionFromNode, delayFromNode, findNode, nextNodeAfter, triggerNode, STRUCTURAL_KINDS,
} from './graph';
export type { AutomationGraph, AutomationNode, GraphProblem, NodeKind, Branch } from './graph';
export { pgStore, ensureAutomationSchema, AUTOMATION_DDL, AUTOMATION_ALTERS, AUTOMATION_INDEXES } from './pg-store';
export { MemoryStore, newMemoryStore } from './memory-store';
export { actionCatalogue, actionDefinition, isIrreversible, ACTIONS } from './actions';
export { CHANNELS, channel, channelStatus } from './adapters';
export {
  DEFAULT_ORG_ID, assertSafeOutboundUrl, verifyWebhook, signWebhookBody,
  newWebhookToken, newWebhookSecret, newRunId, newEventId, ownedBy, safeId,
} from './security';

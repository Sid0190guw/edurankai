// src/lib/mailplatform/index.ts — the automation engine, in one import.
//
//   import { emit, pgStore } from '@/lib/mailplatform';
//   await emit(pgStore, { type: 'application.stage.changed', orgId: ORG_ID, contactEmail: applicant.email, payload: { stage: '3' } });
//
// That is the whole integration surface for the rest of the platform: announce what happened, and
// let the workflows an operator drew decide what follows. Nothing outside this folder should build a
// run, read the step ledger, or decide whether a send is a duplicate.
export * from './graph';
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
export { pgStore, ensureAutomationSchema, AUTOMATION_DDL } from './pg-store';
export { MemoryStore, newMemoryStore } from './memory-store';
export { actionCatalogue, actionDefinition, ACTIONS } from './actions';
export { CHANNELS, channel, channelStatus } from './adapters';
export {
  DEFAULT_ORG_ID, assertSafeOutboundUrl, verifyWebhook, signWebhookBody,
  newWebhookToken, newWebhookSecret, newRunId, newEventId, ownedBy, safeId,
} from './security';

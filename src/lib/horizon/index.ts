// src/lib/horizon/index.ts — THE PUBLIC SURFACE OF THE HORIZON SHARED CONTRACTS.
//
//   import { employeeSubject, buildIntelligenceResult, emitHorizonEvent } from '@/lib/horizon';
//
// EVERY LATER HORIZON PATCH IMPORTS FROM HERE, not from the individual files. That is not a style
// preference: it is what lets this module move a definition between files, or split one, without
// touching eight other patches. A patch that imports '@/lib/horizon/types' directly has coupled
// itself to the current file layout and will break the day it changes.
//
// WHAT IS DELIBERATELY NOT EXPORTED: nothing that writes to another patch's tables, and no engine.
// This module defines contracts and composes what other patches register. It computes no score.
//
// ONE SOURCE PER NAME. `./types` deliberately does not re-export the identifier types, so these star
// exports cannot collide.

export * from './ids';
export * from './types';
export * from './api';
// ./access is the PROFILE-CONSOLE patch's module (per-tab grants) and is imported directly by the
// screens that use it — deliberately NOT re-exported here. This barrel carries the shared contracts
// this patch owns; re-exporting somebody else's module through it would make their file layout part
// of my contract.
export * from './visibility';
export * from './record';
export * from './events';
export { ensureHorizonSchema, verifyHorizonSchema, HORIZON_TABLES, type SchemaReport } from './schema';
export { rowsOf, reasonOf, truncateReason } from './pg';

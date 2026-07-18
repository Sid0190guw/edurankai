// src/lib/kernel/lifecycle.ts — the object lifecycle state machine.
//
// Spec order (nothing bypasses it):
//   Created -> Validated -> Indexed -> Published -> Referenced -> Updated -> Archived -> Deleted
//
// The explicit allowed-transitions map below is the single source of truth. Any transition
// not listed is rejected with a clear error. The real operations (re-publishing after an
// update, archiving from several live states) are expressed as edges in this map WITHOUT
// ever letting an object skip a required earlier stage (e.g. Created can never jump to
// Published).
import type { LifecycleState } from './types';

export const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  created:    ['validated'],
  validated:  ['indexed'],
  indexed:    ['published'],
  published:  ['referenced', 'updated', 'archived'],
  referenced: ['updated', 'archived'],
  updated:    ['indexed', 'published', 'archived'],   // an updated object re-enters the pipeline
  archived:   ['deleted'],
  deleted:    [],                                      // terminal
};

export class LifecycleError extends Error {
  constructor(public from: LifecycleState, public to: LifecycleState) {
    super(`illegal lifecycle transition: ${from} -> ${to} (allowed from "${from}": ${TRANSITIONS[from].join(', ') || 'none'})`);
    this.name = 'LifecycleError';
  }
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws LifecycleError if the transition is not allowed. */
export function assertTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) throw new LifecycleError(from, to);
}

/** Which lifecycle target each repository operation drives to (documentation + guard). */
export const OPERATION_TARGET = {
  validateObject: 'validated',
  indexObject: 'indexed',
  publishObject: 'published',
  updateObject: 'updated',
  archiveObject: 'archived',
  deleteObject: 'deleted',
} as const satisfies Record<string, LifecycleState>;

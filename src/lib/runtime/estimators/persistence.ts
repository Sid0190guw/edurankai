// src/lib/runtime/estimators/persistence.ts — Block 04: read/write LearnerState on the
// StudentObject's learning_metadata (via the kernel's non-lifecycle patchLearningMetadata).
import type { KernelRepository } from '@/lib/kernel';
import type { LearnerState, StudentLearningMetadata } from './types';
import { emptyLearningStyle, estimateDevice, estimateNetwork, estimateAccessibility, estimateLanguage, estimateLoad } from './estimators';

export function emptyLearnerState(now: string): LearnerState {
  return {
    schemaVersion: 1,
    mastery: {},
    language: estimateLanguage(undefined, undefined),
    device: estimateDevice({}),
    network: estimateNetwork({}),
    accessibility: estimateAccessibility({}),
    learningStyle: emptyLearningStyle(),
    cognitiveLoad: estimateLoad(0, 1, 0),
    updatedAt: now,
  };
}

export async function loadLearnerState(kernel: KernelRepository, studentObjectId: string): Promise<LearnerState> {
  const obj = await kernel.getObject(studentObjectId);
  if (!obj || obj.type !== 'StudentObject') throw new Error(`not a StudentObject: ${studentObjectId}`);
  const lm = (obj.learningMetadata ?? {}) as StudentLearningMetadata;
  return lm.learnerState ?? emptyLearnerState(obj.updatedAt ?? new Date().toISOString());
}

export async function saveLearnerState(kernel: KernelRepository, studentObjectId: string, state: LearnerState): Promise<void> {
  const obj = await kernel.getObject(studentObjectId);
  if (!obj || obj.type !== 'StudentObject') throw new Error(`not a StudentObject: ${studentObjectId}`);
  await kernel.patchLearningMetadata(studentObjectId, {
    learnerState: { ...state, updatedAt: new Date().toISOString() },
  });
}

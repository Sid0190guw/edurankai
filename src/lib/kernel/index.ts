// src/lib/kernel/index.ts — public API of the AquinTutor Educational Operating Kernel.
//
//   import { KernelRepository, PgKernelStore } from '@/lib/kernel';
//   const kernel = new KernelRepository(new PgKernelStore());   // production (Postgres)
//   const kernel = new KernelRepository();                       // in-memory (tests/tools)
//
// Later prompts (adapters onto training_*/users, AI tutoring, rendering, offline sync)
// build on this surface without changing it.
export * from './types';
export { TRANSITIONS, canTransition, assertTransition, LifecycleError, OPERATION_TARGET } from './lifecycle';
export { DATA_SCHEMAS, validateObjectData, ValidationError } from './validation';
export { type KernelStore, InMemoryKernelStore, PgKernelStore } from './store';
export { KernelRepository, type CreateInput, type UpdatePatch, type ObjectGraph } from './repository';
export { kernelObjects, kernelEdges, KERNEL_DDL } from './schema';

// Convenience factory: default to the in-memory store; pass PgKernelStore for production.
import { KernelRepository } from './repository';
import { InMemoryKernelStore, PgKernelStore, type KernelStore } from './store';
export function createKernel(store?: KernelStore): KernelRepository {
  return new KernelRepository(store ?? new InMemoryKernelStore());
}
export function createPgKernel(): KernelRepository {
  return new KernelRepository(new PgKernelStore());
}

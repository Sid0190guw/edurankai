// src/lib/rbac/capabilities.ts — the atomic capability registry (AquinTutor Kernel
// Permission Engine, Spec Vol II). Subsystems may register more at runtime via
// registerCapability(); the seed set below is the spec's canonical list.

export const CORE_CAPABILITIES = [
  'read', 'write', 'create', 'delete', 'execute', 'configure', 'manage', 'allocate',
  'release', 'schedule', 'audit', 'replicate', 'backup', 'restore', 'delegate', 'administer',
] as const;
export type Capability = (typeof CORE_CAPABILITIES)[number] | (string & {});

const registry = new Set<string>(CORE_CAPABILITIES);
export function registerCapability(cap: string): void { registry.add(cap); }
export function isCapability(cap: string): boolean { return registry.has(cap); }
export function allCapabilities(): string[] { return [...registry]; }

// 'administer' is the god-capability: holding it authorises every capability.
export const ADMINISTER: Capability = 'administer';

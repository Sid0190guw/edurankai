// src/lib/plugins/types.ts — Block 09: the SubjectPlugin contract. Pure types, no I/O.
import type { z } from 'zod';
import type { ObjectType } from '@/lib/kernel';
import type { Capability } from '@/lib/rbac/capabilities';
import type { Item } from '@/lib/assessment';
import type { RenderTier } from '@/lib/edu-runtime';

/** A concept the runtime recognized ("Concept ID -> Knowledge Graph"). */
export interface ConceptRef {
  conceptId?: string | null;
  domain: string;              // concept-domain tag, e.g. 'physics.fluids.bernoulli'
  name: string;
}

/** Deterministic item factory for a concept (no LLM — pure/seedable). */
export type AssessmentGenerator = (
  concept: ConceptRef,
  opts: { count: number; difficulty?: number; seed?: number },
) => Item[];

/** A plugin-owned specialization of one of the 12 kernel object types. */
export interface PluginObjectSubtype {
  kernelType: ObjectType;
  subtype: string;             // metadata.subtype discriminator
  schema: z.ZodTypeAny;        // validates the extended `data` payload
}

export interface ScenePack {
  id: string;
  primitiveTypes: string[];
}

export interface PluginRenderer {
  objectType: string;
  hydrate: Partial<Record<RenderTier, string[]>>;
  scenePack?: string;
}

export interface AssessmentGeneratorRef {
  conceptDomain: string;
  generate: AssessmentGenerator;
}

export interface SubjectPlugin {
  id: string;
  subject: string;
  version: string;
  namespace: string;
  dependsOn?: string[];
  conceptDomains: string[];    // domain prefixes this plugin owns (longest-prefix wins)
  objectSubtypes: PluginObjectSubtype[];
  renderers: PluginRenderer[];
  assessmentGenerators: AssessmentGeneratorRef[];
  requiredCapabilities: Capability[];
  scenePacks?: ScenePack[];
}

export interface PluginObjectMetadata {
  plugin: string;
  subject: string;
  subtype: string;
}

/** Deterministic PRNG (LCG) so generation is reproducible for a given seed. */
export function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

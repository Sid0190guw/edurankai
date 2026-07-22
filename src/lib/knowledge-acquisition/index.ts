// src/lib/knowledge-acquisition/index.ts — Block 08 public surface.
// The pure, tested core (source trust + extraction schema) is exported here. The DB-backed run
// store, stage orchestrator, media generation, and endpoints are deferred (see spec §6) — they
// build on this surface plus the kernel/LLM/RBAC substrate.
export * from './types';
export {
  scoreSource, scoreSources, recencyScore, domainFamily,
  filterSources, defaultFilterPolicy, crossVerify,
} from './source-trust';
export { ExtractionSchema, type Extraction, extractConcept, stripFences, EXTRACT_SYSTEM } from './extract';

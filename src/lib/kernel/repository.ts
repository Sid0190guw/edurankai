// src/lib/kernel/repository.ts — the kernel service: typed CRUD, lifecycle transitions,
// relationship management, and KnowledgeObject composition. All persistence goes through a
// KernelStore, so this exact logic is proven in memory (tests) and runs on Postgres.
import {
  type KernelObject, type ObjectType, type ObjectDataMap, type Permission, type LearningMetadata,
  type SecurityLabel, type RelationshipEdge, type RelationshipType, type LifecycleState,
} from './types';
import { assertTransition } from './lifecycle';
import { validateObjectData } from './validation';
import type { KernelStore } from './store';
import { InMemoryKernelStore } from './store';

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // deterministic fallback (non-crypto) for exotic runtimes
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const nowISO = () => new Date().toISOString();

export interface CreateInput<T extends ObjectType> {
  type: T;
  data: ObjectDataMap[T];
  owner?: string | null;
  permissions?: Permission[];
  metadata?: Record<string, unknown>;
  learningMetadata?: LearningMetadata;
  securityLabels?: SecurityLabel[];
}

export interface UpdatePatch {
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  learningMetadata?: LearningMetadata;
  securityLabels?: SecurityLabel[];
  permissions?: Permission[];
}

/** An object plus its relationship edges (both directions). */
export interface ObjectGraph {
  object: KernelObject;
  outgoing: RelationshipEdge[];
  incoming: RelationshipEdge[];
}

export class KernelRepository {
  constructor(private store: KernelStore = new InMemoryKernelStore()) {}

  // ---- create (state = created) ----
  async createObject<T extends ObjectType>(input: CreateInput<T>): Promise<KernelObject<ObjectDataMap[T]>> {
    const ts = nowISO();
    const obj: KernelObject<ObjectDataMap[T]> = {
      id: uuid(), type: input.type, version: 1, owner: input.owner ?? null,
      permissions: input.permissions ?? [], metadata: input.metadata ?? {},
      learningMetadata: input.learningMetadata ?? {}, securityLabels: input.securityLabels ?? ['public'],
      synchronizationState: 'synced', lifecycleState: 'created',
      data: input.data, createdAt: ts, updatedAt: ts, archivedAt: null,
    };
    await this.store.insertObject(obj as unknown as KernelObject);   // typed payload -> generic envelope
    return obj;
  }

  private async load(id: string): Promise<KernelObject> {
    const o = await this.store.getObject(id);
    if (!o) throw new Error(`kernel object not found: ${id}`);
    return o;
  }
  private async transition(id: string, to: LifecycleState, mutate?: (o: KernelObject) => void): Promise<KernelObject> {
    const o = await this.load(id);
    assertTransition(o.lifecycleState, to);
    o.lifecycleState = to;
    o.updatedAt = nowISO();
    mutate?.(o);
    await this.store.updateObject(o);
    return o;
  }

  // ---- lifecycle operations ----
  /** created -> validated. Runs the type's Zod schema; a bad payload is rejected here. */
  async validateObject(id: string): Promise<KernelObject> {
    const o = await this.load(id);
    validateObjectData(o.type, o.data);                 // throws ValidationError on bad payload
    return this.transition(id, 'validated');
  }
  /** validated | updated -> indexed. */
  indexObject(id: string): Promise<KernelObject> { return this.transition(id, 'indexed'); }
  /** indexed | updated -> published. */
  publishObject(id: string): Promise<KernelObject> { return this.transition(id, 'published'); }
  /** published -> referenced (called when another object starts referencing this one). */
  markReferenced(id: string): Promise<KernelObject> { return this.transition(id, 'referenced'); }

  /** published | referenced -> updated. Bumps version, marks dirty, applies the patch. */
  async updateObject(id: string, patch: UpdatePatch = {}): Promise<KernelObject> {
    return this.transition(id, 'updated', (o) => {
      o.version += 1;
      o.synchronizationState = 'dirty';
      if (patch.data) o.data = { ...(o.data as Record<string, unknown>), ...patch.data };
      if (patch.metadata) o.metadata = { ...o.metadata, ...patch.metadata };
      if (patch.learningMetadata) o.learningMetadata = { ...o.learningMetadata, ...patch.learningMetadata };
      if (patch.securityLabels) o.securityLabels = patch.securityLabels;
      if (patch.permissions) o.permissions = patch.permissions;
    });
  }
  /** Edit a NOT-yet-published object in place (draft authoring): no version bump, no transition. */
  async editDraft(id: string, patch: UpdatePatch = {}): Promise<KernelObject> {
    const o = await this.load(id);
    if (['published', 'referenced', 'archived', 'deleted'].includes(o.lifecycleState)) throw new Error(`editDraft not allowed in state "${o.lifecycleState}"; use updateObject`);
    o.updatedAt = nowISO();
    if (patch.data) o.data = { ...(o.data as Record<string, unknown>), ...patch.data };
    if (patch.metadata) o.metadata = { ...o.metadata, ...patch.metadata };
    if (patch.learningMetadata) o.learningMetadata = { ...o.learningMetadata, ...patch.learningMetadata };
    if (patch.securityLabels) o.securityLabels = patch.securityLabels;
    if (patch.permissions) o.permissions = patch.permissions;
    await this.store.updateObject(o);
    return o;
  }

  /** Merge presentational metadata (e.g. ordering) in any non-deleted state, without a transition. */
  async patchMeta(id: string, metaPatch: Record<string, unknown>): Promise<KernelObject> {
    const o = await this.load(id);
    if (o.lifecycleState === 'deleted') throw new Error('object is deleted');
    o.metadata = { ...o.metadata, ...metaPatch };
    o.updatedAt = nowISO();
    await this.store.updateObject(o);
    return o;
  }

  /** published | referenced | updated -> archived. */
  archiveObject(id: string): Promise<KernelObject> { return this.transition(id, 'archived', (o) => { o.archivedAt = nowISO(); }); }
  /** archived -> deleted (soft delete: the row remains, state = deleted). */
  deleteObject(id: string): Promise<KernelObject> { return this.transition(id, 'deleted'); }

  // ---- relationships ----
  async addRelationship(fromId: string, type: RelationshipType, toId: string, metadata?: Record<string, unknown>): Promise<RelationshipEdge> {
    await this.load(fromId); await this.load(toId);      // both must exist
    const edge: RelationshipEdge = { id: uuid(), fromId, toId, type, metadata: metadata ?? {}, createdAt: nowISO() };
    await this.store.insertEdge(edge);
    return edge;
  }

  async getObject(id: string): Promise<KernelObject | null> { return this.store.getObject(id); }
  async listByType(type: ObjectType): Promise<KernelObject[]> { return this.store.listByType(type); }

  /** An object plus every edge in and out of it. */
  async getObjectGraph(id: string): Promise<ObjectGraph> {
    const object = await this.load(id);
    const [outgoing, incoming] = await Promise.all([this.store.edgesFrom(id), this.store.edgesTo(id)]);
    return { object, outgoing, incoming };
  }

  // ---- KnowledgeObject composition ----
  /**
   * Build a KnowledgeObject and wire its composition as typed edges:
   *   prerequisites   : prereqId  -[prerequisite_of]-> knowledgeId
   *   assessments     : assessId  -[assesses]->        knowledgeId
   *   concept         : knowledgeId -[part_of]->       conceptId
   *   animations/labs/simulations/research/industry-objs : knowledgeId -[references]-> id
   *   translations    : translId  -[translation_of]->  knowledgeId
   *   accessibility   : variantId -[variant_of]->      knowledgeId
   * Inline scholarly content (equations, examples) lives in `data`.
   */
  async buildKnowledgeObject(input: {
    data: ObjectDataMap['KnowledgeObject'];
    owner?: string | null;
    prerequisites?: string[];
    assessments?: string[];
    references?: string[];         // animations / labs / simulations / research object ids
    translations?: string[];
    accessibilityVariants?: string[];
    conceptId?: string | null;
  }): Promise<KernelObject<ObjectDataMap['KnowledgeObject']>> {
    const ko = await this.createObject({ type: 'KnowledgeObject', data: input.data, owner: input.owner ?? null });
    for (const p of input.prerequisites ?? []) await this.addRelationship(p, 'prerequisite_of', ko.id);
    for (const a of input.assessments ?? []) await this.addRelationship(a, 'assesses', ko.id);
    for (const r of input.references ?? []) await this.addRelationship(ko.id, 'references', r);
    for (const t of input.translations ?? []) await this.addRelationship(t, 'translation_of', ko.id);
    for (const v of input.accessibilityVariants ?? []) await this.addRelationship(v, 'variant_of', ko.id);
    if (input.conceptId) await this.addRelationship(ko.id, 'part_of', input.conceptId);
    return ko;
  }
}

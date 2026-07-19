// src/lib/kernel/repository.ts — the kernel service: typed CRUD, lifecycle transitions,
// relationship management, and KnowledgeObject composition. All persistence goes through a
// KernelStore, so this exact logic is proven in memory (tests) and runs on Postgres.
import {
  type KernelObject, type ObjectType, type ObjectDataMap, type Permission, type LearningMetadata,
  type SecurityLabel, type RelationshipEdge, type RelationshipType, type LifecycleState,
  isEdgeLegal,
} from './types';
import { assertTransition } from './lifecycle';
import { validateObjectData, EdgeGrammarError } from './validation';
import { topoOrder, wouldCycle, CycleError } from './graph';
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
function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** Thrown by updateObject when the caller's expectedVersion no longer matches (optimistic concurrency). */
export class StaleWriteError extends Error {
  constructor(public actual: number, public expected: number) {
    super(`stale write: object is at version ${actual}, caller expected ${expected}`);
    this.name = 'StaleWriteError';
  }
}

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
  // Block 12: onVersionBump fires after a version-bumping write persists, so a cache layer (VSM)
  // can invalidate. Default no-op keeps the kernel dependency-free.
  constructor(
    private store: KernelStore = new InMemoryKernelStore(),
    private onVersionBump: (id: string) => void = () => {},
  ) {}

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
  /** created -> validated. Runs the type's Zod schema; a bad payload is rejected here.
   *  For a KnowledgeObject, also rejects advancing if it sits in a prerequisite cycle. */
  async validateObject(id: string): Promise<KernelObject> {
    const o = await this.load(id);
    validateObjectData(o.type, o.data);                 // throws ValidationError on bad payload
    if (o.type === 'KnowledgeObject') {                 // T4: defence-in-depth cycle gate
      const edges = await this.store.edgesOfType('prerequisite_of');
      const nodeIds = [...new Set(edges.flatMap((e) => [e.fromId, e.toId]))];
      if (nodeIds.includes(o.id)) {
        const { cycle } = topoOrder(nodeIds, edges);
        if (cycle && cycle.includes(o.id)) throw new CycleError(o.id, o.id);
      }
    }
    return this.transition(id, 'validated');
  }
  /** validated | updated -> indexed. */
  indexObject(id: string): Promise<KernelObject> { return this.transition(id, 'indexed'); }
  /** indexed | updated -> published. */
  publishObject(id: string): Promise<KernelObject> { return this.transition(id, 'published'); }
  /** published -> referenced (called when another object starts referencing this one). */
  markReferenced(id: string): Promise<KernelObject> { return this.transition(id, 'referenced'); }

  /** published | referenced -> updated. Bumps version, marks dirty, applies the patch, and
   *  snapshots the pre-mutation object to kernel_object_versions. When `expectedVersion` is
   *  given, a mismatch rejects the write (optimistic concurrency) and flags a sync conflict
   *  instead of clobbering. */
  async updateObject(id: string, patch: UpdatePatch = {}, expectedVersion?: number): Promise<KernelObject> {
    const o = await this.load(id);
    if (expectedVersion != null && o.version !== expectedVersion) {
      o.synchronizationState = 'conflict';             // SYNC_TRANSITIONS: synced|dirty|pending -> conflict
      await this.store.updateObject(o);
      throw new StaleWriteError(o.version, expectedVersion);
    }
    const snapshot = clone(o);                          // capture BEFORE mutation
    assertTransition(o.lifecycleState, 'updated');
    o.version += 1;
    o.synchronizationState = 'dirty';
    if (patch.data) o.data = { ...(o.data as Record<string, unknown>), ...patch.data };
    if (patch.metadata) o.metadata = { ...o.metadata, ...patch.metadata };
    if (patch.learningMetadata) o.learningMetadata = { ...o.learningMetadata, ...patch.learningMetadata };
    if (patch.securityLabels) o.securityLabels = patch.securityLabels;
    if (patch.permissions) o.permissions = patch.permissions;
    o.lifecycleState = 'updated';
    o.updatedAt = nowISO();
    await this.store.insertVersion(snapshot);           // -> kernel_object_versions
    await this.store.updateObject(o);
    this.onVersionBump(o.id);                           // Block 12: cache invalidation hook
    return o;
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

  /** Merge into learning_metadata WITHOUT a lifecycle transition or version bump (Block 04:
   *  learner state is written at high frequency; updateObject would churn version/lifecycle). */
  async patchLearningMetadata(id: string, patch: Partial<LearningMetadata> & Record<string, unknown>): Promise<KernelObject> {
    const o = await this.load(id);
    if (o.lifecycleState === 'deleted') throw new Error('object is deleted');
    o.learningMetadata = { ...o.learningMetadata, ...patch };   // shallow merge
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
    const from = await this.load(fromId);
    const to = await this.load(toId);                    // both must exist
    if (!isEdgeLegal(from.type, type, to.type)) {        // T2: enforce the edge grammar
      throw new EdgeGrammarError(from.type, type, to.type);
    }
    if (type === 'prerequisite_of') {                    // T3: no prerequisite cycles
      const existing = await this.store.edgesOfType('prerequisite_of');
      if (wouldCycle(fromId, toId, existing)) throw new CycleError(fromId, toId);
    }
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

  // ---- version history / rollback / merge (spec "Version / Roll back / Merge") ----
  /** List the retained snapshot versions of an object (oldest first). */
  listVersions(id: string): Promise<Array<{ version: number; createdAt: string }>> {
    return this.store.listVersions(id);
  }

  /** Restore an object's payload to a prior snapshot. Version moves FORWARD (never rewinds):
   *  the pre-rollback state is itself snapshotted first, then a new version is written. */
  async rollbackObject(id: string, toVersion: number): Promise<KernelObject> {
    const o = await this.load(id);
    const snap = await this.store.getVersion(id, toVersion);
    if (!snap) throw new Error(`no such version ${toVersion} for ${id}`);
    await this.store.insertVersion(clone(o));           // rollback is itself a new snapshot
    o.data = snap.data;
    o.metadata = snap.metadata;
    o.learningMetadata = snap.learningMetadata;
    o.version += 1;                                     // monotonic
    o.synchronizationState = 'dirty';
    o.updatedAt = nowISO();
    await this.store.updateObject(o);
    this.onVersionBump(o.id);                           // Block 12: cache invalidation hook
    return o;
  }

  /** Three-way field merge of an offline-diverged payload against a common ancestor version.
   *  Non-overlapping remote changes are applied; fields both sides changed are returned as
   *  conflicts (dot-paths) for last-writer or human resolution. Pure primitive — the full
   *  offline delta-sync engine (transport/batching) is a downstream block. */
  async mergeObject(id: string, incoming: Partial<KernelObject>, base: number): Promise<{ merged: KernelObject; conflicts: string[] }> {
    const current = await this.load(id);
    const baseSnap = await this.store.getVersion(id, base);
    if (!baseSnap) throw new Error(`no base version ${base} for ${id}`);
    const baseData = (baseSnap.data ?? {}) as Dict;
    const localData = (current.data ?? {}) as Dict;
    const remoteData = (incoming.data ?? {}) as Dict;
    const merged = clone(current);
    const conflicts: string[] = [];

    const paths = new Set([...changedPaths(baseData, localData), ...changedPaths(baseData, remoteData)]);
    for (const path of paths) {
      const localChanged = !eq(valueAt(localData, path), valueAt(baseData, path));
      const remoteChanged = !eq(valueAt(remoteData, path), valueAt(baseData, path));
      if (remoteChanged && !localChanged) setAt(merged.data as Dict, path, valueAt(remoteData, path));
      else if (localChanged && remoteChanged) conflicts.push(path);
      // localChanged && !remoteChanged -> keep local (already in `merged`)
    }
    merged.synchronizationState = conflicts.length ? 'conflict' : 'synced';
    return { merged, conflicts };
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

// ---- dot-path helpers for mergeObject (module-private) ----
type Dict = Record<string, unknown>;

function changedPaths(a: Dict, b: Dict, prefix = ''): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const p = prefix ? `${prefix}.${k}` : k;
    const av = a[k], bv = b[k];
    if (isPlainObject(av) && isPlainObject(bv)) out.push(...changedPaths(av, bv, p));
    else if (JSON.stringify(av) !== JSON.stringify(bv)) out.push(p);
  }
  return out;
}
function valueAt(obj: Dict, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}
function setAt(obj: Dict, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Dict = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Dict;
  }
  cur[keys[keys.length - 1]] = value;
}
function isPlainObject(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function eq(a: unknown, b: unknown): boolean {   // structural equality for leaf values
  return JSON.stringify(a) === JSON.stringify(b);
}

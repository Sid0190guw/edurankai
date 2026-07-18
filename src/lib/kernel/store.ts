// src/lib/kernel/store.ts — persistence abstraction for the kernel.
//
// KernelStore is the port; two adapters implement it:
//  - InMemoryKernelStore: dependency-free, used by unit tests and as a safe default.
//  - PgKernelStore: postgres-js/Drizzle, self-bootstrapping (CREATE TABLE IF NOT EXISTS),
//    the production store.
// The repository (repository.ts) is written against the interface, so the exact same
// lifecycle/composition logic is proven in memory and runs on Postgres unchanged.
import type { KernelObject, ObjectType, RelationshipEdge } from './types';

export interface KernelStore {
  insertObject(obj: KernelObject): Promise<void>;
  getObject(id: string): Promise<KernelObject | null>;
  updateObject(obj: KernelObject): Promise<void>;
  listByType(type: ObjectType): Promise<KernelObject[]>;
  insertEdge(edge: RelationshipEdge): Promise<void>;
  edgesFrom(id: string): Promise<RelationshipEdge[]>;
  edgesTo(id: string): Promise<RelationshipEdge[]>;
}

function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
export class InMemoryKernelStore implements KernelStore {
  private objects = new Map<string, KernelObject>();
  private edges: RelationshipEdge[] = [];

  async insertObject(obj: KernelObject): Promise<void> {
    if (this.objects.has(obj.id)) throw new Error(`object ${obj.id} already exists`);
    this.objects.set(obj.id, clone(obj));
  }
  async getObject(id: string): Promise<KernelObject | null> {
    const o = this.objects.get(id);
    return o ? clone(o) : null;
  }
  async updateObject(obj: KernelObject): Promise<void> {
    if (!this.objects.has(obj.id)) throw new Error(`object ${obj.id} not found`);
    this.objects.set(obj.id, clone(obj));
  }
  async listByType(type: ObjectType): Promise<KernelObject[]> {
    return [...this.objects.values()].filter((o) => o.type === type).map(clone);
  }
  async insertEdge(edge: RelationshipEdge): Promise<void> { this.edges.push(clone(edge)); }
  async edgesFrom(id: string): Promise<RelationshipEdge[]> { return this.edges.filter((e) => e.fromId === id).map(clone); }
  async edgesTo(id: string): Promise<RelationshipEdge[]> { return this.edges.filter((e) => e.toId === id).map(clone); }
}

// ---------------------------------------------------------------------------
// Postgres adapter. Imports are done lazily so the in-memory store (and tests) never
// pull in the DB driver / env.
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

function rowToObject(r: any): KernelObject {
  return {
    id: r.id, type: r.type, version: Number(r.version), owner: r.owner ?? null,
    permissions: r.permissions ?? [], metadata: r.metadata ?? {},
    learningMetadata: r.learning_metadata ?? {}, securityLabels: r.security_labels ?? [],
    synchronizationState: r.synchronization_state, lifecycleState: r.lifecycle_state,
    data: r.data ?? {},
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
  };
}
function rowToEdge(r: any): RelationshipEdge {
  return { id: r.id, fromId: r.from_id, toId: r.to_id, type: r.type, metadata: r.metadata ?? {}, createdAt: new Date(r.created_at).toISOString() };
}

export class PgKernelStore implements KernelStore {
  private ready = false;
  private async ensure() {
    if (this.ready) return;
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const { KERNEL_DDL } = await import('./schema');
    for (const ddl of KERNEL_DDL) await db.execute(sql.raw(ddl));
    this.ready = true;
  }
  private async ctx() {
    await this.ensure();
    const { db } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    return { db, sql };
  }

  async insertObject(o: KernelObject): Promise<void> {
    const { db, sql } = await this.ctx();
    await db.execute(sql`INSERT INTO kernel_objects
      (id, type, version, owner, permissions, metadata, learning_metadata, security_labels, synchronization_state, lifecycle_state, data, created_at, updated_at, archived_at)
      VALUES (${o.id}, ${o.type}, ${o.version}, ${o.owner}, ${JSON.stringify(o.permissions)}::jsonb, ${JSON.stringify(o.metadata)}::jsonb,
              ${JSON.stringify(o.learningMetadata)}::jsonb, ${o.securityLabels as any}, ${o.synchronizationState}, ${o.lifecycleState},
              ${JSON.stringify(o.data)}::jsonb, ${o.createdAt}, ${o.updatedAt}, ${o.archivedAt})`);
  }
  async getObject(id: string): Promise<KernelObject | null> {
    const { db, sql } = await this.ctx();
    const r = rows(await db.execute(sql`SELECT * FROM kernel_objects WHERE id = ${id} LIMIT 1`))[0];
    return r ? rowToObject(r) : null;
  }
  async updateObject(o: KernelObject): Promise<void> {
    const { db, sql } = await this.ctx();
    await db.execute(sql`UPDATE kernel_objects SET
      type=${o.type}, version=${o.version}, owner=${o.owner}, permissions=${JSON.stringify(o.permissions)}::jsonb,
      metadata=${JSON.stringify(o.metadata)}::jsonb, learning_metadata=${JSON.stringify(o.learningMetadata)}::jsonb,
      security_labels=${o.securityLabels as any}, synchronization_state=${o.synchronizationState}, lifecycle_state=${o.lifecycleState},
      data=${JSON.stringify(o.data)}::jsonb, updated_at=${o.updatedAt}, archived_at=${o.archivedAt}
      WHERE id=${o.id}`);
  }
  async listByType(type: ObjectType): Promise<KernelObject[]> {
    const { db, sql } = await this.ctx();
    return rows(await db.execute(sql`SELECT * FROM kernel_objects WHERE type = ${type} ORDER BY created_at ASC`)).map(rowToObject);
  }
  async insertEdge(e: RelationshipEdge): Promise<void> {
    const { db, sql } = await this.ctx();
    await db.execute(sql`INSERT INTO kernel_edges (id, from_id, to_id, type, metadata, created_at)
      VALUES (${e.id}, ${e.fromId}, ${e.toId}, ${e.type}, ${JSON.stringify(e.metadata || {})}::jsonb, ${e.createdAt})`);
  }
  async edgesFrom(id: string): Promise<RelationshipEdge[]> {
    const { db, sql } = await this.ctx();
    return rows(await db.execute(sql`SELECT * FROM kernel_edges WHERE from_id = ${id}`)).map(rowToEdge);
  }
  async edgesTo(id: string): Promise<RelationshipEdge[]> {
    const { db, sql } = await this.ctx();
    return rows(await db.execute(sql`SELECT * FROM kernel_edges WHERE to_id = ${id}`)).map(rowToEdge);
  }
}

// src/lib/kernel/schema.ts — Drizzle table definitions for the unified object store.
// Two tables: kernel_objects (the envelope + typed JSON payload) and kernel_edges (typed
// relationships). Additive to the existing schema; nothing here touches training_* / users.
//
// The Postgres store (store.ts) ALSO self-bootstraps these via CREATE TABLE IF NOT EXISTS
// (this repo's dominant pattern), so they exist on first use even without a migration. To
// create them via the ORM instead, add `export * from '@/lib/kernel/schema'` to
// src/lib/db/schema.ts and run `npm run db:push`.
import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const kernelObjects = pgTable('kernel_objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  version: integer('version').notNull().default(1),
  owner: uuid('owner'),
  permissions: jsonb('permissions').notNull().default([]),
  metadata: jsonb('metadata').notNull().default({}),
  learningMetadata: jsonb('learning_metadata').notNull().default({}),
  securityLabels: text('security_labels').array().notNull().default([]),
  synchronizationState: text('synchronization_state').notNull().default('synced'),
  lifecycleState: text('lifecycle_state').notNull().default('created'),
  data: jsonb('data').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => ({
  typeIdx: index('kernel_objects_type_idx').on(t.type),
  lifecycleIdx: index('kernel_objects_lifecycle_idx').on(t.lifecycleState),
  ownerIdx: index('kernel_objects_owner_idx').on(t.owner),
}));

export const kernelEdges = pgTable('kernel_edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromId: uuid('from_id').notNull(),
  toId: uuid('to_id').notNull(),
  type: text('type').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fromIdx: index('kernel_edges_from_idx').on(t.fromId),
  toIdx: index('kernel_edges_to_idx').on(t.toId),
  typeIdx: index('kernel_edges_type_idx').on(t.type),
}));

// Raw DDL used by the self-bootstrap path (store.ts) — kept in sync with the tables above.
export const KERNEL_DDL = [
  `CREATE TABLE IF NOT EXISTS kernel_objects (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     type TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     owner UUID,
     permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     learning_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     security_labels TEXT[] NOT NULL DEFAULT '{}',
     synchronization_state TEXT NOT NULL DEFAULT 'synced',
     lifecycle_state TEXT NOT NULL DEFAULT 'created',
     data JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     archived_at TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS kernel_objects_type_idx ON kernel_objects (type)`,
  `CREATE INDEX IF NOT EXISTS kernel_objects_lifecycle_idx ON kernel_objects (lifecycle_state)`,
  `CREATE INDEX IF NOT EXISTS kernel_objects_owner_idx ON kernel_objects (owner)`,
  `CREATE TABLE IF NOT EXISTS kernel_edges (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     from_id UUID NOT NULL,
     to_id UUID NOT NULL,
     type TEXT NOT NULL,
     metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS kernel_edges_from_idx ON kernel_edges (from_id)`,
  `CREATE INDEX IF NOT EXISTS kernel_edges_to_idx ON kernel_edges (to_id)`,
  `CREATE INDEX IF NOT EXISTS kernel_edges_type_idx ON kernel_edges (type)`,
];

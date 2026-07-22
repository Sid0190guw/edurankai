// src/lib/plugins/schema.ts — Block 09: per-institution plugin enable/disable. Self-bootstrapping.
import { pgTable, uuid, text, boolean, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const NIL_INSTITUTION = '00000000-0000-0000-0000-000000000000';

export const eduPluginRegistry = pgTable('edu_plugin_registry', {
  institutionId: uuid('institution_id').notNull().default(NIL_INSTITUTION),
  pluginId: text('plugin_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: text('version').notNull(),
  config: jsonb('config').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.institutionId, t.pluginId] }) }));

export const PLUGIN_DDL = [
  `CREATE TABLE IF NOT EXISTS edu_plugin_registry (
     institution_id UUID NOT NULL DEFAULT '${NIL_INSTITUTION}',
     plugin_id TEXT NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT true,
     version TEXT NOT NULL,
     config JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (institution_id, plugin_id))`,
];

// src/lib/security/schema.ts — Block 11: derived threat signals (self-bootstrapping).
import { pgTable, uuid, varchar, jsonb, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const securitySignals = pgTable('security_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: varchar('kind', { length: 60 }).notNull(),
  severity: varchar('severity', { length: 10 }).notNull(),   // 'low' | 'medium' | 'high'
  subjectUserId: uuid('subject_user_id'),
  subjectIp: varchar('subject_ip', { length: 64 }),
  score: integer('score').notNull().default(0),
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('open'),   // 'open' | 'ack' | 'dismissed'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindIdx: index('security_signals_kind_idx').on(t.kind),
  subjIdx: index('security_signals_subject_idx').on(t.subjectUserId),
  createdIdx: index('security_signals_created_idx').on(t.createdAt),
}));

export type SecuritySignal = typeof securitySignals.$inferSelect;

export const SECURITY_DDL = [
  `CREATE TABLE IF NOT EXISTS security_signals (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     kind VARCHAR(60) NOT NULL,
     severity VARCHAR(10) NOT NULL,
     subject_user_id UUID,
     subject_ip VARCHAR(64),
     score INTEGER NOT NULL DEFAULT 0,
     evidence JSONB,
     window_start TIMESTAMPTZ NOT NULL,
     window_end TIMESTAMPTZ NOT NULL,
     status VARCHAR(12) NOT NULL DEFAULT 'open',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS security_signals_kind_idx ON security_signals (kind)`,
  `CREATE INDEX IF NOT EXISTS security_signals_subject_idx ON security_signals (subject_user_id)`,
  `CREATE INDEX IF NOT EXISTS security_signals_created_idx ON security_signals (created_at)`,
];

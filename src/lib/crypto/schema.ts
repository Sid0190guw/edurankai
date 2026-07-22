// src/lib/crypto/schema.ts — Block 11: envelope-ciphertext type + the key-metadata table.
// Key MATERIAL never lives in Postgres — only lifecycle metadata, so rotation is auditable.
import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { z } from 'zod';

export interface EnvelopeCiphertext {
  v: 1;
  keyId: string;
  alg: 'A256GCM';
  iv: string;    // base64, 12 bytes
  ct: string;    // base64 ciphertext ('' for blob bodies stored out-of-band)
  tag: string;   // base64, 16-byte GCM auth tag
  aad?: string;  // optional additional-authenticated-data label (not secret)
}

export const EnvelopeCiphertextSchema = z.object({
  v: z.literal(1),
  keyId: z.string().min(1).max(64),
  alg: z.literal('A256GCM'),
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
  aad: z.string().optional(),
});

export const cryptoKeys = pgTable('crypto_keys', {
  keyId: text('key_id').primaryKey(),                 // suffix of DATA_ENCRYPTION_KEY_<keyId>
  purpose: text('purpose').notNull(),                 // 'data-at-rest' | 'blob' | 'field'
  alg: text('alg').notNull().default('A256GCM'),
  state: text('state').notNull().default('active'),   // 'active' | 'rotating' | 'retired'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  rotationDays: integer('rotation_days').notNull().default(365),
}, (t) => ({ stateIdx: index('crypto_keys_state_idx').on(t.state) }));

export type CryptoKey = typeof cryptoKeys.$inferSelect;

export const CRYPTO_DDL = [
  `CREATE TABLE IF NOT EXISTS crypto_keys (
     key_id TEXT PRIMARY KEY,
     purpose TEXT NOT NULL,
     alg TEXT NOT NULL DEFAULT 'A256GCM',
     state TEXT NOT NULL DEFAULT 'active',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     retired_at TIMESTAMPTZ,
     rotation_days INTEGER NOT NULL DEFAULT 365)`,
  `CREATE INDEX IF NOT EXISTS crypto_keys_state_idx ON crypto_keys (state)`,
];

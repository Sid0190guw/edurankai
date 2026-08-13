// src/lib/aquin/store-postgres.ts — the only file in AquinTutor's identity that writes SQL.
//
// It implements AquinStore against the shared Supabase, using the aq_* tables from ./schema.ts.
// When AquinTutor moves to its own database, this file is copied, repointed, and selected in
// aquinStore(); nothing above it changes.
//
// House rules that have cost this project outages, all of them live here:
//   - postgres-js returns PLAIN ARRAYS. `r.rows[0]` is always a bug; rowsOf() normalises.
//   - The real Postgres reason is on `e.cause`. `e.message` is only the failed statement.
//   - A JS array interpolated into a template becomes a RECORD literal, not an array. There is no
//     such interpolation below; role lists are read as rows, never passed as one.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { AQUIN_DDL, AQUIN_TABLES, AQUIN_ROLES } from './schema';
import type { AquinStore, AquinUserRow, NewSession, NewUser, AuditEntry } from './store';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

function userFrom(r: any): AquinUserRow {
  return {
    id: String(r.id),
    email: String(r.email),
    name: String(r.name || ''),
    passwordHash: r.password_hash ?? null,
    isActive: r.is_active !== false,
    inactiveReason: r.inactive_reason ?? null,
  };
}

export function postgresStore(): AquinStore {
  let ensured = false;

  return {
    /**
     * Create the tables and seed the roster.
     *
     * NOT WRAPPED IN ensureOnce. That helper ends in `p.catch(() => {})`, so a failing CREATE
     * resolves and every caller reports success — which is exactly how this codebase shipped a
     * bootstrap saying `ran: 8, failed: 0` while ten tables were missing. This one throws, and the
     * caller decides what to tell the person in front of the screen.
     */
    async ensureSchema() {
      if (ensured) return;
      for (const ddl of AQUIN_DDL) await db.execute(sql.raw(ddl));
      for (const r of AQUIN_ROLES) {
        await db.execute(sql`
          INSERT INTO aq_roles (key, label, description, surface, is_system, rank)
          VALUES (${r.key}, ${r.label}, ${r.description}, ${r.surface}, true, ${r.rank})
          ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description,
            surface = EXCLUDED.surface, rank = EXCLUDED.rank`);
        for (const c of r.capabilities) {
          await db.execute(sql`INSERT INTO aq_role_capabilities (role_key, capability)
            VALUES (${r.key}, ${c}) ON CONFLICT DO NOTHING`);
        }
      }
      ensured = true;
    },

    /** What actually exists, asked of the database rather than inferred from an ensure returning. */
    async presentTables() {
      const r = await db.execute(sql`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name::text LIKE 'aq\\_%'`);
      const present = rowsOf(r).map((x: any) => String(x.table_name));
      return AQUIN_TABLES.filter((t) => present.includes(t));
    },

    async userByEmail(emailLower) {
      const r = rowsOf(await db.execute(sql`
        SELECT id, email, name, password_hash, is_active, inactive_reason
          FROM aq_users WHERE email_lower = ${emailLower} LIMIT 1`))[0];
      return r ? userFrom(r) : null;
    },

    async userById(id) {
      const r = rowsOf(await db.execute(sql`
        SELECT id, email, name, password_hash, is_active, inactive_reason
          FROM aq_users WHERE id = ${id}::uuid LIMIT 1`))[0];
      return r ? userFrom(r) : null;
    },

    async createUser(u: NewUser) {
      const r = rowsOf(await db.execute(sql`
        INSERT INTO aq_users (email, name, password_hash)
        VALUES (${u.email}, ${u.name}, ${u.passwordHash})
        RETURNING id`))[0];
      if (!r?.id) throw new Error('aq_users insert returned no id');
      return String(r.id);
    },

    async sessionByTokenHash(hash) {
      // One statement rather than two: a session whose user vanished between the reads would
      // otherwise resolve to a principal with no account.
      const r = rowsOf(await db.execute(sql`
        SELECT s.id AS session_id, s.user_id, s.expires_at, s.revoked_at,
               u.id, u.email, u.name, u.password_hash, u.is_active, u.inactive_reason
          FROM aq_sessions s JOIN aq_users u ON u.id = s.user_id
         WHERE s.token_hash = ${hash} LIMIT 1`))[0];
      if (!r) return null;
      return {
        user: userFrom(r),
        session: {
          id: String(r.session_id),
          userId: String(r.user_id),
          expiresAt: new Date(r.expires_at),
          revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
        },
      };
    },

    async createSession(s: NewSession) {
      await db.execute(sql`
        INSERT INTO aq_sessions (token_hash, user_id, expires_at, issued_ip, user_agent)
        VALUES (${s.tokenHash}, ${s.userId}::uuid, ${s.expiresAt.toISOString()}::timestamptz,
                ${s.issuedIp ?? null}, ${s.userAgent ?? null})`);
    },

    async revokeSession(hash) {
      // Revoked, not deleted: the row is the record that the session existed and when it ended.
      await db.execute(sql`UPDATE aq_sessions SET revoked_at = NOW() WHERE token_hash = ${hash} AND revoked_at IS NULL`);
    },

    async rolesFor(userId) {
      return rowsOf(await db.execute(sql`
        SELECT role_key FROM aq_user_roles WHERE user_id = ${userId}::uuid`)).map((r: any) => String(r.role_key));
    },

    async assignRole(userId, roleKey, actorId) {
      await db.execute(sql`
        INSERT INTO aq_user_roles (user_id, role_key, assigned_by)
        VALUES (${userId}::uuid, ${roleKey}, ${actorId ? sql`${actorId}::uuid` : sql`NULL`})
        ON CONFLICT (user_id, role_key) DO NOTHING`);
    },

    async removeRole(userId, roleKey) {
      await db.execute(sql`DELETE FROM aq_user_roles WHERE user_id = ${userId}::uuid AND role_key = ${roleKey}`);
    },

    async countRole(roleKey) {
      const r = rowsOf(await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM aq_user_roles WHERE role_key = ${roleKey}`))[0];
      return Number(r?.c ?? 0);
    },

    async audit(e: AuditEntry) {
      await db.execute(sql`
        INSERT INTO aq_audit (actor_id, action, subject, detail, host, ip)
        VALUES (${e.actorId ? sql`${e.actorId}::uuid` : sql`NULL`}, ${e.action}, ${e.subject ?? null},
                ${JSON.stringify(e.detail ?? {})}::jsonb, ${e.host ?? null}, ${e.ip ?? null})`);
    },
  };
}

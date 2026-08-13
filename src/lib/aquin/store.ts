// src/lib/aquin/store.ts — the seam AquinTutor will leave through.
//
// =================================================================================================
// WHY AN INTERFACE AND NOT JUST QUERIES
// =================================================================================================
//
// The instruction is explicit: AquinTutor shares this Supabase for a while, and later it will not.
//
// Every project that has ever said that and then written `db.execute(sql\`...\`)` in its pages
// discovered on the day of the move that "the database" was three hundred call sites. So the whole
// of AquinTutor's identity goes through the interface below, and the SQL lives in exactly one
// implementation of it. Moving to a separate database is then: write a second implementation, change
// the line in aquinStore(), migrate the aq_* tables. Nothing above this file changes at all.
//
// The in-memory implementation at the bottom is not a toy. It is what the tests run against, which
// is how the identity rules get tested at all without a database — and it is a second implementation
// existing today, which is the only real proof that the interface is actually an abstraction rather
// than the shape of one particular SQL dialect.

import { AQUIN_TABLES } from './schema';

export interface AquinUserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  isActive: boolean;
  inactiveReason: string | null;
}

export interface AquinSessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewSession {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  issuedIp?: string | null;
  userAgent?: string | null;
}

export interface NewUser {
  email: string;
  name: string;
  passwordHash: string | null;
}

export interface AuditEntry {
  actorId: string | null;
  action: string;
  subject?: string | null;
  detail?: Record<string, unknown>;
  host?: string | null;
  ip?: string | null;
}

/**
 * Everything AquinTutor's identity needs from storage, and nothing else.
 *
 * DELIBERATELY NARROW. Each method is a question the product actually asks; there is no generic
 * `query()` escape hatch, because one would be used within a week and the seam would be gone.
 */
export interface AquinStore {
  ensureSchema(): Promise<void>;
  /** Which of the expected tables actually exist. Verification, not a trusted ensure. */
  presentTables(): Promise<string[]>;

  userByEmail(emailLower: string): Promise<AquinUserRow | null>;
  userById(id: string): Promise<AquinUserRow | null>;
  createUser(u: NewUser): Promise<string>;

  sessionByTokenHash(hash: string): Promise<{ user: AquinUserRow; session: AquinSessionRow } | null>;
  createSession(s: NewSession): Promise<void>;
  revokeSession(hash: string): Promise<void>;

  rolesFor(userId: string): Promise<string[]>;
  assignRole(userId: string, roleKey: string, actorId: string | null): Promise<void>;
  removeRole(userId: string, roleKey: string): Promise<void>;
  countRole(roleKey: string): Promise<number>;

  /** Course ids this AquinTutor account authors. Empty is a real answer, not a failure. */
  coursesAuthoredBy(userId: string): Promise<string[]>;
  setCourseAuthor(userId: string, courseId: string, actorId: string | null): Promise<void>;
  removeCourseAuthor(userId: string, courseId: string): Promise<void>;

  audit(e: AuditEntry): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// The in-memory implementation. Used by the tests, and proof the interface is not shaped by SQL.
// -------------------------------------------------------------------------------------------------

export function memoryStore(): AquinStore & { _users: Map<string, AquinUserRow>; _audit: AuditEntry[] } {
  const users = new Map<string, AquinUserRow>();
  const sessions = new Map<string, { row: AquinSessionRow; hash: string }>();
  const roles = new Map<string, Set<string>>();
  const authored = new Map<string, Set<string>>();
  const audits: AuditEntry[] = [];
  let n = 0;
  const id = () => 'u' + (++n);

  return {
    _users: users,
    _audit: audits,
    async ensureSchema() {},
    async presentTables() {
      // Read from AQUIN_TABLES rather than a hand-typed list. The in-memory store is only worth
      // anything as a faithful second implementation, and it had already drifted: aq_course_authors
      // was added to the schema and this list still claimed six tables.
      return [...AQUIN_TABLES];
    },
    async userByEmail(emailLower) {
      for (const u of users.values()) if (u.email.toLowerCase() === emailLower) return u;
      return null;
    },
    async userById(uid) { return users.get(uid) || null; },
    async createUser(u) {
      const uid = id();
      users.set(uid, { id: uid, email: u.email, name: u.name, passwordHash: u.passwordHash, isActive: true, inactiveReason: null });
      return uid;
    },
    async sessionByTokenHash(hash) {
      const s = sessions.get(hash);
      if (!s) return null;
      const u = users.get(s.row.userId);
      if (!u) return null;
      return { user: u, session: s.row };
    },
    async createSession(s) {
      sessions.set(s.tokenHash, {
        hash: s.tokenHash,
        row: { id: 's' + (++n), userId: s.userId, expiresAt: s.expiresAt, revokedAt: null },
      });
    },
    async revokeSession(hash) {
      const s = sessions.get(hash);
      if (s) s.row.revokedAt = new Date();
    },
    async rolesFor(userId) { return [...(roles.get(userId) || [])]; },
    async assignRole(userId, roleKey) {
      const set = roles.get(userId) || new Set<string>();
      set.add(roleKey);
      roles.set(userId, set);
    },
    async removeRole(userId, roleKey) { roles.get(userId)?.delete(roleKey); },
    async countRole(roleKey) {
      let c = 0;
      for (const set of roles.values()) if (set.has(roleKey)) c++;
      return c;
    },
    async coursesAuthoredBy(userId) { return [...(authored.get(userId) || [])]; },
    async setCourseAuthor(userId, courseId) {
      const set = authored.get(userId) || new Set<string>();
      set.add(courseId);
      authored.set(userId, set);
    },
    async removeCourseAuthor(userId, courseId) { authored.get(userId)?.delete(courseId); },
    async audit(e) { audits.push(e); },
  };
}

/**
 * The store this deployment uses.
 *
 * THIS FUNCTION IS THE MIGRATION. When AquinTutor leaves this Supabase, a second implementation is
 * written and selected here — by an environment variable, so the two can run side by side during the
 * move — and nothing else in the product is touched.
 */
let cached: AquinStore | null = null;
export async function aquinStore(): Promise<AquinStore> {
  if (cached) return cached;
  const { postgresStore } = await import('./store-postgres');
  cached = postgresStore();
  return cached;
}

/** Tests and scripts swap the store without going through the module cache. */
export function __setAquinStore(s: AquinStore | null): void {
  cached = s;
}

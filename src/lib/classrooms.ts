import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

async function ensureSchema() {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS classrooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL, join_code VARCHAR(20) UNIQUE NOT NULL,
      description TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS classroom_memberships (
      classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (classroom_id, user_id))`);
  } catch (_) {}
}

function newCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; const b = randomBytes(6);
  for (let i = 0; i < 6; i++) s += chars[b[i] % chars.length];
  return s;
}

export async function createClassroom(teacherId: string, name: string, description?: string) {
  await ensureSchema();
  const trimmed = (name || '').trim();
  if (!trimmed) return { ok: false, error: 'Name required' };
  for (let i = 0; i < 8; i++) {
    const code = newCode();
    try {
      const ins = rows(await db.execute(sql`
        INSERT INTO classrooms (teacher_id, name, join_code, description)
        VALUES (${teacherId}, ${trimmed.slice(0, 200)}, ${code}, ${description ? description.slice(0, 1000) : null})
        RETURNING id, join_code
      `));
      return { ok: true, id: ins[0].id, joinCode: ins[0].join_code };
    } catch (_) {}
  }
  return { ok: false, error: 'Could not generate code' };
}

export async function joinClassroom(userId: string, code: string) {
  await ensureSchema();
  const c = (code || '').trim().toUpperCase();
  if (!c) return { ok: false, error: 'Code required' };
  const cls = rows(await db.execute(sql`SELECT id, name FROM classrooms WHERE join_code = ${c} AND is_active = true LIMIT 1`))[0] as any;
  if (!cls) return { ok: false, error: 'Classroom not found' };
  await db.execute(sql`
    INSERT INTO classroom_memberships (classroom_id, user_id) VALUES (${cls.id}, ${userId})
    ON CONFLICT (classroom_id, user_id) DO NOTHING
  `);
  return { ok: true, classroomId: cls.id, name: cls.name };
}

export async function getMyClassrooms(userId: string) {
  await ensureSchema();
  const owned = rows(await db.execute(sql`
    SELECT id, name, join_code, description, created_at,
      (SELECT COUNT(*)::int FROM classroom_memberships WHERE classroom_id = classrooms.id) AS member_count
    FROM classrooms WHERE teacher_id = ${userId} AND is_active = true
    ORDER BY created_at DESC
  `));
  const joined = rows(await db.execute(sql`
    SELECT c.id, c.name, c.join_code, COALESCE(u.name, u.email) AS teacher_name,
      (SELECT COUNT(*)::int FROM classroom_memberships WHERE classroom_id = c.id) AS member_count
    FROM classroom_memberships m JOIN classrooms c ON m.classroom_id = c.id
    LEFT JOIN users u ON c.teacher_id = u.id
    WHERE m.user_id = ${userId} AND c.is_active = true AND c.teacher_id <> ${userId}
    ORDER BY m.joined_at DESC
  `));
  return { owned, joined };
}

export async function getClassroomRoster(classroomId: string, teacherId: string) {
  await ensureSchema();
  const cls = rows(await db.execute(sql`SELECT id, name, join_code, description, teacher_id FROM classrooms WHERE id = ${classroomId} LIMIT 1`))[0] as any;
  if (!cls || cls.teacher_id !== teacherId) return null;
  const roster = rows(await db.execute(sql`
    SELECT u.id, COALESCE(u.name, u.email) AS name,
      COALESCE(x.total_xp, 0) AS total_xp,
      COALESCE(x.streak_days, 0) AS streak,
      COALESCE(x.level, 1) AS level,
      COALESCE(p.total_xp, 0) AS week_xp
    FROM classroom_memberships m JOIN users u ON m.user_id = u.id
    LEFT JOIN user_xp x ON x.user_id = u.id
    LEFT JOIN xp_period_rollups p ON p.user_id = u.id AND p.period = 'week' AND p.period_key = date_trunc('week', CURRENT_DATE)::date
    WHERE m.classroom_id = ${classroomId}
    ORDER BY week_xp DESC, total_xp DESC
  `));
  return { classroom: cls, roster };
}

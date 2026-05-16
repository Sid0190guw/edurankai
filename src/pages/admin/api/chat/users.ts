import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { sql, asc } from 'drizzle-orm';

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  if (user.role === 'applicant') return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });

  const list = await db.select({
    id: users.id,
    name: users.name,
    email: users.email,
    internalHandle: users.internalHandle,
    role: users.role
  }).from(users)
    .where(sql`${users.role} <> 'applicant' AND ${users.isActive} = true`)
    .orderBy(asc(users.name));

  return new Response(JSON.stringify({ users: list }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
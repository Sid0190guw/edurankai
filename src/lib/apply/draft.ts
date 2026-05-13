import { db } from '@/lib/db';
import { applicationDrafts } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export async function getActiveDraft(userId: string) {
  const rows = await db.select().from(applicationDrafts)
    .where(eq(applicationDrafts.userId, userId))
    .orderBy(desc(applicationDrafts.updatedAt))
    .limit(1);
  return rows[0] || null;
}

export async function saveDraft(userId: string, email: string, data: Record<string, any>, step: number) {
  const existing = await getActiveDraft(userId);
  if (existing) {
    await db.update(applicationDrafts)
      .set({ data, step, email, updatedAt: new Date() })
      .where(eq(applicationDrafts.id, existing.id));
    return existing.id;
  } else {
    const inserted = await db.insert(applicationDrafts)
      .values({ userId, email, data, step })
      .returning({ id: applicationDrafts.id });
    return inserted[0].id;
  }
}

export async function deleteDraft(userId: string) {
  await db.delete(applicationDrafts).where(eq(applicationDrafts.userId, userId));
}

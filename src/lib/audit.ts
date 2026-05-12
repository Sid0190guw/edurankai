import { db } from '@/lib/db';
import { auditLog } from '@/lib/db/schema';

export async function logAudit(args: {
  userId: string | null;
  action: string;
  entity: string;
  entityId?: string;
  diff?: Record<string, unknown>;
  ipAddress?: string;
}) {
  try {
    await db.insert(auditLog).values({
      userId: args.userId,
      action: args.action,
      entity: args.entity,
      entityId: args.entityId ?? null,
      diff: args.diff ?? null,
      ipAddress: args.ipAddress ?? null
    });
  } catch (err) {
    console.error('Audit log failed:', err);
  }
}

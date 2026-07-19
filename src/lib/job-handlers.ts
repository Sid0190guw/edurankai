// src/lib/job-handlers.ts — job kinds + their delivery handlers (Prompt AP6). Notifications are
// ENQUEUED (idempotent) and delivered by the worker (in-app + email via the Prompt-18 pipeline,
// optional push) with retries + a delivery log. enqueueNotify() is the reliable send path callers use.
import { enqueue, dedupKey, logDelivery, rateLimited, recentNotifyCount, type JobHandler } from '@/lib/job-queue';

const NOTIFY_CAP_PER_HOUR = 12;

/** Reliable notification: enqueue instead of sending inline. Idempotent via a dedup key, and
 *  rate-limited per user (over the hourly cap it is DEFERRED, not dropped — avoids floods). */
export async function enqueueNotify(userId: string, n: { type: string; title: string; body?: string; link?: string; dedup?: string }): Promise<number | null> {
  const key = dedupKey('notify', [userId, n.type, n.dedup || n.title]);
  const recent = await recentNotifyCount(userId, 60).catch(() => 0);
  const runAfterMs = rateLimited(recent, NOTIFY_CAP_PER_HOUR) ? 60 * 60 * 1000 : 0;   // over cap -> defer an hour
  return enqueue('notify', { userId, ...n }, { dedupKey: key, maxAttempts: 5, runAfterMs });
}
export async function enqueueGuardianAlert(minorId: string, n: { title: string; body?: string; link?: string; dedup?: string }): Promise<number | null> {
  return enqueue('notify-guardians', { minorId, ...n }, { dedupKey: dedupKey('gd', [minorId, n.dedup || n.title]), maxAttempts: 5 });
}

export const HANDLERS: Record<string, JobHandler> = {
  async notify(payload, job) {
    const { notify } = await import('@/lib/edu-notify');
    await notify(String(payload.userId), { type: payload.type || 'general', title: payload.title, body: payload.body, link: payload.link });
    await logDelivery(job.id, 'notify', 'in-app+email', 'sent', String(payload.userId));
  },
  async 'notify-guardians'(payload, job) {
    const { notifyGuardians } = await import('@/lib/edu-notify');
    const n = await notifyGuardians(String(payload.minorId), { title: payload.title, body: payload.body, link: payload.link });
    await logDelivery(job.id, 'notify-guardians', 'guardian', 'sent', String(n) + ' guardians');
  },
  async push(payload, job) {
    try { const push = await import('@/lib/push'); if ((push as any).sendPush) await (push as any).sendPush(payload.userId, payload); await logDelivery(job.id, 'push', 'push', 'sent'); }
    catch (e: any) { await logDelivery(job.id, 'push', 'push', 'skip', e?.message || 'push unavailable'); }
  },
};

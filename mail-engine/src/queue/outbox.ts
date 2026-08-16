// mail-engine/src/queue/outbox.ts — a durable, ordered handoff to something that might be down.
//
// The engine tells the application two kinds of thing: "here is a delivery event" and "here is a
// message that arrived for one of your users". Both are facts that have already happened. If the
// application is unreachable — the laptop is offline, Supabase is rate-limiting, the app is
// mid-deploy — the fact does not stop being true, and dropping it would leave the application's view
// of the mail system permanently wrong with nothing to indicate it.
//
// So each item is written to its own file BEFORE the first delivery attempt, and the file is removed
// only after the application has acknowledged it. Section 13 of the brief: "no data should be
// silently deleted".
//
// POISON ITEMS. An item the application rejects with a 4xx is not retried forever — it is moved to
// rejected/ with the response attached. Retrying a request the far end has told you is malformed is
// how an outbox turns into a loop that never drains and hides everything behind it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface OutboxItem<T> {
  id: string;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  payload: T;
  /** Monotonic within this process. See the note on `sequence` below. */
  seq?: number;
}

/**
 * ORDER IS PART OF THE CONTRACT, AND A TIMESTAMP IS NOT ENOUGH TO KEEP IT.
 *
 * Items were originally named `<createdAt>-<uuid>.json` and read back in filename order, on the
 * assumption that time orders them. It does not: `attempting` and `delivered` for the same delivery
 * are emitted in the same tick and therefore carry the SAME millisecond, so the sort fell through to
 * the random uuid and the application could be told a message was delivered before it was told the
 * attempt had started. It passed in isolation and failed in a full-suite run, which is the signature
 * of an ordering bug that would have shown up in production as an occasional impossible event
 * sequence and been very hard to trace.
 *
 * A process-monotonic counter between the two breaks ties in the order the items were actually
 * created. Across a restart the counter resets, but the timestamp has moved on by then, so the
 * overall order still holds.
 */
let sequence = 0;

export class Outbox<T> {
  private readonly dir: string;
  private readonly rejectedDir: string;

  constructor(root: string, name: string) {
    this.dir = path.join(path.resolve(root), name);
    this.rejectedDir = path.join(this.dir, 'rejected');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.rejectedDir, { recursive: true });
  }

  /** Filenames sort by creation time then by sequence, so items leave in the order they arrived. */
  private nameFor(item: OutboxItem<T>): string {
    return `${String(item.createdAt).padStart(15, '0')}-${String(item.seq ?? 0).padStart(9, '0')}-${item.id}.json`;
  }

  async add(payload: T, now = Date.now()): Promise<OutboxItem<T>> {
    await this.init();
    const item: OutboxItem<T> = { id: randomUUID(), createdAt: now, attempts: 0, lastError: null, payload, seq: ++sequence };
    const tmp = path.join(this.dir, `.${item.id}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(item), 'utf8');
    await fs.rename(tmp, path.join(this.dir, this.nameFor(item)));
    return item;
  }

  async take(limit: number): Promise<{ file: string; item: OutboxItem<T> }[]> {
    await this.init();
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out: { file: string; item: OutboxItem<T> }[] = [];
    for (const n of names.slice(0, limit)) {
      const full = path.join(this.dir, n);
      try {
        out.push({ file: full, item: JSON.parse(await fs.readFile(full, 'utf8')) as OutboxItem<T> });
      } catch {
        // Unreadable: park it rather than tripping over it on every pass.
        try { await fs.rename(full, path.join(this.rejectedDir, n)); } catch { /* leave it */ }
      }
    }
    return out;
  }

  async ack(file: string): Promise<void> {
    try { await fs.unlink(file); } catch { /* already gone */ }
  }

  /** Keep for another try, recording why. */
  async retry(file: string, item: OutboxItem<T>, error: string): Promise<void> {
    item.attempts += 1;
    item.lastError = error.slice(0, 500);
    try { await fs.writeFile(file, JSON.stringify(item), 'utf8'); } catch { /* the item is still on disk */ }
  }

  /** The far end says this will never be accepted. Keep the evidence, stop retrying. */
  async reject(file: string, item: OutboxItem<T>, reason: string): Promise<void> {
    item.lastError = reason.slice(0, 500);
    const target = path.join(this.rejectedDir, path.basename(file));
    try {
      await fs.writeFile(target, JSON.stringify(item, null, 2), 'utf8');
      await fs.unlink(file);
    } catch { /* the item stays where it is, which is still not lost */ }
  }

  async size(): Promise<number> {
    try {
      return (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  async rejectedSize(): Promise<number> {
    try {
      return (await fs.readdir(this.rejectedDir)).filter((n) => n.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}

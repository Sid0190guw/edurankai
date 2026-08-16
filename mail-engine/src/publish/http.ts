// mail-engine/src/publish/http.ts — how the engine tells the application what happened.
//
// The contract is HTTP + JSON + an HMAC, and it is documented in docs/contracts.md so Patch 1 can
// implement the receiving side against a written spec rather than against this file.
//
// WHY AN HMAC AND NOT A BEARER TOKEN. A bearer token in a header is replayable by anything that
// captures one request. The signature here covers the timestamp AND the body, so a captured request
// cannot be modified, and a receiver that rejects timestamps older than a few minutes makes it
// non-replayable too. Both sides already share a secret; this costs one hash.
//
// SUPPRESSION IS ANSWERED LOCALLY. isSuppressed() consults a mirror on the engine's own disk, not
// the application. Two reasons, and the second is the important one:
//   1. Section 13 — the engine has to keep working while the application is unreachable, and
//      "cannot reach the app" must not become either "send to everyone" or "send to no one".
//   2. A suppression check on the hot path of every delivery is a network round trip per recipient.
// The mirror is written whenever the engine suppresses an address, and refreshed from the
// application whenever a sync succeeds, so the two converge without either being a hard dependency.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeliveryEvent, DeliveryEventPublisher, SuppressionEntry } from '../contracts/index.js';
import type { EngineConfig } from '../config.js';
import { Outbox } from '../queue/outbox.js';
import { WarnThrottle } from '../log-once.js';
import { type Logger, reasonOf } from '../logger.js';
import { M, metrics } from '../metrics.js';

// The signature scheme lives in ./signature.ts so the application's routes can verify a request
// without importing the outbox, the metrics registry and node:fs along with it. Re-exported here
// because every existing caller reaches for it through the publisher.
export { SIGNATURE_HEADER, TIMESTAMP_HEADER, signBody, verifySignature } from './signature.js';
import { signBody } from './signature.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from './signature.js';

interface SuppressionFile {
  updatedAt: string;
  entries: SuppressionEntry[];
}

export interface HttpPublisherDeps {
  config: EngineConfig;
  logger: Logger;
  /** Injectable for tests. Same shape as global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class HttpDeliveryEventPublisher implements DeliveryEventPublisher {
  private readonly cfg: EngineConfig;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly outbox: Outbox<DeliveryEvent>;
  private readonly suppressionPath: string;
  private suppressions: Map<string, SuppressionEntry> | null = null;
  private readonly warnThrottle: WarnThrottle;

  constructor(deps: HttpPublisherDeps) {
    this.cfg = deps.config;
    this.log = deps.logger.child({ component: 'event-publisher' });
    this.fetchImpl = deps.fetchImpl || ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.now = deps.now || (() => Date.now());
    this.outbox = new Outbox<DeliveryEvent>(this.cfg.spoolDir, 'events');
    this.suppressionPath = path.join(path.resolve(this.cfg.spoolDir), 'suppressions.json');
    this.warnThrottle = new WarnThrottle(60_000, this.now);
  }

  /**
   * Never throws. An event is durable the moment it is in the outbox; the POST is best-effort and
   * flush() will keep trying. A publisher that threw would abort a delivery that already happened.
   */
  async publish(events: DeliveryEvent[]): Promise<void> {
    for (const e of events) {
      try {
        await this.outbox.add(e, this.now());
      } catch (err) {
        // The last resort: if the event cannot even be written to disk, it goes to the log, which is
        // collected. Losing it entirely without a trace is the one outcome not allowed.
        this.log.error('could not write delivery event to the outbox', { reason: reasonOf(err), event: e });
      }
    }
    try {
      await this.flush();
    } catch (err) {
      this.log.warn('event flush failed; events remain queued', { reason: reasonOf(err) });
    }
  }

  async flush(): Promise<number> {
    const batch = await this.outbox.take(100);
    if (!batch.length) return 0;
    if (!this.cfg.appSharedSecret) {
      // Unsigned events would be rejected by any correct receiver, so there is no point POSTing.
      // Throttled: the worker polls every couple of seconds and this condition does not change
      // between polls — see the note at the top of log-once.ts, which exists because the unthrottled
      // version wrote the same line 43,000 times a day.
      const warn = this.warnThrottle.check('no-shared-secret');
      if (warn.shouldLog) {
        this.log.warn('not publishing: MAIL_APP_SHARED_SECRET is not set', {
          pending: batch.length,
          ...(warn.suppressed ? { similarSuppressed: warn.suppressed } : {}),
        });
      }
      return 0;
    }

    const body = JSON.stringify({ events: batch.map((b) => b.item.payload) });
    const timestamp = String(this.now());
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.cfg.appBaseUrl.replace(/\/$/, '')}/api/mail/engine/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signBody(this.cfg.appSharedSecret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(this.cfg.appTimeoutMs),
      });
    } catch (err) {
      for (const b of batch) await this.outbox.retry(b.file, b.item, reasonOf(err));
      this.log.warn('application unreachable; events held', { pending: batch.length, reason: reasonOf(err) });
      return 0;
    }

    if (response.ok) {
      for (const b of batch) await this.outbox.ack(b.file);
      metrics.counter(M.eventsPublished, 'Delivery events accepted by the application', {}, batch.length);
      this.log.debug('published delivery events', { count: batch.length });
      return batch.length;
    }

    const text = await response.text().catch(() => '');
    // 4xx that is not a rate limit or a timeout means the receiver will never accept this shape.
    // 503 is special: it is what the receiver answers while Patch 1's tables do not exist yet, and
    // it is precisely a "come back later", so those events wait rather than being rejected.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      for (const b of batch) await this.outbox.reject(b.file, b.item, `${response.status}: ${text.slice(0, 200)}`);
      this.log.error('application rejected delivery events', { status: response.status, body: text.slice(0, 300), count: batch.length });
      return 0;
    }
    for (const b of batch) await this.outbox.retry(b.file, b.item, `${response.status}: ${text.slice(0, 200)}`);
    this.log.warn('application could not accept delivery events yet', { status: response.status, pending: batch.length });
    return 0;
  }

  async pending(): Promise<number> {
    return this.outbox.size();
  }

  private async loadSuppressions(): Promise<Map<string, SuppressionEntry>> {
    if (this.suppressions) return this.suppressions;
    const map = new Map<string, SuppressionEntry>();
    try {
      const file = JSON.parse(await fs.readFile(this.suppressionPath, 'utf8')) as SuppressionFile;
      for (const e of file.entries || []) map.set(e.recipient.toLowerCase(), e);
    } catch {
      // No file yet is the normal state on a fresh install.
    }
    this.suppressions = map;
    return map;
  }

  private async saveSuppressions(): Promise<void> {
    const map = await this.loadSuppressions();
    const file: SuppressionFile = { updatedAt: new Date(this.now()).toISOString(), entries: [...map.values()] };
    await fs.mkdir(path.dirname(this.suppressionPath), { recursive: true });
    const tmp = `${this.suppressionPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await fs.rename(tmp, this.suppressionPath);
  }

  async isSuppressed(recipient: string): Promise<boolean> {
    const map = await this.loadSuppressions();
    const entry = map.get(recipient.toLowerCase());
    if (!entry) return false;
    if (entry.permanent) return true;
    if (!entry.expiresAt) return true;
    if (new Date(entry.expiresAt).getTime() > this.now()) return true;
    // Expired: drop it so the address gets another chance and the file does not grow forever.
    map.delete(recipient.toLowerCase());
    await this.saveSuppressions().catch(() => { /* the in-memory removal already took effect */ });
    return false;
  }

  async suppress(entry: SuppressionEntry): Promise<void> {
    const map = await this.loadSuppressions();
    const key = entry.recipient.toLowerCase();
    const existing = map.get(key);
    // A permanent entry is never downgraded by a later temporary one.
    if (existing?.permanent && !entry.permanent) return;
    map.set(key, { ...entry, recipient: key });
    await this.saveSuppressions().catch((err) => this.log.error('could not persist suppression', { reason: reasonOf(err), recipient: key }));

    // Tell the application too. It is the system of record for Patch 1's suppression_entries; the
    // local file is the engine's working copy. A failure here is not fatal — the event carrying the
    // same fact is already in the durable outbox.
    if (!this.cfg.appSharedSecret) return;
    const body = JSON.stringify({ suppression: { ...entry, recipient: key } });
    const timestamp = String(this.now());
    try {
      const res = await this.fetchImpl(`${this.cfg.appBaseUrl.replace(/\/$/, '')}/api/mail/engine/suppressions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signBody(this.cfg.appSharedSecret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(this.cfg.appTimeoutMs),
      });
      if (!res.ok) this.log.warn('application did not record the suppression', { status: res.status, recipient: key });
    } catch (err) {
      this.log.warn('could not send suppression to the application', { reason: reasonOf(err), recipient: key });
    }
  }

  /** Every suppression the engine currently holds, for /stats and for the CLI. */
  async listSuppressions(): Promise<SuppressionEntry[]> {
    return [...(await this.loadSuppressions()).values()];
  }

  /** Remove one entry by hand — the "this address is fine now" path. */
  async unsuppress(recipient: string): Promise<boolean> {
    const map = await this.loadSuppressions();
    const removed = map.delete(recipient.toLowerCase());
    if (removed) await this.saveSuppressions();
    return removed;
  }
}

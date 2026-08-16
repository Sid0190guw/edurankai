// mail-engine/src/inbound/imap-sync.ts — reading Dovecot, so the application does not speak IMAP.
//
// Section 8 of the brief: mailbox access comes from a mature implementation, and the web application
// should not implement the protocol itself. Dovecot is the mailbox store; this is the one component
// that talks IMAP to it, and everything downstream sees the same InboundMessage shape that arrives
// from the SMTP path. A message that came in through Postfix and one that was dragged into a folder
// by a human in a mail client reach the application identically.
//
// UIDVALIDITY IS THE PART EVERY NAIVE IMAP SYNC GETS WRONG. A mailbox's UIDs are only meaningful
// alongside its UIDVALIDITY; when a server renumbers a mailbox it bumps that value, and every UID
// the client remembered now refers to a different message or to none. A syncer that stores "last
// UID 4211" and reconnects after a renumber either re-delivers thousands of old messages or skips
// everything. So the checkpoint stores BOTH, and a changed UIDVALIDITY resets the cursor to the
// current end of the mailbox rather than replaying it.
//
// The checkpoint lives on the engine's own disk, not in the application, for the same reason the
// queue does: the sync has to know where it got to even when the application is unreachable.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import type { EngineConfig } from '../config.js';
import type { InboundMailProcessor } from '../contracts/index.js';
import { type Logger, reasonOf } from '../logger.js';
import { M, metrics } from '../metrics.js';

export interface MailboxCheckpoint {
  /** Mailbox path, e.g. "INBOX". */
  mailbox: string;
  uidValidity: string;
  lastUid: number;
  updatedAt: string;
}

export interface ImapSyncDeps {
  config: EngineConfig;
  logger: Logger;
  processor: InboundMailProcessor;
  /** Injectable so a test can drive the sync without an IMAP server. */
  connect?: (cfg: EngineConfig) => Promise<ImapClientLike>;
  now?: () => number;
}

/** The slice of ImapFlow this module uses, named so it can be substituted in a test. */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<{ uidValidity: bigint | number | string; uidNext: number; exists: number }>;
  fetch(range: string, query: Record<string, boolean>, opts?: { uid?: boolean }): AsyncIterable<{ uid: number; source?: Buffer; envelope?: { to?: { address?: string }[]; from?: { address?: string }[] } }>;
  messageFlagsAdd(range: string, flags: string[], opts?: { uid?: boolean }): Promise<boolean>;
}

export class ImapMailboxSync {
  private readonly cfg: EngineConfig;
  private readonly log: Logger;
  private readonly processor: InboundMailProcessor;
  private readonly connect: (cfg: EngineConfig) => Promise<ImapClientLike>;
  private readonly now: () => number;
  private readonly statePath: string;
  private stopping = false;

  constructor(deps: ImapSyncDeps) {
    this.cfg = deps.config;
    this.log = deps.logger.child({ component: 'imap-sync' });
    this.processor = deps.processor;
    this.now = deps.now || (() => Date.now());
    this.statePath = path.join(path.resolve(this.cfg.spoolDir), 'imap-checkpoints.json');
    this.connect = deps.connect || (async (cfg) => {
      const client = new ImapFlow({
        host: cfg.imapHost,
        port: cfg.imapPort,
        secure: cfg.imapSecure,
        auth: { user: cfg.imapUser, pass: cfg.imapPass },
        // Dovecot in the next container presents a self-signed certificate, and the connection never
        // leaves the host. This flag must NEVER be set against a mailbox on the public Internet —
        // there it would make the encryption decorative.
        tls: { rejectUnauthorized: !cfg.imapAllowSelfSigned },
        logger: false,
      }) as unknown as ImapClientLike;
      await client.connect();
      return client;
    });
  }

  async readCheckpoints(): Promise<Record<string, MailboxCheckpoint>> {
    try {
      return JSON.parse(await fs.readFile(this.statePath, 'utf8')) as Record<string, MailboxCheckpoint>;
    } catch {
      return {};
    }
  }

  private async writeCheckpoint(cp: MailboxCheckpoint): Promise<void> {
    const all = await this.readCheckpoints();
    all[cp.mailbox] = cp;
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await fs.rename(tmp, this.statePath);
  }

  /**
   * Decide which UIDs to fetch. Pure, and separated from the IO precisely so the UIDVALIDITY rule
   * can be tested without an IMAP server — it is the part that silently corrupts a sync.
   */
  static planFetch(
    previous: MailboxCheckpoint | undefined,
    mailbox: { uidValidity: string; uidNext: number },
  ): { range: string | null; reason: 'first-run' | 'uidvalidity-changed' | 'incremental' | 'nothing-new'; from: number } {
    if (!previous) {
      // FIRST RUN TAKES NOTHING. Delivering an entire existing mailbox into the application the
      // first time the syncer starts would re-notify every user about every message they already
      // have. The cursor is planted at the end and only new arrivals are picked up.
      return { range: null, reason: 'first-run', from: mailbox.uidNext };
    }
    if (previous.uidValidity !== mailbox.uidValidity) {
      return { range: null, reason: 'uidvalidity-changed', from: mailbox.uidNext };
    }
    const from = previous.lastUid + 1;
    if (from >= mailbox.uidNext) return { range: null, reason: 'nothing-new', from: previous.lastUid };
    return { range: `${from}:*`, reason: 'incremental', from };
  }

  /** One pass over one mailbox. Returns how many messages were handed to the application. */
  async syncOnce(mailbox = 'INBOX'): Promise<{ fetched: number; delivered: number; reason: string }> {
    if (!this.cfg.imapHost || !this.cfg.imapUser) {
      return { fetched: 0, delivered: 0, reason: 'imap not configured' };
    }

    let client: ImapClientLike;
    try {
      client = await this.connect(this.cfg);
    } catch (err) {
      this.log.warn('could not connect to the mailbox server', { host: this.cfg.imapHost, reason: reasonOf(err) });
      metrics.counter(M.mtaErrors, 'Errors raised by the MTA layer', { stage: 'imap' });
      return { fetched: 0, delivered: 0, reason: `connect failed: ${reasonOf(err)}` };
    }

    try {
      const box = await client.mailboxOpen(mailbox, { readOnly: false });
      const uidValidity = String(box.uidValidity);
      const checkpoints = await this.readCheckpoints();
      const plan = ImapMailboxSync.planFetch(checkpoints[mailbox], { uidValidity, uidNext: box.uidNext });

      if (plan.reason === 'uidvalidity-changed') {
        this.log.warn('mailbox was renumbered; resetting the cursor rather than replaying it', {
          mailbox, was: checkpoints[mailbox]?.uidValidity, now: uidValidity,
        });
      }

      if (!plan.range) {
        await this.writeCheckpoint({ mailbox, uidValidity, lastUid: Math.max(0, plan.from - 1), updatedAt: new Date(this.now()).toISOString() });
        return { fetched: 0, delivered: 0, reason: plan.reason };
      }

      let fetched = 0;
      let delivered = 0;
      let highestUid = checkpoints[mailbox]?.lastUid ?? 0;

      for await (const message of client.fetch(plan.range, { uid: true, source: true, envelope: true }, { uid: true })) {
        if (this.stopping) break;
        fetched += 1;
        const raw = message.source;
        if (!raw) {
          // No source means the server gave us a message we cannot deliver. Advancing past it would
          // lose it silently, so the cursor stays put and the next pass tries again.
          this.log.warn('mailbox returned a message with no source', { mailbox, uid: message.uid });
          break;
        }

        const envelopeTo = (message.envelope?.to || []).map((t) => String(t.address || '').toLowerCase()).filter(Boolean);
        const envelopeFrom = String(message.envelope?.from?.[0]?.address || '').toLowerCase();

        const outcome = await this.processor.process(raw, {
          from: envelopeFrom,
          to: envelopeTo.length ? envelopeTo : [this.cfg.imapUser],
        });

        if (!outcome.accepted && outcome.retryable) {
          // A temporary failure must not move the cursor past this message.
          this.log.warn('holding the mailbox cursor: a message could not be accepted yet', {
            mailbox, uid: message.uid, reason: outcome.rejectReason,
          });
          break;
        }

        if (outcome.accepted) delivered += 1;
        highestUid = Math.max(highestUid, message.uid);
        // \Seen so a human opening the same mailbox in a client is not shown a wall of unread mail
        // the application has already processed.
        await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true }).catch(() => false);

        await this.writeCheckpoint({ mailbox, uidValidity, lastUid: highestUid, updatedAt: new Date(this.now()).toISOString() });
      }

      if (fetched) this.log.info('mailbox sync pass', { mailbox, fetched, delivered, lastUid: highestUid });
      return { fetched, delivered, reason: plan.reason };
    } catch (err) {
      this.log.error('mailbox sync failed', { mailbox, reason: reasonOf(err) });
      metrics.counter(M.mtaErrors, 'Errors raised by the MTA layer', { stage: 'imap' });
      return { fetched: 0, delivered: 0, reason: reasonOf(err) };
    } finally {
      await client.logout().catch(() => { /* the socket closes either way */ });
    }
  }

  /** Poll forever. Stops between passes, never mid-message. */
  async start(intervalMs = 60_000, mailbox = 'INBOX'): Promise<void> {
    this.stopping = false;
    this.log.info('mailbox sync started', { host: this.cfg.imapHost, mailbox, intervalMs });
    while (!this.stopping) {
      await this.syncOnce(mailbox).catch((err) => {
        this.log.error('sync pass threw', { reason: reasonOf(err) });
        return { fetched: 0, delivered: 0, reason: 'threw' };
      });
      if (this.stopping) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    this.log.info('mailbox sync stopped');
  }

  stop(): void {
    this.stopping = true;
  }
}

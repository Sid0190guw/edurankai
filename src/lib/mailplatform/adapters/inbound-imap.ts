// src/lib/mailplatform/adapters/inbound-imap.ts — InboundMailTransport.
//
// Two sources of inbound mail, one interface:
//   PULL — the IMAP poll that already runs on this deployment (src/lib/mail-imap.ts, driven by the
//          imap-poll cron). Today's only source, because the mailbox is hosted elsewhere.
//   PUSH — an MTA or gateway POSTing a message to the platform. `parse()` is the seam the SMTP/MTA
//          agent implements against; nothing above this file changes when that becomes live.

import type {
  InboundFetchResult,
  InboundMailTransport,
  InboundMessage,
  OperationResult,
  ProviderInfo,
} from '../interfaces';
import type { MessageHeader } from '../types';
import { isValidEmail, normalizeEmail, parseAddress, parseAddressList } from '../rfc';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

function toAddr(raw: unknown): { email: string; name?: string | null } | null {
  const parsed = parseAddress(raw);
  return parsed ? { email: parsed.email, name: parsed.name ?? null } : null;
}

function toHeaders(raw: unknown): MessageHeader[] {
  const out: MessageHeader[] = [];
  if (!raw || typeof raw !== 'object') return out;
  let i = 0;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: String(v), ordinal: i++ });
    } else {
      out.push({ name, value: String(value ?? ''), ordinal: i++ });
    }
  }
  return out;
}

export function imapInbound(): InboundMailTransport {
  return {
    info(): ProviderInfo {
      // Read from env rather than the database: info() is synchronous by contract, and an ops
      // screen calling it must not open a connection. The database-backed IMAP config (set at
      // /admin/mail/settings) is authoritative for the poll itself.
      const host = process.env.IMAP_HOST || '';
      return {
        kind: 'imap-poll',
        enabled: true,
        detail: host
          ? `IMAP poll against ${host}. Push delivery also accepted at /api/mail/inbound.`
          : 'IMAP poll uses the mailbox configured at /admin/mail/settings. Push delivery is accepted at /api/mail/inbound.',
      };
    },

    async poll(opts: { limit?: number; force?: boolean } = {}): Promise<InboundFetchResult> {
      try {
        const { pollImapInbox } = await import('@/lib/mail-imap');
        const r = await pollImapInbox({ limit: opts.limit, force: opts.force });
        return { ok: r.ok, fetched: r.fetched, delivered: r.delivered, error: r.error, detail: r.detail };
      } catch (e: any) {
        return { ok: false, fetched: 0, delivered: 0, error: causeOf(e) };
      }
    },

    /**
     * Turn a pushed payload into the platform's inbound shape.
     *
     * Accepts two forms: a parsed object (what a gateway posts as JSON) and a raw MIME string,
     * which is handed to the mailparser already in this project's dependencies. Anything it cannot
     * identify a sender or a recipient for is REFUSED with a reason rather than stored as a
     * message from nobody — an inbound row with no From is a message that can never be replied to
     * and can never be traced.
     */
    async parse(payload: unknown): Promise<OperationResult<InboundMessage>> {
      try {
        if (typeof payload === 'string' || payload instanceof Uint8Array) {
          const { simpleParser } = await import('mailparser');
          const parsed: any = await simpleParser(payload as any);
          const from = toAddr(parsed.from?.text);
          if (!from) return { ok: false, error: 'message has no parsable From address', code: 'no_sender' };
          const to = parseAddressList(parsed.to?.text || '').addresses.map((a) => ({ email: a.email, name: a.name }));
          if (to.length === 0) return { ok: false, error: 'message has no parsable recipient', code: 'no_recipient' };
          return {
            ok: true,
            data: {
              raw: typeof payload === 'string' ? payload : payload,
              rfcMessageId: parsed.messageId || null,
              inReplyTo: parsed.inReplyTo || null,
              references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || null,
              from,
              to,
              cc: parseAddressList(parsed.cc?.text || '').addresses.map((a) => ({ email: a.email, name: a.name })),
              subject: String(parsed.subject || ''),
              html: parsed.html || null,
              text: parsed.text || null,
              headers: toHeaders(parsed.headers instanceof Map ? Object.fromEntries(parsed.headers) : parsed.headers),
              attachments: (parsed.attachments || []).map((a: any) => ({
                filename: a.filename || 'attachment',
                mime: a.contentType || null,
                sizeBytes: typeof a.size === 'number' ? a.size : null,
                content: a.content,
              })),
              receivedAt: (parsed.date ? new Date(parsed.date) : new Date()).toISOString(),
            },
          };
        }

        const p = (payload || {}) as Record<string, any>;
        const from = toAddr(p.from ?? p.sender ?? p.From);
        if (!from) return { ok: false, error: 'payload has no parsable From address', code: 'no_sender' };

        const toList = parseAddressList(p.to ?? p.To ?? p.recipient ?? '').addresses;
        if (toList.length === 0) return { ok: false, error: 'payload has no parsable recipient', code: 'no_recipient' };

        const spamScore = typeof p.spamScore === 'number' ? p.spamScore : null;
        return {
          ok: true,
          data: {
            raw: p.raw ?? null,
            rfcMessageId: p.messageId || p['message-id'] || null,
            inReplyTo: p.inReplyTo || p['in-reply-to'] || null,
            references: p.references || null,
            from,
            to: toList.map((a) => ({ email: a.email, name: a.name })),
            cc: parseAddressList(p.cc ?? '').addresses.map((a) => ({ email: a.email, name: a.name })),
            subject: String(p.subject || ''),
            html: p.html ?? p.bodyHtml ?? null,
            text: p.text ?? p.bodyText ?? null,
            headers: toHeaders(p.headers),
            attachments: Array.isArray(p.attachments)
              ? p.attachments.map((a: any) => ({
                  filename: String(a.filename || 'attachment'),
                  mime: a.mime || a.contentType || null,
                  sizeBytes: typeof a.size === 'number' ? a.size : null,
                }))
              : [],
            receivedAt: p.receivedAt ? new Date(p.receivedAt).toISOString() : new Date().toISOString(),
            spamScore,
            // Advisory only, and labelled as such everywhere it travels: an authentication result
            // is evidence for a human, never an automatic verdict against a sender.
            authResults: p.authResults || null,
          },
        };
      } catch (e: any) {
        return { ok: false, error: causeOf(e), code: 'parse_failed' };
      }
    },
  };
}

/** Push-only adapter, for a deployment whose MTA delivers over HTTP and has no mailbox to poll. */
export function pushOnlyInbound(): InboundMailTransport {
  const base = imapInbound();
  return {
    info: () => ({
      kind: 'push',
      enabled: true,
      detail: 'Push-only: mail arrives at /api/mail/inbound. There is no mailbox to poll, so poll() returns 0.',
    }),
    async poll() {
      // Zero fetched, ok: true, and a detail that says WHY it is zero. An empty result with no
      // explanation reads identically to a working poll finding no new mail.
      return { ok: true, fetched: 0, delivered: 0, detail: 'push-only adapter: nothing to poll' };
    },
    parse: base.parse,
  };
}

export { isValidEmail, normalizeEmail };

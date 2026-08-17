// src/lib/mailplatform/adapters/transport-smtp.ts — MailTransport over SMTP.
//
// This adapter WRAPS the repository's existing outbound path (src/lib/mail-transport.ts) rather
// than replacing it. That module already carries hard-won behaviour: port-driven TLS selection,
// transient-failure retry with backoff, From-address normalization for sender-enforcement, and a
// write to email_logs on every outcome. Reimplementing it here would have thrown that away and
// left two divergent send paths in one codebase.
//
// What this adds is the INTERFACE: a caller above it names no vendor, gets a structured result
// instead of a boolean, and can be pointed at an EduRankAI MTA cluster later by swapping this file
// for one that speaks to it. The MTA agent owns that implementation; this file owns the shape it
// must satisfy.

// Renders link attachments into the body instead of having the server fetch or read them.
import { appendLinkAttachments } from '@/lib/mailsec/link-attachments';
import type {
  MailTransport,
  OperationResult,
  OutboundEnvelope,
  ProviderInfo,
  TransportSendResult,
} from '../interfaces';
import { isRetryableFailure, smtpCodeOf } from '../rfc';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

/** Cached so `info()` is synchronous — the interface promises a cheap call, and ops screens poll it. */
let cachedInfo: ProviderInfo = {
  kind: 'smtp',
  enabled: false,
  detail: 'SMTP status not read yet. Call verify() or send() once.',
};

export function smtpTransport(): MailTransport {
  return {
    info(): ProviderInfo {
      return cachedInfo;
    },

    async verify(): Promise<OperationResult<{ detail: string }>> {
      try {
        const { transportStatus } = await import('@/lib/mail-transport');
        const status = await transportStatus();
        cachedInfo = {
          kind: 'smtp',
          enabled: status.mode === 'smtp',
          detail:
            status.mode === 'smtp'
              ? `SMTP configured at ${status.detail}`
              : 'No SMTP server is configured. Set one at /admin/mail/settings — nothing can leave the platform until then.',
        };
        return status.mode === 'smtp'
          ? { ok: true, data: { detail: cachedInfo.detail } }
          : { ok: false, error: cachedInfo.detail, code: 'no_transport' };
      } catch (e: any) {
        const error = causeOf(e);
        cachedInfo = { kind: 'smtp', enabled: false, detail: 'Could not read mail configuration: ' + error };
        return { ok: false, error, code: 'config_unreadable' };
      }
    },

    async send(envelope: OutboundEnvelope): Promise<TransportSendResult> {
      const started = Date.now();
      const to = envelope.to || [];
      const all = [...to, ...(envelope.cc || []), ...(envelope.bcc || [])];

      if (all.length === 0) {
        return { ok: false, accepted: [], rejected: [], error: 'no recipients', retryable: false };
      }

      try {
        const { sendExternal } = await import('@/lib/mail-transport');
        const from = envelope.fromName ? `${envelope.fromName} <${envelope.from}>` : envelope.from;

        // logToDb:false — the platform records its own delivery attempt and delivery event rows for
        // this send (mp_delivery_attempts / mp_delivery_events, written by ../delivery.ts). Letting
        // the legacy path ALSO write email_logs would double every status count on
        // /admin/mail/analytics, which is a bug that has already happened once on this exact path
        // and is written up in the header of src/lib/mail-transport.ts.
        // ATTACHMENT LINKS GO INTO THE MESSAGE. THEY ARE NOT FETCHED, AND NO PATH IS READ.
        //
        // This passed `href: a.url` and `path: a.path` straight to nodemailer. `href` makes
        // nodemailer FETCH the URL and embed the response; `path` makes it READ THAT FILE off the
        // local disk. Neither transport set disableUrlAccess or disableFileAccess, so both were
        // live capabilities on a path whose envelope is assembled from stored campaign data — an
        // arbitrary file read and a full-response SSRF, with the result delivered by email.
        //
        // The links are rendered into the body instead, which is what this product does everywhere
        // else and what src/lib/mail-links.ts exists to explain. `path` has no replacement on
        // purpose: there is no upload path in this system and a local file is never a legitimate
        // attachment source here.
        const withLinks = appendLinkAttachments(envelope.html || '', envelope.text || '', envelope.attachments as any);

        const result = await sendExternal({
          from,
          to,
          cc: envelope.cc,
          bcc: envelope.bcc,
          subject: envelope.subject,
          html: withLinks.html,
          text: withLinks.text || undefined,
          replyTo: envelope.replyTo || undefined,
          messageId: envelope.messageId || undefined,
          inReplyTo: envelope.inReplyTo || undefined,
          // `headers` was added to SendExternalParams by the SMTP/MTA work happening alongside this
          // patch, for List-Unsubscribe and Precedence on bulk mail. Passed straight through: the
          // platform decides WHICH headers a message needs (see ../send.ts), the transport decides
          // how to put them on the wire. Callers that set none produce byte-identical mail.
          headers: envelope.headers && Object.keys(envelope.headers).length ? envelope.headers : undefined,
          logToDb: false,
        });

        const latencyMs = Date.now() - started;
        cachedInfo = {
          kind: 'smtp',
          enabled: result.provider === 'smtp',
          detail: result.ok ? 'Last send succeeded' : 'Last send failed: ' + (result.error || 'unknown'),
        };

        if (result.ok) {
          return {
            ok: true,
            providerMessageId: result.id || null,
            accepted: all,
            rejected: [],
            latencyMs,
          };
        }

        const smtpCode = smtpCodeOf(result.error);
        return {
          ok: false,
          accepted: [],
          // Every recipient failed together: this transport hands the whole envelope to one server,
          // so it cannot report a per-recipient split. An MTA adapter that CAN must fill this in
          // per address rather than repeating one error across the list.
          rejected: all.map((address) => ({ address, reason: result.error || 'SMTP send failed', smtpCode })),
          smtpCode,
          smtpResponse: result.error || null,
          latencyMs,
          error: result.error || 'SMTP send failed',
          retryable: isRetryableFailure(smtpCode, result.error),
        };
      } catch (e: any) {
        const error = causeOf(e);
        cachedInfo = { kind: 'smtp', enabled: false, detail: 'Transport threw: ' + error };
        return {
          ok: false,
          accepted: [],
          rejected: all.map((address) => ({ address, reason: error })),
          error,
          latencyMs: Date.now() - started,
          retryable: isRetryableFailure(null, error),
        };
      }
    },
  };
}

/**
 * A transport that accepts everything and sends nothing.
 *
 * For tests and for local development without a mail server. It reports `enabled: false` and every
 * result says `provider: none` in the detail — it never claims a message left the building. A dev
 * fallback that looks like a successful send is how "it works on my machine" becomes an outage.
 */
export function nullTransport(sink?: OutboundEnvelope[]): MailTransport {
  return {
    info: () => ({
      kind: 'null',
      enabled: false,
      detail: 'No transport wired. Messages are recorded in the platform but never handed to a server.',
    }),
    async verify() {
      return { ok: false, error: 'null transport: nothing is configured to send mail', code: 'no_transport' };
    },
    async send(envelope) {
      sink?.push(envelope);
      const all = [...(envelope.to || []), ...(envelope.cc || []), ...(envelope.bcc || [])];
      return {
        ok: false,
        accepted: [],
        rejected: all.map((address) => ({ address, reason: 'no transport configured' })),
        error: 'no transport configured',
        retryable: false,
      };
    },
  };
}

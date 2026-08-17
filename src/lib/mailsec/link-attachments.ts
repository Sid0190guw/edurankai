// src/lib/mailsec/link-attachments.ts — A LINK IS SOMETHING THE RECIPIENT CLICKS, NOT SOMETHING WE
// GO AND FETCH ON THEIR BEHALF.
//
// ═══ WHAT THIS REPLACES ═══
//
// Two send paths mapped link attachments onto nodemailer's `href` field:
//
//     src/lib/mailapi/send.ts                        attachments: atts.map(a => ({ filename, href: a.url }))
//     src/lib/mailplatform/adapters/transport-smtp.ts   ... ({ filename, href: a.url, path: a.path })
//
// `href` does not mean "put this link in the message". It means NODEMAILER FETCHES THAT URL and
// embeds the response as an attachment; `path` means it reads that path off the local filesystem.
// Neither transport had `disableUrlAccess` or `disableFileAccess` set.
//
// On the first of those two the URL comes from the body of POST /api/v1/email/send, and
// src/lib/mailapi/validate.ts accepts any absolute http(s) URL. So any holder of an API key could
// name `http://169.254.169.254/latest/meta-data/…`, or any address inside the deployment's network,
// and have the response delivered to an address of their choosing. That is a full-response SSRF with
// exfiltration by email, and the platform's own documentation says the opposite: "nothing is
// uploaded or fetched by the platform".
//
// This module makes the documentation true. The links go into the MESSAGE, where the recipient's own
// browser fetches them under the recipient's own authority, which is what a shared document link is
// for. The server never opens a connection to a caller-supplied URL.
//
// ═══ WHAT THE RECIPIENT SEES CHANGE ═══
//
// Stated plainly because it is a real behaviour change on those two paths: an attachment that used
// to arrive as a FILE now arrives as a NAMED LINK at the end of the message. On every other path in
// this product that is already the behaviour and there is a module explaining why
// (src/lib/mail-links.ts). The two paths above were the exception, and they were the exception by
// accident rather than by decision.
//
// Pure. No network, no database, no clock.

import { sanitizeEmailHtml, ISOLATED } from './html';

export interface LinkAttachment {
  filename?: string | null;
  url: string;
}

export interface RenderedBody {
  html: string;
  text: string;
  /** Links that were refused, with the reason. Returned so a caller can tell the sender. */
  rejected: { url: string; reason: string }[];
}

/** http and https only. A `data:`, `file:` or `blob:` "link" is an upload wearing a link's clothes. */
function usableUrl(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 2000) return '';
  let u: URL;
  try { u = new URL(s); } catch { return ''; }
  return (u.protocol === 'https:' || u.protocol === 'http:') ? s : '';
}

function esc(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A readable name for the link, from the sender's label or from the URL itself. */
function nameFor(a: LinkAttachment, url: string): string {
  const given = String(a.filename ?? '').trim().replace(/\s+/g, ' ');
  if (given) return given.slice(0, 160);
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && last.length <= 120) return last;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'Attachment';
  }
}

/**
 * Append the attachment links to a message body.
 *
 * Returns the body unchanged when there are no usable links, so a message with no attachments is
 * byte-identical to what it was before this existed.
 *
 * The generated block is run through the sanitiser like everything else. It is markup we built
 * ourselves from escaped values and should be safe by construction — but "should be safe by
 * construction" is the sentence that precedes most of the findings in this codebase, and the
 * sanitiser costs nothing here.
 */
export function appendLinkAttachments(html: string, text: string, attachments: readonly LinkAttachment[] | null | undefined): RenderedBody {
  const list = Array.isArray(attachments) ? attachments.slice(0, 25) : [];
  const rejected: { url: string; reason: string }[] = [];
  const usable: { name: string; url: string }[] = [];

  for (const a of list) {
    const url = usableUrl(a?.url);
    if (!url) {
      rejected.push({
        url: String(a?.url ?? '').slice(0, 200),
        reason: 'only http and https links can be attached — nothing is uploaded or fetched by this platform',
      });
      continue;
    }
    usable.push({ name: nameFor(a, url), url });
  }

  if (!usable.length) return { html, text, rejected };

  const rows = usable
    .map((a) => '<li style="margin:4px 0"><a href="' + esc(a.url) + '">' + esc(a.name) + '</a></li>')
    .join('');
  const block =
    '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #E3E8EF">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#5A6779">Attached links</p>'
    + '<ul style="margin:0;padding-left:18px;font-size:14px">' + rows + '</ul>'
    + '</div>';

  const textBlock = '\n\nAttached links:\n' + usable.map((a) => '- ' + a.name + ': ' + a.url).join('\n');

  return {
    html: sanitizeEmailHtml(String(html ?? '') + block, ISOLATED).html,
    text: String(text ?? '') + textBlock,
    rejected,
  };
}

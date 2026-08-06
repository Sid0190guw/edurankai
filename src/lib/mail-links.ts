// src/lib/mail-links.ts — ATTACHMENTS ARE LINKS. THERE IS NO UPLOAD PATH IN MAIL.
//
// The platform rule is absolute: documents of any kind travel as a shared-drive link, never as an
// uploaded file. The only stored upload anywhere here is the small profile photo. So the mail
// composer takes a URL, and this module turns that URL into something that reads like a real
// attachment — a name, a type, and a sentence telling the SENDER what the recipient will actually
// experience when they click it.
//
// It is deliberately a pure function with no network call. We do NOT fetch the link to read its
// title: that would leak the recipient list's reading habits to a third party, would block the send
// on someone else's server, and would fail closed on exactly the private documents people share.
// The name therefore comes from the sender (an optional field in the composer) or from the URL
// itself, and the type comes from the URL shape. Nothing here pretends to know more than the URL.
//
// WHY THE SERVER RE-DERIVES. The composer runs a small mirror of this logic so the chip appears the
// instant you paste. That mirror is a PREVIEW. describeLink() runs again in /api/mail/send and
// /api/mail/draft and its answer is what gets stored, so a hand-crafted POST cannot label a link as
// something it is not.
//
// No provider is named in any user-facing string — see the language rules. The host patterns below
// are matching logic, not copy.

export type LinkKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'form'
  | 'folder'
  | 'file'
  | 'link';

export interface LinkAttachment {
  /** The URL exactly as it will be stored and rendered. */
  url: string;
  /** What the chip is called. Sender-supplied name wins; otherwise derived from the URL. */
  filename: string;
  kind: LinkKind;
  /** Human label for the type, shown next to the name. */
  typeLabel: string;
  /** Stored in mail_attachments.mime. Prefixed `link/` so no reader can mistake it for a file blob. */
  mime: string;
  /**
   * Shown to the SENDER only (composer, and their own copy in the thread). A recipient seeing
   * "check your sharing settings" about someone else's document can do nothing with it; the person
   * who can fix it is the owner.
   */
  ownerNote: string;
  /** True when the link is on a known document host, so the sharing note is worth showing. */
  needsSharing: boolean;
}

/** Rejected input, with the reason to put on screen. Never silently dropped. */
export interface LinkRejection {
  ok: false;
  reason: string;
}

const KIND_LABEL: Record<LinkKind, string> = {
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  form: 'Form',
  folder: 'Folder',
  file: 'Shared file',
  link: 'Web link',
};

const SHARING_NOTE =
  'Shared link — the recipient can only open it if its sharing is set to anyone with the link. Nothing is uploaded or copied.';
const PLAIN_NOTE = 'Shared link — nothing is uploaded or copied. The recipient opens it where it lives.';

/**
 * Classify a URL. Returns the description, or a rejection with a reason a person can act on.
 *
 * @param raw   the URL the sender pasted
 * @param name  optional sender-supplied name for the chip
 */
export function describeLink(raw: string, name?: string): LinkAttachment | LinkRejection {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, reason: 'Paste a link first.' };
  if (url.length > 2000) return { ok: false, reason: 'That link is too long to attach.' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'That is not a link. Paste the full address, starting with https://' };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'https:' && scheme !== 'http:') {
    // data:, blob: and file: are the three shapes an "attachment" arrives as when somebody has
    // wired an upload. None of them are a link and none of them survive leaving this machine.
    return {
      ok: false,
      reason: 'Only https links can be attached. Files are never uploaded here — share the document and paste its link.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  let kind: LinkKind = 'link';
  let needsSharing = false;

  if (host === 'docs.google.com') {
    needsSharing = true;
    if (path.startsWith('/document')) kind = 'document';
    else if (path.startsWith('/spreadsheets')) kind = 'spreadsheet';
    else if (path.startsWith('/presentation')) kind = 'presentation';
    else if (path.startsWith('/forms')) kind = 'form';
    else kind = 'file';
  } else if (host === 'drive.google.com') {
    needsSharing = true;
    kind = path.includes('/folders') ? 'folder' : 'file';
  } else if (
    host.endsWith('sharepoint.com') ||
    host.endsWith('onedrive.live.com') ||
    host.endsWith('dropbox.com') ||
    host.endsWith('box.com') ||
    host.endsWith('1drv.ms')
  ) {
    needsSharing = true;
    kind = 'file';
  } else if (/\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|png|jpe?g|webp|svg)$/i.test(path)) {
    kind = 'file';
  }

  return {
    url,
    filename: cleanName(name) || deriveName(parsed, kind),
    kind,
    typeLabel: KIND_LABEL[kind],
    mime: 'link/' + kind,
    ownerNote: needsSharing ? SHARING_NOTE : PLAIN_NOTE,
    needsSharing,
  };
}

export function isLinkRejection(v: LinkAttachment | LinkRejection): v is LinkRejection {
  return (v as LinkRejection).ok === false;
}

function cleanName(name?: string): string {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  return n ? n.slice(0, 160) : '';
}

/**
 * A name from the URL alone. Document hosts carry an opaque id and no title, so those get the type
 * plus a short id — "Document (1BxiMV…)" — which is honest about what we know. A file URL ending in
 * a real filename keeps that filename.
 */
function deriveName(u: URL, kind: LinkKind): string {
  const segs = u.pathname.split('/').filter(Boolean);
  const last = decodeURIComponent(segs[segs.length - 1] || '');

  if (last && /\.[a-z0-9]{2,5}$/i.test(last) && last.length <= 120) return last;

  // Drive-style ids: /d/<id>/edit, /file/d/<id>/view, /folders/<id>
  const idIdx = segs.findIndex((s) => s === 'd' || s === 'folders');
  const id = idIdx >= 0 ? segs[idIdx + 1] : '';
  if (id && id.length > 8) return KIND_LABEL[kind] + ' (' + id.slice(0, 8) + '…)';

  const label = KIND_LABEL[kind];
  const hostBit = u.hostname.replace(/^www\./, '');
  return kind === 'link' ? hostBit + (segs.length ? '/' + segs[0] : '') : label;
}

/**
 * Normalise a whole list from a request body. Invalid entries are returned separately rather than
 * dropped, so the endpoint can tell the sender WHICH link it refused instead of quietly sending a
 * message with one fewer attachment than they wrote.
 */
export function describeLinkList(
  input: any,
): { attachments: LinkAttachment[]; rejected: { url: string; reason: string }[] } {
  const attachments: LinkAttachment[] = [];
  const rejected: { url: string; reason: string }[] = [];
  if (!Array.isArray(input)) return { attachments, rejected };
  for (const a of input.slice(0, 25)) {
    const url = a && typeof a === 'object' ? a.url : a;
    if (!url) continue;
    const d = describeLink(String(url), a && typeof a === 'object' ? a.filename : undefined);
    if (isLinkRejection(d)) rejected.push({ url: String(url).slice(0, 200), reason: d.reason });
    else attachments.push(d);
  }
  return { attachments, rejected };
}

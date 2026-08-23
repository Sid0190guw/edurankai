// src/lib/mailsec/island.test.ts — a JSON island must never contain a character that can open or
// close a tag, and must still round-trip the author's exact bytes.
import { describe, it, expect } from 'vitest';
import { jsonIsland, escapeJsonForHtml } from './island';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** What the browser would do with the island: read the text node, parse it. */
function readBack(island: string): any {
  return JSON.parse(island);
}

describe('jsonIsland — nothing that can end a tag survives', () => {
  const BREAKOUTS = [
    ['lowercase close', '</script>'],
    ['uppercase close', '</SCRIPT>'],
    ['mixed case close', '</ScRiPt>'],
    ['spaced close', '</script >'],
    ['newline close', '</script\n>'],
    ['tab close', '</script\t>'],
    ['attributed close', '</script foo="bar">'],
    ['open then close', '<script>alert(1)</script>'],
    ['comment close', '--></script><script>alert(1)</script>'],
    ['json string close', '"}</script><script>alert(1)</script>'],
    ['img handler', '<img src=x onerror=alert(1)>'],
    ['unterminated tag', '<img src=x onerror=alert(1)'],
  ] as const;

  for (const [name, payload] of BREAKOUTS) {
    it('escapes: ' + name, () => {
      const island = jsonIsland({ value: payload });
      expect(island, name).not.toContain('<');
      expect(island, name).not.toContain('>');
      expect(readBack(island).value, name).toBe(payload);
    });
  }

  it('escapes a breakout hidden in a KEY as well as in a value', () => {
    const island = jsonIsland({ '</SCRIPT>': 1 });
    expect(island).not.toContain('<');
    expect(Object.keys(readBack(island))[0]).toBe('</SCRIPT>');
  });

  it('escapes a breakout nested deep inside an array of objects', () => {
    const rows = [{ subject: 'Re: offer </SCRIPT><script>alert(1)</script>', snippet: 'hello' }];
    const island = jsonIsland({ rows });
    expect(island).not.toContain('<');
    expect(readBack(island).rows[0].subject).toBe(rows[0].subject);
  });
});

describe('jsonIsland — the value comes back exactly', () => {
  it('round-trips unicode, quotes, backslashes and newlines', () => {
    const value = {
      name: 'प्रिया "Priya" O\'Brien',
      path: 'C:\\Users\\mail',
      body: 'line one\nline two\ttabbed',
      emoji_free: 'no emojis in this codebase',
      n: 42,
      t: true,
      nil: null,
    };
    expect(readBack(jsonIsland(value))).toEqual(value);
  });

  it('escapes the JavaScript line terminators that are legal inside JSON', () => {
    const value = { a: 'before' + LS + 'after', b: 'before' + PS + 'after' };
    const island = jsonIsland(value);
    expect(island).not.toContain(LS);
    expect(island).not.toContain(PS);
    expect(readBack(island)).toEqual(value);
  });

  it('escapes ampersands without double-escaping the ones it introduces', () => {
    const island = jsonIsland({ a: 'Terms & <conditions>' });
    expect(island).not.toContain('&');
    expect(island).not.toContain('<');
    expect(readBack(island).a).toBe('Terms & <conditions>');
  });
});

describe('jsonIsland — it degrades rather than throwing during a render', () => {
  it('answers null for a circular structure', () => {
    const a: any = {}; a.self = a;
    expect(jsonIsland(a)).toBe('null');
  });

  it('answers null for undefined, which JSON.stringify does not serialise', () => {
    expect(jsonIsland(undefined)).toBe('null');
  });

  it('serialises an empty object and an empty array normally', () => {
    expect(jsonIsland({})).toBe('{}');
    expect(jsonIsland([])).toBe('[]');
  });
});

describe('escapeJsonForHtml', () => {
  it('is the pure half, usable on a string somebody already stringified', () => {
    expect(escapeJsonForHtml('{"a":"<b>"}')).toBe('{"a":"\\u003cb\\u003e"}');
  });

  it('is idempotent, which matters because a caller cannot always tell whether it already ran', () => {
    // The escapes it emits are backslash-u sequences containing no `&`, `<` or `>`, so a second
    // pass has nothing left to find. Worth asserting rather than assuming: an escaper that
    // double-escapes turns a correct page into a page full of visible < the first time
    // somebody wraps a helper around it.
    const once = escapeJsonForHtml(JSON.stringify({ a: '<x> & <y>' }));
    expect(escapeJsonForHtml(once)).toBe(once);
    expect(JSON.parse(once).a).toBe('<x> & <y>');
  });
});

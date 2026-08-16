// src/lib/mail-product/blocks.test.ts — the email renderer, asserted on the actual bytes.
//
// These are the assertions that matter for email specifically: that the output is table-based (so it
// survives Outlook), that hostile input cannot reach the recipient's client, and that a malformed
// document degrades instead of throwing. Everything here is pure — no database, no network.
import { describe, it, expect } from 'vitest';
import {
  renderDocument, coerceDocument, emptyDocument, documentVariables,
  sanitizeHtml, safeHref, safeSrc, blockId,
  type EmailDocument,
} from './blocks';

function doc(blocks: any[], settings: any = {}): EmailDocument {
  return { version: 1, settings, blocks } as EmailDocument;
}

describe('safeHref', () => {
  it('keeps http, https, mailto and tel', () => {
    expect(safeHref('https://edurankai.in')).toBe('https://edurankai.in');
    expect(safeHref('http://example.com/a?b=c')).toBe('http://example.com/a?b=c');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeHref('tel:+911234567890')).toBe('tel:+911234567890');
  });

  it('upgrades a bare domain, because that is what authors type', () => {
    expect(safeHref('edurankai.in/programmes')).toBe('https://edurankai.in/programmes');
  });

  // The whole reason this function exists: a stored link is a stored payload, rendered later in
  // somebody else's mail client.
  it('refuses javascript:, data: and vbscript:, visibly rather than quietly', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('JaVaScRiPt:alert(1)')).toBe('#');
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(safeHref('vbscript:msgbox')).toBe('#');
    expect(safeHref('')).toBe('#');
  });
});

describe('safeSrc', () => {
  it('allows only http and https', () => {
    expect(safeSrc('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(safeSrc('data:image/png;base64,AAAA')).toBe('');
    expect(safeSrc('javascript:alert(1)')).toBe('');
    expect(safeSrc('/relative.png')).toBe('');
  });
});

describe('sanitizeHtml', () => {
  it('keeps ordinary formatting', () => {
    const out = sanitizeHtml('<p>Hello <strong>there</strong> and <em>you</em></p>');
    expect(out).toContain('<strong>');
    expect(out).toContain('<em>');
    expect(out).toContain('Hello');
  });

  it('removes a script element AND its body', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    // The body must go with the tag: leaving "alert(1)" as visible text is worse than useless.
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('ok');
  });

  it('drops every on* handler, by construction rather than by list', () => {
    const out = sanitizeHtml('<div onclick="steal()" onmouseover="x()" onerror="y()">hi</div>');
    expect(out).not.toMatch(/on\w+=/i);
    expect(out).toContain('hi');
  });

  it('neutralises a javascript: href but keeps the link text', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click');
  });

  it('refuses an iframe outright', () => {
    const out = sanitizeHtml('<iframe src="https://evil.example"></iframe><p>after</p>');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('after');
  });

  it('strips a style attribute carrying expression() or a javascript url', () => {
    const out = sanitizeHtml('<div style="width:expression(alert(1))">a</div>');
    expect(out).not.toContain('expression(');
  });

  it('adds target and rel to a link so it cannot reach back through window.opener', () => {
    const out = sanitizeHtml('<a href="https://example.com">go</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('noopener');
  });
});

describe('renderDocument', () => {
  it('emits table-based HTML, because Outlook renders through Word', () => {
    const out = renderDocument(emptyDocument());
    expect(out.html).toContain('<table');
    expect(out.html).toContain('role="presentation"');
    // No layout property Word does not implement.
    expect(out.html).not.toMatch(/display\s*:\s*flex/);
    expect(out.html).not.toMatch(/display\s*:\s*grid/);
  });

  it('produces a plain-text fallback with the words in it', () => {
    const out = renderDocument(doc([
      { id: 'a', kind: 'heading', content: 'Programme update', height: 1 },
      { id: 'b', kind: 'text', content: '<p>The deadline has moved.</p>' },
    ]));
    expect(out.text).toContain('Programme update');
    expect(out.text).toContain('The deadline has moved.');
    expect(out.text).not.toContain('<');
  });

  it('renders a button as a nested table, not a padded anchor', () => {
    const out = renderDocument(doc([{ id: 'b', kind: 'button', label: 'Apply', href: 'https://x.com' }]));
    // Outlook drops padding on inline elements; a styled <a> alone renders as bare blue text.
    expect(out.html).toContain('<table');
    expect(out.html).toContain('Apply');
    expect(out.html).toContain('https://x.com');
  });

  it('gives an image an explicit width and keeps its alt text', () => {
    const out = renderDocument(doc([
      { id: 'i', kind: 'image', src: 'https://cdn.example.com/a.png', alt: 'A lecture hall', width: 480 },
    ]));
    expect(out.html).toContain('width="480"');
    expect(out.html).toContain('alt="A lecture hall"');
  });

  it('says so when an image block has no source, instead of emitting a broken img', () => {
    const out = renderDocument(doc([{ id: 'i', kind: 'image', src: '' }]));
    expect(out.html).toContain('No image set');
    expect(out.html).not.toContain('<img');
  });

  it('appends an unsubscribe link to a footer that has none', () => {
    const out = renderDocument(doc([{ id: 'f', kind: 'footer', content: 'EduRankAI' }]));
    expect(out.html).toContain('{{unsubscribe_url}}');
  });

  it('does not append a second unsubscribe when the author placed one', () => {
    const out = renderDocument(doc([
      { id: 'f', kind: 'footer', content: 'Bye. <a href="{{unsubscribe_url}}">Opt out</a>' },
    ]));
    expect(out.html.match(/\{\{unsubscribe_url\}\}/g)!.length).toBe(1);
  });

  it('hides the preheader from the body while leaving it for the inbox preview', () => {
    const out = renderDocument(doc([{ id: 't', kind: 'text', content: 'Body' }], { preheader: 'A short summary' }));
    expect(out.html).toContain('A short summary');
    expect(out.html).toContain('display:none');
  });

  it('falls back on a colour it does not recognise rather than passing it through', () => {
    const out = renderDocument(doc([
      { id: 't', kind: 'text', content: 'x', style: { color: 'expression(alert(1))' } },
    ]));
    expect(out.html).not.toContain('expression(');
  });

  it('clamps a font size that arrived as nonsense', () => {
    const out = renderDocument(doc([
      { id: 't', kind: 'text', content: 'x', style: { fontSize: 9999 } },
    ]));
    expect(out.html).toContain('font-size:96px');
  });

  it('renders columns with an mso conditional so Outlook lays them out too', () => {
    const out = renderDocument(doc([{
      id: 'c', kind: 'columns',
      columns: [[{ id: 'a', kind: 'text', content: 'L' }], [{ id: 'b', kind: 'text', content: 'R' }]],
    }]));
    expect(out.html).toContain('[if mso]');
    expect(out.html).toContain('L');
    expect(out.html).toContain('R');
  });

  it('skips an unknown block kind instead of throwing — a newer document must still open', () => {
    const out = renderDocument(doc([
      { id: 'x', kind: 'carousel-3d' } as any,
      { id: 't', kind: 'text', content: 'still here' },
    ]));
    expect(out.html).toContain('still here');
  });

  it('inline mode omits the document wrapper, which is what the canvas shows', () => {
    const out = renderDocument(emptyDocument(), { inline: true });
    expect(out.html).not.toContain('<!DOCTYPE');
    expect(out.html).not.toContain('<body');
    expect(out.html).toContain('<table');
  });

  it('renders an empty document without throwing', () => {
    expect(() => renderDocument(doc([]))).not.toThrow();
    expect(() => renderDocument(null)).not.toThrow();
    expect(() => renderDocument(undefined)).not.toThrow();
  });
});

describe('coerceDocument', () => {
  it('turns junk into an empty document rather than throwing', () => {
    expect(coerceDocument(null).blocks).toEqual([]);
    expect(coerceDocument('nonsense').blocks).toEqual([]);
    expect(coerceDocument(42).blocks).toEqual([]);
    expect(coerceDocument({ blocks: 'not an array' }).blocks).toEqual([]);
  });

  it('drops entries that are not blocks and keeps the ones that are', () => {
    const d = coerceDocument({ blocks: [null, { kind: 'text', id: 'a' }, 'x', { id: 'b' }] });
    expect(d.blocks.length).toBe(1);
    expect(d.blocks[0].kind).toBe('text');
  });

  it('caps a runaway document', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ id: 'b' + i, kind: 'text', content: 'x' }));
    expect(coerceDocument({ blocks: many }).blocks.length).toBe(400);
  });
});

describe('documentVariables', () => {
  it('finds tokens across content, labels, hrefs and nested columns', () => {
    const vars = documentVariables(doc([
      { id: 'a', kind: 'text', content: 'Hi {{first_name}}' },
      { id: 'b', kind: 'button', label: 'Open {{role}}', href: 'https://x.com/{{application_id}}' },
      { id: 'c', kind: 'columns', columns: [[{ id: 'd', kind: 'text', content: '{{stage}}' }]] },
    ]));
    expect(vars.sort()).toEqual(['application_id', 'first_name', 'role', 'stage']);
  });

  it('does not mistake CSS braces in a style block for a variable', () => {
    const vars = documentVariables(doc([{ id: 'a', kind: 'html', content: '<div>{ color: red }</div>' }]));
    expect(vars).toEqual([]);
  });
});

describe('blockId', () => {
  it('does not collide across a rapid burst', () => {
    const ids = new Set(Array.from({ length: 500 }, () => blockId()));
    expect(ids.size).toBe(500);
  });
});

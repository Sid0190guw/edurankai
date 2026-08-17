// src/lib/mailsec/link-attachments.test.ts — the links go INTO the message; the server never
// fetches them.
import { describe, it, expect } from 'vitest';
import { appendLinkAttachments } from './link-attachments';

describe('appendLinkAttachments', () => {
  it('leaves a message with no attachments byte-identical', () => {
    const r = appendLinkAttachments('<p>hi</p>', 'hi', []);
    expect(r.html).toBe('<p>hi</p>');
    expect(r.text).toBe('hi');
    expect(r.rejected).toEqual([]);
  });

  it('treats null and undefined as no attachments', () => {
    expect(appendLinkAttachments('<p>hi</p>', 'hi', null).html).toBe('<p>hi</p>');
    expect(appendLinkAttachments('<p>hi</p>', 'hi', undefined).html).toBe('<p>hi</p>');
  });

  it('renders a link the recipient can click, in both parts', () => {
    const r = appendLinkAttachments('<p>hi</p>', 'hi', [{ filename: 'July report.pdf', url: 'https://drive.example/d/1' }]);
    expect(r.html).toContain('href="https://drive.example/d/1"');
    expect(r.html).toContain('July report.pdf');
    expect(r.text).toContain('- July report.pdf: https://drive.example/d/1');
  });

  it('derives a name from the URL when the sender gave none', () => {
    const r = appendLinkAttachments('', '', [{ url: 'https://files.example/reports/q3-summary.pdf' }]);
    expect(r.html).toContain('q3-summary.pdf');
  });

  it('falls back to the host when the URL has no useful last segment', () => {
    const r = appendLinkAttachments('', '', [{ url: 'https://www.docs.example/' }]);
    expect(r.html).toContain('docs.example');
  });

  it('REFUSES the schemes that are an upload wearing a link’s clothes, and says which', () => {
    const bad = [
      { url: 'file:///etc/passwd' },
      { url: 'data:text/html,<script>alert(1)</script>' },
      { url: 'blob:https://example.com/abc' },
      { url: 'javascript:alert(1)' },
      { url: 'not a url at all' },
      { url: '' },
    ];
    const r = appendLinkAttachments('<p>hi</p>', 'hi', bad);
    expect(r.rejected).toHaveLength(bad.length);
    expect(r.html).toBe('<p>hi</p>');
    for (const x of r.rejected) expect(x.reason).toMatch(/http and https/i);
  });

  it('keeps the good links and refuses the bad ones in the same message', () => {
    const r = appendLinkAttachments('', '', [
      { url: 'https://ok.example/a.pdf' },
      { url: 'file:///etc/passwd' },
    ]);
    expect(r.html).toContain('https://ok.example/a.pdf');
    expect(r.html).not.toContain('etc/passwd');
    expect(r.rejected).toHaveLength(1);
  });

  it('escapes a filename that is trying to be markup', () => {
    const r = appendLinkAttachments('', '', [
      { filename: '</a><img src=x onerror=alert(1)>', url: 'https://ok.example/a.pdf' },
    ]);
    // It must not become an ELEMENT. It is allowed to remain visible text — a recipient seeing a
    // sender's silly filename spelled out is the correct outcome, and asserting on the escaped text
    // would be asserting against the fix rather than for it.
    expect(r.html).not.toMatch(/<img[^>]*onerror/i);
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a URL that is trying to break out of the href', () => {
    const r = appendLinkAttachments('', '', [
      { filename: 'x', url: 'https://ok.example/"><img src=x onerror=alert(1)>' },
    ]);
    expect(r.html).not.toMatch(/<img[^>]*onerror/i);
  });

  it('caps the number of links so one request cannot produce an unbounded body', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ url: 'https://ok.example/' + i + '.pdf' }));
    const r = appendLinkAttachments('', '', many);
    const count = (r.html.match(/<li/g) || []).length;
    expect(count).toBe(25);
  });
});

// The invitation note used to be escaped on its way into the email (invite.ts:35 esc()), so an
// administrator who wrote or pasted formatted text got literal angle brackets delivered to somebody's
// inbox. It now goes through the same sanitiser as every other outgoing body.
//
// These tests pin the SHARED behaviour rather than the route: invite.ts and src/pages/invite/[token]
// .astro both call these two functions, and what matters is that formatting survives and script does
// not, on both surfaces.
import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtmlString, htmlToPlainText, OUTBOUND, ORIGIN } from '@/lib/mailsec/html';
import { parseInvite, NOTE_MAX } from '@/lib/hiring/invitations';

describe('a note written in the composer', () => {
  const NOTE = '<p>We would <strong>love</strong> you to apply.</p><ul><li>Remote</li><li>Part time</li></ul>';

  it('keeps its formatting in the email instead of showing tags', () => {
    const out = sanitizeEmailHtmlString(NOTE, OUTBOUND);
    expect(out).toContain('<strong>');
    expect(out).toContain('<li>');
    expect(out).not.toContain('&lt;strong&gt;');
  });

  it('keeps its formatting on the landing page too', () => {
    const out = sanitizeEmailHtmlString(NOTE, ORIGIN);
    expect(out).toContain('<li>');
  });

  it('flattens to readable prose for the text/plain part', () => {
    const text = htmlToPlainText(NOTE);
    expect(text).toContain('love');
    expect(text).toContain('Remote');
    expect(text).not.toContain('<li>');
    expect(text).not.toContain('&lt;');
  });
});

describe('a hostile note', () => {
  it('loses its script on both profiles', () => {
    const bad = '<p>Hi</p><script>fetch("//x")</script>';
    expect(sanitizeEmailHtmlString(bad, OUTBOUND)).not.toContain('<script');
    expect(sanitizeEmailHtmlString(bad, ORIGIN)).not.toContain('<script');
  });

  it('loses an event handler that would otherwise run on our own landing page', () => {
    const bad = '<p onmouseover="alert(1)">Hover me</p>';
    const out = sanitizeEmailHtmlString(bad, ORIGIN);
    expect(out).not.toContain('onmouseover');
    expect(out).toContain('Hover me');
  });

  it('loses a javascript: link', () => {
    const out = sanitizeEmailHtmlString('<a href="javascript:alert(1)">click</a>', ORIGIN);
    expect(out).not.toContain('javascript:');
  });

  it('loses an iframe', () => {
    expect(sanitizeEmailHtmlString('<iframe src="//evil"></iframe>', ORIGIN)).not.toContain('<iframe');
  });
});

describe('an OLD note, written as prose before the composer existed', () => {
  // Every stored row predates this change, so the sanitiser has to be safe to apply to plain text.
  it('passes through unchanged', () => {
    const plain = 'We would like you to apply.';
    expect(sanitizeEmailHtmlString(plain, ORIGIN)).toContain('We would like you to apply.');
  });

  it('does not turn a literal angle bracket into markup', () => {
    const out = sanitizeEmailHtmlString('Ask for the <boss> before Friday', ORIGIN);
    expect(out).not.toContain('<boss>');
  });
});

describe('the note cap', () => {
  it('is generous enough for markup but is still a cap', () => {
    expect(NOTE_MAX).toBeGreaterThan(1000);
    const out = parseInvite({ email: 'a@b.co', note: 'x'.repeat(NOTE_MAX * 2) }) as { value: { note: string } };
    expect(out.value.note).toHaveLength(NOTE_MAX);
  });
});

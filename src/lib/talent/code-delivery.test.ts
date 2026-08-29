import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked at the module boundary, because the point of every test here is what happens when the
// transport or the register misbehaves — states that cannot be produced by a real send.
const sendEmail = vi.fn();
const markCodeDelivered = vi.fn();
const markCodeDeliveryFailed = vi.fn();

vi.mock('@/lib/email', () => ({
  sendEmail: (...a: any[]) => sendEmail(...a),
  // composeCodeEmail calls brandedEmail; the real wrapper is irrelevant here and pulls mail config.
  brandedEmail: (o: any) => '<html><body>' + o.body + '</body></html>',
}));
vi.mock('@/lib/talent/codes', () => ({
  markCodeDelivered: (...a: any[]) => markCodeDelivered(...a),
  markCodeDeliveryFailed: (...a: any[]) => markCodeDeliveryFailed(...a),
}));

const { sendCodeByEmail } = await import('./code-delivery');

const CTX = {
  personName: 'Ananya Kumar',
  boundEmail: 'ananya@example.org',
  opportunityTitle: 'Research Engineer',
  validUntil: '2026-09-12',
  origin: 'https://www.edurankai.in',
  code: 'ERA-SEL-AMM7R-NFE69-ZMD2C',
};
const BODY = '<p>Dear {{name}},</p><p>{{code}}</p>';

beforeEach(() => {
  sendEmail.mockReset();
  markCodeDelivered.mockReset();
  markCodeDeliveryFailed.mockReset();
  sendEmail.mockResolvedValue({ ok: true, id: 'm1' });
  markCodeDelivered.mockResolvedValue({ ok: true, changed: true });
  markCodeDeliveryFailed.mockResolvedValue({ ok: true });
});

describe('the happy path', () => {
  it('sends to the BOUND address and records the send as email', async () => {
    const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    expect(r.sent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('ananya@example.org');
    expect(markCodeDelivered).toHaveBeenCalledWith('c1', 'email');
    expect(markCodeDeliveryFailed).not.toHaveBeenCalled();
    expect(r.message).toContain('ananya@example.org');
  });

  it('puts the substituted code into both parts of the message', async () => {
    await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    const sent = sendEmail.mock.calls[0][0];
    expect(sent.html).toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
    expect(sent.text).toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
    expect(sent.html).not.toContain('{{code}}');
  });
});

describe('a refused send', () => {
  // sendEmail RETURNS {ok:false} for an SMTP refusal rather than throwing (src/lib/email.ts:32).
  it('records the failure, does not mark it delivered, and says the code is still usable', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'Mailbox unavailable' });
    const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    expect(r.sent).toBe(false);
    expect(markCodeDelivered).not.toHaveBeenCalled();
    expect(markCodeDeliveryFailed).toHaveBeenCalledWith('c1', 'Mailbox unavailable');
    expect(r.message).toContain('Mailbox unavailable');
    expect(r.message).toContain('send it by hand');
  });

  it('treats a THROWN transport the same way rather than propagating it', async () => {
    sendEmail.mockRejectedValue(Object.assign(new Error('SQL'), { cause: { message: 'ECONNREFUSED' } }));
    const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    expect(r.sent).toBe(false);
    // The real reason lives on e.cause on this project; e.message is the useless half.
    expect(r.message).toContain('ECONNREFUSED');
    expect(markCodeDeliveryFailed).toHaveBeenCalled();
  });

  // The caller has just minted a credential and is the only screen showing it. An exception here
  // would lose that screen, so nothing in this module may throw.
  it('does not throw even when recording the failure ALSO fails', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'nope' });
    markCodeDeliveryFailed.mockRejectedValue(new Error('db down'));
    const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    expect(r.sent).toBe(false);
    expect(r.message).toContain('nope');
  });
});

describe('the register disagreeing with reality', () => {
  it('says so plainly when the mail went out but the register would not update', async () => {
    markCodeDelivered.mockResolvedValue({ ok: false, changed: false, error: 'not active' });
    const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    expect(r.sent).toBe(true);
    expect(r.registerStale).toBe(true);
    expect(r.message).toContain('register could not be updated');
  });

  it('reports a thrown register write as stale rather than as a failed send', async () => {
    markCodeDelivered.mockRejectedValue(new Error('db down'));
    const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    expect(r.sent).toBe(true);
    expect(r.registerStale).toBe(true);
  });
});

describe('refusing to send at all', () => {
  it('sends nothing when the selection carries no address', async () => {
    const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: { ...CTX, boundEmail: '' } });
    expect(r.sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(markCodeDeliveryFailed).not.toHaveBeenCalled();
  });
});

describe('what must never leak', () => {
  // The plaintext belongs in the message body and nowhere else. Everything this module hands back
  // goes on a screen and into an audit diff.
  it('never names the code in the operator-facing message, on any path', async () => {
    const paths = [
      () => sendEmail.mockResolvedValue({ ok: true, id: 'm1' }),
      () => sendEmail.mockResolvedValue({ ok: false, error: 'Mailbox unavailable' }),
      () => sendEmail.mockRejectedValue(new Error('boom')),
      () => markCodeDelivered.mockResolvedValue({ ok: false, changed: false }),
    ];
    for (const setup of paths) {
      sendEmail.mockResolvedValue({ ok: true, id: 'm1' });
      markCodeDelivered.mockResolvedValue({ ok: true, changed: true });
      setup();
      const r = await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
      expect(r.message).not.toContain('ERA-SEL-AMM7R-NFE69-ZMD2C');
      expect(r.message).not.toContain('AMM7R');
      expect(JSON.stringify(r.removed)).not.toContain('AMM7R');
    }
  });

  it('never writes the code into delivery_error', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'Mailbox unavailable' });
    await sendCodeByEmail({ codeRowId: 'c1', bodyHtml: BODY, context: CTX });
    const reason = String(markCodeDeliveryFailed.mock.calls[0][1]);
    expect(reason).not.toContain('AMM7R');
  });
});

describe('hostile operator markup', () => {
  it('strips it before the transport sees it and reports what went', async () => {
    const r = await sendCodeByEmail({
      codeRowId: 'c1',
      bodyHtml: '<p>{{code}}</p><script>fetch("//x")</script>',
      context: CTX,
    });
    expect(r.sent).toBe(true);
    expect(sendEmail.mock.calls[0][0].html).not.toContain('<script');
    expect(r.removed.length).toBeGreaterThan(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createTransport: vi.fn(),
  assertSafeMailTarget: vi.fn(),
  getMailConfig: vi.fn(),
  logOutbound: vi.fn(),
}));

vi.mock('nodemailer', () => ({ default: { createTransport: state.createTransport } }));
vi.mock('@/lib/mailsec/net', () => ({ assertSafeMailTarget: state.assertSafeMailTarget }));
vi.mock('@/lib/mail', () => ({ getMailConfig: state.getMailConfig, logOutbound: state.logOutbound }));

import { verifySmtp } from './mail-transport';

beforeEach(() => {
  state.createTransport.mockReset();
  state.assertSafeMailTarget.mockReset().mockResolvedValue({ allowed: true });
  state.getMailConfig.mockReset();
  state.logOutbound.mockReset();
});

describe('no-save SMTP verification', () => {
  it.each([
    { port: 465, inputSecure: false, expectedSecure: true },
    { port: 587, inputSecure: true, expectedSecure: false },
  ])('uses port-appropriate TLS for $port and verifies without sending a message', async ({ port, inputSecure, expectedSecure }) => {
    const transport = { verify: vi.fn().mockResolvedValue(undefined), sendMail: vi.fn() };
    state.createTransport.mockReturnValue(transport);

    const result = await verifySmtp({
      host: 'smtp.example.test',
      port,
      user: 'mailbox@example.test',
      pass: 'synthetic-test-password',
      secure: inputSecure,
    });

    expect(result).toEqual({ ok: true, detail: 'SMTP connection and authentication succeeded.' });
    expect(state.assertSafeMailTarget).toHaveBeenCalledWith('smtp.example.test', port);
    expect(state.createTransport).toHaveBeenCalledTimes(1);
    const options = state.createTransport.mock.calls[0][0];
    expect(options).toMatchObject({
      host: 'smtp.example.test',
      port,
      secure: expectedSecure,
      auth: { user: 'mailbox@example.test', pass: 'synthetic-test-password' },
    });
    expect(options).not.toHaveProperty('authMethod');
    expect(transport.verify).toHaveBeenCalledTimes(1);
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('synthetic-test-password');
  });

  it('redacts provider authentication errors and never returns the supplied password', async () => {
    const secret = 'synthetic-secret-in-error';
    state.createTransport.mockReturnValue({
      verify: vi.fn().mockRejectedValue(Object.assign(new Error(`Invalid login ${secret}`), { code: 'EAUTH' })),
      sendMail: vi.fn(),
    });

    const result = await verifySmtp({
      host: 'smtp.example.test', port: 465, user: 'mailbox@example.test', pass: secret, secure: true,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({ code: 'SMTP_AUTH_REJECTED', stage: 'verification' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

import { describe, expect, it } from 'vitest';
import { diagnoseImapFailure, diagnoseSmtpFailure } from './mail-connection-diagnostics';

describe('redacted mail connection diagnostics', () => {
  it('preserves safe IMAP status, response code, and command while discarding command arguments', () => {
    const raw = new Error('Command failed') as Error & Record<string, any>;
    raw.responseStatus = 'NO';
    raw.executedCommand = 'A001 LOGIN private-user private-password';
    raw.response = { attributes: [{ section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }] }] };
    raw.responseText = 'server text that must not escape private-password';

    const diagnostic = diagnoseImapFailure(raw, 'connection');

    expect(diagnostic).toMatchObject({
      code: 'IMAP_AUTH_REJECTED',
      stage: 'authentication',
      command: 'LOGIN',
      protocolStatus: 'NO',
      protocolCode: 'AUTHENTICATIONFAILED',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private-user');
    expect(JSON.stringify(diagnostic)).not.toContain('private-password');
    expect(JSON.stringify(diagnostic)).not.toContain('server text');
  });

  it('classifies mailbox selection rejection without returning a mailbox name', () => {
    const raw = Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      executedCommand: 'A002 SELECT private-mailbox',
    });

    const diagnostic = diagnoseImapFailure(raw, 'mailbox_selection');

    expect(diagnostic).toMatchObject({
      code: 'IMAP_MAILBOX_REJECTED',
      stage: 'mailbox_selection',
      command: 'SELECT',
      protocolStatus: 'NO',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private-mailbox');
  });

  it('classifies other protocol command rejections with a safe command name', () => {
    const diagnostic = diagnoseImapFailure(Object.assign(new Error('Command failed'), {
      responseStatus: 'BAD',
      executedCommand: 'A003 UID FETCH 123 BODY[]',
      responseText: 'untrusted server response',
    }), 'message_fetch');

    expect(diagnostic).toMatchObject({
      code: 'IMAP_COMMAND_REJECTED',
      stage: 'message_fetch',
      command: 'UID FETCH',
      protocolStatus: 'BAD',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('123');
    expect(JSON.stringify(diagnostic)).not.toContain('untrusted server response');
  });

  it('does not expose unrecognized server response codes or text', () => {
    const diagnostic = diagnoseImapFailure(Object.assign(new Error('response has private material'), {
      responseStatus: 'NO',
      executedCommand: 'A004 LIST "" "*"',
      response: { attributes: [{ section: [{ type: 'ATOM', value: 'PRIVATE-MATERIAL' }] }] },
      responseText: 'private-material secret-value',
    }), 'mailbox_listing');

    expect(diagnostic).toMatchObject({ code: 'IMAP_COMMAND_REJECTED', command: 'LIST', protocolStatus: 'NO' });
    expect(diagnostic).not.toHaveProperty('protocolCode');
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE-MATERIAL');
    expect(JSON.stringify(diagnostic)).not.toContain('secret-value');
  });

  it('distinguishes TLS, DNS, timeout, and transport connection failures', () => {
    expect(diagnoseImapFailure(Object.assign(new Error('TLS failure'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).code).toBe('IMAP_TLS_FAILURE');
    expect(diagnoseImapFailure(Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' })).code).toBe('IMAP_DNS_FAILURE');
    expect(diagnoseImapFailure(Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' })).code).toBe('IMAP_CONNECTION_TIMEOUT');
    expect(diagnoseImapFailure(Object.assign(new Error('socket refused'), { code: 'ECONNREFUSED' })).code).toBe('IMAP_CONNECTION_FAILURE');
  });

  it('does not label message persistence errors as mail-server connection failures', () => {
    const diagnostic = diagnoseImapFailure(Object.assign(new Error('database authentication failed'), { code: 'EAUTH' }), 'message_delivery');
    expect(diagnostic).toMatchObject({ code: 'IMAP_MESSAGE_PERSISTENCE_FAILED', stage: 'message_delivery' });
  });

  it('returns only a stable SMTP failure category, never the provider response text', () => {
    const diagnostic = diagnoseSmtpFailure(Object.assign(new Error('535 private-user private-password'), { code: 'EAUTH' }));
    expect(diagnostic).toEqual({
      code: 'SMTP_AUTH_REJECTED',
      stage: 'verification',
      detail: 'The SMTP server rejected authentication.',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private-user');
    expect(JSON.stringify(diagnostic)).not.toContain('private-password');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({ poll: vi.fn() }));

vi.mock('@/lib/mail-imap', () => ({ pollImapInbox: (...args: any[]) => state.poll(...args) }));
vi.mock('@/lib/auth/permissions', () => ({ can: () => false }));

import { GET, POST } from './imap-poll';

const previousCronSecret = process.env.CRON_SECRET;

function context(method: 'GET' | 'POST' = 'GET') {
  return {
    request: new Request('https://example.test/api/mail/imap-poll', {
      method,
      headers: { authorization: 'Bearer test-cron-secret' },
    }),
    locals: { user: null },
  } as any;
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-cron-secret';
  state.poll.mockReset();
});

afterEach(() => {
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
});

describe('/api/mail/imap-poll', () => {
  it('returns a failing HTTP status and safe diagnostics when the poll fails', async () => {
    state.poll.mockResolvedValue({
      ok: false,
      fetched: 0,
      delivered: 0,
      error: 'The IMAP server rejected authentication.',
      diagnostic: { code: 'IMAP_AUTH_REJECTED', stage: 'authentication', command: 'LOGIN', protocolStatus: 'NO' },
    });

    const response = await GET(context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      diagnostic: { code: 'IMAP_AUTH_REJECTED', stage: 'authentication', command: 'LOGIN', protocolStatus: 'NO' },
    });
  });

  it('keeps successful polls at HTTP 200', async () => {
    state.poll.mockResolvedValue({ ok: true, fetched: 2, delivered: 2 });

    const response = await POST(context('POST'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, fetched: 2, delivered: 2 });
  });

  it('redacts unexpected driver exceptions from the poll response', async () => {
    state.poll.mockRejectedValue(new Error('private-user private-password provider response'));

    const response = await GET(context());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('private-user');
    expect(body).not.toContain('private-password');
    expect(body).not.toContain('provider response');
    expect(body).toContain('IMAP_OPERATION_FAILED');
  });

  it('does not let the scheduled workflow mask failed API responses or echo response bodies', () => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/imap-poll.yml', import.meta.url), 'utf8');

    expect(workflow).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
    expect(workflow).toContain("jq -e '.ok == true'");
    expect(workflow).not.toMatch(/echo\s+['"]?BODY=/i);
  });
});

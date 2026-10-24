import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  limit: vi.fn(),
  signatureValid: true,
  blocked: false,
  noOrder: false,
  failUpdate: false,
  failMismatchUpdate: false,
  statements: [] as string[],
}));

vi.mock('@/lib/db', () => ({
  db: {
    execute: (query: any) => state.execute(query),
  },
}));

vi.mock('@/lib/public-form-limit', () => ({
  clientIp: () => '192.0.2.10',
  overPublicFormLimit: (...args: any[]) => state.limit(...args),
}));

vi.mock('@/lib/razorpay', () => ({
  verifyPaymentSignature: () => state.signatureValid,
}));

import { POST } from './confirm';

function queryText(query: any): string {
  return (query?.queryChunks || []).map((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value.join('');
    if (Array.isArray(chunk?.queryChunks)) return queryText(chunk);
    return '';
  }).join('');
}

function context(body: string | unknown): any {
  return {
    request: new Request('https://www.edurankai.in/api/forms/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10, 10.0.0.1' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    clientAddress: '192.0.2.10',
  };
}

beforeEach(() => {
  state.signatureValid = true;
  state.blocked = false;
  state.noOrder = false;
  state.failUpdate = false;
  state.failMismatchUpdate = false;
  state.statements.length = 0;
  state.execute.mockImplementation(async (query: any) => {
    const text = queryText(query);
    state.statements.push(text);
    if (/UPDATE form_responses/.test(text)) {
      if (state.signatureValid && state.failUpdate) throw new Error('database unavailable');
      if (!state.signatureValid && state.failMismatchUpdate) throw new Error('database unavailable');
      return state.noOrder ? [] : [{ order_id: 'order_test' }];
    }
    if (/SELECT f\.success_message/.test(text)) return [{ success_message: 'Payment saved.' }];
    throw new Error(`Unexpected SQL in confirm test: ${text}`);
  });
  state.limit.mockClear();
  state.limit.mockImplementation(async () => ({ blocked: state.blocked, used: 1 }));
});

describe('POST /api/forms/confirm', () => {
  const validRequest = {
    razorpay_order_id: 'order_test',
    razorpay_payment_id: 'payment_test',
    razorpay_signature: 'test-signature',
  };

  it('marks an existing response paid and returns its configured confirmation', async () => {
    const response = await POST(context(validRequest));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: 'Payment saved.' });
    expect(state.statements[0]).toContain("payment_status = 'paid'");
    expect(state.statements[0]).toContain('RETURNING order_id');
  });

  it('rejects malformed JSON and missing confirmation fields', async () => {
    const malformed = await POST(context('{'));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe('invalid JSON');

    const missing = await POST(context({ razorpay_order_id: 'order_test' }));
    expect(missing.status).toBe(400);
    expect(state.statements).toHaveLength(0);
  });

  it('records an invalid signature and refuses confirmation', async () => {
    state.signatureValid = false;
    const response = await POST(context(validRequest));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('signature mismatch');
    expect(state.statements[0]).toContain("payment_status = 'signature_mismatch'");
  });

  it('returns a service error rather than swallowing a failed mismatch write', async () => {
    state.signatureValid = false;
    state.failMismatchUpdate = true;
    const response = await POST(context(validRequest));
    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
  });

  it('does not claim success for an unknown payment order', async () => {
    state.noOrder = true;
    const response = await POST(context(validRequest));
    expect(response.status).toBe(404);
    expect((await response.json()).ok).toBe(false);
  });

  it('reports paid-state persistence failures explicitly', async () => {
    state.failUpdate = true;
    const response = await POST(context(validRequest));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('temporarily unavailable');
  });

  it('rate limits unauthenticated confirmation requests', async () => {
    state.blocked = true;
    const response = await POST(context(validRequest));
    expect(response.status).toBe(429);
    expect(state.statements).toHaveLength(0);
    expect(state.limit).toHaveBeenCalledWith('forms-confirm', '192.0.2.10', { whenUnavailable: 'refuse' });
  });
});

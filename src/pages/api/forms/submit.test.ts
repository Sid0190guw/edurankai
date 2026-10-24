import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  limit: vi.fn(),
  form: null as any,
  blocked: false,
  failLookup: false,
  failInsert: false,
  statements: [] as string[],
  insertQueries: [] as any[],
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
  createOrder: vi.fn(),
  getPublicKeyId: vi.fn(() => ''),
  isConfigured: vi.fn(() => false),
}));

vi.mock('@/lib/fx', () => ({
  convertToInrPaise: vi.fn(),
}));

import { POST } from './submit';

const publishedForm = {
  id: 'form-test-id',
  slug: 'test-form',
  title: 'Test form',
  fields: [
    { key: 'name', type: 'text', label: 'Name', required: true, section: 'About' },
    { key: 'email', type: 'email', label: 'Email', required: true, section: 'About' },
    { key: 'choice', type: 'radio', label: 'Choice', options: ['A', 'B'], section: 'Details' },
  ],
  fee_chf: 0,
  success_message: 'Recorded successfully.',
};

function queryText(query: any): string {
  return (query?.queryChunks || []).map((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value.join('');
    if (Array.isArray(chunk?.queryChunks)) return queryText(chunk);
    return '';
  }).join('');
}

function request(body: string | unknown): Request {
  return new Request('https://www.edurankai.in/api/forms/submit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '192.0.2.10, 10.0.0.1',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function submit(body: string | unknown): Promise<Response> {
  return POST({
    request: request(body),
    clientAddress: '192.0.2.10',
    locals: { user: null },
  } as any);
}

function execute(query: any): any[] {
  const text = queryText(query);
  state.statements.push(text);
  if (/SELECT \* FROM forms/.test(text)) {
    if (state.failLookup) throw new Error('database unavailable');
    return state.form ? [state.form] : [];
  }
  if (/FROM form_role_links/.test(text)) return [];
  if (/INSERT INTO form_responses/.test(text)) {
    if (state.failInsert) throw new Error('database unavailable');
    state.insertQueries.push(query);
    return [];
  }
  throw new Error(`Unexpected SQL in submit test: ${text}`);
}

beforeEach(() => {
  state.form = structuredClone(publishedForm);
  state.blocked = false;
  state.failLookup = false;
  state.failInsert = false;
  state.statements.length = 0;
  state.insertQueries.length = 0;
  state.limit.mockClear();
  state.execute.mockImplementation(execute);
  state.limit.mockImplementation(async () => ({ blocked: state.blocked, used: 1 }));
});

describe('POST /api/forms/submit', () => {
  it('validates and persists a successful free-form response', async () => {
    const response = await submit({ slug: 'test-form', data: { name: 'A. Respondent', email: 'a@example.org', choice: 'A', extra: 'ignored' } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, done: true, message: 'Recorded successfully.' });
    expect(state.statements.filter((statement) => /INSERT INTO form_responses/.test(statement))).toHaveLength(1);
    const insertSql = queryText(state.insertQueries[0]);
    expect(insertSql).toContain('{"name":"A. Respondent","email":"a@example.org","choice":"A"}');
    expect(insertSql).not.toContain('extra');
  });

  it('treats repeated ordinary form POSTs as separate responses rather than idempotent retries', async () => {
    const body = { slug: 'test-form', data: { name: 'A. Respondent', email: 'a@example.org' } };
    const first = await submit(body);
    const second = await submit(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(state.insertQueries).toHaveLength(2);
  });

  it('rejects a missing required answer without persisting a response', async () => {
    const response = await submit({ slug: 'test-form', data: { email: 'a@example.org' } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Name');
    expect(state.statements.some((statement) => /INSERT INTO form_responses/.test(statement))).toBe(false);
  });

  it('rejects invalid field-specific values without persisting a response', async () => {
    const response = await submit({ slug: 'test-form', data: { name: 'A. Respondent', email: 'not-an-email', choice: 'A' } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('valid email');
    expect(state.statements.some((statement) => /INSERT INTO form_responses/.test(statement))).toBe(false);
  });

  it('rejects malformed JSON and non-object answer payloads', async () => {
    const malformed = await submit('{');
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe('invalid JSON');

    const invalidAnswers = await submit({ slug: 'test-form', data: ['not', 'an', 'object'] });
    expect(invalidAnswers.status).toBe(400);
    expect((await invalidAnswers.json()).error).toContain('valid form responses');

    const invalidRequest = await submit(['not', 'an', 'object']);
    expect(invalidRequest.status).toBe(400);
  });

  it('does not accept unpublished or nonexistent forms', async () => {
    state.form = null;
    const response = await submit({ slug: 'draft-or-missing', data: { name: 'A. Respondent' } });
    expect(response.status).toBe(404);
    expect(state.statements).toHaveLength(1);
    expect(state.statements[0]).toContain('is_published = true');
  });

  it('returns a service error if the database cannot load the published form', async () => {
    state.failLookup = true;
    const response = await submit({ slug: 'test-form', data: { name: 'A. Respondent', email: 'a@example.org' } });
    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
  });

  it('returns a service error if persisting an otherwise valid response fails', async () => {
    state.failInsert = true;
    const response = await submit({ slug: 'test-form', data: { name: 'A. Respondent', email: 'a@example.org' } });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('could not record');
    expect(state.statements.some((statement) => /INSERT INTO form_responses/.test(statement))).toBe(true);
  });

  it('refuses a request when the public submission limiter blocks it', async () => {
    state.blocked = true;
    const response = await submit({ slug: 'test-form', data: { name: 'A. Respondent', email: 'a@example.org' } });
    expect(response.status).toBe(429);
    expect(state.statements).toHaveLength(0);
    expect(state.limit).toHaveBeenCalledWith('forms-submit', '192.0.2.10', { whenUnavailable: 'refuse' });
  });

  it('rejects a response that exceeds the stored JSON size limit', async () => {
    state.form.fields = Array.from({ length: 7 }, (_, index) => ({
      key: `answer_${index}`,
      type: 'textarea',
      label: `Answer ${index}`,
      required: false,
    }));
    const data = Object.fromEntries(state.form.fields.map((field: any) => [field.key, 'x'.repeat(20_000)]));
    const response = await submit({ slug: 'test-form', data });

    expect(response.status).toBe(413);
    expect(state.statements.some((statement) => /INSERT INTO form_responses/.test(statement))).toBe(false);
  });

  it('rejects a published form whose saved definition is not ready for submissions', async () => {
    state.form.fields = [{ key: 'choice', type: 'select', label: 'Choice', options: [] }];
    const response = await submit({ slug: 'test-form', data: { choice: 'anything' } });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain('temporarily unavailable');
    expect(state.statements.some((statement) => /INSERT INTO form_responses/.test(statement))).toBe(false);
  });
});

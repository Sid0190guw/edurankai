import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  denied: null as Response | null,
}));

vi.mock('@/lib/db', () => ({
  db: {
    execute: (...args: any[]) => state.execute(...args),
  },
}));

vi.mock('@/lib/auth/api-guard', () => ({
  denyAdminApi: vi.fn(async () => state.denied),
}));

import { GET as exportCsv } from './export/[id]';
import { GET as exportJson } from './export-json/[id]';

const savedFields = [
  { key: 'name', type: 'text', label: 'Name', required: true },
  { key: 'comment', type: 'textarea', label: 'Comment', required: false },
];

function context(): any {
  return { params: { id: 'form-id' }, locals: { user: null } };
}

beforeEach(() => {
  state.denied = null;
  state.execute.mockReset();
  state.execute.mockImplementation(async (query: any) => {
    const text = (query?.queryChunks || []).map((chunk: any) =>
      Array.isArray(chunk?.value) ? chunk.value.join('') : '',
    ).join('');
    if (/SELECT slug, fields FROM forms/.test(text)) {
      return [{ slug: 'safe-form', fields: JSON.stringify(savedFields) }];
    }
    if (/SELECT id, slug, title, fields FROM forms/.test(text)) {
      return [{ id: 'form-id', slug: 'safe-form', title: 'Safe form', fields: JSON.stringify(savedFields) }];
    }
    if (/FROM form_responses/.test(text)) {
      return [{
        created_at: new Date('2026-10-24T00:00:00.000Z'),
        respondent_name: '=HYPERLINK("https://bad.invalid","click")',
        respondent_email: 'respondent@example.org',
        respondent_phone: null,
        payment_status: 'none',
        data: {
          name: '=HYPERLINK("https://bad.invalid","click")',
          comment: 'Line 1, "quoted"\nLine 2',
          undeclared: 'must not be exported',
        },
      }];
    }
    throw new Error(`Unexpected export query: ${text}`);
  });
});

describe('Forms response exports', () => {
  it('denies unauthorized CSV and JSON export before querying response data', async () => {
    state.denied = new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });

    const csv = await exportCsv(context());
    const json = await exportJson(context());

    expect(csv.status).toBe(401);
    expect(json.status).toBe(401);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('exports normalized saved JSON fields as safe CSV, with private no-store headers', async () => {
    const response = await exportCsv(context());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="safe-form-responses.csv"');
    expect(body).toContain("'=HYPERLINK");
    expect(body).toContain('"Line 1, ""quoted""\nLine 2"');
    expect(body).not.toContain('must not be exported');
  });

  it('exports JSON with only the declared response answers', async () => {
    const response = await exportJson(context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.questions.map((question: any) => question.key)).toEqual(['name', 'comment']);
    expect(body.responses[0].answers).toEqual({
      name: '=HYPERLINK("https://bad.invalid","click")',
      comment: 'Line 1, "quoted"\nLine 2',
      undeclared: 'must not be exported',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

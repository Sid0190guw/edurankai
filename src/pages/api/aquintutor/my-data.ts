// GET /api/aquintutor/my-data — a student exports ONLY their own learning data as CSV (Prompt 13).
import type { APIRoute } from 'astro';
import { studentExportRows, toCsv } from '@/lib/analytics';

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return new Response('sign in required', { status: 401 });
  const { headers, records } = await studentExportRows(user.id).catch(() => ({ headers: ['kind', 'object_id', 'status', 'value', 'at'], records: [] }));
  const csv = toCsv(headers, records);
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="my-learning-data.csv"' } });
};

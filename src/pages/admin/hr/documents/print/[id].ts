// GET /admin/hr/documents/print/<id> - the issued document alone on an A4 page, for the browser's
// "Print" or "Save as PDF". The stored HTML, never a re-render, so the PDF matches the record.
import type { APIRoute } from 'astro';
import { can } from '@/lib/auth/permissions';
import { getDocument } from '@/lib/hr/hr-documents-store';
import { hrDocType } from '@/lib/hr/hr-documents';
import { esc } from '@/lib/hr/brand-doc';

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user || !can(user, 'employee.manage')) return new Response('Not allowed', { status: 403 });
  const res = await getDocument(String(params.id || ''));
  if (!res.ok) return new Response(res.error, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const doc = res.value;
  if (!doc) return new Response('Not found', { status: 404 });
  const label = hrDocType(doc.docType)?.label || 'Document';
  const revoked = doc.status === 'revoked'
    ? '<div class="revoked">REVOKED ' + esc((doc.revokedAt || '').slice(0, 10)) + ': ' + esc(doc.revokedReason) + '. Do not use this copy.</div>'
    : '';
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>' + esc(label + ' - ' + doc.employeeName + ' - ' + doc.serial) + '</title>'
    + '<style>@page{size:A4;margin:14mm}body{margin:0;background:#eee;font-family:Arial,sans-serif}.wrap{max-width:760px;margin:0 auto;padding:16px}'
    + '.bar{text-align:right;margin-bottom:10px}.bar button{font:inherit;font-weight:700;background:#111;color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer}'
    + '.revoked{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;padding:10px 12px;border-radius:8px;margin-bottom:10px;font-weight:700}'
    + '@media print{body{background:#fff}.wrap{padding:0;max-width:none}.bar{display:none}}</style></head><body><div class="wrap">'
    + '<div class="bar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>'
    + revoked + doc.html + '</div></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
};

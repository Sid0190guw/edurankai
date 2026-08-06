// GET /admin/finance/invoices/print/[id] — THE PRINTABLE INVOICE DOCUMENT.
//
// SERVER RENDERED, exactly as /admin/hr/payslip/[id] renders a payslip: the HTML is built from the
// stored rows by src/lib/invoices.ts renderInvoiceHtml() and sent as a document. No client PDF
// library, no fetch, no data assembled in a browser — what is printed is what the database says, and
// a browser with JavaScript disabled prints the same thing. Printing to PDF is the browser's own
// function, which every phone and desktop already has.
//
// THE GATE IS THE CONSOLE'S GATE: `invoices.view` OR the `finance` section at edit level. An invoice
// carries a counterparty's name, address and commercial terms, so this is not an open link — and it
// answers 404 rather than 403 for an invoice that exists but is not readable, so probing ids cannot
// tell the two apart.
import type { APIRoute } from 'astro';
import { can, canAccessSection } from '@/lib/auth/permissions';
import { viewInvoice, renderInvoiceHtml } from '@/lib/invoices';

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });

  const mayView = can(user as any, 'invoices.view') || (await canAccessSection(user, 'finance', 'edit'));
  if (!mayView) return new Response('Not found', { status: 404 });

  const id = String(params.id || '');
  if (!id) return new Response('Not found', { status: 404 });

  try {
    const view = await viewInvoice(id);
    if (!view) return new Response('Not found', { status: 404 });

    return new Response(renderInvoiceHtml(view, { autoPrint: false }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL. It goes to the log and
    // never to the page — a column name on somebody's screen tells them nothing they can act on.
    console.error('[invoices/print]', e?.cause?.message || e?.message);
    return new Response('The document could not be rendered just now.', { status: 500 });
  }
};

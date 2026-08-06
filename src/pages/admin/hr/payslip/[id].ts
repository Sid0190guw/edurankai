// GET /admin/hr/payslip/[id] — HR view of any employee's payslip.
// The employee's own copy is served from /portal/payslip/[id]; both render the same document
// from src/lib/hr-payslip.ts so the two never drift apart.
import type { APIRoute } from 'astro';
import { fetchPayslip, renderPayslipHtml } from '@/lib/hr-payslip';

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  // Payslips are restricted to designated authority (super admin / HR).
  if (!user || !['super_admin', 'hr'].includes(user.role)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const id = params.id;
  if (!id) return new Response('Missing ID', { status: 400 });

  try {
    const ps = await fetchPayslip(id);
    if (!ps) return new Response('Not found', { status: 404 });

    return new Response(renderPayslipHtml(ps), {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    // WAS `'Error: ' + e.message`, which on a drizzle/postgres-js error is the FAILED SQL TEXT and
    // not the reason — so the HR user was shown a statement in the browser while the log got
    // nothing at all. The reason is on `.cause`; it goes to the log, and the browser gets a sentence
    // that says what did and did not happen. The statement is never echoed to the page.
    console.error('[admin/hr/payslip] could not render payslip', id, '-', e?.cause?.message || e?.message);
    return new Response(
      'This payslip could not be rendered, so nothing is shown. Nothing has been changed and no payslip has been altered. '
      + 'The reason has been written to the server log; ask whoever runs the deployment to read it before reissuing anything.',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
    );
  }
};

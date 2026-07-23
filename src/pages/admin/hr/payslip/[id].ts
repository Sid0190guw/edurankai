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
    return new Response('Error: ' + e.message, { status: 500 });
  }
};

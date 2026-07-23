// GET /portal/payslip/[id] — an employee downloads their OWN payslip.
//
// Previously /portal/employee linked at /admin/hr/payslip/{id}, which employees can never
// reach: middleware redirects non-admin roles away from /admin/*, and the route itself only
// admits super_admin / hr. So the "Download" button on an employee's own payslip was dead.
//
// Authorisation here is ownership, not role: the payslip's employee_id must belong to the
// signed-in user. A payslip carries salary, so an id in the URL must never be enough.
import type { APIRoute } from 'astro';
import { fetchPayslip, renderPayslipHtml, employeeIdForUser } from '@/lib/hr-payslip';

export const GET: APIRoute = async ({ params, locals, redirect }) => {
  const user = (locals as any)?.user;
  if (!user) return redirect('/portal/login');

  const id = params.id;
  if (!id) return new Response('Missing ID', { status: 400 });

  try {
    const empId = await employeeIdForUser(String(user.id));
    if (!empId) return new Response('This account is not linked to an employee record.', { status: 403 });

    const ps = await fetchPayslip(id);
    // Same response for "does not exist" and "not yours" — otherwise the ids become an oracle
    // for which payslips exist.
    if (!ps || String(ps.employee_id) !== String(empId)) {
      return new Response('Payslip not found.', { status: 404 });
    }

    return new Response(renderPayslipHtml(ps, { autoPrint: false }), {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    return new Response('Could not open that payslip. Please try again.', { status: 500 });
  }
};

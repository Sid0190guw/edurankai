// POST /api/portal/expenses/withdraw — the person who raised a claim takes it back.
//
// TWO CHECKS, AND NEITHER IS OPTIONAL. The employee id is resolved from the SESSION and compared to
// the claim's own (withdrawClaim refuses otherwise with the same sentence it uses for "no such
// claim", so a posted id cannot be used to discover which claims exist); and the cancellation itself
// goes through workflow.cancelWorkflow(), which enforces that only the requester may withdraw a live
// approval. Neither check is a role test.
//
// WITHDRAWING IS NOT DECIDING. This route cannot approve or reject anything — it can only stop a
// claim the signed-in person raised, and only while it is still live.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { withdrawClaim } from '@/lib/expenses';

export const prerender = false;

const PAGE = '/portal/employee/expenses';
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

function back(kind: 'msg' | 'err', text: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: PAGE + '?' + kind + '=' + encodeURIComponent(text.slice(0, 400)) },
  });
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return redirect('/portal/login?next=' + encodeURIComponent(PAGE));

  let employeeId = '';
  try {
    const found = rowsOf(await db.execute(sql`
      SELECT id FROM hr_employees WHERE user_id = ${user.id} AND is_active = true LIMIT 1`))[0]
      || rowsOf(await db.execute(sql`
      SELECT id FROM hr_employees
       WHERE (work_email = ${user.email} OR personal_email = ${user.email} OR email = ${user.email})
         AND is_active = true LIMIT 1`))[0];
    employeeId = found?.id ? String(found.id) : '';
  } catch (e: any) {
    console.error('[api/expenses/withdraw] employee lookup', e?.cause?.message || e?.message);
    return back('err', 'We could not read your employee record just now. Nothing was changed. Try again in a moment.');
  }
  if (!employeeId) return back('err', 'Your account is not linked to an employee record.');

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return back('err', 'That form could not be read. Nothing was changed. Try again.');
  }

  const result = await withdrawClaim(
    String(fd.get('claim_id') || ''),
    user,
    employeeId,
    String(fd.get('reason') || ''),
  );

  if (!result.ok) return back('err', result.error || 'That claim could not be withdrawn.');
  return back('msg', 'Claim withdrawn. Nobody is waiting on it any more.');
};

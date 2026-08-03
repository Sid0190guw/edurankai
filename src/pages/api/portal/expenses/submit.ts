// POST /api/portal/expenses/submit — an employee raises a claim against their OWN record.
//
// THE SUBJECT IS NEVER TAKEN FROM THE FORM. `employee_id` is resolved from the signed-in session, so
// a posted body cannot raise a claim in somebody else's name however it is crafted. That matters more
// than usual here: the claim's subject decides WHICH approval chain the Organization Graph walks, so
// a spoofable subject would be a way to choose your own approver.
//
// APPROVAL IS NOT DECIDED HERE OR ANYWHERE NEAR HERE. submitClaim() hands the claim to
// src/lib/workflow.ts, which routes it from relationships and halts if it cannot name an approver.
// This route reports whichever of those happened; it has no approve branch.
//
// FORM POST, NOT JSON. The page it serves works with JavaScript switched off, which is the right
// default for a surface most people reach on a phone with poor signal — and a 303 back to the page
// means a refresh cannot re-submit the claim.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { submitClaim } from '@/lib/expenses';

export const prerender = false;

const PAGE = '/portal/employee/expenses';
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** Back to the page with a sentence. `err` renders as a refusal, `msg` as a confirmation. */
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
    // NOT SWALLOWED into a success. The cause goes to the log and the person is told nothing was
    // saved, rather than being shown a claim list that silently does not contain their claim.
    console.error('[api/expenses/submit] employee lookup', e?.cause?.message || e?.message);
    return back('err', 'We could not read your employee record just now. Nothing was saved. Try again in a moment.');
  }

  if (!employeeId) {
    return back('err', 'Your account is not linked to an employee record, so a claim has nobody to route from. Ask HR to link it.');
  }

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return back('err', 'That form could not be read. Nothing was saved. Try again.');
  }
  const s = (k: string) => String(fd.get(k) || '');

  const result = await submitClaim({
    employeeId,
    userId: String(user.id),
    kind: s('kind'),
    category: s('category'),
    title: s('title'),
    description: s('description'),
    amount: s('amount'),
    currency: s('currency'),
    incurredOn: s('incurred_on'),
    travelFrom: s('travel_from'),
    travelTo: s('travel_to'),
    travelStart: s('travel_start'),
    travelEnd: s('travel_end'),
    neededBy: s('needed_by'),
    receiptUrl: s('receipt_url'),
  });

  if (!result.ok) return back('err', result.error || 'That claim could not be raised.');

  if (result.status === 'halted') {
    // A HALT IS NOT A FAILURE AND IT IS NOT AN APPROVAL. The claim exists and is visible; nobody has
    // been asked for anything because nobody could be named. The engine's own sentence is passed
    // through verbatim, because it names the relationship that is missing.
    return back(
      'err',
      'Your claim was saved, but it could not be sent to anyone for approval: '
      + (result.haltReason || 'no approver could be resolved')
      + '. It is in your list below and will move on its own once HR records the missing relationship.',
    );
  }

  return back('msg', 'Claim raised and sent for approval.');
};

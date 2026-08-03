// GET /admin/hr/separation/statement/[id] — the printable full and final settlement statement.
//
// The document itself lives in src/lib/hr-payslip.ts, beside the payslip renderer, so a settlement
// statement and a payslip cannot drift into two different-looking documents from one company. This
// route only decides WHO may see one.
//
// THE GATE. `employee.manage` through can() — the same key the separation and settlement consoles
// require for their writes, asked again here because a URL is a door. It is deliberately NOT the
// literal role list the payslip route still carries: this statement names one person's pay, their
// leave, and what they owe, and the right question is what somebody may do rather than what their
// role is spelled.
//
// A statement is served whatever state the settlement is in, INCLUDING draft — the document says so
// on its face, and the person preparing it has to be able to read what they are preparing. The
// difference between "agreed" and "paid" is on the page in words, not implied by whether it renders.
import type { APIRoute } from 'astro';
import { can } from '@/lib/auth/permissions';
import { renderSettlementHtml } from '@/lib/hr-payslip';
import { getSettlement, settlementFacts, settlementStateLabel } from '@/lib/settlement';

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!can(user as any, 'employee.manage')) {
    return new Response(
      'You do not have permission to open a settlement statement. It names one person\'s pay, their '
      + 'leave and what they owe.',
      { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  const id = params.id;
  if (!id) return new Response('Missing id', { status: 400 });

  try {
    const s = await getSettlement(id);
    if (!s) return new Response('That settlement could not be found.', { status: 404 });

    // The facts are read for the two header fields only, and a failure to read them is not a failure
    // to render: the statement still shows every line and every total, and simply says the final
    // month is not known. A blank page would be a worse answer than an incomplete header.
    const facts = await settlementFacts(s.separationId);

    const html = renderSettlementHtml({
      employeeName: s.employeeName,
      employeeCode: s.employeeCode,
      designation: null,
      currency: s.currency,
      state: s.state,
      stateLabel: settlementStateLabel(s.state),
      lastWorkingDay: facts?.lastWorkingDay || null,
      finalMonthLabel: facts?.finalMonthLabel || null,
      settledReference: s.settledReference,
      settledAt: s.settledAt,
      notes: s.notes,
      lines: s.lines.map((l) => ({
        label: l.label, kind: l.kind, amount: l.amount, note: l.note,
      })),
      totalEarnings: s.totalEarnings,
      totalDeductions: s.totalDeductions,
      netPayable: s.netPayable,
    }, { autoPrint: false });

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed SQL.
    console.error('[admin/hr/separation/statement] GET', e?.cause?.message || e?.message);
    return new Response('The statement could not be produced. Nothing was changed.', { status: 500 });
  }
};

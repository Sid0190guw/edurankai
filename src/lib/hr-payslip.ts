// src/lib/hr-payslip.ts — one payslip document, two doors.
//
// The payslip renderer used to live inside /admin/hr/payslip/[id].ts, which is gated to
// super_admin + hr. But /portal/employee linked employees straight at that admin URL, so every
// employee who clicked "Download" on their own payslip got a 401 (and middleware bounces
// non-admin roles off /admin/* before the route even runs). An employee could never obtain
// their own payslip.
//
// The document is the same either way; only WHO may see it differs. So the query and the HTML
// live here, and the two routes each apply their own authorisation:
//   /admin/hr/payslip/[id]  — HR / super admin, any employee's payslip
//   /portal/payslip/[id]    — the signed-in employee, their OWN payslip only
//
// -------------------------------------------------------------------------------------------------
// THE DOCUMENT NOW PRINTS CONFIGURED COMPONENTS, NOT HARDCODED STATUTORY RATES.
// -------------------------------------------------------------------------------------------------
//
// This file used to print two labels that were compliance claims the product is not entitled to
// make: "PF (Employee 12%)" and "ESIC (0.75%)". Those percentages came from constants in
// /admin/hr/payroll/index.astro, they are jurisdiction-specific, they change, and they were being put
// in front of an employee on a pay document as though they were the law.
//
// src/lib/payroll.ts now models every component — including those two — as something an
// administrator configures, with the rate they entered. fetchPayslip() attaches those component lines
// and renderPayslipHtml() prints THEM, each with its own label and the rate that was actually
// applied.
//
// THE LEGACY BRANCH IS STILL HERE AND STILL CORRECT. Payslips generated before the component engine
// have no line rows, and their fixed columns are all the record there is; they render from those
// columns exactly as before, with the two rate claims removed from the labels. Nothing that has
// already been issued changes its numbers.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { payslipLines, describeLine, type PayLine } from '@/lib/payroll';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** Escape anything that reaches the document. A component label is free text an admin typed. */
function esc(v: any): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Load a payslip with the employee + run context needed to render it. Null when it does not exist. */
export async function fetchPayslip(id: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT ps.*, e.full_name, e.employee_code, e.designation, e.work_email, e.user_id,
      d.name as dept_name, pr.month, pr.year
    FROM hr_payslips ps
    JOIN hr_employees e ON ps.employee_id = e.id
    LEFT JOIN departments d ON e.department_id = d.id
    JOIN hr_payroll_runs pr ON ps.payroll_run_id = pr.id
    WHERE ps.id = ${id}
    LIMIT 1
  `);
  const ps = rows(r)[0] || null;
  if (!ps) return null;
  // The component breakdown, attached here rather than fetched by each route, so both doors
  // (/portal/payslip/[id] and /admin/hr/payslip/[id]) print the same document without either of them
  // having to know the component engine exists. An empty array is the ordinary answer for a payslip
  // generated before components, and renderPayslipHtml falls back to the fixed columns for it.
  ps.lines = await payslipLines(String(ps.id));
  return ps;
}

/** The hr_employees row for a signed-in user, or null when they are not an employee. */
export async function employeeIdForUser(userId: string): Promise<string | null> {
  try {
    const r = await db.execute(sql`SELECT id FROM hr_employees WHERE user_id = ${userId} AND is_active = true LIMIT 1`);
    return rows(r)[0]?.id ? String(rows(r)[0].id) : null;
  } catch { return null; }
}

function fmt(n: any) {
  if (!n || n == 0) return '0.00';
  return parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * One component row. `rate` is printed only when it EXPLAINS the amount (a percentage); a fixed
 * component prints its amount alone, because "200 (200)" tells nobody anything.
 */
function lineRow(line: PayLine, currency: string, deduction: boolean): string {
  const why = describeLine(line);
  return `<tr><td>${esc(line.label)}${why ? ` <span style="color:#9ca3af;font-size:10px;">${esc(why)}</span>` : ''}</td>`
    + `<td${deduction ? ' class="deduction-color"' : ''}>${deduction ? '- ' : ''}${esc(currency)} ${fmt(line.amount)}</td></tr>`;
}

/** The printable payslip. `autoPrint` opens the browser print dialog (the admin behaviour). */
export function renderPayslipHtml(ps: any, opts: { autoPrint?: boolean } = {}): string {
  const month = MONTHS[(ps.month || 1) - 1];
  const year = ps.year;
  const autoPrint = opts.autoPrint !== false;
  const currency = ps.currency || 'INR';

  // COMPONENTS WHERE THEY EXIST, FIXED COLUMNS WHERE THEY DO NOT. Declared here, above the template
  // literal that reads them — `const` is not hoisted, and a declaration below its first use throws on
  // the first line of whatever reads it.
  const lines: PayLine[] = Array.isArray(ps.lines) ? ps.lines : [];
  const earningLines = lines.filter((l) => l.kind === 'earning');
  const deductionLines = lines.filter((l) => l.kind === 'deduction');
  const employerTotal = lines.reduce((s, l) => s + (Number(l.employerAmount) || 0), 0);
  const hasComponents = lines.length > 0;

  const earningsHtml = hasComponents
    ? earningLines.map((l) => lineRow(l, currency, false)).join('')
    : `
          ${ps.hra > 0 ? `<tr><td>House rent allowance</td><td>${currency} ${fmt(ps.hra)}</td></tr>` : ''}
          ${ps.da > 0 ? `<tr><td>Dearness allowance</td><td>${currency} ${fmt(ps.da)}</td></tr>` : ''}
          ${ps.special_allowance > 0 ? `<tr><td>Special allowance</td><td>${currency} ${fmt(ps.special_allowance)}</td></tr>` : ''}
          ${ps.transport_allowance > 0 ? `<tr><td>Transport allowance</td><td>${currency} ${fmt(ps.transport_allowance)}</td></tr>` : ''}
          ${ps.medical_allowance > 0 ? `<tr><td>Medical allowance</td><td>${currency} ${fmt(ps.medical_allowance)}</td></tr>` : ''}
          ${ps.other_allowances > 0 ? `<tr><td>Other allowances</td><td>${currency} ${fmt(ps.other_allowances)}</td></tr>` : ''}`;

  // THE TWO RATE CLAIMS ARE GONE FROM THESE LABELS. They used to read "PF (Employee 12%)" and
  // "ESIC (0.75%)" — percentages hardcoded in the run, printed on a pay document as though they were
  // the law. The numbers on already-issued payslips are untouched; only the claim about WHY they are
  // that number has been removed, because this product cannot stand behind it.
  const deductionsHtml = hasComponents
    ? deductionLines.map((l) => lineRow(l, currency, true)).join('')
    : `
          ${ps.pf_employee > 0 ? `<tr><td>Provident fund (employee)</td><td class="deduction-color">- ${currency} ${fmt(ps.pf_employee)}</td></tr>` : ''}
          ${ps.esic_employee > 0 ? `<tr><td>State insurance (employee)</td><td class="deduction-color">- ${currency} ${fmt(ps.esic_employee)}</td></tr>` : ''}
          ${ps.professional_tax > 0 ? `<tr><td>Professional tax</td><td class="deduction-color">- ${currency} ${fmt(ps.professional_tax)}</td></tr>` : ''}
          ${ps.tds > 0 ? `<tr><td>Tax deducted at source</td><td class="deduction-color">- ${currency} ${fmt(ps.tds)}</td></tr>` : ''}
          ${ps.lop_deduction > 0 ? `<tr><td>Loss of pay (${ps.lop_days || 0} day${Number(ps.lop_days) === 1 ? '' : 's'})</td><td class="deduction-color">- ${currency} ${fmt(ps.lop_deduction)}</td></tr>` : ''}
          ${ps.other_deductions > 0 ? `<tr><td>Other deductions</td><td class="deduction-color">- ${currency} ${fmt(ps.other_deductions)}</td></tr>` : ''}`;

  const employerHtml = employerTotal > 0
    ? `<div class="total-row" style="margin-top:10px;">
         <span style="font-weight:600;">Employer contributions (not deducted from you)</span>
         <span style="font-weight:700;">${currency} ${fmt(employerTotal)}</span>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payslip - ${ps.full_name} - ${month} ${year}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; padding: 20px; }
  .header { background: #FF4F00; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .header h1 { font-size: 20px; font-weight: 700; }
  .header p { font-size: 12px; opacity: 0.85; margin-top: 4px; }
  .badge { background: rgba(255,255,255,0.2); padding: 3px 10px; border-radius: 100px; font-size: 11px; display: inline-block; margin-top: 8px; }
  .body { border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; padding: 20px; }
  .employee-info { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
  .info-group label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; display: block; margin-bottom: 2px; }
  .info-group span { font-size: 13px; font-weight: 600; color: #111; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin-bottom: 8px; }
  .pay-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .pay-table { width: 100%; }
  .pay-table tr td { padding: 5px 0; border-bottom: 1px solid #f3f4f6; font-size: 12px; }
  .pay-table tr td:last-child { text-align: right; font-weight: 500; }
  .pay-table tr:last-child td { border-bottom: none; }
  .total-row { background: #f9fafb; border-radius: 6px; padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .net-pay { background: #FF4F00; color: white; border-radius: 6px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; margin-top: 12px; }
  .net-pay .label { font-size: 12px; opacity: 0.9; }
  .net-pay .amount { font-size: 20px; font-weight: 700; }
  .attendance { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
  .att-box { background: #f9fafb; border-radius: 6px; padding: 8px; text-align: center; }
  .att-box .num { font-size: 18px; font-weight: 700; color: #111; }
  .att-box .lbl { font-size: 10px; color: #6b7280; margin-top: 2px; }
  .footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 10px; color: #9ca3af; }
  .deduction-color { color: #ef4444; }
  .printbar { max-width: 780px; margin: 0 auto 12px; text-align: right; }
  .printbar button { font: inherit; font-weight: 700; background: #111; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; cursor: pointer; }
  @media (max-width: 640px) {
    .employee-info, .pay-grid { grid-template-columns: 1fr; }
  }
  @media print { body { padding: 0; } .printbar { display: none; } }
</style>
</head>
<body>
  <div class="printbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <div class="header">
    <h1>EduRankAI</h1>
    <p>Payslip for ${month} ${year}</p>
    <span class="badge">${ps.status?.toUpperCase() || 'PENDING'}</span>
  </div>
  <div class="body">
    <div class="employee-info">
      <div class="info-group"><label>Employee Name</label><span>${ps.full_name}</span></div>
      <div class="info-group"><label>Employee Code</label><span>${ps.employee_code}</span></div>
      <div class="info-group"><label>Designation</label><span>${ps.designation || '-'}</span></div>
      <div class="info-group"><label>Department</label><span>${ps.dept_name || '-'}</span></div>
      <div class="info-group"><label>Pay Period</label><span>${month} ${year}</span></div>
      <div class="info-group"><label>Currency</label><span>${ps.currency || 'INR'}</span></div>
    </div>

    <p class="section-title">Attendance</p>
    <div class="attendance">
      <div class="att-box"><div class="num">${ps.days_worked || 0}</div><div class="lbl">Days Worked</div></div>
      <div class="att-box"><div class="num">${ps.days_leave || 0}</div><div class="lbl">Leave Days</div></div>
      <div class="att-box"><div class="num">${ps.days_absent || 0}</div><div class="lbl">Absent Days</div></div>
    </div>

    <div class="pay-grid">
      <div>
        <p class="section-title">Earnings</p>
        <table class="pay-table">
          <tr><td>Basic salary</td><td>${currency} ${fmt(ps.basic)}</td></tr>
          ${earningsHtml}
        </table>
        <div class="total-row" style="margin-top:8px;">
          <span style="font-weight:600;">Gross salary</span>
          <span style="font-weight:700;">${currency} ${fmt(ps.gross_salary)}</span>
        </div>
      </div>
      <div>
        <p class="section-title">Deductions</p>
        <table class="pay-table">
          ${deductionsHtml || '<tr><td colspan="2" style="color:#9ca3af;">No deductions this month.</td></tr>'}
        </table>
        <div class="total-row" style="margin-top:8px;">
          <span style="font-weight:600;">Total deductions</span>
          <span style="font-weight:700;color:#ef4444;">- ${currency} ${fmt(ps.total_deductions)}</span>
        </div>
        ${employerHtml}
      </div>
    </div>

    <div class="net-pay">
      <div><div class="label">Net pay</div><div style="font-size:10px;opacity:0.75;">${month} ${year}</div></div>
      <div class="amount">${currency} ${fmt(ps.net_salary)}</div>
    </div>

    <div class="footer">
      <p>This is a computer-generated payslip and does not require a signature.</p>
      <p>Every component above, including any statutory deduction, is calculated from rates configured
         by this organisation. It is a record of what was paid, not advice on what any tax or
         contribution rule requires of you.</p>
      <p>EduRankAI &bull; hr@edurankai.in &bull; Generated on ${new Date().toLocaleDateString('en-IN')}</p>
    </div>
  </div>
  ${autoPrint ? `<script>window.onload = function() { window.print(); }<\/script>` : ''}
</body>
</html>`;
}

// =================================================================================================
// THE FULL AND FINAL SETTLEMENT STATEMENT
// =================================================================================================
//
// A payslip-style document, and it lives HERE rather than in src/lib/settlement.ts on purpose: this
// file already owns what a pay document looks like in this product, and a second HTML document with
// its own fonts, its own money formatting and its own footer would drift from the payslip within a
// month. The settlement module owns the ARITHMETIC; this file owns the PAGE.
//
// WHAT THE DOCUMENT IS CAREFUL TO SAY:
//   - it is a statement of a figure that has been agreed, not a receipt for money that has moved.
//     The settlement is handed off for payment as a separate, recorded act, and a document that
//     reads like a receipt would have people believing they had been paid;
//   - each computed line carries the note explaining how it was reached, because the person reading
//     it has just lost their income and "Salary for 14 days" with no method behind it is the line
//     that starts an argument;
//   - the same footer disclaimer the payslip carries. No statutory or compliance claim is made here
//     either, and none of these figures is advice about what any rule requires of anybody.

/** The shape this renderer needs. Structural only, so settlement.ts is not imported for its types. */
export interface SettlementStatementInput {
  employeeName: string | null;
  employeeCode: string | null;
  designation?: string | null;
  currency: string;
  state: string;
  stateLabel: string;
  lastWorkingDay: string | null;
  finalMonthLabel?: string | null;
  settledReference?: string | null;
  settledAt?: string | null;
  notes?: string | null;
  lines: {
    label: string;
    kind: string;
    amount: number;
    note?: string | null;
  }[];
  totalEarnings: number;
  totalDeductions: number;
  netPayable: number;
}

/** One statement row. The note is printed under the label, small — it is the method, not decoration. */
function settlementRow(
  line: SettlementStatementInput['lines'][number],
  currency: string,
): string {
  const deduction = String(line.kind) === 'deduction';
  const note = line.note
    ? `<div style="color:#9ca3af;font-size:10px;margin-top:2px;line-height:1.4;">${esc(line.note)}</div>`
    : '';
  return `<tr><td>${esc(line.label)}${note}</td>`
    + `<td${deduction ? ' class="deduction-color"' : ''}>${deduction ? '- ' : ''}`
    + `${esc(currency)} ${fmt(line.amount)}</td></tr>`;
}

/** The printable settlement statement. `autoPrint` opens the browser print dialog. */
export function renderSettlementHtml(
  s: SettlementStatementInput,
  opts: { autoPrint?: boolean } = {},
): string {
  // CONSTANTS ABOVE THE TEMPLATE THAT READS THEM. `const` is not hoisted, and a declaration below its
  // first use throws on the first line of whatever reads it.
  const autoPrint = opts.autoPrint !== false;
  const currency = s.currency || 'INR';
  const earnings = (s.lines || []).filter((l) => String(l.kind) !== 'deduction');
  const deductions = (s.lines || []).filter((l) => String(l.kind) === 'deduction');
  const negative = Number(s.netPayable) < 0;

  const earningsHtml = earnings.length
    ? earnings.map((l) => settlementRow(l, currency)).join('')
    : '<tr><td colspan="2" style="color:#9ca3af;">Nothing is owed to this person on this statement.</td></tr>';

  const deductionsHtml = deductions.length
    ? deductions.map((l) => settlementRow(l, currency)).join('')
    : '<tr><td colspan="2" style="color:#9ca3af;">Nothing is being recovered.</td></tr>';

  // A HANDED-OFF STATEMENT SAYS SO, AND ONE THAT HAS NOT SAYS THAT INSTEAD. The difference between
  // "agreed" and "paid" is the whole reason this banner exists.
  const handoffHtml = s.settledReference
    ? `<div class="total-row" style="margin-top:10px;">
         <span style="font-weight:600;">Handed off for payment</span>
         <span style="font-weight:700;">${esc(s.settledReference)}</span>
       </div>`
    : `<div class="total-row" style="margin-top:10px;">
         <span style="font-weight:600;color:#b45309;">Not yet handed off for payment</span>
         <span style="font-size:11px;color:#6b7280;">This is a statement of the agreed figure, not a receipt.</span>
       </div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Full and final settlement - ${esc(s.employeeName || 'Employee')}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; background: #fff; padding: 20px; }
  .header { background: #FF4F00; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
  .header h1 { font-size: 20px; font-weight: 700; }
  .header p { font-size: 12px; opacity: 0.85; margin-top: 4px; }
  .badge { background: rgba(255,255,255,0.2); padding: 3px 10px; border-radius: 100px; font-size: 11px; display: inline-block; margin-top: 8px; }
  .body { border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; padding: 20px; }
  .employee-info { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; }
  .info-group label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; display: block; margin-bottom: 2px; }
  .info-group span { font-size: 13px; font-weight: 600; color: #111; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin-bottom: 8px; }
  .pay-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .pay-table { width: 100%; }
  .pay-table tr td { padding: 6px 0; border-bottom: 1px solid #f3f4f6; font-size: 12px; vertical-align: top; }
  .pay-table tr td:last-child { text-align: right; font-weight: 500; white-space: nowrap; }
  .pay-table tr:last-child td { border-bottom: none; }
  .total-row { background: #f9fafb; border-radius: 6px; padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
  .net-pay { background: #FF4F00; color: white; border-radius: 6px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; margin-top: 12px; }
  .net-pay.owed { background: #b91c1c; }
  .net-pay .label { font-size: 12px; opacity: 0.9; }
  .net-pay .amount { font-size: 20px; font-weight: 700; }
  .notes { margin-top: 14px; background: #f9fafb; border-radius: 6px; padding: 10px 12px; font-size: 11.5px; color: #4b5563; line-height: 1.6; }
  .footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 10px; color: #9ca3af; line-height: 1.6; }
  .deduction-color { color: #ef4444; }
  .printbar { max-width: 780px; margin: 0 auto 12px; text-align: right; }
  .printbar button { font: inherit; font-weight: 700; background: #111; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; cursor: pointer; }
  @media (max-width: 640px) {
    .employee-info, .pay-grid { grid-template-columns: 1fr; }
  }
  @media print { body { padding: 0; } .printbar { display: none; } }
</style>
</head>
<body>
  <div class="printbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <div class="header">
    <h1>EduRankAI</h1>
    <p>Full and final settlement</p>
    <span class="badge">${esc(s.stateLabel || s.state || '')}</span>
  </div>
  <div class="body">
    <div class="employee-info">
      <div class="info-group"><label>Employee Name</label><span>${esc(s.employeeName || '-')}</span></div>
      <div class="info-group"><label>Employee Code</label><span>${esc(s.employeeCode || '-')}</span></div>
      <div class="info-group"><label>Designation</label><span>${esc(s.designation || '-')}</span></div>
      <div class="info-group"><label>Last Working Day</label><span>${esc(s.lastWorkingDay || 'Not recorded')}</span></div>
      <div class="info-group"><label>Final Pay Month</label><span>${esc(s.finalMonthLabel || '-')}</span></div>
      <div class="info-group"><label>Currency</label><span>${esc(currency)}</span></div>
    </div>

    <div class="pay-grid">
      <div>
        <p class="section-title">Owed to the employee</p>
        <table class="pay-table">${earningsHtml}</table>
        <div class="total-row" style="margin-top:8px;">
          <span style="font-weight:600;">Total owed</span>
          <span style="font-weight:700;">${esc(currency)} ${fmt(s.totalEarnings)}</span>
        </div>
      </div>
      <div>
        <p class="section-title">Recovered from the settlement</p>
        <table class="pay-table">${deductionsHtml}</table>
        <div class="total-row" style="margin-top:8px;">
          <span style="font-weight:600;">Total recovered</span>
          <span style="font-weight:700;color:#ef4444;">- ${esc(currency)} ${fmt(s.totalDeductions)}</span>
        </div>
        ${handoffHtml}
      </div>
    </div>

    <div class="net-pay${negative ? ' owed' : ''}">
      <div>
        <div class="label">${negative ? 'Owed by the employee' : 'Net settlement'}</div>
        <div style="font-size:10px;opacity:0.75;">${negative ? 'Recoveries exceed what is due' : 'Payable on handoff'}</div>
      </div>
      <div class="amount">${esc(currency)} ${fmt(Math.abs(Number(s.netPayable) || 0))}</div>
    </div>

    ${s.notes ? `<div class="notes">${esc(s.notes)}</div>` : ''}

    <div class="footer">
      <p>This is a computer-generated statement of an agreed settlement figure. It is not a receipt,
         and it does not confirm that any payment has been made.</p>
      <p>Every figure above is either read from this organisation's own records or entered by an
         administrator. It is a record of what was agreed, not advice on what any tax, contribution
         or employment rule requires of you.</p>
      <p>EduRankAI &bull; hr@edurankai.in &bull; Generated on ${new Date().toLocaleDateString('en-IN')}</p>
    </div>
  </div>
  ${autoPrint ? `<script>window.onload = function() { window.print(); }<\/script>` : ''}
</body>
</html>`;
}

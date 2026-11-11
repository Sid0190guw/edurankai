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
import { amountInWords, maskTail } from '@/lib/hr/hr-documents';
import { longDate } from '@/lib/hr/brand-doc';

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
  // Particulars a payslip normally carries (date of joining; bank account and PAN, both masked).
  // Read as to_jsonb(e) so this never names a column a hand-run migration may not have added on the
  // live database: a column that is absent is simply not printed. Never fatal to the payslip.
  try {
    const x = rows(await db.execute(sql`SELECT to_jsonb(e) AS j FROM hr_employees e WHERE e.id = ${ps.employee_id} LIMIT 1`))[0];
    const j = x?.j && typeof x.j === 'object' ? x.j : (typeof x?.j === 'string' ? JSON.parse(x.j) : {});
    ps.extra = { joining_date: j?.joining_date || null, bank_name: j?.bank_name || null, bank_account_number: j?.bank_account_number || null, pan_number: j?.pan_number || null };
  } catch (e: any) {
    console.error('[hr-payslip] employee particulars unavailable:', e?.cause?.message || e?.message);
    ps.extra = {};
  }
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


/** The printable payslip. `autoPrint` opens the browser print dialog (the admin behaviour). */
export function renderPayslipHtml(ps: any, opts: { autoPrint?: boolean } = {}): string {
  // A FORMAL PAYSLIP, NOT A DASHBOARD CARD. Letterhead, the period, the employee's particulars, one
  // earnings-and-deductions table read across, and net pay in figures AND in words, which is what a
  // bank, a landlord or a visa office reads first. Every value is escaped: names, designations and
  // component labels are text somebody typed.
  // Declared here, above the template literal that reads them: `const` is not hoisted.
  const month = MONTHS[(Number(ps.month) || 1) - 1] || '';
  const year = esc(ps.year);
  const autoPrint = opts.autoPrint !== false;
  const currency = String(ps.currency || 'INR');
  const cur = esc(currency);
  const extra = ps.extra && typeof ps.extra === 'object' ? ps.extra : {};

  const lines: PayLine[] = Array.isArray(ps.lines) ? ps.lines : [];
  const hasComponents = lines.length > 0;
  type Item = { label: string; note: string; amount: number };
  const legacy = (pairs: [string, any][]): Item[] => pairs.filter(([, v]) => Number(v) > 0).map(([label, v]) => ({ label, note: '', amount: Number(v) }));
  const earnings: Item[] = hasComponents
    ? lines.filter((l) => l.kind === 'earning').map((l) => ({ label: String(l.label || ''), note: describeLine(l) || '', amount: Number(l.amount) || 0 }))
    : legacy([['Basic salary', ps.basic], ['House rent allowance', ps.hra], ['Dearness allowance', ps.da], ['Special allowance', ps.special_allowance],
        ['Transport allowance', ps.transport_allowance], ['Medical allowance', ps.medical_allowance], ['Other allowances', ps.other_allowances]]);
  // The component engine prints basic as its own line on the old document; keep it first.
  if (hasComponents && Number(ps.basic) > 0 && !earnings.some((e) => /basic/i.test(e.label))) earnings.unshift({ label: 'Basic salary', note: '', amount: Number(ps.basic) });
  // THE TWO RATE CLAIMS STAY GONE: "Provident fund (employee)", not "PF (Employee 12%)". See the header.
  const lopDays = Number(ps.lop_days) || 0;
  const deductions: Item[] = hasComponents
    ? lines.filter((l) => l.kind === 'deduction').map((l) => ({ label: String(l.label || ''), note: describeLine(l) || '', amount: Number(l.amount) || 0 }))
    : legacy([['Provident fund (employee)', ps.pf_employee], ['State insurance (employee)', ps.esic_employee], ['Professional tax', ps.professional_tax],
        ['Tax deducted at source', ps.tds], ['Loss of pay (' + lopDays + ' day' + (lopDays === 1 ? '' : 's') + ')', ps.lop_deduction],
        ['Other deductions', ps.other_deductions]]);
  const employerTotal = lines.reduce((s, l) => s + (Number(l.employerAmount) || 0), 0);

  const cell = (it: Item | undefined, emptyText = '') => it
    ? '<td class="lbl">' + esc(it.label) + (it.note ? '<span class="note">' + esc(it.note) + '</span>' : '') + '</td><td class="amt">' + fmt(it.amount) + '</td>'
    : '<td class="lbl' + (emptyText ? ' muted' : '') + '">' + esc(emptyText) + '</td><td class="amt"></td>';
  const rowCount = Math.max(earnings.length, deductions.length, 1);
  let body = '';
  for (let k = 0; k < rowCount; k++) body += '<tr>' + cell(earnings[k]) + cell(deductions[k], k === 0 && deductions.length === 0 ? 'No deductions this month' : '') + '</tr>';

  const particular = (k: string, v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? '' : '<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>');
  const joined = extra.joining_date ? longDate(String(extra.joining_date).slice(0, 10)) : '';
  const bank = extra.bank_account_number ? (extra.bank_name ? String(extra.bank_name) + ' ' : '') + maskTail(extra.bank_account_number) : '';
  const left = particular('Employee name', ps.full_name) + particular('Employee code', ps.employee_code) + particular('Designation', ps.designation)
    + particular('Department', ps.dept_name) + particular('Date of joining', joined);
  const right = particular('Pay period', month + ' ' + ps.year) + particular('Days worked', ps.days_worked ?? 0)
    + particular('Leave days', ps.days_leave ?? 0) + particular('Absent days', ps.days_absent ?? 0)
    + particular('Bank account', bank) + particular('PAN', extra.pan_number ? maskTail(extra.pan_number) : '')
    + particular('Payment status', (() => { const t = String(ps.status || 'pending').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); })());
  const generated = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
  const employerHtml = employerTotal > 0 ? '<p class="employer">Employer contributions, not deducted from your pay: <strong>' + cur + ' ' + fmt(employerTotal) + '</strong></p>' : '';
  const printScript = autoPrint ? '<script>window.onload = function() { window.print(); }<\/script>' : '';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">'
    + '<title>Payslip - ' + esc(ps.full_name) + ' - ' + esc(month) + ' ' + year + '</title>'
    + '<style>'
    + '@page{size:A4;margin:12mm}*{box-sizing:border-box}'
    + 'body{margin:0;background:#eceae6;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#1a1a1a}'
    + '.sheet{max-width:800px;margin:0 auto 24px;background:#fff;border:1px solid #d9d4cc;padding:26px 30px}'
    + '.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #FF4F00;padding-bottom:12px}'
    + '.wm{font-family:Georgia,"Times New Roman",serif;font-size:26px;font-weight:700;letter-spacing:-0.3px}.wm span{color:#FF4F00}'
    + '.tag{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b635c;font-weight:700;margin-top:3px}'
    + '.addr{text-align:right;font-size:10.5px;color:#6b635c;line-height:1.5}'
    + '.title{display:flex;justify-content:space-between;align-items:baseline;margin:16px 0 12px}'
    + '.title h1{margin:0;font-size:16px;letter-spacing:3px;text-transform:uppercase}.title p{margin:0;font-size:12.5px;color:#3a332d}'
    + '.parts{display:grid;grid-template-columns:1fr 1fr;gap:0 18px;border:1px solid #d9d4cc;padding:6px 12px;margin-bottom:14px}'
    + '.parts table{width:100%;border-collapse:collapse}.parts th{text-align:left;font-weight:400;color:#6b635c;padding:4px 0;width:42%;font-size:11px}'
    + '.parts td{padding:4px 0;font-weight:700;font-size:12px}'
    + 'table.pay{width:100%;border-collapse:collapse;border:1px solid #d9d4cc}'
    + 'table.pay thead th{background:#f4f1ec;text-align:left;padding:7px 10px;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #d9d4cc}'
    + 'table.pay thead th.amt{text-align:right}table.pay td{padding:6px 10px;border-bottom:1px solid #efebe5;vertical-align:top}'
    + 'table.pay td:nth-child(3){border-left:1px solid #d9d4cc}'
    + 'table.pay td.amt{text-align:right;white-space:nowrap;width:17%;font-variant-numeric:tabular-nums}'
    + '.note{display:block;color:#8a837b;font-size:10px}.muted{color:#8a837b}'
    + 'table.pay tr.tot td{font-weight:700;background:#faf8f4;border-top:1px solid #d9d4cc}'
    + '.net{display:flex;justify-content:space-between;align-items:center;border:2px solid #1a1a1a;margin-top:12px;padding:10px 14px}'
    + '.net .k{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700}.net .v{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}'
    + '.words{margin:6px 0 0;font-size:11.5px;color:#3a332d}.employer{margin-top:8px;font-size:11px;color:#3a332d}'
    + '.foot{margin-top:18px;padding-top:10px;border-top:1px solid #e5e0d8;font-size:9.5px;color:#8a837b;line-height:1.55}'
    + '.printbar{max-width:800px;margin:14px auto 10px;text-align:right}'
    + '.printbar button{font:inherit;font-weight:700;background:#111;color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer}'
    + '@media (max-width:640px){.parts{grid-template-columns:1fr}.sheet{padding:18px}.head{flex-direction:column;align-items:flex-start;gap:8px}.addr{text-align:left}}'
    + '@media print{body{background:#fff}.sheet{border:0;margin:0;max-width:none;padding:0}.printbar{display:none}}'
    + '</style></head><body>'
    + '<div class="printbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>'
    + '<div class="sheet">'
    + '<div class="head"><div><div class="wm">Edu<span>Rank</span>AI</div><div class="tag">AI Research &amp; Engineering</div></div>'
    + '<div class="addr">Guwahati, Assam, India<br>hr@edurankai.in | edurankai.in</div></div>'
    + '<div class="title"><h1>Payslip</h1><p>For the month of <strong>' + esc(month) + ' ' + year + '</strong></p></div>'
    + '<div class="parts"><table>' + left + '</table><table>' + right + '</table></div>'
    + '<table class="pay"><thead><tr><th>Earnings</th><th class="amt">Amount (' + cur + ')</th><th>Deductions</th><th class="amt">Amount (' + cur + ')</th></tr></thead><tbody>'
    + body
    + '<tr class="tot"><td>Gross earnings</td><td class="amt">' + fmt(ps.gross_salary) + '</td><td>Total deductions</td><td class="amt">' + fmt(ps.total_deductions) + '</td></tr>'
    + '</tbody></table>'
    + '<div class="net"><span class="k">Net pay for ' + esc(month) + ' ' + year + '</span><span class="v">' + cur + ' ' + fmt(ps.net_salary) + '</span></div>'
    + '<p class="words">In words: <strong>' + esc(amountInWords(ps.net_salary, currency)) + '</strong></p>'
    + employerHtml
    + '<div class="foot">This is a computer-generated payslip and does not require a signature. '
    + 'Every component above, including any statutory deduction, is calculated from rates configured by this organisation. '
    + 'It is a record of what was paid, not advice on what any tax or contribution rule requires of you. Generated on ' + esc(generated) + '.</div>'
    + '</div>' + printScript + '</body></html>';
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

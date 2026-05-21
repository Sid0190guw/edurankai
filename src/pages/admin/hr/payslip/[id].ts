import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user || user.role === 'applicant') {
    return new Response('Unauthorized', { status: 401 });
  }

  const id = params.id;
  if (!id) return new Response('Missing ID', { status: 400 });

  try {
    const r = await db.execute(sql`
      SELECT ps.*, e.full_name, e.employee_code, e.designation, e.work_email,
        d.name as dept_name, pr.month, pr.year
      FROM hr_payslips ps
      JOIN hr_employees e ON ps.employee_id = e.id
      LEFT JOIN departments d ON e.department_id = d.id
      JOIN hr_payroll_runs pr ON ps.payroll_run_id = pr.id
      WHERE ps.id = ${id}
      LIMIT 1
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    if (rows.length === 0) return new Response('Not found', { status: 404 });
    const ps = rows[0] as any;

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const month = MONTHS[(ps.month || 1) - 1];
    const year = ps.year;

    function fmt(n: any) {
      if (!n || n == 0) return '0.00';
      return parseFloat(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
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
  @media print { body { padding: 0; } }
</style>
</head>
<body>
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
          <tr><td>Basic Salary</td><td>${ps.currency} ${fmt(ps.basic)}</td></tr>
          <tr><td>HRA</td><td>${ps.currency} ${fmt(ps.hra)}</td></tr>
          ${ps.da > 0 ? `<tr><td>DA</td><td>${ps.currency} ${fmt(ps.da)}</td></tr>` : ''}
          ${ps.special_allowance > 0 ? `<tr><td>Special Allowance</td><td>${ps.currency} ${fmt(ps.special_allowance)}</td></tr>` : ''}
          ${ps.transport_allowance > 0 ? `<tr><td>Transport Allowance</td><td>${ps.currency} ${fmt(ps.transport_allowance)}</td></tr>` : ''}
          ${ps.medical_allowance > 0 ? `<tr><td>Medical Allowance</td><td>${ps.currency} ${fmt(ps.medical_allowance)}</td></tr>` : ''}
          ${ps.other_allowances > 0 ? `<tr><td>Other Allowances</td><td>${ps.currency} ${fmt(ps.other_allowances)}</td></tr>` : ''}
        </table>
        <div class="total-row" style="margin-top:8px;">
          <span style="font-weight:600;">Gross Salary</span>
          <span style="font-weight:700;">${ps.currency} ${fmt(ps.gross_salary)}</span>
        </div>
      </div>
      <div>
        <p class="section-title">Deductions</p>
        <table class="pay-table">
          ${ps.pf_employee > 0 ? `<tr><td>PF (Employee 12%)</td><td class="deduction-color">- ${ps.currency} ${fmt(ps.pf_employee)}</td></tr>` : ''}
          ${ps.esic_employee > 0 ? `<tr><td>ESIC (0.75%)</td><td class="deduction-color">- ${ps.currency} ${fmt(ps.esic_employee)}</td></tr>` : ''}
          ${ps.professional_tax > 0 ? `<tr><td>Professional Tax</td><td class="deduction-color">- ${ps.currency} ${fmt(ps.professional_tax)}</td></tr>` : ''}
          ${ps.tds > 0 ? `<tr><td>TDS</td><td class="deduction-color">- ${ps.currency} ${fmt(ps.tds)}</td></tr>` : ''}
          ${ps.other_deductions > 0 ? `<tr><td>Other Deductions</td><td class="deduction-color">- ${ps.currency} ${fmt(ps.other_deductions)}</td></tr>` : ''}
        </table>
        <div class="total-row" style="margin-top:8px;">
          <span style="font-weight:600;">Total Deductions</span>
          <span style="font-weight:700;color:#ef4444;">- ${ps.currency} ${fmt(ps.total_deductions)}</span>
        </div>
      </div>
    </div>

    <div class="net-pay">
      <div><div class="label">Net Pay</div><div style="font-size:10px;opacity:0.75;">${month} ${year}</div></div>
      <div class="amount">${ps.currency} ${fmt(ps.net_salary)}</div>
    </div>

    <div class="footer">
      <p>This is a computer-generated payslip and does not require a signature.</p>
      <p>EduRankAI &bull; hr@edurankai.in &bull; Generated on ${new Date().toLocaleDateString('en-IN')}</p>
    </div>
  </div>
  <script>window.onload = function() { window.print(); }</script>
</body>
</html>`;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
      }
    });
  } catch(e: any) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
};

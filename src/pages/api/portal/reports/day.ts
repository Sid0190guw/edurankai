// GET /api/portal/reports/day?d=YYYY-MM-DD
//
// What the form needs to know the moment somebody changes the day it covers:
//   - is there already a report for that day (so the button says "Update" and not "Submit", and the
//     person is told BEFORE typing that they are about to revise something they wrote);
//   - what the clock recorded for that day, because a report filed against a day with no attendance
//     is a different thing from one filed against a day that was worked, and the person should see
//     that mismatch while they can still fix it.
//
// SCOPE. requireEmployee() resolves the employee id from the SESSION. There is no employee id in the
// query string, so there is no id to change in the address bar and no way to read somebody else's
// day.
import type { APIRoute } from 'astro';
import { requireEmployee } from '@/lib/auth/workspace-access';
import { attendanceFacts, getReport, dayStateSentence } from '@/lib/daily-report';
import { formatMinutes } from '@/lib/attendance';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET: APIRoute = async ({ url, locals }) => {
  const gate = await requireEmployee((locals as any).user, '/portal/employee/reports');
  if (!gate.ok) return json({ ok: false, error: gate.title || 'unavailable' }, 403);

  const d = String(url.searchParams.get('d') || '');
  if (!DATE_RE.test(d)) return json({ ok: false, error: 'Pick a day.' }, 400);

  const employeeId = gate.workspace.employeeId;
  const [report, facts] = await Promise.all([
    getReport(employeeId, d),
    attendanceFacts([employeeId], d, d),
  ]);
  const fact = facts.get(employeeId)?.get(d) || null;

  return json({
    ok: true,
    date: d,
    existing: report
      ? {
          revision: report.revision,
          summary: report.summary,
          blockers: report.blockers,
          url: report.url,
          reviewedAt: report.reviewedAt,
        }
      : null,
    attendance: fact
      ? {
          state: fact.state,
          sentence: dayStateSentence(fact.state),
          // NULL on an incomplete day, and rendered as "not known" rather than as a zero.
          worked: fact.workedMinutes === null ? null : formatMinutes(fact.workedMinutes),
        }
      : null,
  });
};

// GET /api/aquintutor/lms/export?course=<id>[&section=<id>] — the registrar's grade export.
//
// GATED THE SAME WAY THE GRADEBOOK PAGE IS, and for the same reason: this file is the gradebook,
// in one request, in a format that leaves the building. A route that returned a CSV of a cohort's
// grades to anybody holding a course id would be the single worst leak in this spine, so the teach
// claim is resolved from the SESSION user server-side, never from anything in the query string.
import type { APIRoute } from 'astro';
import { teachClaim } from '@/lib/lms/access';
import { gradebookMatrix } from '@/lib/lms/gradebook';
import { buildGradeCsv } from '@/lib/lms/interop';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const prerender = false;

function text(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return text('Sign in required', 401);

  const courseId = String(url.searchParams.get('course') || '');
  const sectionId = String(url.searchParams.get('section') || '') || null;
  if (!courseId) return text('course is required', 400);

  const claim = await teachClaim(user, courseId);
  if (!claim.canGrade) return text('You do not have grading access to this course', 403);

  try {
    const matrix = await gradebookMatrix(courseId, sectionId);
    const csv = buildGradeCsv(matrix);

    let slug = 'course';
    try {
      const r = await db.execute(sql`SELECT slug FROM training_courses WHERE id = ${courseId} LIMIT 1`);
      const rowList = Array.isArray(r) ? r : ((r as any)?.rows || []);
      slug = rowList[0]?.slug || 'course';
    } catch (e: any) {
      console.error('[lms/export] slug:', e?.cause?.message || e?.message);
    }

    // The BOM keeps a spreadsheet from mangling non-ASCII names on open, which is most of them here.
    return new Response('﻿' + csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="grades-' + slug + (sectionId ? '-section' : '') + '.csv"',
        'cache-control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[lms/export]', e?.cause?.message || e?.message);
    return text('The export failed: ' + (e?.cause?.message || e?.message || 'unknown error'), 500);
  }
};

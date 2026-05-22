// src/pages/api/search.ts - Global Cmd+K search
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ results: [] }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length < 2) {
    return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } });
  }

  const pattern = '%' + q.toLowerCase() + '%';
  const results: any[] = [];

  // Static pages - fast match
  const STATIC_PAGES = [
    { name: 'Dashboard', url: '/admin', cat: 'page' },
    { name: 'Applications', url: '/admin/applications', cat: 'page' },
    { name: 'Users', url: '/admin/users', cat: 'page' },
    { name: 'DMs / Messages', url: '/admin/messages', cat: 'page' },
    { name: 'Offer Letters', url: '/admin/offers', cat: 'page' },
    { name: 'HR Management', url: '/admin/hr', cat: 'page' },
    { name: 'Employees', url: '/admin/hr/employees', cat: 'page' },
    { name: 'Payroll', url: '/admin/hr/payroll', cat: 'page' },
    { name: 'Attendance', url: '/admin/hr/attendance', cat: 'page' },
    { name: 'Leave', url: '/admin/hr/leave', cat: 'page' },
    { name: 'Training & Courses', url: '/admin/hr/training', cat: 'page' },
    { name: 'Performance Reviews', url: '/admin/hr/performance', cat: 'page' },
    { name: 'Analytics', url: '/admin/analytics', cat: 'page' },
    { name: 'Audit Log', url: '/admin/audit', cat: 'page' },
    { name: 'Notifications', url: '/admin/notifications', cat: 'page' },
    { name: 'Settings', url: '/admin/settings', cat: 'page' },
    { name: 'Face 2FA Settings', url: '/admin/settings/face', cat: 'page' },
    { name: 'Roles', url: '/admin/roles', cat: 'page' },
    { name: 'Departments', url: '/admin/departments', cat: 'page' },
    { name: 'Events', url: '/admin/events', cat: 'page' },
    { name: 'Custom Sections', url: '/admin/sections', cat: 'page' },
    { name: 'SOS & Safety', url: '/admin/sos', cat: 'page' },
    { name: 'Content Moderation', url: '/admin/moderation', cat: 'page' },
    { name: 'HEI Editorial', url: '/admin/hei', cat: 'page' },
    { name: 'HEI Leads', url: '/admin/hei/leads', cat: 'page' },
    { name: 'HEI Surveys', url: '/admin/hei/surveys', cat: 'page' },
    { name: 'HEI RTI Filings', url: '/admin/hei/rti', cat: 'page' },
  ];

  const qLow = q.toLowerCase();
  for (const p of STATIC_PAGES) {
    if (p.name.toLowerCase().includes(qLow)) {
      results.push({ type: 'page', title: p.name, url: p.url, subtitle: p.url });
    }
  }

  // Users
  try {
    const r = await db.execute(sql`
      SELECT id, name, email, role FROM users
      WHERE LOWER(name) LIKE ${pattern} OR LOWER(email) LIKE ${pattern}
      ORDER BY name LIMIT 6
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    for (const u of rows as any[]) {
      results.push({ type: 'user', title: u.name, subtitle: u.email + ' - ' + (u.role || ''), url: '/admin/users?filter=' + (u.role === 'applicant' ? 'applicants' : 'admins') });
    }
  } catch(e) {}

  // Applications
  try {
    const r = await db.execute(sql`
      SELECT id, application_number, first_name, last_name, email, status, role_title_snapshot
      FROM applications
      WHERE LOWER(first_name) LIKE ${pattern} OR LOWER(last_name) LIKE ${pattern}
        OR LOWER(email) LIKE ${pattern} OR LOWER(application_number) LIKE ${pattern}
      ORDER BY created_at DESC LIMIT 6
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    for (const a of rows as any[]) {
      results.push({
        type: 'application',
        title: (a.first_name || '') + ' ' + (a.last_name || '') + ' - ' + (a.role_title_snapshot || 'Application'),
        subtitle: a.application_number + ' - ' + a.email + ' [' + a.status + ']',
        url: '/admin/applications/' + a.id
      });
    }
  } catch(e) {}

  // Courses
  try {
    const r = await db.execute(sql`
      SELECT id, slug, title, instructor_name FROM training_courses
      WHERE LOWER(title) LIKE ${pattern} OR LOWER(instructor_name) LIKE ${pattern}
      LIMIT 5
    `);
    const rows = Array.isArray(r) ? r : (r?.rows || []);
    for (const c of rows as any[]) {
      results.push({ type: 'course', title: c.title, subtitle: 'by ' + (c.instructor_name || 'EduRankAI'), url: '/admin/hr/training' });
    }
  } catch(e) {}

  // HEI Institutions
  try {
    const r = await db.execute(sql`
      SELECT id, name FROM hei_institutions
      WHERE LOWER(name) LIKE ${pattern} LIMIT 5
    `).catch(() => null);
    const rows = r ? (Array.isArray(r) ? r : (r?.rows || [])) : [];
    for (const i of rows as any[]) {
      results.push({ type: 'institution', title: i.name, subtitle: 'HEI', url: '/admin/hei/institutions' });
    }
  } catch(e) {}

  return new Response(JSON.stringify({ results: results.slice(0, 20) }), {
    headers: { 'Content-Type': 'application/json' }
  });
};

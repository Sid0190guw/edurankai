import type { APIRoute } from 'astro';
import { SITE } from '@/lib/site';
import { db } from '@/lib/db';
import { roles } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

const STATIC_ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/hei', changefreq: 'monthly', priority: '0.9' },
  { path: '/research', changefreq: 'monthly', priority: '0.9' },
  { path: '/ecosystem', changefreq: 'monthly', priority: '0.8' },
  { path: '/careers', changefreq: 'daily', priority: '0.9' },
  { path: '/aquintutor', changefreq: 'weekly', priority: '0.9' },
  { path: '/aquintutor/courses', changefreq: 'daily', priority: '0.9' },
  { path: '/aquintutor/paths', changefreq: 'weekly', priority: '0.85' },
  { path: '/aquintutor/instructors', changefreq: 'weekly', priority: '0.8' },
  { path: '/events', changefreq: 'weekly', priority: '0.7' },
  { path: '/policy', changefreq: 'monthly', priority: '0.6' },
  { path: '/contact', changefreq: 'monthly', priority: '0.7' },
  { path: '/about', changefreq: 'monthly', priority: '0.8' },
  { path: '/faq', changefreq: 'monthly', priority: '0.7' },
  { path: '/accessibility', changefreq: 'yearly', priority: '0.4' },
  { path: '/p/privacy', changefreq: 'yearly', priority: '0.4' },
  { path: '/p/terms', changefreq: 'yearly', priority: '0.4' },
  { path: '/p/hiring-philosophy', changefreq: 'yearly', priority: '0.5' },
];

export const GET: APIRoute = async () => {
  const today = new Date().toISOString().split('T')[0];

  // Dynamic: every open role gets a sitemap entry so Google for Jobs crawls them
  let openRoles: Array<{ slug: string; updatedAt: Date | null }> = [];
  try {
    openRoles = await db.select({
      slug: roles.slug,
      updatedAt: roles.updatedAt,
    }).from(roles).where(eq(roles.isOpen, true)).orderBy(desc(roles.updatedAt));
  } catch (_) {
    // DB unreachable - degrade to static sitemap
  }

  const { sql: rawSql } = await import('drizzle-orm');

  // Public published courses for Course rich-results
  let publicCourses: Array<{ slug: string; updated_at: any }> = [];
  try {
    const r = await db.execute(rawSql`
      SELECT slug, updated_at FROM training_courses
      WHERE is_published = true AND access_type IN ('public', 'both')
      ORDER BY updated_at DESC LIMIT 500
    `);
    publicCourses = (Array.isArray(r) ? r : (r?.rows || [])) as any[];
  } catch (_) {}

  // Learning paths
  let publicPaths: Array<{ slug: string; updated_at: any }> = [];
  try {
    const r = await db.execute(rawSql`SELECT slug, updated_at FROM training_paths WHERE is_published = true ORDER BY updated_at DESC LIMIT 200`);
    publicPaths = (Array.isArray(r) ? r : (r?.rows || [])) as any[];
  } catch (_) {}

  // Instructor profiles
  let publicInstructors: Array<{ slug: string; updated_at: any }> = [];
  try {
    const r = await db.execute(rawSql`SELECT slug, updated_at FROM training_instructors ORDER BY updated_at DESC LIMIT 500`);
    publicInstructors = (Array.isArray(r) ? r : (r?.rows || [])) as any[];
  } catch (_) {}

  const staticUrls = STATIC_ROUTES.map((r) => {
    return '  <url>'
      + '<loc>' + SITE.url + r.path + '</loc>'
      + '<lastmod>' + today + '</lastmod>'
      + '<changefreq>' + r.changefreq + '</changefreq>'
      + '<priority>' + r.priority + '</priority>'
      + '</url>';
  });

  const roleUrls = openRoles.map((r) => {
    const lastmod = r.updatedAt
      ? new Date(r.updatedAt).toISOString().split('T')[0]
      : today;
    return '  <url>'
      + '<loc>' + SITE.url + '/careers/' + r.slug + '</loc>'
      + '<lastmod>' + lastmod + '</lastmod>'
      + '<changefreq>weekly</changefreq>'
      + '<priority>0.85</priority>'
      + '</url>';
  });

  const courseUrls = publicCourses.map((c) => {
    const lastmod = c.updated_at
      ? new Date(c.updated_at).toISOString().split('T')[0]
      : today;
    return '  <url>'
      + '<loc>' + SITE.url + '/aquintutor/courses/' + c.slug + '</loc>'
      + '<lastmod>' + lastmod + '</lastmod>'
      + '<changefreq>weekly</changefreq>'
      + '<priority>0.8</priority>'
      + '</url>';
  });

  const pathUrls = publicPaths.map((p) => {
    const lastmod = p.updated_at ? new Date(p.updated_at).toISOString().split('T')[0] : today;
    return '  <url>'
      + '<loc>' + SITE.url + '/aquintutor/paths/' + p.slug + '</loc>'
      + '<lastmod>' + lastmod + '</lastmod>'
      + '<changefreq>weekly</changefreq>'
      + '<priority>0.78</priority>'
      + '</url>';
  });

  const instructorUrls = publicInstructors.map((i) => {
    const lastmod = i.updated_at ? new Date(i.updated_at).toISOString().split('T')[0] : today;
    return '  <url>'
      + '<loc>' + SITE.url + '/aquintutor/instructors/' + i.slug + '</loc>'
      + '<lastmod>' + lastmod + '</lastmod>'
      + '<changefreq>monthly</changefreq>'
      + '<priority>0.7</priority>'
      + '</url>';
  });

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + staticUrls.concat(roleUrls).concat(courseUrls).concat(pathUrls).concat(instructorUrls).join('\n') + '\n'
    + '</urlset>\n';

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=900',
    },
  });
};

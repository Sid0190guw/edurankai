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
  // The department directory and the research search. Both are category pages in the sense the
  // structured-data guidance means: stable canonical URLs that group postings and are worth
  // crawling in their own right, not just as a route to a job.
  { path: '/careers/departments', changefreq: 'weekly', priority: '0.85' },
  { path: '/careers/opportunities', changefreq: 'daily', priority: '0.85' },
  { path: '/aquintutor', changefreq: 'weekly', priority: '0.9' },
  { path: '/aquintutor/schools', changefreq: 'weekly', priority: '0.88' },
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
  // Official policy documents - high priority for SEO + recruiter discovery
  { path: '/policy/hiring',       changefreq: 'monthly', priority: '0.9' },
  { path: '/policy/recruitment',  changefreq: 'monthly', priority: '0.9' },
  { path: '/policy/work-culture', changefreq: 'monthly', priority: '0.85' },
  // Visvambhara aerospace research product
  { path: '/products/visvambhara', changefreq: 'weekly', priority: '0.9' },
  { path: '/products/akasha-q', changefreq: 'weekly', priority: '0.9' },
];

export const GET: APIRoute = async () => {
  const today = new Date().toISOString().split('T')[0];

  // Dynamic: every open role gets a sitemap entry so Google for Jobs crawls them
  //
  // A FAILURE HERE MUST NOT BE CACHED. MEASURED ON THE LIVE SITE, 2026-08-24.
  //
  // https://www.edurankai.in/sitemap.xml served 101 URLs, of which ZERO were job postings. The same
  // URL with a cache-busting query string, seconds later, served 1,092. Generation was never
  // broken: one request had lost the database, this catch swallowed it, the role-less sitemap was
  // returned with `max-age=900`, and the CDN pinned that answer for fifteen minutes and handed it
  // to every crawler that asked.
  //
  // Connecting to this database fails intermittently -- roughly one attempt in four stalls while
  // the same database answers a reused connection in ~130ms -- so this is not a rare event. Every
  // time it happens, Google for Jobs is told this company has no openings, for fifteen minutes, and
  // nothing anywhere reports it. A short sitemap still validates.
  //
  // That is the same defect the middleware already refuses to make for HTML pages: it will not
  // CDN-cache a render that set `x-era-degraded`. This route builds its own Response and never
  // participated in that rule, so it makes the guarantee itself, below.
  let openRoles: Array<{ slug: string; updatedAt: Date | null; isFeatured: boolean | null }> = [];
  let rolesReadable = true;
  try {
    openRoles = await db.select({
      slug: roles.slug,
      updatedAt: roles.updatedAt,
      isFeatured: roles.isFeatured,
    }).from(roles).where(eq(roles.isOpen, true)).orderBy(desc(roles.updatedAt));
  } catch (e: any) {
    // The real Postgres reason, not the failed SQL. Logged rather than swallowed silently: this
    // went unnoticed precisely because nothing said anything.
    console.error('[sitemap] open roles query failed:', e?.cause?.message || e?.message);
    rolesReadable = false;
  }

  // Department and division pages. Both degrade to nothing rather than taking the sitemap down:
  // a sitemap that 500s is worse for indexing than one that is a few URLs short, and `divisions`
  // does not exist on a database where db/xscale-schema.sql has not been run yet.
  let departmentIds: string[] = [];
  let divisionSlugs: string[] = [];
  const { sql: s1 } = await import('drizzle-orm');
  try {
    const dr: any = await db.execute(s1`
      SELECT DISTINCT d.id
        FROM departments d
        JOIN roles r ON r.department_id = d.id
       WHERE d.is_visible = TRUE
         AND r.is_open = TRUE
         AND COALESCE(r.job_status, 'PUBLISHED') = 'PUBLISHED'
         AND (r.application_deadline IS NULL OR r.application_deadline > NOW())`);
    departmentIds = (Array.isArray(dr) ? dr : (dr?.rows || [])).map((x: any) => String(x.id));
  } catch (_) {
    // job_status is an additive column that only exists once db/xscale-schema.sql has been applied
    // by hand. Without this retry the sitemap silently ships with ZERO department URLs on a
    // database that has every one of those pages live - the failure is invisible because a short
    // sitemap still validates. Where the column is absent the predicate is a no-op anyway
    // (COALESCE(NULL,'PUBLISHED') = 'PUBLISHED'), so dropping it changes nothing but the outcome.
    try {
      const dr2: any = await db.execute(s1`
        SELECT DISTINCT d.id
          FROM departments d
          JOIN roles r ON r.department_id = d.id
         WHERE d.is_visible = TRUE
           AND r.is_open = TRUE
           AND (r.application_deadline IS NULL OR r.application_deadline > NOW())`);
      departmentIds = (Array.isArray(dr2) ? dr2 : (dr2?.rows || [])).map((x: any) => String(x.id));
    } catch (_2) { /* no department pages in the sitemap; the rest of it still ships */ }
  }
  try {
    const { sql: s2 } = await import('drizzle-orm');
    const vr: any = await db.execute(s2`
      SELECT slug FROM divisions WHERE is_visible = TRUE ORDER BY sort_order ASC`);
    divisionSlugs = (Array.isArray(vr) ? vr : (vr?.rows || [])).map((x: any) => String(x.slug));
  } catch (_) { /* the divisions table is absent on a database without the migration */ }

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

  // Schools (each gets its own detail page at /aquintutor/schools/[slug])
  let publicSchools: Array<{ slug: string; updated_at: any }> = [];
  try {
    const r = await db.execute(rawSql`SELECT slug, updated_at FROM schools WHERE is_published = true ORDER BY display_order ASC`);
    publicSchools = (Array.isArray(r) ? r : (r?.rows || [])) as any[];
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
    // Flagship (featured) roles are the ones we most want crawled and surfaced, so they get the
    // highest role priority and a daily changefreq rather than sitting level with every other post.
    return '  <url>'
      + '<loc>' + SITE.url + '/careers/' + r.slug + '</loc>'
      + '<lastmod>' + lastmod + '</lastmod>'
      + '<changefreq>' + (r.isFeatured ? 'daily' : 'weekly') + '</changefreq>'
      + '<priority>' + (r.isFeatured ? '0.95' : '0.85') + '</priority>'
      + '</url>';
  });

  const departmentUrls = departmentIds.map((id) =>
    '  <url>'
    + '<loc>' + SITE.url + '/careers/department/' + id + '</loc>'
    + '<lastmod>' + today + '</lastmod>'
    + '<changefreq>weekly</changefreq>'
    + '<priority>0.8</priority>'
    + '</url>');

  const divisionUrls = divisionSlugs.map((slug) =>
    '  <url>'
    + '<loc>' + SITE.url + '/careers/division/' + slug + '</loc>'
    + '<lastmod>' + today + '</lastmod>'
    + '<changefreq>weekly</changefreq>'
    + '<priority>0.8</priority>'
    + '</url>');

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

  const schoolUrls = publicSchools.map((s) => {
    const lastmod = s.updated_at ? new Date(s.updated_at).toISOString().split('T')[0] : today;
    return '  <url>'
      + '<loc>' + SITE.url + '/aquintutor/schools/' + s.slug + '</loc>'
      + '<lastmod>' + lastmod + '</lastmod>'
      + '<changefreq>weekly</changefreq>'
      + '<priority>0.85</priority>'
      + '</url>';
  });

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + staticUrls.concat(roleUrls).concat(departmentUrls).concat(divisionUrls).concat(courseUrls).concat(pathUrls).concat(instructorUrls).concat(schoolUrls).join('\n') + '\n'
    + '</urlset>\n';

  // A sitemap missing every job posting is not a slightly smaller sitemap; it is a statement that
  // there are no jobs. It ships (a 500 is worse for indexing than a short file) but it is never
  // stored, so the next crawl re-asks instead of being handed the same wrong answer for 15 minutes.
  const degraded = !rolesReadable;
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': degraded ? 'no-store' : 'public, max-age=900',
    },
  });
};

import type { APIRoute } from 'astro';
import { SITE } from '@/lib/site';

const STATIC_ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/hei', changefreq: 'monthly', priority: '0.9' },
  { path: '/research', changefreq: 'monthly', priority: '0.9' },
  { path: '/ecosystem', changefreq: 'monthly', priority: '0.8' },
  { path: '/careers', changefreq: 'daily', priority: '0.9' },
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
  const urls = STATIC_ROUTES.map((r) => {
    return '  <url>'
      + '<loc>' + SITE.url + r.path + '</loc>'
      + '<lastmod>' + today + '</lastmod>'
      + '<changefreq>' + r.changefreq + '</changefreq>'
      + '<priority>' + r.priority + '</priority>'
      + '</url>';
  }).join('\n');

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls + '\n'
    + '</urlset>\n';

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};

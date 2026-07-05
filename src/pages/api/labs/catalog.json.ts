// GET /api/labs/catalog.json — the public labs API. An institution can read
// this to discover every licensable virtual lab and its embed URL, then wire
// them into its own LMS / virtual infrastructure (iframe, SDK, or LTI launch).
import type { APIRoute } from 'astro';
import { LABS } from '@/data/labs-catalog';

export const GET: APIRoute = async ({ url }) => {
  const origin = url.origin.includes('localhost') ? 'https://edurankai.in' : url.origin;
  const body = {
    provider: 'EduRankAI Virtual Labs',
    version: '1.0',
    embed: {
      iframe: origin + '/aquintutor/labs/{slug}?embed=1',
      sdk: origin + '/era-labs-embed.js',
      lti: 'LTI 1.3 launch available on request',
      events: 'postMessage: { source:"era-lab", type:"ready|progress|complete", slug, ... }',
    },
    count: LABS.length,
    labs: LABS.map((l) => ({
      slug: l.slug,
      title: l.title,
      category: l.category,
      flagship: !!l.flagship,
      description: l.blurb,
      url: origin + '/aquintutor/labs/' + l.slug,
      embedUrl: origin + '/aquintutor/labs/' + l.slug + '?embed=1',
    })),
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=600, s-maxage=3600',
    },
  });
};

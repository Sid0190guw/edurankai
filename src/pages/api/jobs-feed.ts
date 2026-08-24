import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { roles } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publicCompensation, isUnpaidTrainee, stripTraineePayProse, stripTraineePayItems } from '@/lib/compensation-text';
import { displayLocation, resolveWorkMode, workModeLabel } from '@/lib/work-mode';

export const prerender = false;

/* Public jobs feed — the single URL the Vrittih job board (www.vrittih.online)
 * reads to mirror EduRankAI's open roles. No database credentials leave this
 * app: only the currently-open, publicly-listed roles are exposed here, exactly
 * as they already appear on /careers. Vrittih fetches this once a day and
 * reconciles — a role that stops appearing here is deactivated there, a new one
 * appears automatically. This is the same JSON contract every EduRankAI-family
 * site can implement to plug into the shared board.
 *
 * Shape:  { generatedAt, count, jobs: [ { externalId, title, company,
 *           description, location, type, remote, workMode, salary, industry,
 *           applyUrl, closesAt } ] } */

const SITE = 'https://edurankai.in';
const COMPANY = 'EduRankAI';

// Map EduRankAI engagement types onto the feed's employment-type vocabulary.
const TYPE: Record<string, string> = {
  'Full-Time': 'FULLTIME',
  'Internship': 'INTERNSHIP',
  'Apprenticeship': 'CONTRACT',
};

// Nulling `salary` was not enough: this feed's own description carried
// "About this role: AI Research Intern - up to INR 3 LPA + research stipend." straight out of the
// stored `about`, and a board that mirrors the feed publishes the description too. For an unpaid
// trainee role the prose is filtered the same way the public page filters it.
function description(r: any): string {
  const parts: string[] = [];
  const unpaidTrainee = isUnpaidTrainee(r);
  const about = unpaidTrainee ? stripTraineePayProse(r.about) : r.about;
  if (about) parts.push(String(about).trim());
  const list = (label: string, items: unknown) => {
    const clean = unpaidTrainee ? stripTraineePayItems(items) : (Array.isArray(items) ? items : []);
    if (clean.length) parts.push(`${label}:\n` + clean.map((x) => `- ${x}`).join('\n'));
  };
  list('Responsibilities', r.responsibilities);
  list('Skills', r.skills);
  list('Eligibility', r.eligibility);
  return parts.join('\n\n');
}

function json(body: any, status = 200) {
  // A FAILED FEED IS NEVER CACHED, AND THE REASON IS NOT PERFORMANCE.
  //
  // This helper served one header set for every status, so the catch below -- which answers a
  // database failure with `{ count: 0, jobs: [] }` and a 500 -- went out as
  // `public, s-maxage=3600`. Vercel's CDN caches on status, so one transient pooler hiccup pinned
  // an EMPTY feed at the edge for an hour.
  //
  // Empty is not a neutral answer here. The mirror at www.vrittih.online reconciles against this
  // URL: a role that stops appearing is deactivated there. An hour of cached emptiness would have
  // read as "EduRankAI closed every posting" and unpublished the lot, from a blip that had already
  // passed. The same rule the middleware applies to a degraded page render -- never let a broken
  // response outlive the break -- applies to the feed a third party acts on.
  //
  // The happy path keeps the hour: the mirror only pulls daily, and stale-while-revalidate means a
  // pull at minute 61 is served instantly from the edge while one request refreshes behind it.
  const ok = status >= 200 && status < 300;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ok
        ? 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400'
        : 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

export const GET: APIRoute = async () => {
  try {
    const open = await db.select().from(roles).where(eq(roles.isOpen, true));

    const jobs = open
      .filter((r) => !r.applicationDeadline || new Date(r.applicationDeadline as any).getTime() > Date.now())
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((r) => ({
        externalId: r.slug,
        title: r.title,
        company: COMPANY,
        description: description(r),
        location: displayLocation(r.engagementType, r.level, r.location),
        type: TYPE[r.engagementType as string] || 'FULLTIME',
        // Always false. This used to be a regex over the stored location string, and since every
        // catalogue row said "Remote / Hybrid (India)" the mirrored board listed the entire
        // EduRankAI feed as remote work. Nothing here is remote; `workMode` carries the real
        // distinction (on-site everywhere, hybrid available on trainee engagements only).
        remote: false,
        workMode: workModeLabel(resolveWorkMode(r.engagementType, r.level, r.location)),
        // null for every internship and apprenticeship but the paid LLM programme. A board that
        // mirrors this feed cannot be made to un-publish a pay figure, so an unpaid trainee role
        // must never leave here carrying one, whatever /admin/roles has stored against it.
        salary: publicCompensation(r),
        industry: 'Education',
        applyUrl: `${SITE}/careers/${r.slug}`,
        closesAt: r.applicationDeadline ? new Date(r.applicationDeadline as any).toISOString() : null,
      }));

    return json({ generatedAt: new Date().toISOString(), count: jobs.length, jobs });
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the SQL that failed. This response
    // is public and sent with access-control-allow-origin '*', so the SQL used to be published to
    // anonymous callers -- table and column names included -- while the operator got nothing
    // usable. The reason now goes to the server log and the caller gets a fixed string.
    console.error('[jobs-feed] query failed:', e?.cause?.message || e?.message);
    return json({ error: 'feed temporarily unavailable', count: 0, jobs: [] }, 500);
  }
};

// GET /api/careers/posting?slug=... — ONE POSTING, FOR THE PREVIEW DIALOG.
//
// =================================================================================================
// WHY THIS EXISTS RATHER THAN SHIPPING THE DESCRIPTION WITH EVERY CARD
// =================================================================================================
//
// The results list carries up to twenty-four cards. A posting's `about` text runs to several
// hundred words, its responsibilities and eligibility to several more, and none of it is visible
// until somebody asks. Attaching all of that to every card would put a hundred kilobytes of prose
// into a response to show twelve lines of it — which is the same mistake, at a smaller scale, that
// the old /careers page made by rendering the whole catalogue.
//
// So the card stays compact and this is fetched once, when a person opens one.
//
// PUBLIC, CACHEABLE, AND IT ANSWERS FOR A CLOSED POSTING TOO. `getOpportunityBySlug` deliberately
// returns a posting whatever its status, because "this one has closed" is a thing a candidate needs
// to be TOLD rather than a 404 — the dialog renders that state and says so, and hides the apply
// button rather than offering a form that will be refused at submission.

import type { APIRoute } from 'astro';
import { getOpportunityBySlug } from '@/lib/xscale/roles-ext';
import { effectiveJobStatus, classificationDef, careerRung, scaleRangeText } from '@/lib/xscale/taxonomy';
import { displayLocation, resolveWorkMode, workModeLabel, workModeSentence } from '@/lib/work-mode';
import { json } from '@/lib/career-intel/wire';

export const prerender = false;

const strArray = (v: any): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const slug = (url.searchParams.get('slug') || '').trim().slice(0, 200);
  if (!slug) return json({ ok: false, error: 'No posting named.' }, 400);

  const found = await getOpportunityBySlug(slug);

  // readable:false means the READ FAILED. Not "no such posting" — the dialog renders the two
  // differently, because telling somebody a job does not exist when the database is unreachable is
  // a lie the system would be telling on its own initiative.
  if (!found.readable) {
    return json({ ok: false, readable: false, error: 'We could not load this posting just now.' }, 503);
  }
  if (!found.row) {
    return json({ ok: false, readable: true, notFound: true, error: 'That posting is no longer listed.' }, 404);
  }

  const r = found.row;
  const ext = found.ext;

  // THROUGH work-mode.ts, LIKE EVERY OTHER SURFACE. A dialog is a new place a posting is rendered,
  // and a new place is exactly where a legacy "Remote / Hybrid (India)" row gets to advertise remote
  // work again if the raw column is read directly.
  const mode = resolveWorkMode(r.engagement_type, r.level, r.location);

  const status = effectiveJobStatus({
    isOpen: r.is_open !== false,
    jobStatus: ext.jobStatus,
    applicationDeadline: r.application_deadline ? new Date(r.application_deadline) : null,
  } as any);

  // effectiveJobStatus returns the DEFINITION, not a string: its own words for the candidate, and
  // whether the apply route will accept them. Both travel, so the dialog can say what is happening
  // rather than silently hiding a button.
  const accepting = status.acceptsApplications === true;
  const cls = classificationDef(ext.researchClassification);
  const rung = careerRung(ext.careerLevel);
  const hasScale = typeof ext.scaleMinExp === 'number' && typeof ext.scaleMaxExp === 'number';

  return json({
    ok: true,
    readable: true,
    posting: {
      slug: String(r.slug),
      title: String(r.title),
      level: String(r.level || ''),
      functionText: String(r.function || ''),
      engagementType: String(r.engagement_type || ''),
      duration: r.duration ? String(r.duration) : null,
      location: displayLocation(r.engagement_type, r.level, r.location),
      workMode: workModeLabel(mode),
      workModeSentence: workModeSentence(mode, r.engagement_type, r.location),
      about: r.about ? String(r.about) : '',
      responsibilities: strArray(r.responsibilities),
      skills: strArray(r.skills),
      eligibility: strArray(r.eligibility),
      classification: cls ? cls.label : null,
      rung: rung ? rung.label : null,
      scale: hasScale ? scaleRangeText(ext.scaleMinExp as number, ext.scaleMaxExp as number) : null,
      deadline: r.application_deadline ? new Date(r.application_deadline).toISOString() : null,
      // The status a candidate needs to know, and whether the apply route will actually accept
      // them. Hiding the button is a courtesy; assertAcceptingApplications() on the server is the
      // rule, and this flag is derived from the same function so the two cannot disagree.
      status: status.key,
      statusLabel: status.label,
      statusNote: status.publicNote,
      accepting,
      href: '/careers/' + String(r.slug),
      applyHref: accepting ? '/apply?role=' + encodeURIComponent(String(r.slug)) : null,
    },
    // A posting is the same for everybody, so this is genuinely shareable at the edge.
  }, 200, 'public, max-age=60, s-maxage=300');
};

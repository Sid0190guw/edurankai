// SAMARTH events: hackathons, AI challenges, competitions, technology and research events, and
// institutional programmes (spec Part 10.2 B).
//
// BUILT ON THE PLATFORM'S EVENTS, NOT BESIDE THEM. A SAMARTH event is an ordinary row in `events`
// tagged 'samarth', so it gets the existing public page (/events/<slug>), registration
// (/events/register/<slug>), levels, fees, certificates and the full editor at /admin/events/<id>.
// What this module adds is the SAMARTH view of those events and the bridge from an event's
// registrants into the SAMARTH X evaluation pipeline (channel 'event').
//
// NOMINATION IS A PERSON'S DECISION. Nothing here nominates automatically; staff pick registrants.
// A registrant already nominated from the same registration is skipped, never duplicated.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createX } from '@/lib/samarth/x';
import { clean, zonedLocalToUtc, isTimeZone } from '@/lib/samarth/validate';
import { rows, num, iso, str, isUuid, json, audit, type Read, type ActorRef } from '@/lib/samarth/store-core';

export const SAMARTH_EVENT_TAG = 'samarth';

export const SAMARTH_EVENT_KINDS: readonly { value: string; label: string }[] = [
  { value: 'hackathon', label: 'Hackathon' },
  { value: 'ai-challenge', label: 'AI challenge' },
  { value: 'intelligent-systems', label: 'Intelligent systems competition' },
  { value: 'technology-event', label: 'Technology event' },
  { value: 'entrepreneurship', label: 'Entrepreneurship competition' },
  { value: 'research-event', label: 'Research event' },
  { value: 'institutional', label: 'Institutional programme' },
  { value: 'startup-challenge', label: 'Startup challenge' },
];

export function eventKindLabel(tags: string[]): string {
  const t = tags.find((x) => x.startsWith('samarth-'));
  return SAMARTH_EVENT_KINDS.find((k) => 'samarth-' + k.value === t)?.label || 'Event';
}

export interface SamarthEvent {
  id: string; slug: string; title: string; description: string; mode: string; status: string;
  startsAt: string | null; endsAt: string | null; location: string; capacity: number | null; tags: string[];
  registrations: number; nominated: number;
}

const toEvent = (r: any): SamarthEvent => ({
  id: str(r.id), slug: str(r.slug), title: str(r.title), description: str(r.description), mode: str(r.mode), status: str(r.status),
  startsAt: iso(r.starts_at), endsAt: iso(r.ends_at), location: str(r.location), capacity: num(r.capacity),
  tags: Array.isArray(r.tags) ? r.tags.map(String) : [], registrations: num(r.registrations) || 0, nominated: num(r.nominated) || 0,
});

async function readEvents(publicOnly: boolean): Promise<SamarthEvent[]> {
  // The registration count is read separately and tolerated: an event can exist before anybody
  // registers, and on a deployment where event_registrations has never been created.
  const list = rows(await db.execute(sql`
    SELECT id, slug, title, description, mode::text AS mode, status::text AS status, starts_at, ends_at, location, capacity, tags
      FROM events
     WHERE tags ? ${SAMARTH_EVENT_TAG}
       AND (${publicOnly} = false OR status::text IN ('upcoming', 'past'))
     ORDER BY starts_at DESC NULLS LAST
     LIMIT 200`)).map(toEvent);
  if (!list.length) return list;
  try {
    const ids = json(list.map((e) => e.id));
    const counts = rows(await db.execute(sql`
      SELECT event_id, COUNT(*)::int AS n FROM event_registrations
       WHERE event_id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid) GROUP BY event_id`));
    const byId = new Map(counts.map((c) => [str(c.event_id), num(c.n) || 0]));
    for (const e of list) e.registrations = byId.get(e.id) || 0;
  } catch (e: any) {
    console.error('[samarth/events] registration counts unavailable:', String(e?.cause?.message || e?.message || e));
  }
  return list;
}

export async function listSamarthEvents(publicOnly: boolean): Promise<Read<SamarthEvent[]>> {
  try {
    return { ready: true, value: await readEvents(publicOnly) };
  } catch (e: any) {
    console.error('[samarth/events] list failed:', String(e?.cause?.message || e?.message || e));
    return { ready: false, error: 'Events could not be read just now (' + String(e?.cause?.message || e?.message || 'unknown error').slice(0, 160) + ').' };
  }
}

export interface NewEventInput {
  title: string; kind: string; description: string; longDescription: string; mode: string; status: string;
  startsAt: string; endsAt: string; location: string; capacity: string;
  /** IANA zone the organiser typed the times in. */
  timezone: string;
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'event';
}

/** Create a platform event tagged for SAMARTH. Draft unless the organiser publishes it. */
export async function createSamarthEvent(input: NewEventInput, who: ActorRef): Promise<{ ok: true; id: string; slug: string } | { ok: false; error: string }> {
  const title = clean(input.title, 300);
  if (title.length < 4) return { ok: false, error: 'Give the event a title.' };
  if (!SAMARTH_EVENT_KINDS.some((k) => k.value === input.kind)) return { ok: false, error: 'Choose the kind of event.' };
  if (!['online', 'in_person', 'hybrid'].includes(input.mode)) return { ok: false, error: 'Choose online, in person or hybrid.' };
  const status = input.status === 'upcoming' ? 'upcoming' : 'draft';
  const tz = isTimeZone(input.timezone) ? input.timezone : 'Asia/Kolkata';
  const starts = zonedLocalToUtc(input.startsAt, tz);
  if (!starts) return { ok: false, error: 'Enter the start date and time.' };
  const ends = input.endsAt ? zonedLocalToUtc(input.endsAt, tz) : null;
  if (input.endsAt && !ends) return { ok: false, error: 'The end date and time is not valid.' };
  if (ends && ends < starts) return { ok: false, error: 'The end must be after the start.' };
  const capacity = input.capacity ? Math.max(1, Math.min(1_000_000, parseInt(input.capacity, 10) || 0)) : null;
  const tags = [SAMARTH_EVENT_TAG, 'samarth-' + input.kind];
  try {
    const base = slugify(title);
    for (let n = 1; n <= 20; n++) {
      const slug = n === 1 ? base : base + '-' + n;
      const r = rows(await db.execute(sql`
        INSERT INTO events (slug, title, description, long_description, mode, status, starts_at, ends_at, location, capacity, tags, is_featured)
        VALUES (${slug}, ${title}, ${clean(input.description, 2000, true)}, ${clean(input.longDescription, 20000, true) || null},
                ${input.mode}::event_mode, ${status}::event_status, ${starts.toISOString()}::timestamptz, ${ends ? ends.toISOString() : null}::timestamptz,
                ${clean(input.location, 300) || null}, ${capacity}, ${json(tags)}::jsonb, false)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id`));
      if (r.length && r[0]?.id) {
        await audit(who, 'samarth.event.create', 'event', str(r[0].id), { slug, kind: input.kind, status });
        return { ok: true, id: str(r[0].id), slug };
      }
    }
    return { ok: false, error: 'Could not find a free address for this event. Change the title slightly.' };
  } catch (e: any) {
    console.error('[samarth/events] create failed:', String(e?.cause?.message || e?.message || e));
    return { ok: false, error: 'The event was not created: ' + String(e?.cause?.message || e?.message || 'unknown error').slice(0, 200) };
  }
}

export interface Registrant { id: string; name: string; email: string; institution: string; city: string; createdAt: string | null; nominatedRef: string }

export async function registrantsFor(eventId: string): Promise<Read<Registrant[]>> {
  if (!isUuid(eventId)) return { ready: true, value: [] };
  try {
    const list = rows(await db.execute(sql`
      SELECT id, participant_name, participant_email, institution, participant_city, created_at
        FROM event_registrations WHERE event_id = ${eventId}::uuid ORDER BY created_at DESC LIMIT 500`)).map((r) => ({
      id: str(r.id), name: str(r.participant_name), email: str(r.participant_email), institution: str(r.institution), city: str(r.participant_city),
      createdAt: iso(r.created_at), nominatedRef: '',
    }));
    if (list.length) {
      try {
        const done = rows(await db.execute(sql`
          SELECT source_reference, ref FROM samarth_x_candidates
           WHERE channel = 'event' AND source_reference IN (SELECT jsonb_array_elements_text(${json(list.map((x) => x.id))}::jsonb))`));
        const byReg = new Map(done.map((d) => [str(d.source_reference), str(d.ref)]));
        for (const r of list) r.nominatedRef = byReg.get(r.id) || '';
      } catch { /* SAMARTH not set up yet: nothing has been nominated */ }
    }
    return { ready: true, value: list };
  } catch (e: any) {
    return { ready: false, error: 'Registrations could not be read (' + String(e?.cause?.message || e?.message || 'unknown error').slice(0, 160) + ').' };
  }
}

/** Nominate chosen registrants into SAMARTH X. Already-nominated registrations are skipped. */
export async function nominateRegistrants(eventId: string, registrationIds: string[], who: ActorRef): Promise<{ added: string[]; skipped: number; failed: string[] }> {
  const added: string[] = [];
  const failed: string[] = [];
  let skipped = 0;
  const ev = rows(await db.execute(sql`SELECT title FROM events WHERE id = ${eventId}::uuid LIMIT 1`))[0];
  const eventTitle = str(ev?.title) || 'a SAMARTH event';
  const regs = await registrantsFor(eventId);
  if (!regs.ready) return { added, skipped, failed: [regs.error] };
  const wanted = new Set(registrationIds.filter(isUuid));
  for (const r of regs.value.filter((x) => wanted.has(x.id))) {
    if (r.nominatedRef) { skipped++; continue; }
    const res = await createX({
      applicantKind: 'individual', name: r.name || r.email, email: r.email, phone: '', country: '', team: [], ventureName: '',
      problem: 'Nominated from ' + eventTitle + (r.institution ? ' (' + r.institution + ')' : '') + '. Details to be added by the reviewer or the candidate.',
      domain: '', proposedSystem: '', skills: '', previousWork: '', githubUrl: '', portfolioUrl: '', prototypeUrl: '', vision: '', market: '',
      // Not the candidate's own consent: they registered for an event and a person nominated them.
      resourcesNeeded: '', consentPrivacy: false, sourceEvent: eventTitle, sourceReference: r.id, nominatedBy: who.name,
    }, 'event', who);
    if (res.ok) added.push(res.ref);
    else failed.push((r.name || r.email) + ': ' + res.error);
  }
  return { added, skipped, failed };
}

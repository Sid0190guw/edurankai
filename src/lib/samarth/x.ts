// SAMARTH X: one evaluation pipeline for all three entry channels (spec Part 10.6).
//
//   eoi          the public expression of interest at /samarth/x/apply
//   event        a hackathon, challenge or competition nomination, entered by staff
//   recruitment  an exceptional candidate from EduRankAI hiring, entered by staff. The hiring
//                decision and the venture decision stay separate: this record carries only a
//                reference to the recruitment record, never its status.
//
// NO FEE, ANYWHERE. Nothing in this module or its pages creates a payment order.
//
// Selection needs reviews; formal incubation needs a cohort, a recorded agreement (IP, resources and
// any equity, in writing) and a free place among the best six of that cohort. The advisory ranking in
// x-scoring.ts orders candidates for the panel and never changes a status by itself.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { canTransition, MIN_REVIEWS_TO_SELECT, INCUBATION_PLACES, X_CHANNELS, type Actor } from '@/lib/samarth/workflow';
import { reviewTotal, aggregate, type Scores, type Aggregate } from '@/lib/samarth/x-scoring';
import { clean, cleanEmail, cleanPhone, cleanUrl, isCountryCode, newRef, newToken, hashToken } from '@/lib/samarth/validate';
import {
  rows, readSafely, writeSafely, num, iso, isoDay, str, isUuid, json, addEvent, audit,
  type Read, type Write, type ActorRef, SYSTEM_ACTOR,
} from '@/lib/samarth/store-core';

export interface TeamMember { name: string; role: string; link: string }

export interface XCandidate {
  id: string; ref: string; channel: string; status: string; applicantKind: string; name: string; email: string; phone: string; country: string;
  team: TeamMember[]; ventureName: string; problem: string; domain: string; proposedSystem: string; skills: string; previousWork: string;
  githubUrl: string; portfolioUrl: string; prototypeUrl: string; vision: string; market: string; resourcesNeeded: string;
  sourceEvent: string; sourceReference: string; nominatedBy: string; cohort: string; agreementReference: string; decisionNote: string;
  accessHash: string; createdAt: string | null; updatedAt: string | null;
}

export const toX = (r: any): XCandidate => ({
  id: str(r.id), ref: str(r.ref), channel: str(r.channel), status: str(r.status), applicantKind: str(r.applicant_kind), name: str(r.name), email: str(r.email),
  phone: str(r.phone), country: str(r.country), team: Array.isArray(r.team) ? r.team : [], ventureName: str(r.venture_name), problem: str(r.problem),
  domain: str(r.domain), proposedSystem: str(r.proposed_system), skills: str(r.skills), previousWork: str(r.previous_work),
  githubUrl: str(r.github_url), portfolioUrl: str(r.portfolio_url), prototypeUrl: str(r.prototype_url), vision: str(r.vision), market: str(r.market),
  resourcesNeeded: str(r.resources_needed), sourceEvent: str(r.source_event), sourceReference: str(r.source_reference), nominatedBy: str(r.nominated_by),
  cohort: str(r.cohort), agreementReference: str(r.agreement_reference), decisionNote: str(r.decision_note), accessHash: str(r.access_hash),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export const X_DOMAINS: readonly string[] = [
  'AI systems and agents', 'Machine learning and data', 'Computer vision', 'Robotics and autonomous systems', 'Industrial and manufacturing technology',
  'Healthcare technology', 'Education technology', 'Climate and energy technology', 'Infrastructure and computing', 'Financial technology', 'Other',
];

export interface XInput {
  applicantKind: string; name: string; email: string; phone: string; country: string; team: TeamMember[]; ventureName: string; problem: string;
  domain: string; proposedSystem: string; skills: string; previousWork: string; githubUrl: string; portfolioUrl: string; prototypeUrl: string;
  vision: string; market: string; resourcesNeeded: string; consentPrivacy: boolean;
  sourceEvent?: string; sourceReference?: string; nominatedBy?: string;
}

/** Read the expression-of-interest form (also used by staff for nominations). */
export function parseX(get: (n: string) => string, staffEntry = false): { value: XInput; problems: string[] } {
  const problems: string[] = [];
  const email = cleanEmail(get('email'));
  const team: TeamMember[] = [];
  for (let i = 0; i < 6; i++) {
    const n = clean(get('team_name_' + i), 200);
    if (!n) continue;
    const linkRaw = clean(get('team_link_' + i), 800);
    team.push({ name: n, role: clean(get('team_role_' + i), 200), link: (linkRaw && cleanUrl(linkRaw)) || '' });
  }
  const urlField = (k: string) => { const raw = clean(get(k), 800); const u = raw ? cleanUrl(raw) : ''; if (raw && !u) problems.push('The ' + k.replace('_url', '') + ' link must be a full address starting with https://'); return u || ''; };
  const phoneRaw = clean(get('phone'), 32);
  const value: XInput = {
    applicantKind: get('applicant_kind') === 'team' ? 'team' : 'individual', name: clean(get('name'), 200), email: email || '',
    phone: (phoneRaw && cleanPhone(phoneRaw)) || '', country: clean(get('country'), 2).toUpperCase(), team,
    ventureName: clean(get('venture_name'), 200), problem: clean(get('problem'), 4000, true), domain: clean(get('domain'), 120),
    proposedSystem: clean(get('proposed_system'), 4000, true), skills: clean(get('skills'), 3000, true), previousWork: clean(get('previous_work'), 4000, true),
    githubUrl: urlField('github_url'), portfolioUrl: urlField('portfolio_url'), prototypeUrl: urlField('prototype_url'),
    vision: clean(get('vision'), 3000, true), market: clean(get('market'), 3000, true), resourcesNeeded: clean(get('resources_needed'), 3000, true),
    consentPrivacy: staffEntry || get('consent_privacy') === 'yes',
    sourceEvent: clean(get('source_event'), 300), sourceReference: clean(get('source_reference'), 300), nominatedBy: clean(get('nominated_by'), 200),
  };
  if (value.name.length < 2) problems.push('Enter your name.');
  if (!email) problems.push('Enter a valid email address.');
  if (phoneRaw && !value.phone) problems.push('That phone number does not look right.');
  if (!isCountryCode(value.country)) problems.push('Choose your country.');
  if (value.applicantKind === 'team' && !team.length) problems.push('Add at least one other team member, or apply as an individual.');
  if (!staffEntry) {
    if (value.problem.length < 40) problems.push('Describe the problem you want to solve (a few sentences).');
    if (value.proposedSystem.length < 40) problems.push('Describe the AI or intelligent system you propose to build.');
    if (!X_DOMAINS.includes(value.domain)) problems.push('Choose a technology domain.');
    if (value.skills.length < 20) problems.push('Describe your technical skills.');
    if (!value.consentPrivacy) problems.push('Please confirm you have read how your information is used.');
  } else if (value.problem.length < 10) problems.push('Describe what the candidate is working on.');
  return { value, problems };
}

export async function createX(input: XInput, channel: string, who: ActorRef): Promise<Write<{ id: string; ref: string; token: string }>> {
  if (!X_CHANNELS.some((c) => c.value === channel)) return { ok: false, error: 'Unknown entry channel.' };
  return writeSafely('saving the application', async () => {
    const token = newToken();
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = newRef('X');
      try {
        const r = rows(await db.execute(sql`
          INSERT INTO samarth_x_candidates (ref, channel, applicant_kind, name, email, phone, country, team, venture_name, problem, domain, proposed_system,
            skills, previous_work, github_url, portfolio_url, prototype_url, vision, market, resources_needed, source_event, source_reference, nominated_by,
            consent_privacy, access_hash)
          VALUES (${ref}, ${channel}, ${input.applicantKind}, ${input.name}, ${input.email}, ${input.phone || null}, ${input.country}, ${json(input.team)}::jsonb,
            ${input.ventureName || null}, ${input.problem || null}, ${input.domain || null}, ${input.proposedSystem || null}, ${input.skills || null},
            ${input.previousWork || null}, ${input.githubUrl || null}, ${input.portfolioUrl || null}, ${input.prototypeUrl || null}, ${input.vision || null},
            ${input.market || null}, ${input.resourcesNeeded || null}, ${input.sourceEvent || null}, ${input.sourceReference || null}, ${input.nominatedBy || null},
            ${input.consentPrivacy}, ${hashToken(token)})
          RETURNING id`))[0];
        const id = str(r?.id);
        const via = channel === 'eoi' ? 'Expression of interest received.' : channel === 'event' ? 'Nominated from ' + (input.sourceEvent || 'an event') + '.' : 'Referred from recruitment.';
        await addEvent('x', id, { kind: 'status', to: 'RECEIVED', body: via, visibility: 'applicant', actor: channel === 'eoi' ? { userId: null, name: input.name } : who });
        await audit(who, 'samarth.x.create', 'samarth_x', id, { ref, channel });
        return { ok: true, id, ref, token };
      } catch (e: any) {
        if (/duplicate key|unique/i.test(String(e?.cause?.message || e?.message || '')) && attempt < 2) continue;
        throw e;
      }
    }
    return { ok: false, error: 'Could not issue a reference. Try again.' };
  });
}

export async function getX(id: string): Promise<Read<XCandidate | null>> {
  if (!isUuid(id)) return { ready: true, value: null };
  return readSafely('the candidate', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_x_candidates WHERE id = ${id}::uuid LIMIT 1`))[0];
    return r ? toX(r) : null;
  });
}

export async function getXByRef(ref: string): Promise<Read<XCandidate | null>> {
  return readSafely('the application', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_x_candidates WHERE ref = ${ref} LIMIT 1`))[0];
    return r ? toX(r) : null;
  });
}

export async function listX(f: { q?: string; status?: string; channel?: string; cohort?: string; cursor?: string; limit?: number } = {}): Promise<Read<{ items: (XCandidate & { reviews: number; mean: number | null })[]; next: string | null }>> {
  const limit = Math.max(1, Math.min(5000, f.limit || 50));
  const q = clean(f.q, 120);
  const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const [cTs, cId] = String(f.cursor || '').split('|');
  const hasCursor = !!iso(cTs) && isUuid(cId);
  return readSafely('SAMARTH X applications', async () => {
    const r = rows(await db.execute(sql`
      SELECT c.*, COALESCE(rv.n, 0) AS review_count, rv.mean AS review_mean
        FROM samarth_x_candidates c
        LEFT JOIN (SELECT candidate_id, COUNT(*)::int AS n, ROUND(AVG(total)::numeric, 1) AS mean FROM samarth_x_reviews GROUP BY candidate_id) rv ON rv.candidate_id = c.id
       WHERE (${f.status || ''} = '' OR c.status = ${f.status || ''})
         AND (${f.channel || ''} = '' OR c.channel = ${f.channel || ''})
         AND (${f.cohort || ''} = '' OR c.cohort = ${f.cohort || ''})
         AND (${q} = '' OR c.ref ILIKE ${like} OR c.name ILIKE ${like} OR c.email ILIKE ${like} OR c.venture_name ILIKE ${like}
              OR c.problem ILIKE ${like} OR c.proposed_system ILIKE ${like} OR c.domain ILIKE ${like} OR c.source_event ILIKE ${like})
         AND (${hasCursor} = false OR (c.created_at, c.id) < (${hasCursor ? iso(cTs) : null}::timestamptz, ${hasCursor ? cId : null}::uuid))
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ${limit + 1}`));
    const items = r.slice(0, limit).map((x) => ({ ...toX(x), reviews: num(x.review_count) || 0, mean: num(x.review_mean) }));
    const last = items[items.length - 1];
    return { items, next: r.length > limit && last ? last.createdAt + '|' + last.id : null };
  });
}

export interface XReview { id: string; reviewerUserId: string; reviewerName: string; scores: Scores; total: number; recommendation: string; note: string; updatedAt: string | null }

export async function reviewsFor(candidateId: string): Promise<Read<{ list: XReview[]; aggregate: Aggregate }>> {
  if (!isUuid(candidateId)) return { ready: true, value: { list: [], aggregate: aggregate([]) } };
  return readSafely('reviews', async () => {
    const list = rows(await db.execute(sql`SELECT * FROM samarth_x_reviews WHERE candidate_id = ${candidateId}::uuid ORDER BY updated_at DESC`)).map((r) => ({
      id: str(r.id), reviewerUserId: str(r.reviewer_user_id), reviewerName: str(r.reviewer_name), scores: (r.scores || {}) as Scores,
      total: num(r.total) || 0, recommendation: str(r.recommendation), note: str(r.note), updatedAt: iso(r.updated_at),
    }));
    return { list, aggregate: aggregate(list.map((x) => x.scores)) };
  });
}

/** One review per reviewer per candidate; submitting again replaces it. */
export async function saveReview(candidateId: string, scores: Scores, recommendation: string, note: string, who: ActorRef): Promise<Write> {
  if (!isUuid(who.userId)) return { ok: false, error: 'Sign in to review.' };
  if (!['advance', 'hold', 'decline'].includes(recommendation)) return { ok: false, error: 'Choose a recommendation.' };
  return writeSafely('saving the review', async () => {
    const total = reviewTotal(scores);
    await db.execute(sql`
      INSERT INTO samarth_x_reviews (candidate_id, reviewer_user_id, reviewer_name, scores, total, recommendation, note)
      VALUES (${candidateId}::uuid, ${who.userId}::uuid, ${who.name}, ${json(scores)}::jsonb, ${total}, ${recommendation}, ${clean(note, 4000, true) || null})
      ON CONFLICT (candidate_id, reviewer_user_id) DO UPDATE SET scores = EXCLUDED.scores, total = EXCLUDED.total,
        recommendation = EXCLUDED.recommendation, note = EXCLUDED.note, reviewer_name = EXCLUDED.reviewer_name, updated_at = NOW()`);
    await addEvent('x', candidateId, { kind: 'note', body: who.name + ' reviewed: ' + total + ' of 30, recommends ' + recommendation + '.', actor: who });
    await audit(who, 'samarth.x.review', 'samarth_x', candidateId, { total, recommendation });
    return { ok: true };
  });
}

export async function setXProgram(id: string, cohort: string, agreementReference: string, who: ActorRef): Promise<Write> {
  return writeSafely('saving the programme details', async () => {
    await db.execute(sql`UPDATE samarth_x_candidates SET cohort = ${clean(cohort, 60) || null}, agreement_reference = ${clean(agreementReference, 300) || null}, updated_at = NOW() WHERE id = ${id}::uuid`);
    await addEvent('x', id, { kind: 'note', body: 'Cohort: ' + (clean(cohort, 60) || 'none') + '. Agreement: ' + (clean(agreementReference, 300) || 'not recorded') + '.', actor: who });
    await audit(who, 'samarth.x.programme', 'samarth_x', id, { cohort: clean(cohort, 60), agreement: !!clean(agreementReference, 300) });
    return { ok: true };
  });
}

export async function transitionX(id: string, to: string, actor: Actor, note: string, who: ActorRef): Promise<Write> {
  return writeSafely('changing the status', async () => {
    const r = rows(await db.execute(sql`SELECT * FROM samarth_x_candidates WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, error: 'That application no longer exists.' };
    const c = toX(r);
    const reviews = num(rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM samarth_x_reviews WHERE candidate_id = ${id}::uuid`))[0]?.n) || 0;
    const taken = c.cohort
      ? num(rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM samarth_x_candidates WHERE cohort = ${c.cohort} AND status = 'INCUBATING' AND id <> ${id}::uuid`))[0]?.n) || 0
      : 0;
    const check = canTransition('x', c.status, to, actor, {
      enoughReviews: reviews >= MIN_REVIEWS_TO_SELECT,
      cohortSet: !!c.cohort,
      agreementRecorded: !!c.agreementReference,
      incubationSlotFree: taken < INCUBATION_PLACES,
    }, note);
    if (!check.ok) return { ok: false, error: check.error || 'That change is not allowed.' };
    const done = rows(await db.execute(sql`
      UPDATE samarth_x_candidates SET status = ${to}, decision_note = COALESCE(${note.trim() || null}, decision_note), updated_at = NOW()
       WHERE id = ${id}::uuid AND status = ${c.status} RETURNING id`));
    if (!done.length) return { ok: false, error: 'This application changed a moment ago. Reload the page.' };
    await addEvent('x', id, { kind: 'status', from: c.status, to, body: note.trim() || null, visibility: 'applicant', actor: who });
    await audit(who, 'samarth.x.status', 'samarth_x', id, { ref: c.ref, from: c.status, to });
    return { ok: true };
  });
}

export interface XProgress { id: string; kind: string; title: string; detail: string; dueDate: string | null; state: string; url: string; actorName: string; createdAt: string | null }

export const PROGRESS_KINDS: readonly { value: string; label: string }[] = [
  { value: 'milestone', label: 'Milestone' },
  { value: 'resource', label: 'Resource allocated' },
  { value: 'demo', label: 'Prototype demonstration' },
  { value: 'showcase', label: 'Final venture showcase' },
];

export async function progressFor(candidateId: string): Promise<Read<XProgress[]>> {
  if (!isUuid(candidateId)) return { ready: true, value: [] };
  return readSafely('progress', async () => rows(await db.execute(sql`SELECT * FROM samarth_x_progress WHERE candidate_id = ${candidateId}::uuid ORDER BY COALESCE(due_date, created_at::date), created_at`)).map((r) => ({
    id: str(r.id), kind: str(r.kind), title: str(r.title), detail: str(r.detail), dueDate: isoDay(r.due_date), state: str(r.state), url: str(r.url),
    actorName: str(r.actor_name), createdAt: iso(r.created_at),
  })));
}

export async function addProgress(candidateId: string, p: { kind: string; title: string; detail: string; dueDate: string; url: string }, who: ActorRef): Promise<Write> {
  if (!PROGRESS_KINDS.some((k) => k.value === p.kind)) return { ok: false, error: 'Choose what kind of entry this is.' };
  const title = clean(p.title, 300);
  if (title.length < 3) return { ok: false, error: 'Give the entry a title.' };
  const urlRaw = clean(p.url, 800);
  const url = urlRaw ? cleanUrl(urlRaw) : '';
  if (urlRaw && !url) return { ok: false, error: 'The link must be a full address starting with https://' };
  return writeSafely('adding the entry', async () => {
    await db.execute(sql`
      INSERT INTO samarth_x_progress (candidate_id, kind, title, detail, due_date, url, actor_name)
      VALUES (${candidateId}::uuid, ${p.kind}, ${title}, ${clean(p.detail, 4000, true) || null}, ${/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate) ? p.dueDate : null}::date, ${url || null}, ${who.name})`);
    await addEvent('x', candidateId, { kind: 'note', body: (PROGRESS_KINDS.find((k) => k.value === p.kind)?.label || p.kind) + ': ' + title, visibility: p.kind === 'resource' || p.kind === 'milestone' ? 'applicant' : 'internal', actor: who });
    await audit(who, 'samarth.x.progress', 'samarth_x', candidateId, { kind: p.kind, title });
    return { ok: true };
  });
}

export async function setProgressState(progressId: string, state: string, who: ActorRef): Promise<Write> {
  if (!['open', 'done', 'missed'].includes(state)) return { ok: false, error: 'Unknown state.' };
  return writeSafely('updating the entry', async () => {
    const r = rows(await db.execute(sql`UPDATE samarth_x_progress SET state = ${state}, updated_at = NOW() WHERE id = ${progressId}::uuid RETURNING candidate_id, title`))[0];
    if (!r) return { ok: false, error: 'That entry no longer exists.' };
    await audit(who, 'samarth.x.progress_state', 'samarth_x', str(r.candidate_id), { title: str(r.title), state });
    return { ok: true };
  });
}

export async function xMessage(id: string, body: string, toApplicant: boolean, who: ActorRef): Promise<Write> {
  const text = clean(body, 5000, true);
  if (text.length < 2) return { ok: false, error: 'Write the note first.' };
  return writeSafely('saving the note', async () => {
    await addEvent('x', id, { kind: toApplicant ? 'message' : 'note', body: text, visibility: toApplicant ? 'applicant' : 'internal', actor: who });
    return { ok: true };
  });
}

export const X_SYSTEM = SYSTEM_ACTOR;

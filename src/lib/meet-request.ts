// src/lib/meet-request.ts — the ONE normalisation of a meeting payload.
//
// POST /api/meet/rooms and PATCH /api/meet/rooms/:id are sent the SAME object by the same form in
// src/pages/portal/meet/index.astro. Two copies of this function would be two chances for create and
// update to disagree about what a duration or an invitee list is, which is the small version of the
// defect this whole pass is about. It lives in lib/ rather than in either route so neither route has
// to import the other.
const KINDS = ['huddle', 'scheduled', 'webinar', 'classroom'];

export interface MeetingInput {
  title: string;
  description: string | null;
  scheduledAt: string | null;
  durationMin: number;
  kind: string;
  recurrence: string;
  invitees: string[];
  passcode: string | null;
  recordOnDefault: boolean;
  waitingRoom: boolean;
  breakoutsEnabled: boolean;
  attendeeMuteDefault: boolean;
}

/** Normalise the body the scheduler's client already sends. Every field is bounded. */
export function readMeetingBody(body: any): MeetingInput {
  const invitees = Array.isArray(body?.invitees)
    ? body.invitees
        .map((s: any) => String(s || '').trim())
        .filter((s: string) => /@/.test(s))
        .slice(0, 200)
    : [];
  const durationRaw = parseInt(String(body?.durationMin ?? ''), 10);
  const scheduledRaw = body?.scheduledAt ? new Date(String(body.scheduledAt)) : null;
  const kindRaw = String(body?.kind || 'huddle');
  return {
    title: String(body?.title || '').trim().slice(0, 200) || 'Untitled meeting',
    description: body?.description == null ? null : String(body.description).slice(0, 4000),
    scheduledAt: scheduledRaw && !isNaN(scheduledRaw.getTime()) ? scheduledRaw.toISOString() : null,
    durationMin: Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(durationRaw, 24 * 60) : 30,
    kind: KINDS.includes(kindRaw) ? kindRaw : 'scheduled',
    recurrence: String(body?.recurrence || 'none').slice(0, 40),
    invitees,
    passcode: body?.passcode ? String(body.passcode).slice(0, 40) : null,
    recordOnDefault: !!body?.recordOnDefault,
    waitingRoom: body?.waitingRoom !== false,
    breakoutsEnabled: !!body?.breakoutsEnabled,
    attendeeMuteDefault: !!body?.attendeeMuteDefault,
  };
}

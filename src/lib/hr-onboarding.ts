// src/lib/hr-onboarding.ts — new-hire credential collection. After a candidate accepts their offer
// letter they must submit their educational / professional credentials before joining. Documents are
// shared as GOOGLE DRIVE links in a fixed access format ("Anyone with the link — Viewer"), so HR can
// open them without the file ever passing through our servers. Hard cap: MAX_DOCS per hire.
// Feeds the BGV education check (hr-bgv.ts) rather than duplicating it.

export const MAX_DOCS = 5;

// WHAT MAY BE ASKED FOR. This list is engagement-BLIND on purpose -- it says what a document IS,
// not who has to produce one. WHICH of these a particular joiner actually owes is decided by their
// engagement, in src/lib/onboarding-packs.ts, because the answer differs: an independent contractor
// owes a signed contract and a tax registration and does NOT owe a relieving letter from a previous
// employer, since asking one for a relieving letter presumes they were somebody's employee.
//
// `agreement` and `tax_registration` were added for exactly that reason. Every non-employee pack
// needs a home for the document that actually governs the engagement, and 'other' is not a home --
// a reviewer opening a link labelled "Other supporting document" cannot tell whether the contract
// has been produced at all.
export const DOC_TYPES = [
  { key: 'degree', label: 'Degree certificate', hint: 'Final degree / provisional certificate' },
  { key: 'marksheet', label: 'Mark sheets', hint: 'Consolidated or semester-wise' },
  { key: 'certification', label: 'Professional certification', hint: 'Course or industry certification' },
  { key: 'experience', label: 'Experience / relieving letter', hint: 'From a previous employer' },
  { key: 'identity', label: 'Government ID', hint: 'Aadhaar / PAN / passport' },
  { key: 'agreement', label: 'Signed agreement', hint: 'The document that governs this engagement: appointment letter, contract and statement of work, learning agreement or contract of apprenticeship' },
  { key: 'tax_registration', label: 'Tax registration', hint: 'For anyone who invoices us: PAN / GST or the local equivalent, in their own or their entity name' },
  { key: 'other', label: 'Other supporting document', hint: 'Anything else HR asked for' },
] as const;

/** A key of DOC_TYPES. Used by the joining packs so a pack cannot ask for a document type that does not exist. */
export type DocTypeKey = (typeof DOC_TYPES)[number]['key'];
export type DocStatus = 'submitted' | 'verified' | 'rejected';

/** The required sharing format. Enforced in the UI copy and re-stated to the reviewer. */
export const ACCESS_FORMAT = 'Anyone with the link - Viewer';

/** Only real Google Drive / Docs links are accepted (that is the agreed submission format). */
export function isDriveLink(url: string): boolean {
  const u = String(url || '').trim();
  return /^https:\/\/(drive|docs)\.google\.com\/[^\s]+$/i.test(u) && u.length <= 500;
}
/** A friendly reason when a link is rejected — never a bare "invalid". */
export function linkProblem(url: string): string | null {
  const u = String(url || '').trim();
  if (!u) return 'Paste the Google Drive link to the document.';
  if (!/^https:\/\//i.test(u)) return 'The link must start with https:// — copy it straight from Drive.';
  if (!/(drive|docs)\.google\.com/i.test(u)) return 'Please share the document from Google Drive (drive.google.com or docs.google.com).';
  if (u.length > 500) return 'That link is unusually long — paste the plain share link.';
  return null;
}
export function docTypeLabel(key: string): string {
  return (DOC_TYPES.find((d) => d.key === key) || { label: key }).label;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS hr_onboarding_documents (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    employee_id text,
    doc_type text NOT NULL DEFAULT 'other',
    title text NOT NULL DEFAULT '',
    drive_url text NOT NULL,
    status text NOT NULL DEFAULT 'submitted',
    review_note text,
    reviewed_by text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS hr_onboarding_docs_user_idx ON hr_onboarding_documents (user_id, id)`,
  `CREATE INDEX IF NOT EXISTS hr_onboarding_docs_status_idx ON hr_onboarding_documents (status, id)`,
];
let _ready = false;
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  if (!_ready) { for (const d of DDL) await db.execute(sql.raw(d)); _ready = true; }
  return { db, sql };
}

export interface OnboardingDoc {
  id: number; userId: string; docType: string; title: string; driveUrl: string;
  status: DocStatus; reviewNote: string | null; createdAt: string;
}
function toDoc(r: any): OnboardingDoc {
  return {
    id: Number(r.id), userId: String(r.user_id), docType: String(r.doc_type), title: String(r.title || ''),
    driveUrl: String(r.drive_url), status: (r.status || 'submitted') as DocStatus,
    reviewNote: r.review_note || null, createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
  };
}

export async function listDocs(userId: string): Promise<OnboardingDoc[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`SELECT * FROM hr_onboarding_documents WHERE user_id = ${userId} ORDER BY id ASC`)).map(toDoc);
}
export async function countDocs(userId: string): Promise<number> {
  const { db, sql } = await ctx();
  return Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS c FROM hr_onboarding_documents WHERE user_id = ${userId}`))[0]?.c || 0);
}
/** Add a credential. Enforces the cap and the Drive-link format server-side. */
export async function addDoc(userId: string, o: { docType: string; title: string; driveUrl: string; employeeId?: string | null }): Promise<{ ok: boolean; error?: string; id?: number }> {
  const problem = linkProblem(o.driveUrl);
  if (problem) return { ok: false, error: problem };
  if (!isDriveLink(o.driveUrl)) return { ok: false, error: 'Please share the document from Google Drive.' };
  if (await countDocs(userId) >= MAX_DOCS) return { ok: false, error: `You can submit at most ${MAX_DOCS} documents. Remove one to add another.` };
  const { db, sql } = await ctx();
  const type = DOC_TYPES.some((d) => d.key === o.docType) ? o.docType : 'other';
  const r = rows(await db.execute(sql`
    INSERT INTO hr_onboarding_documents (user_id, employee_id, doc_type, title, drive_url)
    VALUES (${userId}, ${o.employeeId || null}, ${type}, ${String(o.title || '').slice(0, 200)}, ${o.driveUrl.trim()})
    RETURNING id`));

  // Tell the people who have to act on it. A hire submitting a joining document produced no
  // notification at all, so the document sat waiting for a review nobody knew was owed — the hire
  // has done their part and is then blocked by silence. Best-effort: the document is already
  // committed by this point, so a notification failure must not report the submission as failed.
  try {
    const { record } = await import('@/lib/activity-feed');
    await record('hr.onboarding_document_submitted', {
      id: Number(r[0]?.id || 0), userId, employeeId: o.employeeId || null,
      docType: type, title: String(o.title || '').slice(0, 200),
    }, { actorId: userId });
  } catch (_) { /* recorded activity is secondary to the submission itself */ }

  return { ok: true, id: Number(r[0]?.id || 0) };
}
/** A hire may withdraw their own document while it is still under review. */
export async function removeDoc(userId: string, id: number): Promise<boolean> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`DELETE FROM hr_onboarding_documents WHERE id = ${id} AND user_id = ${userId} AND status <> 'verified' RETURNING id`));
  return r.length > 0;
}
/**
 * HR review. Verified documents are locked from further edits by the hire.
 *
 * IT RETURNS WHETHER ANYTHING WAS ACTUALLY REVIEWED, and it did not. This was `Promise<void>`: the
 * UPDATE's own answer was read only to decide whether to send a notification, and the caller
 * (/api/portal/onboarding/documents) answered `{ ok: true }` whatever happened. So a stale review
 * queue — a document the hire withdrew, an id that never existed, a second click on a row somebody
 * else had already actioned — printed "Saved. Reloading…" over an UPDATE that matched no row, and
 * the reviewer believed a credential had been verified when nothing anywhere said so.
 */
export async function reviewDoc(id: number, status: DocStatus, by: string, note?: string): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'That is not a document on the review queue, so nothing was changed.' };
  }
  const { db, sql } = await ctx();
  const changed = rows(await db.execute(sql`UPDATE hr_onboarding_documents SET status = ${status}, review_note = ${note || null}, reviewed_by = ${by}, reviewed_at = now() WHERE id = ${id} RETURNING user_id, doc_type, title`));
  if (!changed.length) {
    return {
      ok: false,
      error: 'That document is no longer on the review queue — the hire may have withdrawn it, or '
        + 'somebody else has already actioned it. Nothing was changed. Reload the list.',
    };
  }

  // THE PERSON WHOSE DOCUMENT IT IS GETS TOLD.
  //
  // This wrote the status and an audit entry and sent nothing. addDoc() in this same file
  // deliberately records an activity event when a hire submits, precisely so the hire is not blocked
  // by silence — and the reverse direction, HR back to the hire, was left silent. So a joiner who had
  // done their part had their credential bounced with a note, and learned about it only if they
  // happened to revisit /portal/onboarding and read an amber chip. Meanwhile progress() reads
  // complete only when EVERY document is verified, so one quietly rejected credential held the whole
  // step open indefinitely, waiting on somebody who had not been told anything was wrong.
  //
  // Best-effort: the decision above is already committed, and a notification failure must never
  // report the review as having failed. It is logged with the real Postgres reason rather than
  // dropped.
  const reviewed = changed[0];
  if (reviewed?.user_id && (status === 'rejected' || status === 'verified')) {
    try {
      const { notifyUser } = await import('@/lib/notify');
      const what = String(reviewed.title || docTypeLabel(String(reviewed.doc_type || 'other')));
      await notifyUser(String(reviewed.user_id), {
        title: status === 'rejected' ? 'A joining document needs re-sending' : 'Joining document verified',
        body: status === 'rejected'
          ? what + ' was not accepted' + (note ? ': ' + note : '.') + ' Share it again from your onboarding page.'
          : what + ' has been verified. Nothing further is needed for it.',
        type: 'hire',
        actionUrl: '/portal/onboarding',
        entityType: 'hr_onboarding_document',
        entityId: String(id),
      });
    } catch (e: any) {
      console.error('[hr-onboarding] the hire was NOT told about document', id, '-', e?.cause?.message || e?.message);
    }
  }

  // Verifying a credential is a hiring decision — it needs a record of who decided and why.
  try {
    const { logAudit } = await import('@/lib/audit');
    await logAudit({ userId: by, action: 'hr.onboarding_doc.' + status, entity: 'hr_onboarding_document',
      entityId: String(id), diff: { status, note: note || null } });
  } catch (e: any) {
    // The decision itself is already committed above, so this cannot abort — but audit_log is the
    // ONLY record of who verified a new hire's credential and why, and a bare catch here meant that
    // record could vanish with nothing anywhere noting that it had.
    console.error('[hr-onboarding] the audit record for document', id, 'review by', by, 'was NOT written -', e?.cause?.message || e?.message);
  }

  return { ok: true };
}
/** Everything awaiting HR, newest first, with who submitted it. */
export async function pendingForReview(limit = 100): Promise<any[]> {
  const { db, sql } = await ctx();
  return rows(await db.execute(sql`
    SELECT d.*, u.name AS user_name, u.email AS user_email
    FROM hr_onboarding_documents d
    LEFT JOIN users u ON u.id::text = d.user_id
    ORDER BY (d.status = 'submitted') DESC, d.id DESC LIMIT ${limit}`));
}
/** Promote a retained face-2FA enrolment selfie to the employee's profile photo.
 *  Called when the employee record is created, because enrolment happens BEFORE that row exists
 *  (middleware forces face-2FA on the first protected page load). Safe to call repeatedly. */
export async function promoteEnrolmentPhoto(userId: string): Promise<boolean> {
  const { db, sql } = await ctx();
  try {
    await db.execute(sql`ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS selfie_url TEXT`)
      .catch((e: any) => console.error('[hr-onboarding] selfie_url column', e?.cause?.message || e?.message));
    await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url TEXT`)
      .catch((e: any) => console.error('[hr-onboarding] photo_url column', e?.cause?.message || e?.message));
    const r = rows(await db.execute(sql`SELECT selfie_url FROM user_face_enrollments WHERE user_id = ${userId} AND selfie_url IS NOT NULL LIMIT 1`));
    const photo = r[0]?.selfie_url;
    if (!photo) return false;
    // TRUE MEANT "THE PHOTO WAS PROMOTED" AND WAS RETURNED WHATEVER HAPPENED. Both writes ended in
    // `.catch(() => {})` and the function then answered true regardless, so a failure to copy the
    // picture onto the employee record was reported to the offer-signing flow as a success and left
    // no trace anywhere. The failures are now logged and the answer says whether either write landed.
    let promoted = false;
    await db.execute(sql`UPDATE users SET photo_url = COALESCE(photo_url, ${photo}) WHERE id = ${userId}::uuid`)
      .then(() => { promoted = true; })
      .catch((e: any) => console.error('[hr-onboarding] users.photo_url NOT set for', userId, '-', e?.cause?.message || e?.message));
    await db.execute(sql`UPDATE hr_employees SET photo_url = COALESCE(photo_url, ${photo}) WHERE user_id = ${userId}`)
      .then(() => { promoted = true; })
      .catch((e: any) => console.error('[hr-onboarding] hr_employees.photo_url NOT set for', userId, '-', e?.cause?.message || e?.message));
    return promoted;
  } catch (e: any) {
    console.error('[hr-onboarding] promoteEnrolmentPhoto', userId, '-', e?.cause?.message || e?.message);
    return false;
  }
}

/** Progress for a hire: how far through the credential step they are. */
export function progress(docs: OnboardingDoc[]): { submitted: number; verified: number; rejected: number; complete: boolean } {
  const verified = docs.filter((d) => d.status === 'verified').length;
  const rejected = docs.filter((d) => d.status === 'rejected').length;
  return { submitted: docs.length, verified, rejected, complete: docs.length > 0 && rejected === 0 && verified === docs.length };
}

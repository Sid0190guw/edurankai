// src/lib/hr-onboarding.ts — new-hire credential collection. After a candidate accepts their offer
// letter they must submit their educational / professional credentials before joining. Documents are
// shared as GOOGLE DRIVE links in a fixed access format ("Anyone with the link — Viewer"), so HR can
// open them without the file ever passing through our servers. Hard cap: MAX_DOCS per hire.
// Feeds the BGV education check (hr-bgv.ts) rather than duplicating it.

export const MAX_DOCS = 5;

export const DOC_TYPES = [
  { key: 'degree', label: 'Degree certificate', hint: 'Final degree / provisional certificate' },
  { key: 'marksheet', label: 'Mark sheets', hint: 'Consolidated or semester-wise' },
  { key: 'certification', label: 'Professional certification', hint: 'Course or industry certification' },
  { key: 'experience', label: 'Experience / relieving letter', hint: 'From a previous employer' },
  { key: 'identity', label: 'Government ID', hint: 'Aadhaar / PAN / passport' },
  { key: 'other', label: 'Other supporting document', hint: 'Anything else HR asked for' },
] as const;
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
  return { ok: true, id: Number(r[0]?.id || 0) };
}
/** A hire may withdraw their own document while it is still under review. */
export async function removeDoc(userId: string, id: number): Promise<boolean> {
  const { db, sql } = await ctx();
  const r = rows(await db.execute(sql`DELETE FROM hr_onboarding_documents WHERE id = ${id} AND user_id = ${userId} AND status <> 'verified' RETURNING id`));
  return r.length > 0;
}
/** HR review. Verified documents are locked from further edits by the hire. */
export async function reviewDoc(id: number, status: DocStatus, by: string, note?: string): Promise<void> {
  const { db, sql } = await ctx();
  await db.execute(sql`UPDATE hr_onboarding_documents SET status = ${status}, review_note = ${note || null}, reviewed_by = ${by}, reviewed_at = now() WHERE id = ${id}`);
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
    await db.execute(sql`ALTER TABLE user_face_enrollments ADD COLUMN IF NOT EXISTS selfie_url TEXT`).catch(() => {});
    await db.execute(sql`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url TEXT`).catch(() => {});
    const r = rows(await db.execute(sql`SELECT selfie_url FROM user_face_enrollments WHERE user_id = ${userId} AND selfie_url IS NOT NULL LIMIT 1`));
    const photo = r[0]?.selfie_url;
    if (!photo) return false;
    await db.execute(sql`UPDATE users SET photo_url = COALESCE(photo_url, ${photo}) WHERE id = ${userId}::uuid`).catch(() => {});
    await db.execute(sql`UPDATE hr_employees SET photo_url = COALESCE(photo_url, ${photo}) WHERE user_id = ${userId}`).catch(() => {});
    return true;
  } catch { return false; }
}

/** Progress for a hire: how far through the credential step they are. */
export function progress(docs: OnboardingDoc[]): { submitted: number; verified: number; rejected: number; complete: boolean } {
  const verified = docs.filter((d) => d.status === 'verified').length;
  const rejected = docs.filter((d) => d.status === 'rejected').length;
  return { submitted: docs.length, verified, rejected, complete: docs.length > 0 && rejected === 0 && verified === docs.length };
}

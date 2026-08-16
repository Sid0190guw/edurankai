// src/lib/mailgov/ai-records.ts — THE REGISTER OF AI PROCESSING PERFORMED ON MAIL.
//
// The brief's retention section requires a policy for "AI processing records". This is the register
// that policy governs, and it is written the way a governance register has to be written: it records
// THAT content was processed, by which model, for what purpose, and what was kept — and it does not
// copy the content itself. A register that duplicates the data it governs has doubled the exposure it
// exists to manage, and would then need its own register.
//
// WHAT IS STORED INSTEAD OF THE CONTENT. A SHA-256 digest of the input and its length. The digest
// answers the questions that actually get asked — "was this same message processed twice", "is this
// record about the message I am looking at" — without holding anything readable. It is not reversible
// and it is not meant to be.
//
// HONEST ABOUT ITS CURRENT STATE: nothing in this repository calls recordAiProcessing() yet, because
// the mail platform's AI features are not built. The table exists, the writer works, retention sweeps
// it and the console reads it, so the register is in place BEFORE the first feature that needs it —
// which is the only order in which a governance control is ever actually adopted. The console says
// "no AI processing has been recorded on this deployment" rather than implying the feature is running
// and finding nothing.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { logEvent } from '@/lib/logger';
import { ensureGovernanceSchema, rows, dbReason } from './schema';

export interface AiProcessingInput {
  orgId: string;
  environment?: string;
  messageId?: string | null;
  /** What it was for: 'summarise', 'classify', 'translate', 'draft-reply', 'spam-score'. */
  purpose: string;
  model: string;
  provider?: string | null;
  /** The text that was sent to the model. HASHED HERE and never stored. */
  input?: string | null;
  /** Any output that was RETAINED — a label, a score, a summary the product keeps. */
  outputKept?: string | null;
  humanReviewed?: boolean;
  actorUserId?: string | null;
}

/**
 * Record one act of AI processing.
 *
 * Never throws. This is called from inside a feature doing real work, and a register that can fail a
 * summarisation is a register somebody will wrap in a try/catch and then forget. It logs loudly and
 * returns false, and governanceHealth() surfaces the gap.
 */
export async function recordAiProcessing(input: AiProcessingInput): Promise<boolean> {
  try {
    await ensureGovernanceSchema();
    const text = input.input == null ? null : String(input.input);
    const digest = text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');
    await db.execute(sql`
      INSERT INTO mailapi_ai_records (
        org_id, environment, message_id, purpose, model, provider,
        input_digest, input_chars, output_kept, retained_output, human_reviewed, actor_user_id)
      VALUES (
        ${input.orgId}::uuid, ${input.environment || 'production'}, ${input.messageId || null}::uuid,
        ${input.purpose}, ${input.model}, ${input.provider || null},
        ${digest}, ${text === null ? null : text.length},
        ${input.outputKept || null}, ${!!input.outputKept}, ${!!input.humanReviewed},
        ${input.actorUserId || null}::uuid)`);
    return true;
  } catch (e: any) {
    logEvent('error', 'mailgov.ai-record.failed', { purpose: input.purpose, message: dbReason(e) });
    return false;
  }
}

export interface AiRecordRow {
  id: string;
  orgId: string;
  environment: string;
  messageId: string | null;
  purpose: string;
  model: string;
  provider: string | null;
  inputDigest: string | null;
  inputChars: number | null;
  retainedOutput: boolean;
  humanReviewed: boolean;
  createdAt: string;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

export async function listAiRecords(q: { orgId?: string | null; messageId?: string | null; limit?: number }): Promise<ReadResult<AiRecordRow>> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT id, org_id, environment, message_id, purpose, model, provider,
             input_digest, input_chars, retained_output, human_reviewed, created_at
        FROM mailapi_ai_records
       WHERE ${q.orgId ? sql`org_id = ${q.orgId}::uuid` : sql`TRUE`}
         AND ${q.messageId ? sql`message_id = ${q.messageId}::uuid` : sql`TRUE`}
       ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(q.limit) || 100, 1), 500)}`);
    return {
      ok: true,
      rows: rows(r).map((x: any) => ({
        id: String(x.id),
        orgId: String(x.org_id),
        environment: String(x.environment),
        messageId: x.message_id ? String(x.message_id) : null,
        purpose: String(x.purpose),
        model: String(x.model),
        provider: x.provider ?? null,
        inputDigest: x.input_digest ?? null,
        inputChars: x.input_chars === null || x.input_chars === undefined ? null : Number(x.input_chars),
        retainedOutput: !!x.retained_output,
        humanReviewed: !!x.human_reviewed,
        createdAt: new Date(x.created_at).toISOString(),
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

/** Counts for the retention screen, so "0 records" and "no such table" are distinguishable. */
export async function aiRecordSummary(orgId: string | null): Promise<{ ok: boolean; reason?: string; total: number; byPurpose: Record<string, number>; oldest: string | null }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT purpose, COUNT(*)::int AS n, MIN(created_at) AS oldest
        FROM mailapi_ai_records
       WHERE ${orgId ? sql`org_id = ${orgId}::uuid` : sql`TRUE`}
       GROUP BY purpose`));
    const byPurpose: Record<string, number> = {};
    let total = 0;
    let oldest: string | null = null;
    for (const row of r) {
      const n = Number(row.n) || 0;
      byPurpose[String(row.purpose)] = n;
      total += n;
      const o = row.oldest ? new Date(row.oldest).toISOString() : null;
      if (o && (!oldest || o < oldest)) oldest = o;
    }
    return { ok: true, total, byPurpose, oldest };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e), total: 0, byPurpose: {}, oldest: null };
  }
}

// The in-house CRM: schema bootstrap and every read the console makes.
//
// WHY THIS FILE EXISTS AT ALL. All of this used to sit in the frontmatter of
// src/pages/portal/crm.astro, which means six CREATE TABLE and six CREATE INDEX statements ran on
// EVERY page load, and every read was wrapped in `catch (_) {}`. Two consequences, both of which
// this project has shipped before:
//
//   * a page that runs DDL per request pays for it per request, and there is no guard anywhere that
//     says "already done";
//   * a swallowed read is pixel-identical to an empty CRM. "0 open deals, pipeline value 0" is what
//     you saw whether nobody had sold anything or whether crm_deals was unreachable. Nothing on the
//     screen and nothing in the log told the two apart.
//
// Every reader below therefore returns a DISCRIMINATED result — { ok: true, rows } or
// { ok: false, error } — so the page can print "this panel could not be read: <reason>" instead of
// drawing an empty table. The reason comes from e.cause.message first: with postgres-js, e.message
// is the SQL that failed and e.cause.message is the actual Postgres complaint.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

/** The real reason a query failed. postgres-js puts the SQL in .message and the cause underneath. */
export function dbReason(e: any): string {
  const msg = e?.cause?.message || e?.message || 'unknown database error';
  return String(msg).slice(0, 300);
}

export type Read<T> = { ok: true; rows: T } | { ok: false; error: string };

/** The stage vocabulary. Exported so the validator and the columns cannot drift apart. */
export const CRM_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
export type CrmStage = typeof CRM_STAGES[number];

// ONE bootstrap per process, not one per request. The promise is the guard: concurrent requests
// during a cold start await the same DDL rather than racing six CREATE TABLE statements each.
// Additive only — no DROP, no ALTER that removes anything.
let ready: Promise<{ ok: boolean; error?: string }> | null = null;

export function ensureCrmSchema(): Promise<{ ok: boolean; error?: string }> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS crm_contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id UUID,
        full_name VARCHAR(200) NOT NULL,
        email VARCHAR(200), phone VARCHAR(40), company VARCHAR(200),
        role VARCHAR(120), location VARCHAR(120),
        source VARCHAR(80),
        pipeline_stage VARCHAR(40) NOT NULL DEFAULT 'lead',
        lifetime_value_chf NUMERIC(12,2),
        tags JSONB DEFAULT '[]'::jsonb,
        notes TEXT,
        last_contacted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS crm_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contact_id UUID REFERENCES crm_contacts(id) ON DELETE CASCADE,
        user_id UUID, kind VARCHAR(20),
        summary TEXT, payload JSONB DEFAULT '{}'::jsonb,
        due_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS crm_deals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contact_id UUID REFERENCES crm_contacts(id) ON DELETE CASCADE,
        owner_user_id UUID, title TEXT NOT NULL,
        amount_chf NUMERIC(12,2), stage VARCHAR(40) DEFAULT 'qualified',
        close_date DATE, probability_pct INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_crm_contacts_stage ON crm_contacts(pipeline_stage)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_crm_contacts_owner ON crm_contacts(owner_user_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_crm_activities_due ON crm_activities(due_at)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals(stage)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON crm_deals(contact_id)`);
      return { ok: true };
    } catch (e: any) {
      const error = dbReason(e);
      console.error('[crm] schema bootstrap failed:', error);
      // Do NOT cache a failure as success: clear the guard so the next request retries, and tell the
      // caller, which is what puts a sentence on the screen instead of an empty pipeline.
      ready = null;
      return { ok: false, error };
    }
  })();
  return ready;
}

/** Deals for the kanban, newest first. `mineOnly` scopes to the signed-in owner. */
export async function listDeals(opts: { ownerUserId?: string } = {}): Promise<Read<any[]>> {
  const boot = await ensureCrmSchema();
  if (!boot.ok) return { ok: false, error: boot.error || 'schema unavailable' };
  try {
    return {
      ok: true,
      rows: rows(await db.execute(sql`
        SELECT d.id, d.title, d.amount_chf, d.stage, d.probability_pct, d.close_date, d.owner_user_id,
               c.full_name AS contact_name, c.company AS contact_company, c.id AS contact_id
        FROM crm_deals d
        LEFT JOIN crm_contacts c ON c.id = d.contact_id
        ${opts.ownerUserId ? sql`WHERE d.owner_user_id = ${opts.ownerUserId}` : sql``}
        ORDER BY d.created_at DESC
        LIMIT 200
      `)),
    };
  } catch (e: any) {
    console.error('[crm] listDeals failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export interface DealStats { open_deals: number; pipeline_value: number; won_month: number; total_deals: number; won_total: number }

export async function dealStats(opts: { ownerUserId?: string } = {}): Promise<Read<DealStats>> {
  const boot = await ensureCrmSchema();
  if (!boot.ok) return { ok: false, error: boot.error || 'schema unavailable' };
  try {
    const r = rows(await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE stage NOT IN ('won', 'lost')) AS open_deals,
        COALESCE(SUM(amount_chf) FILTER (WHERE stage NOT IN ('won', 'lost')), 0) AS pipeline_value,
        COUNT(*) FILTER (WHERE stage = 'won' AND date_trunc('month', created_at) = date_trunc('month', NOW())) AS won_month,
        COUNT(*) AS total_deals,
        COUNT(*) FILTER (WHERE stage = 'won') AS won_total
      FROM crm_deals
      ${opts.ownerUserId ? sql`WHERE owner_user_id = ${opts.ownerUserId}` : sql``}
    `));
    const row = r[0] || {};
    return {
      ok: true,
      rows: {
        open_deals: Number(row.open_deals) || 0,
        pipeline_value: Number(row.pipeline_value) || 0,
        won_month: Number(row.won_month) || 0,
        total_deals: Number(row.total_deals) || 0,
        won_total: Number(row.won_total) || 0,
      },
    };
  } catch (e: any) {
    console.error('[crm] dealStats failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function listContacts(opts: {
  stage?: string; tag?: string; ownerUserId?: string; limit: number; offset: number; sortKey: string;
}): Promise<Read<{ contacts: any[]; total: number }>> {
  const boot = await ensureCrmSchema();
  if (!boot.ok) return { ok: false, error: boot.error || 'schema unavailable' };
  try {
    const parts: any[] = [];
    if (opts.stage && (CRM_STAGES as readonly string[]).includes(opts.stage)) parts.push(sql`pipeline_stage = ${opts.stage}`);
    if (opts.tag) parts.push(sql`tags::text ILIKE ${'%' + opts.tag + '%'}`);
    if (opts.ownerUserId) parts.push(sql`owner_user_id = ${opts.ownerUserId}`);
    const where = parts.length > 0 ? sql`WHERE ${sql.join(parts, sql` AND `)}` : sql``;

    const countR = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM crm_contacts ${where}`));
    const total = countR[0]?.n || 0;

    let order: any;
    if (opts.sortKey === 'name') order = sql`full_name ASC`;
    else if (opts.sortKey === 'company') order = sql`company ASC NULLS LAST`;
    else if (opts.sortKey === 'last_contacted') order = sql`last_contacted_at DESC NULLS LAST`;
    else if (opts.sortKey === 'ltv') order = sql`lifetime_value_chf DESC NULLS LAST`;
    else if (opts.sortKey === 'stage') order = sql`pipeline_stage ASC`;
    else order = sql`updated_at DESC`;

    const contacts = rows(await db.execute(sql`
      SELECT id, full_name, email, phone, company, role, location, source, pipeline_stage,
             lifetime_value_chf, tags, last_contacted_at, updated_at, owner_user_id
      FROM crm_contacts
      ${where}
      ORDER BY ${order}
      LIMIT ${opts.limit} OFFSET ${opts.offset}
    `));
    return { ok: true, rows: { contacts, total } };
  } catch (e: any) {
    console.error('[crm] listContacts failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function listActivities(opts: { ownerUserId?: string; limit?: number } = {}): Promise<Read<any[]>> {
  const boot = await ensureCrmSchema();
  if (!boot.ok) return { ok: false, error: boot.error || 'schema unavailable' };
  try {
    return {
      ok: true,
      rows: rows(await db.execute(sql`
        SELECT a.id, a.kind, a.summary, a.created_at, a.due_at, a.completed_at,
               c.full_name AS contact_name, c.id AS contact_id
        FROM crm_activities a
        LEFT JOIN crm_contacts c ON c.id = a.contact_id
        ${opts.ownerUserId ? sql`WHERE a.user_id = ${opts.ownerUserId}` : sql``}
        ORDER BY a.created_at DESC
        LIMIT ${opts.limit || 20}
      `)),
    };
  } catch (e: any) {
    console.error('[crm] listActivities failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/** Open tasks due within seven days. Completed tasks drop out — closeTask() is what removes them. */
export async function listOpenTasks(opts: { ownerUserId?: string } = {}): Promise<Read<any[]>> {
  const boot = await ensureCrmSchema();
  if (!boot.ok) return { ok: false, error: boot.error || 'schema unavailable' };
  try {
    return {
      ok: true,
      rows: rows(await db.execute(sql`
        SELECT a.id, a.summary, a.due_at, a.completed_at, a.user_id,
               c.full_name AS contact_name, c.id AS contact_id
        FROM crm_activities a
        LEFT JOIN crm_contacts c ON c.id = a.contact_id
        WHERE a.kind = 'task' AND a.completed_at IS NULL
          AND a.due_at IS NOT NULL
          AND a.due_at <= NOW() + INTERVAL '7 days'
          ${opts.ownerUserId ? sql`AND a.user_id = ${opts.ownerUserId}` : sql``}
        ORDER BY a.due_at ASC
        LIMIT 30
      `)),
    };
  } catch (e: any) {
    console.error('[crm] listOpenTasks failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function listContactOptions(): Promise<Read<any[]>> {
  const boot = await ensureCrmSchema();
  if (!boot.ok) return { ok: false, error: boot.error || 'schema unavailable' };
  try {
    return { ok: true, rows: rows(await db.execute(sql`SELECT id, full_name, company FROM crm_contacts ORDER BY full_name ASC LIMIT 500`)) };
  } catch (e: any) {
    console.error('[crm] listContactOptions failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

/**
 * Mark a task done. The tasks panel has always LISTED open tasks and offered no way to close one,
 * so the list could only grow; this is the write that empties it.
 * Throws on failure — the caller is a POST handler and must report the failure, never swallow it.
 */
export async function closeTask(taskId: string, userId: string): Promise<boolean> {
  await ensureCrmSchema();
  const r = rows(await db.execute(sql`
    UPDATE crm_activities SET completed_at = NOW()
    WHERE id = ${taskId}::uuid AND kind = 'task' AND completed_at IS NULL
    RETURNING id, contact_id, summary
  `));
  if (r.length === 0) return false;
  await db.execute(sql`
    INSERT INTO crm_activities (contact_id, user_id, kind, summary, payload, completed_at)
    VALUES (${r[0].contact_id}, ${userId}, 'note', ${'Task completed: ' + String(r[0].summary || '').slice(0, 180)},
            ${JSON.stringify({ task_id: taskId })}::jsonb, NOW())
  `);
  return true;
}

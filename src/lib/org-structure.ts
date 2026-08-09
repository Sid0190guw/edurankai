// src/lib/org-structure.ts — the WRITER for the organisation layer.
//
// WHY THIS FILE EXISTS.
// src/lib/org-graph-schema.ts creates three tables with care — org_teams (plus seven ALTERs and
// three indexes), org_positions (the same again) and org_employee_assignments (append-only, with a
// partial unique index enforcing one open primary posting per person). Not one of them had a single
// INSERT or UPDATE anywhere in the repository. src/lib/org-chart.ts:teamGroups() READ org_teams for
// the Team dimension of /portal/organization, so that view was structurally empty: not "no teams
// yet" as a state a person could leave, but a branch that could never render a row because nothing
// could ever create one. The Position dimension had neither a reader nor a writer.
//
// This is the missing half, and only that half. It creates no schema of its own: every statement
// below runs against the tables ensureOrgGraphSchema() already declares, and it calls that function
// rather than re-declaring anything.
//
// THE THREE-LAYER RULE IS NOT BENT HERE. A team and a position are ORGANISATION facts. Nothing in
// this file grants a permission, and nothing here is read as authorization: capabilities come from
// src/lib/auth/permissions.ts and relationships from src/lib/org-graph.ts, both untouched. Naming a
// person's seat is not the same act as deciding what they may do, and this file only does the first.
//
// APPEND-ONLY, LIKE THE RELATIONSHIPS IT SITS BESIDE. Moving somebody CLOSES their open row
// (effective_to = now) and INSERTs a new one. Nothing is deleted and nothing is overwritten, so
// "which team was she in in March" still has an answer. The close and the insert run in ONE
// transaction: half of a move — a person closed out of their old team and never written into the
// new one — is a person who has vanished from the chart.
//
// HOUSE TRAPS OBSERVED. departments.id is varchar(50) in schema.ts and UUID in db/hr-schema.sql, so
// every department comparison here is ::text and never ::uuid. postgres-js returns plain arrays.
// The real Postgres reason is on e.cause.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOrgGraphSchema } from '@/lib/org-graph-schema';

function rows(r: any): any[] { return Array.isArray(r) ? r : (r?.rows || []); }

function reasonOf(e: any): string { return String(e?.cause?.message || e?.message || 'unknown error'); }
function logFail(tag: string, e: any): string {
  const reason = reasonOf(e);
  console.error('[org-structure] ' + tag, reason);
  return reason;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string { return typeof v === 'string' && UUID_RE.test(v); }

/**
 * Every read here is discriminated. A team list that comes back empty because the query failed is
 * indistinguishable, on screen, from an organisation that has not defined any teams — and the
 * second one invites somebody to create a duplicate of a team that already exists.
 */
export type OrgResult<T> = { ok: true; value: T } | { ok: false; reason: string };
export type WriteResult = { ok: true; id?: string } | { ok: false; error: string };

export interface TeamRow {
  id: string;
  name: string;
  slug: string | null;
  departmentId: string | null;
  departmentName: string | null;
  parentTeamId: string | null;
  isActive: boolean;
  memberCount: number;
}

export interface PositionRow {
  id: string;
  title: string;
  code: string | null;
  departmentId: string | null;
  departmentName: string | null;
  teamId: string | null;
  teamName: string | null;
  grade: string | null;
  isActive: boolean;
  filledCount: number;
}

export interface AssignmentRow {
  id: string;
  employeeId: string;
  employeeName: string;
  teamId: string | null;
  teamName: string | null;
  positionId: string | null;
  positionTitle: string | null;
  departmentId: string | null;
  isPrimary: boolean;
  allocationPct: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface EmployeeOption {
  id: string;
  fullName: string;
  departmentId: string | null;
}

function slugify(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// ---------------------------------------------------------------------------
// TEAMS
// ---------------------------------------------------------------------------

/**
 * Teams with the number of people currently posted to each.
 *
 * The member count comes from open assignment rows (effective_to IS NULL), which is the same
 * predicate org-chart.ts uses to draw the Team view — so this screen and that chart cannot disagree
 * about who is in a team.
 */
export async function listTeams(includeInactive = true): Promise<OrgResult<TeamRow[]>> {
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT t.id::text AS id, t.name, t.slug, t.department_id::text AS department_id,
             d.name AS department_name,
             t.parent_team_id::text AS parent_team_id, t.is_active,
             (SELECT COUNT(*)::int FROM org_employee_assignments a
               WHERE a.team_id = t.id AND a.status = 'active' AND a.effective_to IS NULL) AS member_count
        FROM org_teams t
        LEFT JOIN departments d ON d.id::text = t.department_id::text
       WHERE ${includeInactive ? sql`TRUE` : sql`t.is_active = TRUE`}
       ORDER BY t.is_active DESC, t.name ASC
       LIMIT 500`);
    return {
      ok: true,
      value: rows(r).map((x: any) => ({
        id: String(x.id),
        name: String(x.name || ''),
        slug: x.slug || null,
        departmentId: x.department_id || null,
        departmentName: x.department_name || null,
        parentTeamId: x.parent_team_id || null,
        isActive: !!x.is_active,
        memberCount: Number(x.member_count || 0),
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: logFail('listTeams', e) };
  }
}

export async function createTeam(input: {
  name: string;
  departmentId?: string | null;
  parentTeamId?: string | null;
  createdBy?: string | null;
}): Promise<WriteResult> {
  const name = String(input.name || '').trim();
  if (name.length < 2) return { ok: false, error: 'Give the team a name.' };
  if (name.length > 120) return { ok: false, error: 'That name is too long.' };
  const dept = String(input.departmentId || '').trim() || null;
  const parent = isUuid(input.parentTeamId) ? input.parentTeamId : null;

  try {
    await ensureOrgGraphSchema();
    // The slug is unique where present. Derive one, and step aside if it is taken rather than
    // failing the whole create on a name collision the operator did not ask about.
    const base = slugify(name) || 'team';
    let slug: string | null = base;
    for (let attempt = 0; attempt < 20; attempt++) {
      const taken = rows(await db.execute(sql`SELECT 1 FROM org_teams WHERE slug = ${slug} LIMIT 1`)).length > 0;
      if (!taken) break;
      slug = base.slice(0, 74) + '-' + (attempt + 2);
      if (attempt === 19) slug = null; // the column is nullable; a team without a slug is still a team
    }
    const r = rows(await db.execute(sql`
      INSERT INTO org_teams (name, slug, department_id, parent_team_id, created_by)
      VALUES (${name}, ${slug}, ${dept}, ${parent ? sql`${parent}::uuid` : sql`NULL::uuid`},
              ${isUuid(input.createdBy) ? sql`${input.createdBy}::uuid` : sql`NULL::uuid`})
      RETURNING id::text AS id`));
    if (!r[0]?.id) return { ok: false, error: 'The team was not created. Nothing has been saved.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    return { ok: false, error: logFail('createTeam', e) };
  }
}

/**
 * Deactivate rather than delete. A team with history is a fact about where people worked, and
 * deleting the row would rewrite every assignment that points at it.
 */
export async function setTeamActive(id: string, active: boolean): Promise<WriteResult> {
  if (!isUuid(id)) return { ok: false, error: 'That team id is not valid.' };
  try {
    await ensureOrgGraphSchema();
    const r = rows(await db.execute(sql`
      UPDATE org_teams SET is_active = ${!!active} WHERE id = ${id}::uuid RETURNING id::text AS id`));
    if (!r.length) return { ok: false, error: 'No such team.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    return { ok: false, error: logFail('setTeamActive', e) };
  }
}

// ---------------------------------------------------------------------------
// POSITIONS — the SEAT, never the person and never a role name.
// ---------------------------------------------------------------------------

export async function listPositions(includeInactive = true): Promise<OrgResult<PositionRow[]>> {
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT p.id::text AS id, p.title, p.code, p.department_id::text AS department_id,
             d.name AS department_name, p.team_id::text AS team_id, t.name AS team_name,
             p.grade, p.is_active,
             (SELECT COUNT(*)::int FROM org_employee_assignments a
               WHERE a.position_id = p.id AND a.status = 'active' AND a.effective_to IS NULL) AS filled_count
        FROM org_positions p
        LEFT JOIN departments d ON d.id::text = p.department_id::text
        LEFT JOIN org_teams t ON t.id = p.team_id
       WHERE ${includeInactive ? sql`TRUE` : sql`p.is_active = TRUE`}
       ORDER BY p.is_active DESC, p.title ASC
       LIMIT 500`);
    return {
      ok: true,
      value: rows(r).map((x: any) => ({
        id: String(x.id),
        title: String(x.title || ''),
        code: x.code || null,
        departmentId: x.department_id || null,
        departmentName: x.department_name || null,
        teamId: x.team_id || null,
        teamName: x.team_name || null,
        grade: x.grade || null,
        isActive: !!x.is_active,
        filledCount: Number(x.filled_count || 0),
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: logFail('listPositions', e) };
  }
}

export async function createPosition(input: {
  title: string;
  code?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  grade?: string | null;
  createdBy?: string | null;
}): Promise<WriteResult> {
  const title = String(input.title || '').trim();
  if (title.length < 2) return { ok: false, error: 'Give the position a title.' };
  if (title.length > 160) return { ok: false, error: 'That title is too long.' };
  const code = String(input.code || '').trim().slice(0, 40) || null;
  const dept = String(input.departmentId || '').trim() || null;
  const team = isUuid(input.teamId) ? input.teamId : null;
  const grade = String(input.grade || '').trim().slice(0, 40) || null;

  try {
    await ensureOrgGraphSchema();
    if (code) {
      const taken = rows(await db.execute(sql`SELECT 1 FROM org_positions WHERE code = ${code} LIMIT 1`)).length > 0;
      // Said plainly rather than surfaced as a unique-index violation: the operator chose this code
      // and needs to know it is already in use, not to read a constraint name.
      if (taken) return { ok: false, error: 'A position already uses the code "' + code + '". Codes are unique.' };
    }
    const r = rows(await db.execute(sql`
      INSERT INTO org_positions (title, code, department_id, team_id, grade, created_by)
      VALUES (${title}, ${code}, ${dept},
              ${team ? sql`${team}::uuid` : sql`NULL::uuid`}, ${grade},
              ${isUuid(input.createdBy) ? sql`${input.createdBy}::uuid` : sql`NULL::uuid`})
      RETURNING id::text AS id`));
    if (!r[0]?.id) return { ok: false, error: 'The position was not created. Nothing has been saved.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    return { ok: false, error: logFail('createPosition', e) };
  }
}

export async function setPositionActive(id: string, active: boolean): Promise<WriteResult> {
  if (!isUuid(id)) return { ok: false, error: 'That position id is not valid.' };
  try {
    await ensureOrgGraphSchema();
    const r = rows(await db.execute(sql`
      UPDATE org_positions SET is_active = ${!!active} WHERE id = ${id}::uuid RETURNING id::text AS id`));
    if (!r.length) return { ok: false, error: 'No such position.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    return { ok: false, error: logFail('setPositionActive', e) };
  }
}

// ---------------------------------------------------------------------------
// ASSIGNMENTS — who sits where, and since when.
// ---------------------------------------------------------------------------

/** The open postings: one row per person per current seat. */
export async function listOpenAssignments(limit = 300): Promise<OrgResult<AssignmentRow[]>> {
  try {
    await ensureOrgGraphSchema();
    const r = await db.execute(sql`
      SELECT a.id::text AS id, a.employee_id::text AS employee_id, e.full_name AS employee_name,
             a.team_id::text AS team_id, t.name AS team_name,
             a.position_id::text AS position_id, p.title AS position_title,
             a.department_id::text AS department_id,
             a.is_primary, a.allocation_pct, a.effective_from, a.effective_to
        FROM org_employee_assignments a
        LEFT JOIN hr_employees e ON e.id = a.employee_id
        LEFT JOIN org_teams t ON t.id = a.team_id
        LEFT JOIN org_positions p ON p.id = a.position_id
       WHERE a.status = 'active' AND a.effective_to IS NULL
       ORDER BY e.full_name ASC NULLS LAST
       LIMIT ${Math.max(1, Math.min(1000, Math.floor(limit)))}`);
    return {
      ok: true,
      value: rows(r).map((x: any) => ({
        id: String(x.id),
        employeeId: String(x.employee_id || ''),
        employeeName: String(x.employee_name || 'Unnamed employee'),
        teamId: x.team_id || null,
        teamName: x.team_name || null,
        positionId: x.position_id || null,
        positionTitle: x.position_title || null,
        departmentId: x.department_id || null,
        isPrimary: !!x.is_primary,
        allocationPct: x.allocation_pct == null ? null : Number(x.allocation_pct),
        effectiveFrom: x.effective_from ? new Date(x.effective_from).toISOString() : '',
        effectiveTo: x.effective_to ? new Date(x.effective_to).toISOString() : null,
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: logFail('listOpenAssignments', e) };
  }
}

/** Employees who can be posted, so the form offers real people rather than a typed id. */
export async function listAssignableEmployees(limit = 500): Promise<OrgResult<EmployeeOption[]>> {
  try {
    const r = await db.execute(sql`
      SELECT id::text AS id, full_name, department_id::text AS department_id
        FROM hr_employees
       WHERE COALESCE(employment_status, 'active') NOT IN ('exited', 'terminated', 'resigned')
       ORDER BY full_name ASC
       LIMIT ${Math.max(1, Math.min(2000, Math.floor(limit)))}`);
    return {
      ok: true,
      value: rows(r).map((x: any) => ({
        id: String(x.id),
        fullName: String(x.full_name || 'Unnamed employee'),
        departmentId: x.department_id || null,
      })),
    };
  } catch (e: any) {
    return { ok: false, reason: logFail('listAssignableEmployees', e) };
  }
}

/**
 * Post somebody to a team and/or a position.
 *
 * A PRIMARY posting closes the person's existing open primary row first, in the SAME TRANSACTION as
 * the insert. Two statements outside a transaction can leave a person closed out of their old team
 * and never written into the new one — somebody who has silently vanished from the org chart and
 * from every department-scoped screen that reads it. The partial unique index
 * (org_assignments_one_open_primary_uq) is what makes the ordering matter: the insert would be
 * rejected if the close had not happened, and the close must not survive a rejected insert.
 *
 * A SECONDARY posting (isPrimary = false) closes nothing — that is how a dotted-line or
 * part-allocation posting is recorded alongside the main one.
 */
export async function assignEmployee(input: {
  employeeId: string;
  teamId?: string | null;
  positionId?: string | null;
  departmentId?: string | null;
  isPrimary?: boolean;
  allocationPct?: number | null;
  createdBy?: string | null;
}): Promise<WriteResult> {
  if (!isUuid(input.employeeId)) return { ok: false, error: 'Choose the person being posted.' };
  const team = isUuid(input.teamId) ? input.teamId : null;
  const position = isUuid(input.positionId) ? input.positionId : null;
  if (!team && !position) {
    return { ok: false, error: 'A posting needs a team, a position, or both. Recording neither says nothing.' };
  }
  const dept = String(input.departmentId || '').trim() || null;
  const isPrimary = input.isPrimary !== false;
  const alloc =
    input.allocationPct == null || (input.allocationPct as any) === ''
      ? null
      : Math.max(1, Math.min(100, Math.floor(Number(input.allocationPct) || 0)));
  const by = isUuid(input.createdBy) ? input.createdBy : null;

  try {
    await ensureOrgGraphSchema();
    let newId = '';
    await db.transaction(async (tx: any) => {
      if (isPrimary) {
        await tx.execute(sql`
          UPDATE org_employee_assignments
             SET effective_to = NOW()
           WHERE employee_id = ${input.employeeId}::uuid
             AND is_primary = TRUE AND status = 'active' AND effective_to IS NULL`);
      }
      const r = rows(await tx.execute(sql`
        INSERT INTO org_employee_assignments
          (employee_id, position_id, team_id, department_id, allocation_pct, is_primary, created_by)
        VALUES (${input.employeeId}::uuid,
                ${position ? sql`${position}::uuid` : sql`NULL::uuid`},
                ${team ? sql`${team}::uuid` : sql`NULL::uuid`},
                ${dept}, ${alloc}, ${isPrimary},
                ${by ? sql`${by}::uuid` : sql`NULL::uuid`})
        RETURNING id::text AS id`));
      if (!r[0]?.id) throw new Error('the assignment row was not written');
      newId = String(r[0].id);
    });
    return { ok: true, id: newId };
  } catch (e: any) {
    // The transaction rolled back, so the previous posting is still open and still true.
    return { ok: false, error: logFail('assignEmployee', e) };
  }
}

/**
 * End a posting without replacing it — somebody leaving a team rather than moving between two.
 * Closes the row; never deletes it.
 */
export async function endAssignment(assignmentId: string): Promise<WriteResult> {
  if (!isUuid(assignmentId)) return { ok: false, error: 'That posting id is not valid.' };
  try {
    await ensureOrgGraphSchema();
    const r = rows(await db.execute(sql`
      UPDATE org_employee_assignments
         SET effective_to = NOW()
       WHERE id = ${assignmentId}::uuid AND effective_to IS NULL
       RETURNING id::text AS id`));
    if (!r.length) return { ok: false, error: 'That posting has already been closed.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    return { ok: false, error: logFail('endAssignment', e) };
  }
}

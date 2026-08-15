// src/lib/lms/interop.ts — TALKING TO THE REST OF THE WORLD (L6).
//
// Four jobs, and one honest limit stated up front.
//
//   1. xAPI  — a statement store. Statements are written by this platform's own surfaces (a
//              submission, a released grade, a completed lesson) and accepted from outside over
//              /api/aquintutor/lms/xapi. This is an LRS-lite: it stores, shreds and reports
//              statements. It is not a conformant LRS — there is no statement signing, no
//              attachment handling and no /activities/state document API.
//
//   2. SCORM — imsmanifest.xml is parsed into a course structure and imported as modules and
//              lessons whose content is the launch link. THAT IS THE WHOLE CLAIM. There is no
//              SCORM run-time environment here: a package launched from another origin cannot
//              reach a window.API object on this page (the browser forbids it across origins), so
//              claiming cmi.core tracking would be claiming something that cannot work. Completion
//              of an imported item is tracked the same way every other lesson is.
//
//   3. Roster CSV in — enrol a list of people into a section by email, in one paste.
//
//   4. Grades CSV out — the export every registrar asks for on day one.
//
// The parsers are pure and exported, so they are tested without a database and without a network.

import { ensureLmsSchema, rows } from './schema';

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ================================================================================================
// xAPI
// ================================================================================================

export interface StatementInput {
  actorUserId?: string | null;
  actorName?: string | null;
  verb: string;
  objectId: string;
  objectName?: string | null;
  courseId?: string | null;
  success?: boolean | null;
  completion?: boolean | null;
  scoreScaled?: number | null;
  durationSeconds?: number | null;
  source?: string;
  raw?: any;
}

/** Write one statement. Best-effort by design: no learning event is worth failing the act it
 *  describes, so callers log and continue. */
export async function recordStatement(input: StatementInput): Promise<string | null> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    const r = rows(await db.execute(sql`INSERT INTO lms_xapi_statements
      (actor_user_id, actor_name, verb, object_id, object_name, course_id, success, completion,
       score_scaled, duration_seconds, raw, source)
      VALUES (${input.actorUserId || null}, ${input.actorName || null}, ${input.verb}, ${input.objectId},
        ${input.objectName || null}, ${input.courseId || null}, ${input.success ?? null},
        ${input.completion ?? null}, ${input.scoreScaled ?? null}, ${input.durationSeconds ?? null},
        ${JSON.stringify(input.raw || {})}::jsonb, ${input.source || 'internal'})
      RETURNING id`))[0] as any;
    return r?.id || null;
  } catch (e: any) {
    console.error('[lms/interop] recordStatement:', e?.cause?.message || e?.message);
    return null;
  }
}

/** The xAPI verbs this platform emits and understands. An unknown verb is stored, not rejected —
 *  a statement store that drops what it does not recognise is a store you cannot migrate into. */
export const KNOWN_VERBS = [
  'attempted', 'completed', 'passed', 'failed', 'scored', 'submitted', 'experienced',
  'answered', 'launched', 'terminated', 'reminded', 'attended',
] as const;

export interface ParsedStatement { ok: boolean; error?: string; value?: StatementInput }

/**
 * Turn an inbound xAPI JSON body into our row shape.
 *
 * xAPI is loose about where the useful values live — a verb is an IRI whose tail is the word, an
 * actor may be an mbox, an account or a name, and a result score may be scaled, raw/max, or absent.
 * This normalises all of that in one place so that no reader downstream has to know the format.
 * Pure: no database, no clock, no network.
 */
export function parseXapiStatement(body: any): ParsedStatement {
  if (!body || typeof body !== 'object') return { ok: false, error: 'statement must be an object' };

  const verbRaw = body.verb?.id || body.verb?.display?.['en-US'] || body.verb || '';
  const verb = String(verbRaw).split('/').filter(Boolean).pop() || '';
  if (!verb) return { ok: false, error: 'verb is required' };

  const objectId = String(body.object?.id || body.object?.objectType || '').trim();
  if (!objectId) return { ok: false, error: 'object.id is required' };

  const definition = body.object?.definition || {};
  const objectName = pickLangMap(definition.name) || null;

  const actor = body.actor || {};
  const mbox = String(actor.mbox || '').replace(/^mailto:/, '') || null;
  const actorName = actor.name || actor.account?.name || mbox || null;

  const result = body.result || {};
  const scoreScaled = result.score?.scaled != null
    ? clamp(Number(result.score.scaled), -1, 1)
    : (result.score?.raw != null && result.score?.max ? clamp(Number(result.score.raw) / Number(result.score.max), -1, 1) : null);

  return {
    ok: true,
    value: {
      actorName,
      verb,
      objectId,
      objectName,
      success: typeof result.success === 'boolean' ? result.success : null,
      completion: typeof result.completion === 'boolean' ? result.completion : null,
      scoreScaled: Number.isFinite(scoreScaled as number) ? (scoreScaled as number) : null,
      durationSeconds: parseIso8601Duration(result.duration),
      source: 'external',
      raw: body,
    },
  };
}

/** ISO-8601 durations as xAPI sends them: PT1H30M12S. Returns null on anything else. Pure. */
export function parseIso8601Duration(value: unknown): number | null {
  const text = String(value || '').trim();
  if (!text) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  if (!m) return null;
  const days = Number(m[1] || 0), hours = Number(m[2] || 0), mins = Number(m[3] || 0), secs = Number(m[4] || 0);
  const total = days * 86400 + hours * 3600 + mins * 60 + secs;
  return total > 0 ? Math.round(total) : null;
}

export async function listStatements(filter: { courseId?: string | null; userId?: string | null; limit?: number } = {}): Promise<any[]> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  try {
    return rows(await db.execute(sql`SELECT s.*, u.name AS user_name FROM lms_xapi_statements s
      LEFT JOIN users u ON u.id = s.actor_user_id
      WHERE 1 = 1
        ${filter.courseId ? sql`AND s.course_id = ${filter.courseId}` : sql``}
        ${filter.userId ? sql`AND s.actor_user_id = ${filter.userId}` : sql``}
      ORDER BY s.stored_at DESC LIMIT ${Math.min(500, filter.limit || 100)}`));
  } catch (e: any) {
    console.error('[lms/interop] listStatements:', e?.cause?.message || e?.message);
    return [];
  }
}

// ================================================================================================
// SCORM MANIFEST
// ================================================================================================

export interface ScormItem { title: string; href: string | null; children: ScormItem[] }
export interface ScormManifest { title: string; items: ScormItem[]; resourceCount: number }

/**
 * Parse an imsmanifest.xml into a title and a tree of items with launch links.
 *
 * NO XML LIBRARY. There is none in this project's dependencies and adding one to read a file format
 * with this little structural variety is not a trade worth making. The parser walks tags with a
 * regex scanner and keeps a stack, which handles nesting correctly — the thing a naive regex does
 * not do. Pure.
 */
export function parseScormManifest(xml: string): ScormManifest {
  const text = String(xml || '');

  // resource identifier -> href, so an <item identifierref="R1"> can be given its launch link.
  const resources: Record<string, string> = {};
  const resourceRe = /<resource\b([^>]*)>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = resourceRe.exec(text))) {
    const attrs = parseAttrs(rm[1]);
    if (attrs.identifier && attrs.href) resources[attrs.identifier] = attrs.href;
  }

  const orgTitle = firstTagText(text, 'title') || 'Imported package';

  // Walk <item> open/close tags with a stack so nesting survives.
  const root: ScormItem = { title: orgTitle, href: null, children: [] };
  const stack: ScormItem[] = [root];
  const tokenRe = /<(\/?)item\b([^>]*?)(\/?)>|<title\b[^>]*>([\s\S]*?)<\/title>/gi;
  let tm: RegExpExecArray | null;
  let pendingTitleFor: ScormItem | null = null;

  while ((tm = tokenRe.exec(text))) {
    const isTitle = tm[4] !== undefined;
    if (isTitle) {
      if (pendingTitleFor) { pendingTitleFor.title = decodeEntities(tm[4].trim()); pendingTitleFor = null; }
      continue;
    }
    const closing = tm[1] === '/';
    const selfClosing = tm[3] === '/';
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = parseAttrs(tm[2]);
    const node: ScormItem = {
      title: attrs.identifier || 'Item',
      href: attrs.identifierref ? (resources[attrs.identifierref] || null) : null,
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    pendingTitleFor = node;
    if (!selfClosing) stack.push(node);
  }

  return { title: orgTitle, items: root.children, resourceCount: Object.keys(resources).length };
}

function parseAttrs(chunk: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) out[m[1]] = decodeEntities(m[2]);
  return out;
}
function firstTagText(text: string, tag: string): string | null {
  const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(text);
  return m ? decodeEntities(m[1].trim()) : null;
}
function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Flatten a manifest into the module/lesson pairs this platform stores. Pure, so the admin screen
 *  can show exactly what an import WOULD create before anybody presses the button. */
export function manifestPlan(manifest: ScormManifest, baseUrl?: string): Array<{ module: string; lessons: Array<{ title: string; href: string | null }> }> {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const abs = (href: string | null) => {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    return base ? base + '/' + href.replace(/^\/+/, '') : href;
  };
  const plan: Array<{ module: string; lessons: Array<{ title: string; href: string | null }> }> = [];
  for (const item of manifest.items) {
    if (item.children.length) {
      plan.push({ module: item.title, lessons: item.children.map((c) => ({ title: c.title, href: abs(c.href) })) });
    } else {
      const loose = plan.find((p) => p.module === manifest.title);
      if (loose) loose.lessons.push({ title: item.title, href: abs(item.href) });
      else plan.push({ module: manifest.title, lessons: [{ title: item.title, href: abs(item.href) }] });
    }
  }
  return plan;
}

/** Write a parsed plan into training_modules and training_lessons. Additive: an import never
 *  deletes existing course content. */
export async function importScormPlan(courseId: string, plan: Array<{ module: string; lessons: Array<{ title: string; href: string | null }> }>, byUserId: string, filename: string): Promise<{ ok: boolean; modules: number; lessons: number; error?: string }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  let modules = 0, lessons = 0;
  try {
    const { ensureAquintutorAuthoringSchema } = await import('@/lib/aquintutor-authoring');
    await ensureAquintutorAuthoringSchema();

    const startOrder = Number(rows(await db.execute(sql`SELECT COALESCE(MAX(order_in_course), -1) + 1 AS next FROM training_modules WHERE course_id = ${courseId}`))[0]?.next || 0);

    for (let i = 0; i < plan.length; i++) {
      const group = plan[i];
      const mod = rows(await db.execute(sql`INSERT INTO training_modules (course_id, title, order_in_course)
        VALUES (${courseId}, ${group.module}, ${startOrder + i}) RETURNING id`))[0] as any;
      modules++;
      for (let j = 0; j < group.lessons.length; j++) {
        const lesson = group.lessons[j];
        const content = lesson.href
          ? 'Launch this item: ' + lesson.href
          : 'This item had no launch link in the package manifest.';
        await db.execute(sql`INSERT INTO training_lessons (course_id, module_id, title, content, sort_order)
          VALUES (${courseId}, ${mod.id}, ${lesson.title}, ${content}, ${j})`);
        lessons++;
      }
    }

    await db.execute(sql`INSERT INTO lms_imports (kind, course_id, filename, status, summary, created_by)
      VALUES ('scorm', ${courseId}, ${filename}, 'ok', ${JSON.stringify({ modules, lessons })}::jsonb, ${byUserId})`);
    return { ok: true, modules, lessons };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message;
    console.error('[lms/interop] importScormPlan:', reason);
    return { ok: false, modules, lessons, error: reason || 'Import failed' };
  }
}

// ================================================================================================
// ROSTER CSV IN
// ================================================================================================

export interface RosterRow { email: string; name: string | null; role: string; line: number }
export interface RosterParse { rows: RosterRow[]; errors: Array<{ line: number; text: string; reason: string }> }

/**
 * Parse a pasted roster. Accepts `email`, `email,name`, or `email,name,role`, with or without a
 * header line, comma or tab separated. Everything it cannot read is REPORTED, never dropped — an
 * import that silently skips four of forty students is how a section ends up half-enrolled with
 * nobody knowing which half. Pure.
 */
export function parseRosterCsv(text: string): RosterParse {
  const out: RosterRow[] = [];
  const errors: Array<{ line: number; text: string; reason: string }> = [];
  const lines = String(text || '').split(/\r?\n/);
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const parts = raw.split(/[,\t;]/).map((p) => p.trim().replace(/^"|"$/g, ''));
    const email = (parts[0] || '').toLowerCase();
    if (i === 0 && (email === 'email' || email === 'e-mail')) continue;   // header
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ line: i + 1, text: raw, reason: 'not an email address' });
      continue;
    }
    if (seen.has(email)) {
      errors.push({ line: i + 1, text: raw, reason: 'duplicate of an earlier line' });
      continue;
    }
    seen.add(email);
    const role = (parts[2] || 'student').toLowerCase();
    out.push({
      email,
      name: parts[1] || null,
      role: ['student', 'instructor', 'ta', 'observer'].includes(role) ? role : 'student',
      line: i + 1,
    });
  }
  return { rows: out, errors };
}

/** Enrol parsed roster rows into a section. People who have no account here are reported back, not
 *  created — creating accounts from a paste is an invitation flow, and a different decision. */
export async function importRoster(sectionId: string, parsed: RosterRow[], byUserId: string): Promise<{ added: number; alreadyThere: number; noAccount: string[] }> {
  await ensureLmsSchema();
  const { db, sql } = await ctx();
  let added = 0, alreadyThere = 0;
  const noAccount: string[] = [];

  for (const row of parsed) {
    try {
      const user = rows(await db.execute(sql`SELECT id FROM users WHERE LOWER(email) = ${row.email} LIMIT 1`))[0] as any;
      if (!user?.id) { noAccount.push(row.email); continue; }
      const r = rows(await db.execute(sql`INSERT INTO lms_section_members (section_id, user_id, role, added_by)
        VALUES (${sectionId}, ${user.id}, ${row.role}, ${byUserId})
        ON CONFLICT (section_id, user_id, role) DO NOTHING RETURNING id`));
      if (r.length) added++; else alreadyThere++;
    } catch (e: any) {
      console.error('[lms/interop] importRoster', row.email, e?.cause?.message || e?.message);
      noAccount.push(row.email);
    }
  }

  try {
    await db.execute(sql`INSERT INTO lms_imports (kind, section_id, status, summary, created_by)
      VALUES ('csv_roster', ${sectionId}, 'ok', ${JSON.stringify({ added, alreadyThere, noAccount: noAccount.length })}::jsonb, ${byUserId})`);
  } catch { /* the import already happened; the log is not worth failing it */ }

  return { added, alreadyThere, noAccount };
}

// ================================================================================================
// GRADES CSV OUT
// ================================================================================================

export function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** Build the registrar's export from a gradebook matrix. Pure — the route just sets the headers. */
export function buildGradeCsv(matrix: { assignments: any[]; students: any[] }): string {
  const header = ['Student', 'Email', ...matrix.assignments.map((a: any) => a.title + ' (' + Number(a.points || 0) + ')'), 'Course %', 'Letter'];
  const lines = [header.map(csvCell).join(',')];
  for (const s of matrix.students) {
    const cells = matrix.assignments.map((a: any) => {
      const cell = s.cells.find((c: any) => c.assignmentId === a.id);
      if (!cell || cell.points == null) return cell?.excused ? 'excused' : '';
      return String(cell.points);
    });
    lines.push([s.name, s.email || '', ...cells, s.total?.pct ?? '', s.total?.letter ?? ''].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function pickLangMap(map: any): string | null {
  if (!map || typeof map !== 'object') return null;
  return map['en-US'] || map['en'] || (Object.values(map)[0] as string) || null;
}

// src/lib/aes/session.ts — AES section 11: the LIVE TEACHING SESSION and its context.
//
// Section 11 exists to prevent one specific failure: every teacher sentence being interpreted
// alone. "Make it faster" is meaningless without the current Experience; "now try the moon" is
// meaningless without the current experiment; "go back to the last one" is meaningless without the
// previous commands. This module is the context those sentences are read against.
//
// It holds exactly what section 11 lists: institution, course, module, lesson, topic, objectives,
// teacher, current explanation, current board state, current Experience, previous commands,
// learner level, current experiment state.
//
// The pure core (createContext / recordCommand / resolveReference / contextWindow) takes plain
// values and is unit-testable with no database. The DB layer below persists a session so a teacher
// whose phone reloads in the middle of a class does not lose the context of the class.
//
// It DELIBERATELY does not invent a session id space: sessionId is the SAME string the live board
// already uses in edu_board_events.session_id, so an AES session and a board session are one
// session, not two things to reconcile.
import { TIER_IDS } from '@/lib/aquintutor-learn';
import { makeSchemaGuard, assertSchema } from '@/lib/aes/schema';

// ---------------------------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------------------------

/** The board state, shaped exactly like the broadcast event the live board already sends. */
export interface BoardStateRef {
  templateId: string | null;      // projectile | sine | sortbars | scene | ink | slide | null
  params: Record<string, any>;
  playState: string;              // playing | paused | static
  timelinePos: number;            // 0..1
  seq: number;                    // the monotonic broadcast seq this state came from (0 = never fired)
}

/**
 * The current Experience. Kept STRUCTURAL on purpose: the Experience type itself is section 19's
 * job, and this module must not fork a second definition of it. What section 11 needs is only the
 * handle — which one, which version, which parameters, whether students can see it.
 */
export interface ExperienceRef {
  id: string | null;
  kind: string | null;            // the Experience kind (NOT the renderer id)
  version: number;
  params: Record<string, any>;
  status: 'none' | 'proposed' | 'approved' | 'live' | 'hidden';
}

/** Section 11 "current experiment state" — what is running, where it is, what the variables are. */
export interface ExperimentState {
  running: boolean;
  step: number;
  variables: Record<string, number>;
}

/** One previous command. The classifier reads these; so does the teacher, on screen. */
export interface CommandRecord {
  at: string;
  utterance: string;
  kind: string;                   // an IntentKind, a string here so intent.ts imports session, not the reverse
  latencyClass: string;
  route: string;
  accepted: boolean;              // did anything actually happen, or was it ordinary speech
  slots: Record<string, any>;
}

export interface TeachingContext {
  sessionId: string;
  institutionId: string | null;
  courseId: string | null;
  moduleId: string | null;
  lessonId: string | null;
  topic: string;
  objectives: string[];
  teacherId: string | null;
  learnerLevel: string;           // one of the eight learner tiers (aquintutor-learn TIER_IDS)
  language: string;
  currentExplanation: string;
  board: BoardStateRef;
  experience: ExperienceRef;
  experiment: ExperimentState;
  commands: CommandRecord[];      // most recent LAST
  startedAt: string;
  updatedAt: string;
}

export const MAX_COMMANDS = 24;
export const MAX_OBJECTIVES = 12;
const MAX_TEXT = 2000;

const s = (v: any, cap = 200): string => String(v == null ? '' : v).slice(0, cap);
const sn = (v: any, cap = 200): string | null => { const t = s(v, cap).trim(); return t ? t : null; };
const num = (v: any, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const obj = (v: any): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export const EMPTY_BOARD: BoardStateRef = { templateId: null, params: {}, playState: 'static', timelinePos: 0, seq: 0 };
export const EMPTY_EXPERIENCE: ExperienceRef = { id: null, kind: null, version: 0, params: {}, status: 'none' };
export const EMPTY_EXPERIMENT: ExperimentState = { running: false, step: 0, variables: {} };

// ---------------------------------------------------------------------------------------------
// PURE CORE
// ---------------------------------------------------------------------------------------------

/** Build a normalised context. Every field is clamped here so nothing downstream has to re-check. */
export function createContext(init: Partial<TeachingContext> & { sessionId: string }): TeachingContext {
  const now = new Date().toISOString();
  const level = s(init.learnerLevel, 40);
  return {
    sessionId: s(init.sessionId, 120) || 'aes-session',
    institutionId: sn(init.institutionId, 120),
    courseId: sn(init.courseId, 120),
    moduleId: sn(init.moduleId, 120),
    lessonId: sn(init.lessonId, 120),
    topic: s(init.topic, 240),
    objectives: (Array.isArray(init.objectives) ? init.objectives : []).slice(0, MAX_OBJECTIVES).map((o) => s(o, 240)).filter(Boolean),
    teacherId: sn(init.teacherId, 120),
    learnerLevel: TIER_IDS.includes(level) ? level : 'tutor',
    language: s(init.language, 12) || 'en',
    currentExplanation: s(init.currentExplanation, MAX_TEXT),
    board: init.board ? normalizeBoard(init.board) : { ...EMPTY_BOARD },
    experience: init.experience ? normalizeExperience(init.experience) : { ...EMPTY_EXPERIENCE },
    experiment: init.experiment ? normalizeExperiment(init.experiment) : { ...EMPTY_EXPERIMENT },
    commands: (Array.isArray(init.commands) ? init.commands : []).slice(-MAX_COMMANDS).map(normalizeCommand),
    startedAt: init.startedAt ? s(init.startedAt, 40) : now,
    updatedAt: now,
  };
}

export function normalizeBoard(b: Partial<BoardStateRef>): BoardStateRef {
  return {
    templateId: sn(b.templateId, 60),
    params: obj(b.params),
    playState: s(b.playState, 20) || 'static',
    timelinePos: Math.max(0, Math.min(1, num(b.timelinePos, 0))),
    seq: Math.max(0, Math.floor(num(b.seq, 0))),
  };
}

export function normalizeExperience(e: Partial<ExperienceRef>): ExperienceRef {
  const status = s(e.status, 20);
  const allowed = ['none', 'proposed', 'approved', 'live', 'hidden'];
  return {
    id: sn(e.id, 120),
    kind: sn(e.kind, 60),
    version: Math.max(0, Math.floor(num(e.version, 0))),
    params: obj(e.params),
    status: (allowed.includes(status) ? status : 'none') as ExperienceRef['status'],
  };
}

export function normalizeExperiment(x: Partial<ExperimentState>): ExperimentState {
  const vars: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(x.variables)).slice(0, 32)) {
    const n = Number(v);
    if (Number.isFinite(n)) vars[s(k, 40)] = n;
  }
  return { running: !!x.running, step: Math.max(0, Math.floor(num(x.step, 0))), variables: vars };
}

export function normalizeCommand(c: Partial<CommandRecord>): CommandRecord {
  return {
    at: c.at ? s(c.at, 40) : new Date().toISOString(),
    utterance: s(c.utterance, 500),
    kind: s(c.kind, 40) || 'speech',
    latencyClass: s(c.latencyClass, 20) || 'ultra-low',
    route: s(c.route, 20) || 'local',
    accepted: !!c.accepted,
    slots: obj(c.slots),
  };
}

// -- immutable updates: each returns a NEW context, so a caller can never half-apply a change --

export function recordCommand(ctx: TeachingContext, cmd: Partial<CommandRecord>): TeachingContext {
  const commands = [...ctx.commands, normalizeCommand(cmd)].slice(-MAX_COMMANDS);
  return { ...ctx, commands, updatedAt: new Date().toISOString() };
}
export function setExplanation(ctx: TeachingContext, text: string): TeachingContext {
  return { ...ctx, currentExplanation: s(text, MAX_TEXT), updatedAt: new Date().toISOString() };
}
export function setBoard(ctx: TeachingContext, b: Partial<BoardStateRef>): TeachingContext {
  return { ...ctx, board: normalizeBoard({ ...ctx.board, ...b }), updatedAt: new Date().toISOString() };
}
export function setExperience(ctx: TeachingContext, e: Partial<ExperienceRef>): TeachingContext {
  return { ...ctx, experience: normalizeExperience({ ...ctx.experience, ...e }), updatedAt: new Date().toISOString() };
}
export function setExperiment(ctx: TeachingContext, x: Partial<ExperimentState>): TeachingContext {
  return { ...ctx, experiment: normalizeExperiment({ ...ctx.experiment, ...x }), updatedAt: new Date().toISOString() };
}

/**
 * The compact context an intent classifier — or, later, a model prompt — is given. Small on
 * purpose: a context window carrying the whole lesson is one nobody can reason about, and on a
 * phone it is also bytes on a metered connection.
 */
export interface ContextWindow {
  topic: string;
  objectives: string[];
  learnerLevel: string;
  language: string;
  hasBoard: boolean;
  boardTemplate: string | null;
  boardParams: Record<string, any>;
  hasExperience: boolean;
  experienceKind: string | null;
  experienceParams: Record<string, any>;
  experimentRunning: boolean;
  recent: { utterance: string; kind: string; accepted: boolean }[];
}

export function contextWindow(ctx: TeachingContext, commands = 6): ContextWindow {
  return {
    topic: ctx.topic,
    objectives: ctx.objectives.slice(0, 6),
    learnerLevel: ctx.learnerLevel,
    language: ctx.language,
    hasBoard: !!ctx.board.templateId,
    boardTemplate: ctx.board.templateId,
    boardParams: ctx.board.params,
    hasExperience: !!ctx.experience.id,
    experienceKind: ctx.experience.kind,
    experienceParams: ctx.experience.params,
    experimentRunning: ctx.experiment.running,
    recent: ctx.commands.slice(-Math.max(0, commands)).map((c) => ({ utterance: c.utterance, kind: c.kind, accepted: c.accepted })),
  };
}

/**
 * DEIXIS. "Make it faster", "show that again", "increase the angle" — what is "it"?
 * Resolution order is deliberately: the current Experience, then the live board, then nothing.
 * Returning target 'none' is a first-class answer: the right response to an unresolvable reference
 * is to do nothing and let the teacher keep talking, not to guess and fire something.
 */
export interface Reference {
  target: 'experience' | 'board' | 'none';
  templateId: string | null;
  params: Record<string, any>;
  pronoun: string | null;
  reason: string;
}

export function resolveReference(ctx: TeachingContext, text: string): Reference {
  const t = ' ' + String(text || '').toLowerCase().trim() + ' ';
  const pronouns = [' it ', ' that ', ' this ', ' them ', ' those ', ' the same ', ' again '];
  const hit = pronouns.find((p) => t.includes(p));
  const pronoun = hit ? hit.trim() : null;

  if (ctx.experience.id && ctx.experience.status !== 'hidden') {
    return { target: 'experience', templateId: ctx.experience.kind, params: ctx.experience.params, pronoun, reason: 'current Experience' };
  }
  if (ctx.board.templateId) {
    return { target: 'board', templateId: ctx.board.templateId, params: ctx.board.params, pronoun, reason: 'current board state' };
  }
  return { target: 'none', templateId: null, params: {}, pronoun, reason: 'nothing on the board and no Experience — the reference cannot be resolved' };
}

/** A one-paragraph, deterministic summary. Used on screen AND as the context line for a prompt. */
export function summarizeContext(ctx: TeachingContext): string {
  const bits: string[] = [];
  bits.push(ctx.topic ? 'Topic: ' + ctx.topic + '.' : 'Topic not set.');
  if (ctx.objectives.length) bits.push('Objectives: ' + ctx.objectives.slice(0, 3).join('; ') + '.');
  bits.push('Learner level: ' + ctx.learnerLevel + ', language ' + ctx.language + '.');
  bits.push(ctx.board.templateId ? 'Board shows ' + ctx.board.templateId + ' (' + ctx.board.playState + ').' : 'Board is empty.');
  if (ctx.experience.id) bits.push('Experience ' + ctx.experience.kind + ' v' + ctx.experience.version + ' is ' + ctx.experience.status + '.');
  if (ctx.experiment.running) bits.push('An experiment is running at step ' + ctx.experiment.step + '.');
  const last = ctx.commands.slice(-1)[0];
  if (last) bits.push('Last command: "' + last.utterance + '" (' + last.kind + ').');
  return bits.join(' ');
}

/**
 * Which section-11 fields are missing. Honest, not decorative: a session with no lesson and no
 * objectives interprets sentences with less context, and the teacher is told so rather than being
 * handed confident nonsense.
 */
export function contextGaps(ctx: TeachingContext): string[] {
  const gaps: string[] = [];
  if (!ctx.institutionId) gaps.push('institution');
  if (!ctx.courseId) gaps.push('course');
  if (!ctx.moduleId) gaps.push('module');
  if (!ctx.lessonId) gaps.push('lesson');
  if (!ctx.topic) gaps.push('topic');
  if (!ctx.objectives.length) gaps.push('objectives');
  if (!ctx.teacherId) gaps.push('teacher');
  return gaps;
}

/** 0..1 — how much of the section-11 context this session actually has. */
export function contextCompleteness(ctx: TeachingContext): number {
  const total = 7;
  return Math.max(0, Math.min(1, (total - contextGaps(ctx).length) / total));
}

// ---------------------------------------------------------------------------------------------
// PERSISTENCE (additive tables, created and then VERIFIED against information_schema)
// ---------------------------------------------------------------------------------------------

const DDL = [
  `CREATE TABLE IF NOT EXISTS aes_sessions (
    session_id text PRIMARY KEY,
    institution_id text,
    course_id text,
    module_id text,
    lesson_id text,
    topic text NOT NULL DEFAULT '',
    objectives jsonb NOT NULL DEFAULT '[]'::jsonb,
    teacher_id text,
    learner_level text NOT NULL DEFAULT 'tutor',
    language text NOT NULL DEFAULT 'en',
    context jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS aes_session_commands (
    id bigserial PRIMARY KEY,
    session_id text NOT NULL,
    utterance text NOT NULL DEFAULT '',
    kind text NOT NULL DEFAULT 'speech',
    latency_class text NOT NULL DEFAULT 'ultra-low',
    route text NOT NULL DEFAULT 'local',
    accepted boolean NOT NULL DEFAULT false,
    slots jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS aes_session_commands_session_idx ON aes_session_commands (session_id, id DESC)`,
];
const REQUIRED: Record<string, string[]> = {
  aes_sessions: ['session_id', 'institution_id', 'course_id', 'module_id', 'lesson_id', 'topic', 'objectives', 'teacher_id', 'learner_level', 'language', 'context', 'started_at', 'updated_at'],
  aes_session_commands: ['id', 'session_id', 'utterance', 'kind', 'latency_class', 'route', 'accepted', 'slots', 'created_at'],
};
export const sessionSchema = makeSchemaGuard('aes_teaching_session_v1', DDL, REQUIRED);

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
async function ctxDb() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

/**
 * Persist the whole context. THROWS on failure — a session the teacher believes is saved and is
 * not saved is exactly the divergence between reported success and observable result that has
 * cost this project before.
 */
export async function saveContext(c: TeachingContext): Promise<void> {
  const state = await sessionSchema.ensure();
  assertSchema(state, 'saveContext');
  const { db, sql } = await ctxDb();
  const payload = JSON.stringify({ board: c.board, experience: c.experience, experiment: c.experiment, currentExplanation: c.currentExplanation });
  try {
    await db.execute(sql`INSERT INTO aes_sessions
      (session_id, institution_id, course_id, module_id, lesson_id, topic, objectives, teacher_id, learner_level, language, context, started_at, updated_at)
      VALUES (${c.sessionId}, ${c.institutionId}, ${c.courseId}, ${c.moduleId}, ${c.lessonId}, ${c.topic},
              ${JSON.stringify(c.objectives)}::jsonb, ${c.teacherId}, ${c.learnerLevel}, ${c.language},
              ${payload}::jsonb, ${c.startedAt}, now())
      ON CONFLICT (session_id) DO UPDATE SET
        institution_id = EXCLUDED.institution_id, course_id = EXCLUDED.course_id,
        module_id = EXCLUDED.module_id, lesson_id = EXCLUDED.lesson_id, topic = EXCLUDED.topic,
        objectives = EXCLUDED.objectives, teacher_id = EXCLUDED.teacher_id,
        learner_level = EXCLUDED.learner_level, language = EXCLUDED.language,
        context = EXCLUDED.context, updated_at = now()`);
  } catch (e: any) {
    throw new Error('saveContext failed: ' + (e?.cause?.message || e?.message || 'unknown'));
  }
}

/** Append one command to the durable history. Throws — never a silent loss of the class record. */
export async function appendCommand(sessionId: string, cmd: Partial<CommandRecord>): Promise<number> {
  const state = await sessionSchema.ensure();
  assertSchema(state, 'appendCommand');
  const c = normalizeCommand(cmd);
  const { db, sql } = await ctxDb();
  try {
    const r = rows(await db.execute(sql`INSERT INTO aes_session_commands (session_id, utterance, kind, latency_class, route, accepted, slots)
      VALUES (${sessionId}, ${c.utterance}, ${c.kind}, ${c.latencyClass}, ${c.route}, ${c.accepted}, ${JSON.stringify(c.slots)}::jsonb)
      RETURNING id`));
    return Number(r[0]?.id || 0);
  } catch (e: any) {
    throw new Error('appendCommand failed: ' + (e?.cause?.message || e?.message || 'unknown'));
  }
}

/** Read a session back, commands oldest-first, ready to hand straight to the classifier. */
export async function loadContext(sessionId: string): Promise<TeachingContext | null> {
  const state = await sessionSchema.ensure();
  if (!state.ok) return null;                       // a read may degrade; a write may not
  const { db, sql } = await ctxDb();
  const r = rows(await db.execute(sql`SELECT * FROM aes_sessions WHERE session_id = ${sessionId} LIMIT 1`))[0];
  if (!r) return null;
  const cmds = rows(await db.execute(sql`SELECT * FROM aes_session_commands WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${MAX_COMMANDS}`))
    .reverse()
    .map((x: any) => normalizeCommand({
      at: x.created_at ? new Date(x.created_at).toISOString() : undefined,
      utterance: x.utterance, kind: x.kind, latencyClass: x.latency_class,
      route: x.route, accepted: !!x.accepted, slots: x.slots,
    }));
  const stored = (r.context && typeof r.context === 'object') ? r.context : {};
  return createContext({
    sessionId: String(r.session_id),
    institutionId: r.institution_id, courseId: r.course_id, moduleId: r.module_id, lessonId: r.lesson_id,
    topic: r.topic, objectives: Array.isArray(r.objectives) ? r.objectives : [],
    teacherId: r.teacher_id, learnerLevel: r.learner_level, language: r.language,
    currentExplanation: (stored as any).currentExplanation || '',
    board: (stored as any).board, experience: (stored as any).experience, experiment: (stored as any).experiment,
    commands: cmds,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
  });
}

/**
 * Mirror the live board's latest broadcast into section 11's "current board state". The board
 * remains the source of truth for what students see; this only reads it. Reusing the existing
 * channel is the point — there is no second broadcast here.
 */
export async function syncBoardState(ctx: TeachingContext): Promise<TeachingContext> {
  try {
    const { currentEvent } = await import('@/lib/board-session');
    const ev = await currentEvent(ctx.sessionId);
    if (!ev) return ctx;
    return setBoard(ctx, { templateId: ev.templateId, params: ev.params, playState: ev.playState, timelinePos: ev.timelinePos, seq: ev.seq });
  } catch {
    return ctx;   // a read-only convenience; the board itself is unaffected
  }
}

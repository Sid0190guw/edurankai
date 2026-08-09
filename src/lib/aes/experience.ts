// src/lib/aes/experience.ts — THE Experience TYPE (spec section 19), and the bridge that puts it
// on the transport this repository already has.
//
// WHAT WAS ALREADY THERE. edu_board_events + /api/aquintutor/board/stream already broadcast a SPEC
// AND NOT A FRAME: monotonic seq, discriminated payload, play state, timeline position, actor,
// Last-Event-ID resume, and a render capability envelope {tier, animate, physics} that the SERVER
// resolves per receiver. That is section 19's mechanism, in production, with tests.
//
// THE FOUR THINGS IT COULD NOT EXPRESS, and that an Experience adds:
//   1. a VERSION on the event, so a payload shape can change without guessing;
//   2. a KIND separate from a RENDERER id — templateId was doing both jobs, which is why a
//      damped oscillator had nowhere to live;
//   3. a SUPERSEDE, so a teacher can pull something back off thirty screens (section 28);
//   4. a DECLARED PARAMS SCHEMA per kind, instead of per-endpoint hand-clamping.
// Plus the two things section 20 requires and no board payload carried: what AES UNDERSTOOD, and
// WHICH PHYSICS MODEL produced the numbers together with what it could not verify.
//
// IT DOES NOT FORK THE TRANSPORT. toBoardTemplateId()/toBoardParams() emit a payload the EXISTING
// student page already renders — a parametric template stays a parametric template, a computed
// simulation rides as a `scene` whose points are the integrated series — with the whole Experience
// envelope carried alongside under params.aes. An old renderer ignores the extra key (clampParams
// builds its output from the template schema and drops what it does not know); a renderer that
// understands AES reads it. Nothing on a student's screen changes shape to make room for this.
import { clampToSpec } from '@/lib/board-speech';
import { isTemplate } from '@/lib/animation';
import { normalizeScene, type SceneSpec } from '@/lib/scene-spec';

export const EXPERIENCE_VERSION = 1;

/** WHAT the experience is. Deliberately not the same axis as WHICH RENDERER draws it. */
export type ExperienceKind = 'parametric' | 'scene' | 'simulation' | 'ink' | 'slide';
/** Where a teacher has put it. Nothing reaches a student on 'draft' or 'rejected'. */
export type Approval = 'draft' | 'approved' | 'locked' | 'rejected' | 'retracted';
export type PlayState = 'playing' | 'paused' | 'static';

/** What AES understood — shown to the teacher BEFORE anything is broadcast. */
export interface ExperienceIntent {
  utterance: string;
  /** one sentence, in the teacher's language, of what was understood */
  understood: string;
  concept: string;
  source: 'teacher' | 'rule' | 'model';
  confidence: number;
  /** true when nothing matched — an empty result, not a failure */
  unmatched: boolean;
}

/** WHICH physics model produced the numbers, and what it could not check. Section 20 and 172. */
export interface ModelReport {
  modelId: string | null;
  modelName: string;
  solver: 'rk4' | 'closed-form' | 'none';
  computedBy: 'deterministic-engine' | 'authored-scene' | 'none';
  assumptions: string[];
  checks: { name: string; ok: boolean; detail: string }[];
  /** never abridged for layout; a teacher approving this is entitled to all of it */
  cannotVerify: string[];
  invariants: { label: string; value: number; unit: string }[];
  error: string | null;
}

export interface Experience {
  version: number;
  id: string;
  sessionId: string;
  kind: ExperienceKind;
  /** the renderer id the transport carries: a template id, or 'scene' | 'ink' | 'slide' */
  renderer: string;
  params: Record<string, any>;
  playState: PlayState;
  timelinePos: number;
  title: string;
  courseId: string | null;
  lessonId: string | null;
  intent: ExperienceIntent;
  model: ModelReport;
  approval: Approval;
  /** the id of the experience this one takes off the screen (section 28) */
  supersedes: string | null;
  /** the edu_board_events seq this was broadcast as; 0 means it has never reached a student */
  boardSeq: number;
  actor: string | null;
  at: string;
}

// ---------------------------------------------------------------------------------------------
// THE DECLARED SCHEMA PER KIND — the thing board.ts had to hand-clamp inline at four endpoints
// ---------------------------------------------------------------------------------------------

export interface KindSchema {
  kind: ExperienceKind;
  label: string;
  /** which renderer ids this kind may name; 'template' means the animation template registry */
  renderers: 'template' | string[];
  /** the params keys this kind promises to carry */
  keys: string[];
  describe: string;
}

export const KIND_SCHEMA: Record<ExperienceKind, KindSchema> = {
  parametric: { kind: 'parametric', label: 'Parametric template', renderers: 'template', keys: ['<template schema>'], describe: 'A registry template driven by clamped parameters. The oldest and cheapest path: one insert, no model call.' },
  scene: { kind: 'scene', label: 'Authored scene', renderers: ['scene'], keys: ['scene'], describe: 'A declarative SceneSpec, validated and repaired, rendered by WebGL or the 2D fallback from the same resolved model.' },
  simulation: { kind: 'simulation', label: 'Computed simulation', renderers: ['scene'], keys: ['scene', 'modelId', 'modelParams'], describe: 'A scene whose geometry IS the output of the deterministic physics engine. No drawing step can disagree with the integration.' },
  ink: { kind: 'ink', label: 'Board ink', renderers: ['ink'], keys: ['strokes', 'source'], describe: 'Vector strokes from a pen layer or a captured physical board. Never pixels, never an image.' },
  slide: { kind: 'slide', label: 'Structured slide', renderers: ['slide'], keys: ['slide'], describe: 'A title and bullets as structured text, so it re-renders at any tier and in any language.' },
};

const KINDS = Object.keys(KIND_SCHEMA) as ExperienceKind[];
const APPROVALS: Approval[] = ['draft', 'approved', 'locked', 'rejected', 'retracted'];
const PLAY: PlayState[] = ['playing', 'paused', 'static'];

// ---------------------------------------------------------------------------------------------
// Normalise + repair. Never throws — a hallucinated or malformed experience becomes a repaired
// one with its issues listed, exactly the posture scene-spec.ts already takes.
// ---------------------------------------------------------------------------------------------

const s = (v: any, def: string, max = 400): string => (typeof v === 'string' && v.length ? v.slice(0, max) : def);
const nClamp = (v: any, min: number, max: number, def: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

export function blankIntent(utterance = ''): ExperienceIntent {
  return { utterance, understood: '', concept: '', source: 'teacher', confidence: 0, unmatched: !utterance };
}
export function blankModel(): ModelReport {
  return { modelId: null, modelName: '', solver: 'none', computedBy: 'none', assumptions: [], checks: [], cannotVerify: [], invariants: [], error: null };
}

/** A stable id that survives a page reload and can be named by a supersede. */
export function experienceId(): string {
  const r = Math.random().toString(36).slice(2, 10);
  return 'exp_' + Date.now().toString(36) + '_' + r;
}

export function normalizeExperience(input: any): { experience: Experience; issues: string[] } {
  const issues: string[] = [];
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : (issues.push('experience was not an object; used an empty one'), {} as any);

  let kind = String(src.kind || 'parametric') as ExperienceKind;
  if (!KINDS.includes(kind)) { issues.push('unknown kind "' + String(src.kind) + '" treated as slide'); kind = 'slide'; }

  const schema = KIND_SCHEMA[kind];
  let renderer = String(src.renderer || '');
  if (schema.renderers === 'template') {
    if (!isTemplate(renderer)) { issues.push('renderer "' + renderer + '" is not a registry template; used projectile'); renderer = 'projectile'; }
  } else if (!schema.renderers.includes(renderer)) {
    issues.push('renderer "' + renderer + '" is not valid for kind ' + kind + '; used ' + schema.renderers[0]);
    renderer = schema.renderers[0];
  }

  const params = normalizeParams(kind, renderer, src.params, issues);

  let approval = String(src.approval || 'draft') as Approval;
  if (!APPROVALS.includes(approval)) { issues.push('unknown approval "' + String(src.approval) + '" treated as draft'); approval = 'draft'; }
  let playState = String(src.playState || (kind === 'ink' || kind === 'slide' ? 'static' : 'playing')) as PlayState;
  if (!PLAY.includes(playState)) { issues.push('unknown play state; treated as paused'); playState = 'paused'; }

  const rawIntent = src.intent && typeof src.intent === 'object' ? src.intent : {};
  const intent: ExperienceIntent = {
    utterance: s(rawIntent.utterance, '', 1000),
    understood: s(rawIntent.understood, '', 600),
    concept: s(rawIntent.concept, '', 120),
    source: (['teacher', 'rule', 'model'] as const).includes(rawIntent.source) ? rawIntent.source : 'teacher',
    confidence: nClamp(rawIntent.confidence, 0, 1, 0),
    unmatched: rawIntent.unmatched === true,
  };

  const rawModel = src.model && typeof src.model === 'object' ? src.model : {};
  const model: ModelReport = {
    modelId: rawModel.modelId ? s(rawModel.modelId, '', 60) : null,
    modelName: s(rawModel.modelName, '', 160),
    solver: (['rk4', 'closed-form', 'none'] as const).includes(rawModel.solver) ? rawModel.solver : 'none',
    computedBy: (['deterministic-engine', 'authored-scene', 'none'] as const).includes(rawModel.computedBy) ? rawModel.computedBy : 'none',
    assumptions: strList(rawModel.assumptions),
    checks: Array.isArray(rawModel.checks) ? rawModel.checks.slice(0, 20).map((c: any) => ({ name: s(c?.name, 'check', 160), ok: c?.ok === true, detail: s(c?.detail, '', 400) })) : [],
    cannotVerify: strList(rawModel.cannotVerify),
    invariants: Array.isArray(rawModel.invariants) ? rawModel.invariants.slice(0, 12).map((i: any) => ({ label: s(i?.label, '', 120), value: Number(i?.value) || 0, unit: s(i?.unit, '', 20) })) : [],
    error: rawModel.error ? s(rawModel.error, '', 400) : null,
  };

  const experience: Experience = {
    version: EXPERIENCE_VERSION,
    id: s(src.id, experienceId(), 80),
    sessionId: s(src.sessionId, '', 120),
    kind, renderer, params,
    playState,
    timelinePos: nClamp(src.timelinePos, 0, 1, 0),
    title: s(src.title, KIND_SCHEMA[kind].label, 200),
    courseId: src.courseId ? s(src.courseId, '', 80) : null,
    lessonId: src.lessonId ? s(src.lessonId, '', 80) : null,
    intent, model, approval,
    supersedes: src.supersedes ? s(src.supersedes, '', 80) : null,
    boardSeq: Math.max(0, Math.round(Number(src.boardSeq) || 0)),
    actor: src.actor ? s(src.actor, '', 80) : null,
    at: typeof src.at === 'string' && src.at ? src.at : new Date().toISOString(),
  };
  return { experience, issues };
}

function strList(v: any, cap = 20, max = 500): string[] {
  return Array.isArray(v) ? v.slice(0, cap).map((x: any) => String(x).slice(0, max)).filter(Boolean) : [];
}

function normalizeParams(kind: ExperienceKind, renderer: string, raw: any, issues: string[]): Record<string, any> {
  const p = raw && typeof raw === 'object' ? raw : {};
  if (kind === 'parametric') return clampToSpec(renderer, p);
  if (kind === 'scene' || kind === 'simulation') {
    const { spec, issues: si } = normalizeScene(p.scene);
    for (const i of si) issues.push('scene: ' + i);
    const out: Record<string, any> = { scene: spec };
    if (kind === 'simulation') {
      out.modelId = p.modelId ? String(p.modelId).slice(0, 60) : null;
      out.modelParams = p.modelParams && typeof p.modelParams === 'object' ? p.modelParams : {};
    }
    return out;
  }
  if (kind === 'ink') {
    // The same shape board.ts already enforces inline, moved into the schema so there is ONE
    // definition of what ink is instead of one per endpoint.
    const strokes = Array.isArray(p.strokes)
      ? p.strokes.slice(0, 400).map((st: any) => Array.isArray(st) ? st.slice(0, 400).map((q: any) => [Number(q?.[0]) || 0, Number(q?.[1]) || 0]) : []).filter((st: any[]) => st.length)
      : [];
    if (Array.isArray(p.strokes) && p.strokes.length > 400) issues.push('ink: kept the first 400 strokes');
    return { strokes, source: p.source === 'physical' ? 'physical' : 'pen' };
  }
  // slide
  const slide = p.slide && typeof p.slide === 'object' ? p.slide : {};
  return {
    slide: {
      title: String(slide.title || '').slice(0, 200),
      bullets: Array.isArray(slide.bullets) ? slide.bullets.slice(0, 12).map((b: any) => String(b).slice(0, 200)) : [],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The bridge to the EXISTING board transport
// ---------------------------------------------------------------------------------------------

/** Which templateId this Experience rides as. A computed simulation is a `scene` — nothing new. */
export function toBoardTemplateId(exp: Experience): string {
  if (exp.kind === 'parametric') return exp.renderer;
  if (exp.kind === 'simulation' || exp.kind === 'scene') return 'scene';
  return exp.kind;                                              // 'ink' | 'slide'
}

/**
 * The params a student's browser receives. Backwards-compatible by construction: every key the
 * existing renderer branches on is in the same place it has always been, and the Experience
 * envelope sits beside it under `aes`. A renderer that has never heard of AES draws exactly what
 * it drew before.
 */
export function toBoardParams(exp: Experience): Record<string, any> {
  const envelope = {
    version: exp.version,
    id: exp.id,
    kind: exp.kind,
    renderer: exp.renderer,
    title: exp.title,
    approval: exp.approval,
    supersedes: exp.supersedes,
    intent: { understood: exp.intent.understood, concept: exp.intent.concept, source: exp.intent.source, confidence: exp.intent.confidence },
    model: { modelId: exp.model.modelId, modelName: exp.model.modelName, solver: exp.model.solver, computedBy: exp.model.computedBy, cannotVerify: exp.model.cannotVerify },
  };
  if (exp.kind === 'parametric') return { ...exp.params, aes: envelope };
  if (exp.kind === 'scene' || exp.kind === 'simulation') return { scene: exp.params.scene, aes: envelope };
  if (exp.kind === 'ink') return { strokes: exp.params.strokes, source: exp.params.source, aes: envelope };
  return { slide: exp.params.slide, aes: envelope };
}

/** Read an Experience envelope back off a board event, when one is present. */
export function envelopeFromBoardParams(params: any): any | null {
  return params && typeof params === 'object' && params.aes && typeof params.aes === 'object' ? params.aes : null;
}

/**
 * Section 28: THE RETRACTION. The board channel has no delete and no expiry — an event is a row and
 * rows do not un-happen — so taking something back means broadcasting a REPLACEMENT that supersedes
 * it. This builds that replacement: either the previous approved experience, or a plain structured
 * slide carrying the lesson title. It is stated here rather than hidden in an endpoint because a
 * teacher must be told what "take it back" actually does: the class stops seeing it, and the record
 * that it was shown remains.
 */
export function buildRetraction(exp: Experience, previous: Experience | null, fallbackTitle: string): Experience {
  if (previous && previous.approval === 'approved') {
    const { experience } = normalizeExperience({ ...previous, id: experienceId(), supersedes: exp.id, approval: 'approved', boardSeq: 0, at: new Date().toISOString() });
    return experience;
  }
  const { experience } = normalizeExperience({
    id: experienceId(),
    sessionId: exp.sessionId,
    kind: 'slide',
    renderer: 'slide',
    params: { slide: { title: fallbackTitle || 'Back to the board', bullets: ['The previous item was withdrawn by the teacher.'] } },
    title: 'Withdrawn',
    courseId: exp.courseId, lessonId: exp.lessonId,
    approval: 'approved',
    supersedes: exp.id,
    actor: exp.actor,
    intent: { utterance: '', understood: 'The teacher withdrew what was on the board.', concept: 'retraction', source: 'teacher', confidence: 1, unmatched: false },
  });
  return experience;
}

/** May this experience be broadcast? Section 28 in one place, so no endpoint can forget it. */
export function canBroadcast(exp: Experience): { ok: boolean; reason: string } {
  if (exp.approval === 'rejected') return { ok: false, reason: 'this experience was rejected; a rejected experience never reaches a student' };
  if (exp.approval === 'retracted') return { ok: false, reason: 'this experience was withdrawn; broadcast a new one instead' };
  if (exp.approval === 'draft') return { ok: false, reason: 'approve it first — nothing is shown to a class until a teacher has approved it' };
  if (exp.kind === 'simulation' && exp.model.error) return { ok: false, reason: 'the physics engine reported: ' + exp.model.error };
  if (exp.kind === 'simulation' && exp.model.checks.some((c) => !c.ok)) {
    return { ok: false, reason: 'a physics check failed: ' + (exp.model.checks.find((c) => !c.ok)?.detail || 'unknown') };
  }
  return { ok: true, reason: '' };
}

/** May a teacher still change it? A locked experience is frozen on purpose (section 28). */
export function canEdit(exp: Experience): { ok: boolean; reason: string } {
  if (exp.approval === 'locked') return { ok: false, reason: 'locked — unlock it before changing a parameter' };
  if (exp.approval === 'retracted') return { ok: false, reason: 'withdrawn — start a new experience' };
  return { ok: true, reason: '' };
}

/** The one-line summary the teacher console shows above the approve button. */
export function summarise(exp: Experience): string {
  const bits: string[] = [KIND_SCHEMA[exp.kind].label];
  if (exp.kind === 'parametric') bits.push(exp.renderer + ' (' + Object.keys(exp.params).map((k) => k + '=' + exp.params[k]).join(', ') + ')');
  if (exp.kind === 'simulation') bits.push(exp.model.modelName + ' via ' + exp.model.solver.toUpperCase());
  if (exp.kind === 'scene') bits.push(((exp.params.scene as SceneSpec)?.objects?.length || 0) + ' objects');
  if (exp.kind === 'slide') bits.push((exp.params.slide?.bullets?.length || 0) + ' bullets');
  if (exp.kind === 'ink') bits.push((exp.params.strokes?.length || 0) + ' strokes');
  return bits.join(' — ');
}

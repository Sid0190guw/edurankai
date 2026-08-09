// src/lib/aes/intent.ts — AES section 12 (what did the teacher just ask for?) and section 22/23
// (which path is allowed to answer it).
//
// SECTION 12. A teacher speaks in ordinary sentences. They must not learn a command language, and
// they must be able to explain out loud for ten minutes without the system firing anything at the
// class. So ORDINARY SPEECH IS THE DEFAULT, and a sentence only becomes a command when it carries
// a directive marker. "The projectile lands about thirty metres away" is teaching. "Show me the
// projectile at thirty degrees" is a request.
//
// SECTIONS 22 AND 23. A label, a camera nudge and a parameter tweak are not generation requests,
// and sending them down a model round trip is what makes a teaching tool unusable in a real class.
// Every intent kind is bound at declaration to a LATENCY CLASS, a budget, a route and whether a
// model may be involved at all. Ultra-low kinds are marked allowModel:false and assertModelAllowed()
// throws if a caller tries anyway — the routing is enforced, not documented.
//
// It reuses the existing extractor (board-speech.ts: detectTemplate / extractParams / clampToSpec),
// which already mirrors the browser template schema. There is no second parameter parser here.
import { detectTemplate, extractParams, clampToSpec, PARAM_SPEC } from '@/lib/board-speech';
import type { ContextWindow } from '@/lib/aes/session';

export type IntentKind =
  | 'speech'      // ordinary teaching — nothing fires
  | 'visualize'   // show/draw an existing thing
  | 'object'      // generate something new
  | 'animate'     // animate / re-time what is there
  | 'parameter'   // change a parameter of what is there
  | 'camera'      // move the viewpoint
  | 'annotate'    // label, mark, highlight
  | 'simulate'    // run / pause / step / reset the experiment
  | 'compare'     // put two things beside each other
  | 'explain';    // a request for an explanation

export type LatencyClass = 'ultra-low' | 'low' | 'moderate';
export type Route = 'local' | 'engine' | 'model';

export interface RoutePolicy { latencyClass: LatencyClass; budgetMs: number; route: Route; allowModel: boolean }

/**
 * THE ROUTING TABLE (section 22). Read it as the promise the teacher is given:
 *   ultra-low  — answered on the spot with arithmetic. No model. Ever.
 *   low        — answered by a deterministic engine (template registry, scene modification).
 *   moderate   — the only place a generation request is allowed to take a slow path.
 */
export const ROUTING: Record<IntentKind, RoutePolicy> = {
  speech:    { latencyClass: 'ultra-low', budgetMs: 0,    route: 'local',  allowModel: false },
  camera:    { latencyClass: 'ultra-low', budgetMs: 50,   route: 'local',  allowModel: false },
  parameter: { latencyClass: 'ultra-low', budgetMs: 80,   route: 'local',  allowModel: false },
  annotate:  { latencyClass: 'ultra-low', budgetMs: 80,   route: 'local',  allowModel: false },
  simulate:  { latencyClass: 'ultra-low', budgetMs: 100,  route: 'local',  allowModel: false },
  visualize: { latencyClass: 'low',       budgetMs: 400,  route: 'engine', allowModel: false },
  animate:   { latencyClass: 'low',       budgetMs: 400,  route: 'engine', allowModel: false },
  compare:   { latencyClass: 'low',       budgetMs: 800,  route: 'engine', allowModel: true  },
  explain:   { latencyClass: 'moderate',  budgetMs: 2500, route: 'model',  allowModel: true  },
  object:    { latencyClass: 'moderate',  budgetMs: 4000, route: 'model',  allowModel: true  },
};

/** The kinds that may never reach a model, whatever a caller believes it is doing. */
export const LOCAL_ONLY_KINDS: readonly IntentKind[] = Object.freeze(
  (Object.keys(ROUTING) as IntentKind[]).filter((k) => !ROUTING[k].allowModel)
);

export interface Intent {
  kind: IntentKind;
  confidence: number;          // 0..1
  transcript: string;
  matched: string[];           // the exact markers that decided it — shown to the teacher, not hidden
  slots: Record<string, any>;
  latencyClass: LatencyClass;
  budgetMs: number;
  route: Route;
  allowModel: boolean;
  needsConfirmation: boolean;  // low confidence: suggest, never act
  reason: string;
}

// ---------------------------------------------------------------------------------------------
// MARKERS. Weighted, natural phrasing — never a command language the teacher has to memorise.
// ---------------------------------------------------------------------------------------------
type Marker = [string, number];

const MARKERS: Record<Exclude<IntentKind, 'speech'>, Marker[]> = {
  camera: [['camera', 3], ['zoom in', 3], ['zoom out', 3], ['zoom', 2], ['pan ', 2], ['tilt', 2], ['orbit', 2],
    ['top view', 3], ['side view', 3], ['front view', 3], ['from the top', 3], ['from the side', 3], ['from the front', 3],
    ['closer', 2], ['further away', 2], ['zoom back', 3], ['reset the view', 3], ['look at', 2], ['point of view', 3], ['rotate', 1]],
  parameter: [['increase', 3], ['decrease', 3], ['reduce', 3], ['raise', 2], ['lower', 2], ['set the', 2], ['change the', 2],
    ['make it', 3], ['faster', 3], ['slower', 3], ['bigger', 2], ['smaller', 2], ['taller', 2], ['shorter', 2],
    ['double', 3], ['halve', 3], ['turn it up', 2], ['turn it down', 2], ['what if', 2], ['try it with', 3], ['now try', 2]],
  annotate: [['label', 3], ['annotate', 3], ['highlight', 3], ['underline', 3], ['circle the', 3], ['mark the', 3],
    ['point at', 3], ['point to', 3], ['call this', 3], ['write ', 2], ['put an arrow', 3], ['tag the', 2], ['clear the labels', 3]],
  simulate: [['simulate', 3], ['run it', 3], ['run the', 3], ['start the simulation', 3], ['pause', 3], ['resume', 2],
    ['freeze', 3], ['reset', 3], ['restart', 3], ['step through', 3], ['next step', 3], ['one step', 3], ['stop it', 3], ['play it', 2], ['keep going', 2]],
  visualize: [['show', 3], ['display', 3], ['draw', 3], ['plot', 3], ['graph', 2], ['put up', 3], ['bring up', 3],
    ['visualise', 3], ['visualize', 3], ['on the board', 2], ['let us see', 2], ['lets see', 2], ['demonstrate', 2], ['have a look at', 2]],
  object: [['create', 3], ['generate', 3], ['build', 3], ['make a', 3], ['make an', 3], ['add a', 3], ['add an', 3],
    ['construct', 3], ['new scene', 3], ['scene of', 3], ['a model of', 3], ['set up a', 2], ['put together', 2]],
  animate: [['animate', 3], ['animation', 2], ['in slow motion', 3], ['slow motion', 3], ['loop it', 3], ['loop the', 2],
    ['make it move', 3], ['set it in motion', 3], ['play the animation', 3]],
  compare: [['compare', 3], ['versus', 3], [' vs ', 3], ['side by side', 3], ['side-by-side', 3],
    ['difference between', 3], ['both at once', 3], ['at the same time as', 2], ['next to each other', 3]],
  explain: [['explain', 3], ['why does', 3], ['why is', 3], ['why do', 3], ['how does', 3], ['how come', 3],
    ['what is the reason', 3], ['can you explain', 3], ['tell them why', 3], ['what happens when', 2]],
};

const CLASS_RANK: Record<LatencyClass, number> = { 'ultra-low': 0, low: 1, moderate: 2 };
const norm = (t: string) => ' ' + String(t || '').toLowerCase().replace(/\s+/g, ' ').trim() + ' ';

function scoreKind(kind: Exclude<IntentKind, 'speech'>, t: string): { score: number; matched: string[] } {
  let score = 0; const matched: string[] = [];
  for (const [term, w] of MARKERS[kind]) {
    if (t.includes(term)) { score += w; matched.push(term.trim()); }
  }
  return { score, matched };
}

/** Does this sentence ask for anything at all? If not, it is teaching, and nothing may fire. */
export function isDirective(text: string): boolean {
  const t = norm(text);
  for (const kind of Object.keys(MARKERS) as Exclude<IntentKind, 'speech'>[]) {
    if (scoreKind(kind, t).score > 0) return true;
  }
  return false;
}

// -- ultra-low slot parsers: pure string work. No model, no engine, no round trip. ---------------

export interface CameraCommand { op: 'zoom-in' | 'zoom-out' | 'orbit' | 'pan' | 'tilt' | 'view' | 'reset'; arg: string | null }
export function cameraCommand(text: string): CameraCommand {
  const t = norm(text);
  if (t.includes('reset the view') || t.includes('reset view')) return { op: 'reset', arg: null };
  if (t.includes('zoom in') || t.includes('closer')) return { op: 'zoom-in', arg: null };
  if (t.includes('zoom out') || t.includes('zoom back') || t.includes('further away')) return { op: 'zoom-out', arg: null };
  for (const v of ['top', 'side', 'front', 'back']) {
    if (t.includes(v + ' view') || t.includes('from the ' + v)) return { op: 'view', arg: v };
  }
  if (t.includes('pan ')) return { op: 'pan', arg: null };
  if (t.includes('tilt')) return { op: 'tilt', arg: null };
  return { op: 'orbit', arg: null };
}

export interface AnnotationCommand { op: 'label' | 'highlight' | 'point' | 'clear'; text: string }
const LABEL_RE = /\b(?:label|call|mark|write|tag)\s+(?:this|that|it)?\s*(?:as\s+)?([A-Za-z0-9 .,_-]{1,60})/i;
export function annotationCommand(text: string): AnnotationCommand {
  const raw = String(text || '');
  const t = norm(raw);
  if (t.includes('clear the labels') || t.includes('remove the labels')) return { op: 'clear', text: '' };
  const quoted = raw.match(/"([^"]{1,80})"/);
  const after = raw.match(LABEL_RE);
  const label = (quoted ? quoted[1] : (after ? after[1] : '')).trim().slice(0, 80);
  if (t.includes('highlight') || t.includes('underline') || t.includes('circle the')) return { op: 'highlight', text: label };
  if (t.includes('point at') || t.includes('point to') || t.includes('arrow')) return { op: 'point', text: label };
  return { op: 'label', text: label };
}

export interface SimulationCommand { op: 'run' | 'pause' | 'resume' | 'reset' | 'step' | 'stop' }
export function simulationCommand(text: string): SimulationCommand {
  const t = norm(text);
  if (t.includes('pause') || t.includes('freeze') || t.includes('hold it')) return { op: 'pause' };
  if (t.includes('reset') || t.includes('restart') || t.includes('start over')) return { op: 'reset' };
  if (t.includes('step through') || t.includes('next step') || t.includes('one step')) return { op: 'step' };
  if (t.includes('stop it') || t.includes(' stop ')) return { op: 'stop' };
  if (t.includes('resume') || t.includes('keep going') || t.includes('carry on')) return { op: 'resume' };
  return { op: 'run' };
}

// -- parameter arithmetic: the whole point of the ultra-low class --------------------------------
//
// "Make it faster" is a multiplication, not a generation. The words map to a real parameter of the
// template already on the board, the arithmetic happens here, and the result goes through the SAME
// clamp (clampToSpec) that constrains the model path — so a spoken tweak can never push a value
// outside the schema either.

const SEMANTIC: Record<string, Record<string, string>> = {
  projectile: { faster: 'v0', slower: 'v0', bigger: 'v0', smaller: 'v0', higher: 'angle', lower: 'angle', taller: 'angle', shorter: 'angle', heavier: 'gravity', lighter: 'gravity' },
  sine: { faster: 'frequency', slower: 'frequency', bigger: 'amplitude', smaller: 'amplitude', higher: 'amplitude', lower: 'amplitude', taller: 'amplitude', shorter: 'amplitude' },
};
const UP = ['increase', 'raise', 'more', 'faster', 'bigger', 'taller', 'higher', 'double', 'turn it up', 'speed it up', 'heavier'];
const DOWN = ['decrease', 'reduce', 'lower', 'less', 'slower', 'smaller', 'shorter', 'halve', 'turn it down', 'slow it down', 'lighter'];

export interface ParamChange {
  op: 'set' | 'scale' | 'none';
  values: Record<string, number>;   // op 'set'
  key: string | null;               // op 'scale'
  factor: number;                   // op 'scale'
  matched: string[];
}

/** Read a parameter change out of a sentence, against the template that is actually on the board. */
export function parseParamChange(templateId: string | null, text: string): ParamChange {
  const empty: ParamChange = { op: 'none', values: {}, key: null, factor: 1, matched: [] };
  if (!templateId || !PARAM_SPEC[templateId]) return empty;
  const t = norm(text);
  const matched: string[] = [];

  // 1. an explicit value the teacher said out loud: "set the angle to sixty", "gravity 1.6"
  const explicit = extractParams(templateId, text);
  const values: Record<string, number> = {};
  for (const [k, v] of Object.entries(explicit)) if (typeof v === 'number' && Number.isFinite(v)) { values[k] = v; matched.push(k); }
  if (Object.keys(values).length) return { op: 'set', values, key: null, factor: 1, matched };

  // 2. a direction word: which way, and by how much
  const up = UP.find((w) => t.includes(w));
  const down = DOWN.find((w) => t.includes(w));
  if (!up && !down) return empty;
  const word = (up || down) as string;
  matched.push(word);
  const factor = t.includes('double') ? 2 : t.includes('halve') ? 0.5 : (up ? 1.25 : 0.8);

  // 2a. a named parameter wins over a loose adjective: "lower the gravity" is gravity, not angle
  for (const spec of PARAM_SPEC[templateId]) {
    if (spec.list) continue;
    if (spec.synonyms.some((s) => t.includes(s))) { matched.push(spec.key); return { op: 'scale', values: {}, key: spec.key, factor, matched }; }
  }
  // 2b. otherwise the adjective decides, per template
  const key = (SEMANTIC[templateId] || {})[word] || null;
  if (!key) return { op: 'none', values: {}, key: null, factor, matched };
  matched.push(key);
  return { op: 'scale', values: {}, key, factor, matched };
}

/** Apply a change to the current params. Clamped to the template schema; never throws. */
export function applyParamChange(templateId: string, current: Record<string, any>, change: ParamChange): { params: Record<string, any>; changed: string[] } {
  const base = clampToSpec(templateId, current || {});
  if (change.op === 'none') return { params: base, changed: [] };
  const next: Record<string, any> = { ...base };
  const changed: string[] = [];
  if (change.op === 'set') {
    for (const [k, v] of Object.entries(change.values)) if (k in next) { next[k] = v; changed.push(k); }
  } else if (change.op === 'scale' && change.key && typeof next[change.key] === 'number') {
    next[change.key] = Number(next[change.key]) * change.factor;
    changed.push(change.key);
  }
  return { params: clampToSpec(templateId, next), changed };
}

// ---------------------------------------------------------------------------------------------
// CLASSIFICATION (section 12)
// ---------------------------------------------------------------------------------------------

/**
 * Classify one teacher utterance against the session context.
 *
 * Three rules carry the weight:
 *   1. ORDINARY SPEECH IS THE DEFAULT. No directive marker, no command — a teacher explaining
 *      projectile motion for five minutes fires nothing.
 *   2. THE CHEAPEST READING WINS A TIE. If a sentence reads equally as a parameter tweak and as a
 *      generation request, it is a parameter tweak (section 22 — the fast path is the common path).
 *   3. CONTEXT DECIDES DEIXIS. With something already on the board, "make it faster" is a change to
 *      that thing; with an empty board the same words resolve to nothing and are marked for
 *      confirmation instead of guessing.
 */
export function classify(transcript: string, ctx?: ContextWindow | null): Intent {
  const raw = String(transcript || '');
  const t = norm(raw);
  const base = (kind: IntentKind, confidence: number, slots: Record<string, any>, matched: string[], reason: string): Intent => ({
    kind, confidence: Math.max(0, Math.min(1, confidence)), transcript: raw.slice(0, 500), matched, slots,
    latencyClass: ROUTING[kind].latencyClass, budgetMs: ROUTING[kind].budgetMs, route: ROUTING[kind].route,
    allowModel: ROUTING[kind].allowModel, needsConfirmation: kind !== 'speech' && confidence < 0.5, reason,
  });

  if (!t.trim()) return base('speech', 1, {}, [], 'empty utterance');

  const concept = detectTemplate(raw);                                   // reuses the existing extractor
  const onBoard = ctx?.boardTemplate || ctx?.experienceKind || null;
  const subject = onBoard || (concept ? concept.templateId : null);

  const scores: Record<string, number> = {};
  const marks: Record<string, string[]> = {};
  for (const kind of Object.keys(MARKERS) as Exclude<IntentKind, 'speech'>[]) {
    const r = scoreKind(kind, t);
    scores[kind] = r.score; marks[kind] = r.matched;
  }

  // context adjustments
  const somethingLive = !!(ctx && (ctx.hasBoard || ctx.hasExperience));
  if (somethingLive) { scores.object -= 2; scores.parameter += 1; }
  else { scores.parameter -= 1; }
  const change = parseParamChange(subject, raw);
  if (change.op !== 'none') { scores.parameter += 3; marks.parameter = [...marks.parameter, ...change.matched]; }
  if (concept && scores.visualize > 0) { scores.visualize += 1; }
  if (concept && scores.object > 0 && somethingLive) { scores.visualize += 1; }   // a known template is a lookup, not a generation

  // pick: highest score, ties to the CHEAPER latency class
  let bestKind: IntentKind = 'speech'; let bestScore = 0;
  for (const kind of Object.keys(scores) as Exclude<IntentKind, 'speech'>[]) {
    const sc = scores[kind];
    if (sc <= 0) continue;
    if (sc > bestScore) { bestKind = kind; bestScore = sc; continue; }
    if (sc === bestScore && bestKind !== 'speech' && CLASS_RANK[ROUTING[kind].latencyClass] < CLASS_RANK[ROUTING[bestKind].latencyClass]) bestKind = kind;
  }
  if (bestScore <= 0) return base('speech', 0.9, {}, [], 'no directive marker — this is teaching, nothing fires');

  // A named, registered template is a LOOKUP, not a generation: never let it take the moderate path.
  if (bestKind === 'object' && concept) bestKind = 'visualize';

  const matched = marks[bestKind] || [];
  const runnerUp = Math.max(0, ...(Object.keys(scores) as string[]).filter((k) => k !== bestKind).map((k) => scores[k]));
  const margin = bestScore - runnerUp;
  let confidence = Math.min(0.95, 0.3 + bestScore * 0.09 + Math.max(0, margin) * 0.05);

  // slots
  const slots: Record<string, any> = {};
  let reason = 'matched ' + matched.slice(0, 3).join(', ');
  if (bestKind === 'camera') { slots.camera = cameraCommand(raw); }
  else if (bestKind === 'annotate') { slots.annotation = annotationCommand(raw); }
  else if (bestKind === 'simulate') { slots.simulation = simulationCommand(raw); }
  else if (bestKind === 'parameter') {
    slots.templateId = subject; slots.change = change;
    if (!subject) { confidence = Math.min(confidence, 0.4); reason = 'a change was asked for, but nothing is on the board to change'; }
    else if (change.op === 'none') { confidence = Math.min(confidence, 0.45); reason = 'a change was asked for, but no parameter of ' + subject + ' was named'; }
    else { slots.next = applyParamChange(subject, ctx?.boardParams || ctx?.experienceParams || {}, change).params; }
  } else if (bestKind === 'visualize' || bestKind === 'animate' || bestKind === 'object') {
    if (concept) {
      slots.templateId = concept.templateId;
      slots.params = clampToSpec(concept.templateId, extractParams(concept.templateId, raw));
      slots.known = true;
      if (bestKind === 'object') { reason = 'names the known template ' + concept.templateId + ' — a registry lookup, not a generation'; }
    } else {
      slots.known = false;
      slots.description = raw.slice(0, 300);
      if (bestKind === 'visualize') { reason = 'a display request naming nothing the registry knows'; }
    }
  } else if (bestKind === 'compare') {
    const m = raw.match(/\b(?:compare|between)\s+(.{1,60}?)\s+(?:with|to|and|versus|vs)\s+(.{1,60})$/i);
    slots.left = m ? m[1].trim() : null; slots.right = m ? m[2].trim() : null;
  } else if (bestKind === 'explain') {
    slots.question = raw.slice(0, 300);
    slots.topic = ctx?.topic || null;
  }

  return base(bestKind, confidence, slots, matched, reason);
}

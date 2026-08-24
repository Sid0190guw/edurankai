// src/lib/career-intel/interpret.ts — HUMAN LANGUAGE INTO STRUCTURED, NUANCED SIGNALS.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// =================================================================================================
//
// A pure, synchronous, first-party reader. No network, no model, no key, no vendor. It takes what
// somebody wrote and returns dimensions with confidences, context dependencies, interests, skills,
// a career stage, and a plain-English summary of what it understood.
//
// IT IS THE FLOOR, NOT THE CEILING. A language model reads nuance better than a lexicon does, and
// the seam for one is `CareerInterpreter` at the bottom of this file — the same shape, async, so a
// model-backed reader can be dropped in behind it without a single caller changing. What is NOT
// acceptable is a careers page that stops working when a model endpoint does, and section 31 of the
// brief says so outright. So the deterministic reader is the default path and the fallback path,
// and the model, when there is one, is an enrichment on top of an answer that already exists.
//
// =================================================================================================
// THE FOUR THINGS A LEXICON USUALLY GETS WRONG, AND WHAT IS DONE ABOUT EACH
// =================================================================================================
//
// 1. NEGATION. "I do not want to work alone" is not evidence of wanting to work alone. Each clause
//    is scanned for a negator before its matches are scored, and a negated match INVERTS the value
//    rather than being dropped — because "I don't like structure" is real evidence about structure.
//
// 2. CONTEXT. "Quiet for hard problems, but energetic people for brainstorming" is two answers, not
//    a contradiction to be averaged into mush. Clauses carrying a context marker are recorded as a
//    ContextDependency instead of being folded into the scalar, and the person sees both.
//
// 3. HEDGING. "I think maybe I prefer research" is weaker evidence than "I want to do research".
//    Hedges scale confidence down; intensifiers scale it up. The value does not move — how sure we
//    are about it does.
//
// 4. "IT DEPENDS". The most honest answer to most of these questions, and the one a scalar cannot
//    hold. It is detected explicitly and lowers confidence across the whole reading rather than
//    being silently ignored.
//
// Everything here is exercised in interpret.test.ts. A refusal rule or a nuance rule that nobody
// can run in a test is one nobody should trust — the same reasoning src/lib/ask/intent.ts gives.

import {
  MODEL_VERSION, type CareerStage, type ContextDependency, type Signal, type Tag,
  type SignalSource, clamp01,
} from './dimensions';
import { INTEREST_DOMAINS, SKILL_LEXICON, STAGE_PATTERNS } from './ontology';

/* ------------------------------------------------------------------------------------ the result */

export interface Interpretation {
  /** Dimension key -> reading. Values 0..1; confidence separate and never merged into the value. */
  dimensions: Record<string, { value: number; confidence: number }>;
  contextDependencies: ContextDependency[];
  interests: { key: string; label: string; confidence: number }[];
  skills: { key: string; label: string; confidence: number }[];
  /** Things the person said they do NOT want. Demotes; never hides. */
  avoid: { key: string; label: string; confidence: number }[];
  stage: CareerStage;
  stageConfidence: number;
  /** Salient words handed to server-side retrieval as a search term. */
  queryTerms: string[];
  /** Overall confidence in this whole reading. Drops on hedging and on "it depends". */
  confidence: number;
  /** Plain sentences shown back before anything is acted on. Empty when nothing was understood. */
  summary: string[];
  modelVersion: string;
  /** True when nothing at all could be read. The caller falls back to plain keyword search. */
  empty: boolean;
}

/* --------------------------------------------------------------------------------- the lexicon */

interface Rule {
  re: RegExp;
  dims: Record<string, number>;
  /** How strong a piece of evidence a match is, before hedges and intensifiers. */
  weight: number;
}

/**
 * PHRASES BEFORE WORDS. Every rule is a phrase or a stemmed word with boundaries, because single
 * loose words are how "I want to work on plant genomics" becomes evidence of wanting a slow pace
 * (from "plant" matching nothing and "want" matching everything).
 */
const RULES: Rule[] = [
  // ---- autonomy / structure / goals ----
  { re: /\b(on my own terms|my own way|freedom in how|figure it out myself|self[-\s]?direct\w*|independen\w+|autonom\w+|own the problem|left alone to)\b/i, dims: { autonomy: 0.88 }, weight: 0.85 },
  { re: /\b(told what to do|clear instructions|defined process|follow a process|guidance|hand[-\s]?holding|well[-\s]?defined approach)\b/i, dims: { structure: 0.85, autonomy: 0.25 }, weight: 0.75 },
  { re: /\b(clear (goals?|objectives?|targets?|outcomes?|deliverables?)|know what success looks like|know what.{0,12}expected|defined goals?)\b/i, dims: { goal_clarity: 0.9 }, weight: 0.85 },
  { re: /\b(structure|structured|organis\w+|organiz\w+|process|framework around)\b/i, dims: { structure: 0.75 }, weight: 0.55 },
  // "FLEXIBILITY" ON ITS OWN MEANS FOUR DIFFERENT THINGS AND IS NOT READ AS ANY OF THEM.
  //
  // An earlier version of this rule also asserted autonomy at 0.6, on the reasoning that people who
  // want flexibility usually want freedom in how they work. Often true, and still the wrong thing
  // to do: it filled in the exact gap the follow-up question exists to ask about, so the engine
  // decided it already knew and never asked. Section 8 of the brief is explicit — do not assume
  // what the word means. It records flexibility, and the follow-up resolves the rest.
  { re: /\b(flexib\w+|freedom|my own (schedule|hours|pace)|choose (when|how)|adapt\w* as i go)\b/i, dims: { flexibility: 0.85 }, weight: 0.7 },
  { re: /\b(routine|same thing every day|predictab\w+|steady rhythm|know what my day)\b/i, dims: { routine: 0.82, structure: 0.6 }, weight: 0.7 },

  // ---- focus / collaboration / social ----
  { re: /\b(quiet|silence|silent|alone|uninterrupted|no distractions?|deep work|deep focus|head down|focus for hours|long stretch\w*)\b/i, dims: { deep_focus: 0.88, collaboration: 0.3 }, weight: 0.8 },
  { re: /\b(with (other )?people|collaborat\w+|team|together|pair\w*|discuss\w*|bounce ideas|whiteboard\w*|group)\b/i, dims: { collaboration: 0.85 }, weight: 0.7 },
  { re: /\b(energetic people|energy of|buzz|around people|social|people around me|talking to people|meeting people)\b/i, dims: { social_energy: 0.85, collaboration: 0.7 }, weight: 0.75 },
  { re: /\b(introvert\w*|prefer working alone|by myself|on my own\b)\b/i, dims: { deep_focus: 0.8, collaboration: 0.22, social_energy: 0.22 }, weight: 0.75 },

  // ---- pace / ambiguity ----
  { re: /\b(fast[-\s]?pac\w+|move quickly|ship fast|quick turnaround|urgency|high tempo|move fast)\b/i, dims: { pace: 0.88 }, weight: 0.8 },
  { re: /\b(take my time|carefully|thorough\w*|slow and steady|no rush|get it right)\b/i, dims: { pace: 0.22, detail_orientation: 0.75 }, weight: 0.7 },
  { re: /\b(uncertain\w*|ambiguous|ambiguity|no clear answer|open[-\s]?ended|not knowing|unknown territory|unsolved|unanswered|nobody has solved|hasn'?t been solved|haven'?t been solved)\b/i, dims: { ambiguity_tolerance: 0.85, research_orientation: 0.72 }, weight: 0.8 },

  // ---- cognitive ----
  { re: /\b(analy\w+|reason\w+ through|logic\w*|rigorous|quantitative|numbers|proof|prove|derivation|first principles)\b/i, dims: { analytical: 0.85 }, weight: 0.75 },
  { re: /\b(experiment\w+|try (it|things) (and see|out)|lab work|hands[-\s]?on|test\w* (it|things)|trial and error|prototyp\w+)\b/i, dims: { experimental: 0.85, implementation: 0.6 }, weight: 0.78 },
  { re: /\b(research\w*|discover\w+|investigat\w+|explore.{0,12}(question|problem)|publish\w*|new knowledge|frontier|open problems?)\b/i, dims: { research_orientation: 0.88, ambiguity_tolerance: 0.6 }, weight: 0.82 },
  { re: /\b(system\w*|architect\w+|how (the|all the) (parts|pieces) fit|end[-\s]?to[-\s]?end|infrastructur\w+|platform|scal\w+ systems?)\b/i, dims: { systems_thinking: 0.85 }, weight: 0.75 },
  { re: /\b(creativ\w+|design\w*|imagin\w+|invent\w+|make something new|from scratch|aesthetic|craft)\b/i, dims: { creativity: 0.85 }, weight: 0.75 },
  { re: /\b(abstract\w*|theor\w+|conceptual|formal\w*|mathematical structure|pure math\w*)\b/i, dims: { abstraction: 0.85, analytical: 0.65 }, weight: 0.78 },
  { re: /\b(build\w*|building|ship\w*|implement\w+|make it work|working (thing|product|system)|hands on the code|actually build)\b/i, dims: { implementation: 0.88 }, weight: 0.8 },
  { re: /\b(cod\w+|programming|develop\w+ software|software)\b/i, dims: { implementation: 0.8, systems_thinking: 0.55 }, weight: 0.7 },
  { re: /\b(optimis\w+|optimiz\w+|efficien\w+|performance|make it faster|hard problems?|difficult problems?|challenging problems?)\b/i, dims: { analytical: 0.8, deep_focus: 0.62 }, weight: 0.72 },

  // ---- rhythm (exploration only — never reaches the ranker) ----
  { re: /\b(morning person|early morning|mornings?\b|before (\d|noon)|at dawn|sharp in the morning)\b/i, dims: { morning_energy: 0.85 }, weight: 0.7 },
  { re: /\b(night owl|late night|at night|evenings?\b|after (dinner|midnight)|nocturnal)\b/i, dims: { evening_energy: 0.85 }, weight: 0.7 },
  { re: /\b(hours at a time|long stretch\w*|marathon|sustained|for hours without)\b/i, dims: { sustained_focus: 0.82 }, weight: 0.7 },
  { re: /\b(in bursts|sprint\w*|short intense|then rest|recovery|pomodoro)\b/i, dims: { burst_focus: 0.82 }, weight: 0.7 },

  // ---- behavioural (exploration only — never reaches the ranker) ----
  { re: /\b(start things|initiative|self[-\s]?starter|without being asked|don'?t wait to be asked|proactive)\b/i, dims: { initiative: 0.85 }, weight: 0.7 },
  { re: /\b(persist\w+|stick with it|don'?t give up|keep going|stubborn about|until it works)\b/i, dims: { persistence: 0.85 }, weight: 0.7 },
  { re: /\b(feedback|critique|criticis\w+|criticiz\w+|argued with|challenged on)\b/i, dims: { feedback_openness: 0.8 }, weight: 0.65 },
  { re: /\b(detail\w*|precise\w*|meticulous|notice.{0,10}(small|wrong)|pedantic)\b/i, dims: { detail_orientation: 0.85 }, weight: 0.7 },
];

/* ------------------------------------------------------------------------------ context markers */

const CONTEXTS: { key: string; label: string; re: RegExp }[] = [
  { key: 'deep_work', label: 'Deep problem-solving', re: /\b(deep work|hard problems?|difficult (problems?|tasks?|work)|complex (problems?|work)|solving|concentrat\w+|focus\w* work|writing code|debugging)\b/i },
  { key: 'brainstorming', label: 'Brainstorming and ideas', re: /\b(brainstorm\w*|ideation|idea\w* (session|phase)|early ideas|thinking out loud|exploring options)\b/i },
  { key: 'learning', label: 'Learning something new', re: /\b(learn\w+|picking up|new (subject|topic|skill)|studying)\b/i },
  { key: 'teaching', label: 'Teaching and explaining', re: /\b(teach\w+|explain\w+|present\w+|mentor\w+|workshop)\b/i },
  { key: 'delivery', label: 'Getting something shipped', re: /\b(deadlin\w+|shipping|deliver\w+|launch\w*|release|crunch)\b/i },
];

/* ------------------------------------------------------------------------------------- modifiers */

const NEGATORS = /\b(not|never|no|none|don'?t|doesn'?t|didn'?t|can'?t|cannot|won'?t|isn'?t|aren'?t|dislike|hate|avoid|rather not|prefer not|away from|tired of|sick of|struggle with|bad at)\b/i;
const HEDGES = /\b(maybe|perhaps|i think|i guess|probably|sort of|kind of|somewhat|a bit|slightly|not sure|unsure|might|could be|i suppose)\b/i;
const INTENSIFIERS = /\b(really|very|absolutely|definitely|strongly|love|passionate|always|deeply|extremely|most of all|above all)\b/i;
const DEPENDS = /\b(it depends|depends on|a mix|mix of|both|combination|sometimes|either|varies|context)\b/i;
const AVOID_LEAD = /\b(don'?t want|do not want|not interested in|no interest in|rather not|prefer not to|avoid|nothing to do with|not looking for|hate|dislike)\b/i;

/**
 * Split where the person changes what they are talking about.
 *
 * TWO THINGS THIS GETS DELIBERATELY RIGHT, both of which it got wrong first time round.
 *
 * A COMMA IS NOT A BOUNDARY. "I like coding, mathematics and hard problems" is one thought, and
 * splitting it produces three fragments too short to read.
 *
 * "WHEN", "IF" AND "FOR" ARE NOT BOUNDARIES EITHER — they are the words that ATTACH a condition to
 * a preference, and cutting there severs the two halves that have to stay together. Splitting "I
 * prefer working alone when solving complex problems" on "when" leaves "I prefer working alone" in
 * one fragment and "solving complex problems" in another, so the preference has no context and the
 * context has no preference, and the conditional answer this whole model exists to preserve is
 * silently flattened back into a scalar. They are read as context markers WITHIN a clause instead.
 *
 * What does split is contrast — a full stop, or a word that means "and now the other case".
 */
export function splitClauses(text: string): string[] {
  return String(text || '')
    .split(/(?:[.;!?\n]+|\b(?:but|however|whereas|although|though|while|on the other hand)\b)/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

const uniq = <T,>(a: T[]): T[] => Array.from(new Set(a));

function contextOf(clause: string): { key: string; label: string } | null {
  for (const c of CONTEXTS) if (c.re.test(clause)) return { key: c.key, label: c.label };
  return null;
}

/* ------------------------------------------------------------------------------- the interpreter */

export interface InterpretOptions {
  /** The question this text answers, when it answers one. Recorded, not used to steer the reading. */
  questionId?: string | null;
  /** Option ids the person also picked. Each may carry its own dimension contributions. */
  selectedDims?: Record<string, number>[];
  /** How firm a selected option is. Picking a button is firmer evidence than a hedged sentence. */
  selectionConfidence?: number;
}

/**
 * READ WHAT SOMEBODY WROTE.
 *
 * Total and synchronous. Never throws, never returns null: an unreadable input comes back with
 * `empty: true` and a `queryTerms` list, so the caller can still run a plain search — which is the
 * whole of section 31's fallback requirement and costs nothing to honour here.
 */
export function interpretText(text: string, opts: InterpretOptions = {}): Interpretation {
  const raw = String(text || '');
  const trimmed = raw.trim();

  const dims: Record<string, { sum: number; weight: number }> = {};
  const contexts: ContextDependency[] = [];
  const add = (key: string, value: number, weight: number) => {
    if (weight <= 0) return;
    const d = dims[key] || (dims[key] = { sum: 0, weight: 0 });
    d.sum += clamp01(value) * weight;
    d.weight += weight;
  };

  let sawDepends = false;
  let clauseCount = 0;

  for (const clause of splitClauses(trimmed)) {
    clauseCount++;
    const negated = NEGATORS.test(clause);
    const hedged = HEDGES.test(clause);
    const intense = INTENSIFIERS.test(clause);
    if (DEPENDS.test(clause)) sawDepends = true;

    let mod = 1;
    if (hedged) mod *= 0.55;
    if (intense) mod *= 1.25;

    const ctx = contextOf(clause);
    const clauseDims: Record<string, number> = {};

    for (const rule of RULES) {
      if (!rule.re.test(clause)) continue;
      for (const [key, value] of Object.entries(rule.dims)) {
        // A NEGATED MATCH INVERTS RATHER THAN VANISHING. "I don't like structure" says something
        // about structure, and dropping it would leave the strongest sentence in the answer unread.
        const v = negated ? 1 - value : value;
        add(key, v, rule.weight * mod);
        clauseDims[key] = Math.max(clauseDims[key] ?? 0, v);
      }
    }

    // A clause with BOTH a context marker and a reading of its own is a conditional preference, and
    // it is kept as one. Without this, the two halves of "quiet for hard problems but noisy for
    // brainstorming" average out to a person with no preference at all.
    if (ctx && Object.keys(clauseDims).length > 0) {
      const existing = contexts.find((c) => c.context === ctx.key);
      if (existing) {
        Object.assign(existing.dimensions, clauseDims);
      } else {
        contexts.push({ context: ctx.key, label: ctx.label, dimensions: clauseDims, quote: clause });
      }
    }
  }

  // Options the person picked, folded in at their own confidence. A button is a firmer statement
  // than a hedged sentence, so it enters at a higher weight and is not subject to hedge scaling.
  const selWeight = clamp01(opts.selectionConfidence ?? 0.9);
  for (const sel of opts.selectedDims || []) {
    for (const [key, value] of Object.entries(sel || {})) add(key, value, selWeight);
  }

  /* ---- interests, avoidances, skills ---- */

  const lower = trimmed.toLowerCase();
  const interests: { key: string; label: string; confidence: number }[] = [];
  const avoid: { key: string; label: string; confidence: number }[] = [];

  // The avoidance window: the part of the sentence AFTER "I don't want", where the thing they do
  // not want is named. Matching a domain anywhere in a sentence containing a negation would file
  // "I want AI research, not sales" under avoiding AI as well as avoiding sales.
  const avoidWindows: string[] = [];
  const avoidRe = new RegExp(AVOID_LEAD.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = avoidRe.exec(lower)) !== null) {
    avoidWindows.push(lower.slice(m.index, Math.min(lower.length, m.index + m[0].length + 60)));
  }

  for (const domain of INTEREST_DOMAINS) {
    let hit = false;
    for (const alias of domain.aliases) {
      if (lower.includes(alias.toLowerCase())) { hit = true; break; }
    }
    if (!hit) continue;
    const inAvoid = avoidWindows.some((w) => domain.aliases.some((a) => w.includes(a.toLowerCase())));
    if (inAvoid) {
      avoid.push({ key: domain.key, label: domain.label, confidence: 0.72 });
      continue;
    }
    interests.push({ key: domain.key, label: domain.label, confidence: 0.7 });
    // A named domain leans on some dimensions. WEAK evidence on purpose: naming a field says
    // something about how you like to think, but far less than saying how you like to think.
    for (const [k, v] of Object.entries(domain.leans || {})) add(k, v, 0.3);
  }

  const skills: { key: string; label: string; confidence: number }[] = [];
  for (const s of SKILL_LEXICON) {
    // Word-boundary matching so "r" does not match every word containing the letter, and "go" does
    // not match "going". Escaped, because the lexicon contains "c++" and "ci/cd".
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^a-z0-9+#/])' + esc + '($|[^a-z0-9+#/])', 'i');
    if (re.test(lower)) skills.push({ key: s, label: s, confidence: 0.62 });
  }

  /* ---- stage ---- */

  let stage: CareerStage = 'unknown';
  let stageConfidence = 0;
  for (const p of STAGE_PATTERNS) {
    if (!p.re.test(trimmed)) continue;
    if (p.confidence > stageConfidence) { stage = p.stage; stageConfidence = p.confidence; }
  }

  /* ---- assemble ---- */

  const dimensions: Record<string, { value: number; confidence: number }> = {};
  for (const [key, acc] of Object.entries(dims)) {
    if (acc.weight <= 0) continue;
    const value = clamp01(acc.sum / acc.weight);
    // Confidence saturates rather than growing without bound: five sentences saying the same thing
    // are better evidence than one, and not five times better.
    let confidence = clamp01(1 - Math.exp(-acc.weight * 0.9));
    if (sawDepends) confidence *= 0.75;
    dimensions[key] = { value, confidence: clamp01(confidence) };
  }

  const queryTerms = extractQueryTerms(trimmed, interests, skills);

  const readSomething = Object.keys(dimensions).length > 0 || interests.length > 0
    || skills.length > 0 || stage !== 'unknown';

  const base = readSomething
    ? clamp01(
      0.25
      + Math.min(0.3, Object.values(dimensions).reduce((n, d) => n + d.confidence, 0) * 0.12)
      + Math.min(0.25, interests.length * 0.1)
      + Math.min(0.1, skills.length * 0.05)
      + (stage === 'unknown' ? 0 : 0.1),
    )
    : 0;
  const confidence = clamp01(sawDepends ? base * 0.8 : base) * (clauseCount === 0 ? 0 : 1);

  return {
    dimensions,
    contextDependencies: contexts,
    interests,
    skills,
    avoid,
    stage,
    stageConfidence,
    queryTerms,
    confidence,
    summary: summarise({ dimensions, contextDependencies: contexts, interests, avoid, skills, stage }),
    modelVersion: MODEL_VERSION,
    empty: !readSomething,
  };
}

/* ---------------------------------------------------------------------------------- query terms */

const STOPWORDS = new Set([
  'i', 'me', 'my', 'we', 'you', 'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on',
  'at', 'for', 'with', 'about', 'into', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'it', 'this', 'that', 'these', 'those', 'not', 'no',
  'so', 'than', 'then', 'too', 'very', 'can', 'will', 'just', 'like', 'want', 'wants', 'wanted',
  'really', 'know', "don't", 'dont', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'work', 'working', 'job', 'jobs', 'role', 'roles', 'career', 'careers', 'something', 'things',
  'enjoy', 'enjoys', 'love', 'good', 'best', 'more', 'most', 'some', 'any', 'would', 'could',
  'looking', 'interested', 'sure', 'think', 'feel', 'suits', 'suit', 'fits', 'fit',
]);

/**
 * What to hand the database as a search term when the structured signals are thin.
 *
 * Named things first (a domain or a skill the person actually said), then the longest remaining
 * content words. Capped, because a fifteen-term ILIKE is a full scan and returns everything anyway.
 */
export function extractQueryTerms(
  text: string,
  interests: { label: string }[] = [],
  skills: { label: string }[] = [],
): string[] {
  const named = [...skills.map((s) => s.label), ...interests.map((i) => i.label)];
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#/\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const counted = new Map<string, number>();
  for (const w of words) counted.set(w, (counted.get(w) || 0) + 1);
  const ranked = Array.from(counted.entries())
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .map(([w]) => w);
  return uniq([...named, ...ranked]).slice(0, 6);
}

/* -------------------------------------------------------------------------- the confirmation text */

/**
 * "Here is what I understood" — in sentences, before anything is acted on.
 *
 * Section 7 of the brief: never silently build a picture of somebody without giving them the chance
 * to correct it. These lines are what the confirmation panel shows, and every one of them is
 * generated from a signal that actually exists. There is no template that fires when nothing was
 * read; an empty reading produces an empty list and the caller says so honestly.
 */
export function summarise(r: {
  dimensions: Record<string, { value: number; confidence: number }>;
  contextDependencies: ContextDependency[];
  interests: { label: string }[];
  avoid: { label: string }[];
  skills: { label: string }[];
  stage: CareerStage;
}): string[] {
  const out: string[] = [];

  if (r.interests.length) {
    out.push('You are drawn to ' + joinList(r.interests.map((i) => i.label.toLowerCase())) + '.');
  }
  if (r.skills.length) {
    out.push('You mentioned working with ' + joinList(r.skills.slice(0, 5).map((s) => s.label)) + '.');
  }

  // Import kept local to the function so the module stays free of a cycle: dimensions.ts does not
  // import this file, and this file needs only the definitions table.
  const strong = Object.entries(r.dimensions)
    .filter(([, d]) => d.confidence >= 0.35)
    .sort((a, b) => (b[1].value * b[1].confidence) - (a[1].value * a[1].confidence));

  for (const [key, d] of strong.slice(0, 5)) {
    const def = DIM_TEXT[key];
    if (!def) continue;
    if (d.value >= 0.6) out.push(def.affirm);
    else if (d.value <= 0.35 && def.deny) out.push(def.deny);
  }

  for (const c of r.contextDependencies.slice(0, 3)) {
    const named = Object.entries(c.dimensions)
      .filter(([k]) => DIM_TEXT[k])
      .sort((a, b) => b[1] - a[1])[0];
    if (!named) continue;
    const phrase = named[1] >= 0.5 ? DIM_TEXT[named[0]].affirm : (DIM_TEXT[named[0]].deny || DIM_TEXT[named[0]].affirm);
    out.push('For ' + c.label.toLowerCase() + ': ' + lowerFirst(phrase));
  }

  if (r.contextDependencies.length > 1) {
    out.push('What you prefer depends on the kind of work — you gave more than one answer, and both are kept.');
  }

  if (r.avoid.length) {
    out.push('You would rather not go towards ' + joinList(r.avoid.map((a) => a.label.toLowerCase())) + '.');
  }

  if (r.stage !== 'unknown') out.push('You are ' + STAGE_TEXT[r.stage] + '.');

  return out;
}

const STAGE_TEXT: Record<CareerStage, string> = {
  student: 'currently studying',
  early: 'early in your career',
  experienced: 'already working, with some experience behind you',
  senior: 'senior, with a track record of leading work',
  unknown: '',
};

/** The affirm/deny sentences, keyed by dimension. Mirrors DIMENSIONS without importing the array. */
const DIM_TEXT: Record<string, { affirm: string; deny?: string }> = {
  autonomy: { affirm: 'You value independence and freedom in how you work.', deny: 'You would rather work inside a defined approach than invent one.' },
  structure: { affirm: 'You work well with a clear structure around you.', deny: 'You are comfortable when the structure is still being worked out.' },
  goal_clarity: { affirm: 'Clear objectives are important to you.' },
  flexibility: { affirm: 'You want room to change how and when you approach things.' },
  deep_focus: { affirm: 'You prefer quiet environments for deep problem-solving.' },
  collaboration: { affirm: 'You do your best thinking with other people in the room.', deny: 'You would rather work through a problem on your own first.' },
  social_energy: { affirm: 'You draw energy from the people around you.' },
  pace: { affirm: 'You like work that moves quickly.', deny: 'You would rather go carefully than quickly.' },
  ambiguity_tolerance: { affirm: 'You are comfortable when the answer is not known yet.' },
  routine: { affirm: 'You like knowing what your day looks like.' },
  analytical: { affirm: 'You like reasoning a problem through carefully.' },
  experimental: { affirm: 'You would rather try something and see what happens.' },
  research_orientation: { affirm: 'You are drawn to questions nobody has answered properly yet.' },
  systems_thinking: { affirm: 'You like seeing how the parts of something fit together.' },
  creativity: { affirm: 'You like making things that did not exist before.' },
  abstraction: { affirm: 'You are comfortable working with ideas before they are concrete.' },
  implementation: { affirm: 'You want to build the working thing, not only describe it.' },
  morning_energy: { affirm: 'Your sharpest thinking happens early in the day.' },
  evening_energy: { affirm: 'Your sharpest thinking happens later in the day.' },
  sustained_focus: { affirm: 'You can hold one thing for a long stretch.' },
  burst_focus: { affirm: 'You work in intense bursts, with real recovery between them.' },
  initiative: { affirm: 'You tend to start things rather than wait to be asked.' },
  persistence: { affirm: 'You stay with a problem after it stops being fun.' },
  feedback_openness: { affirm: 'You want your work argued with.' },
  detail_orientation: { affirm: 'You notice the small thing that is wrong.' },
};

function joinList(items: string[]): string {
  const a = uniq(items).slice(0, 4);
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/* ----------------------------------------------------------------------------- signals and tags */

const nowIso = () => new Date().toISOString();

/** Turn a reading into storable signals, stamped with where they came from and how sure we are. */
export function toSignals(
  r: Interpretation,
  responseId: string,
  source: SignalSource = 'inferred',
  at = nowIso(),
): Record<string, Signal> {
  const out: Record<string, Signal> = {};
  for (const [key, d] of Object.entries(r.dimensions)) {
    out[key] = {
      value: d.value,
      confidence: d.confidence,
      source,
      confirmation: 'unconfirmed',
      modelVersion: r.modelVersion,
      at,
      from: [responseId],
    };
  }
  return out;
}

export function toTags(
  items: { key: string; label: string; confidence: number }[],
  responseId: string,
  source: SignalSource = 'inferred',
): Tag[] {
  return items.map((i) => ({
    key: i.key,
    label: i.label,
    confidence: i.confidence,
    source,
    confirmation: 'unconfirmed' as const,
    from: [responseId],
  }));
}

/* --------------------------------------------------------------------------------- the model seam */

/**
 * THE SEAM A LANGUAGE MODEL PLUGS INTO.
 *
 * Same result type, async. A model-backed reader implements this, and every caller keeps working;
 * so does the page, because `interpretText` above is what runs when the implementation is absent,
 * slow or failing. That ordering — deterministic first, model as enrichment — is the reason the
 * careers page cannot be taken down by an AI endpoint.
 *
 * Whatever a model returns must come back through this same shape, which means it must state a
 * confidence and it must be summarisable back to the person. A reading that cannot be shown to
 * somebody for correction is not usable here, however good it is.
 */
export interface CareerInterpreter {
  readonly name: string;
  interpret(text: string, opts?: InterpretOptions): Promise<Interpretation>;
}

export const lexicalInterpreter: CareerInterpreter = {
  name: 'lexical',
  async interpret(text: string, opts: InterpretOptions = {}) {
    return interpretText(text, opts);
  },
};

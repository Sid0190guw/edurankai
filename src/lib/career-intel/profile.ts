// src/lib/career-intel/profile.ts — APPLYING A READING TO A PERSON, AND LETTING THEM TAKE IT BACK.
//
// Pure. Every function takes a profile and returns a new one; nothing mutates its argument and
// nothing touches a database. That makes the whole personalisation layer testable without a
// connection, and it makes the API routes thin enough to read in one screen.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD:
//
//   The person's own words are never overwritten, and the interpretation of them is never final.
//
// `rawResponses` is append-only. Confirming, adjusting, rejecting and removing all act on the
// INTERPRETATION — the derived layer — and leave the original sentence exactly as typed. That is
// what makes section 26's "reinterpret later as models improve" a real possibility rather than a
// sentence in a design document: a better reader can be run over the same words tomorrow.
//
// AND REMOVAL REALLY REMOVES. `removeResponse` drops the sentence AND every signal that came only
// from it, then rebuilds what is left from the surviving responses. A delete that leaves the
// conclusions standing is not a delete.

import {
  MODEL_VERSION, PROFILE_VERSION, emptyProfile, mergeSignal, mergeTag, clamp01,
  type CareerProfile, type CareerStage, type ContextDependency, type RawResponse,
  type Signal, type Tag,
} from './dimensions';
import { interpretText, toSignals, toTags, type Interpretation, type InterpretOptions } from './interpret';

/* ------------------------------------------------------------------------------------- ids */

let counter = 0;

/**
 * A response id. Short, unique within a profile, and NOT derived from the content — two identical
 * sentences typed at different moments are two responses, and collapsing them would silently
 * discard the second one's timestamp.
 */
export function responseId(at: string = new Date().toISOString()): string {
  counter = (counter + 1) % 100000;
  return 'r' + Date.parse(at).toString(36) + '-' + counter.toString(36);
}

/* --------------------------------------------------------------------------------- recording */

export interface RecordInput {
  /** Free text exactly as typed. May be empty when the person only picked options. */
  text?: string;
  /** Option ids picked, in order. */
  selected?: string[];
  /** Dimension contributions carried by those options, supplied by the questions engine. */
  selectedDims?: Record<string, number>[];
  /** The question being answered, or null for the opening free text. */
  questionId?: string | null;
  at?: string;
}

export interface RecordResult {
  profile: CareerProfile;
  /** What was read out of this one answer, for the confirmation panel. */
  interpretation: Interpretation;
  /** The id of the raw response just stored, so a later correction can point at it. */
  responseId: string;
}

/**
 * Store what somebody said, read it, and fold the reading into their profile.
 *
 * BOTH HALVES, ALWAYS. The sentence goes into rawResponses verbatim and the interpretation goes
 * into dimensions/interests/skills separately. A caller cannot store one without the other, which
 * is what stops the raw layer from quietly falling out of use.
 */
export function recordAnswer(profile: CareerProfile, input: RecordInput): RecordResult {
  const at = input.at || new Date().toISOString();
  const text = String(input.text ?? '');
  const selected = (input.selected || []).map(String);
  const id = responseId(at);

  const opts: InterpretOptions = {
    questionId: input.questionId ?? null,
    selectedDims: input.selectedDims || [],
    selectionConfidence: 0.9,
  };
  const interpretation = interpretText(text, opts);

  const raw: RawResponse = {
    id,
    at,
    questionId: input.questionId ?? null,
    selected,
    text,
    modelVersion: interpretation.modelVersion,
  };

  const next = applyInterpretation(
    { ...profile, rawResponses: [...(profile.rawResponses || []), raw] },
    interpretation,
    id,
    at,
  );

  const asked = input.questionId
    ? Array.from(new Set([...(next.asked || []), input.questionId]))
    : (next.asked || []);

  return { profile: { ...next, asked, updatedAt: at }, interpretation, responseId: id };
}

/** Fold a reading into a profile. Separated from recordAnswer so a re-read can reuse it. */
export function applyInterpretation(
  profile: CareerProfile,
  r: Interpretation,
  fromResponseId: string,
  at = new Date().toISOString(),
): CareerProfile {
  const dimensions: Record<string, Signal> = { ...(profile.dimensions || {}) };
  const incoming = toSignals(r, fromResponseId, 'inferred', at);
  for (const [key, sig] of Object.entries(incoming)) {
    dimensions[key] = mergeSignal(dimensions[key], sig);
  }

  let interests = profile.interests || [];
  for (const t of toTags(r.interests, fromResponseId, 'stated')) interests = mergeTag(interests, t);

  let skills = profile.skills || [];
  for (const t of toTags(r.skills, fromResponseId, 'stated')) skills = mergeTag(skills, t);

  let avoid = profile.avoid || [];
  for (const t of toTags(r.avoid, fromResponseId, 'stated')) avoid = mergeTag(avoid, t);

  // A domain the person has just told us they do not want stops being an interest. Keeping both
  // would let a demotion and a promotion for the same thing cancel out and look like indifference.
  const avoidKeys = new Set(avoid.filter((a) => a.confirmation !== 'rejected').map((a) => a.key));
  interests = interests.filter((i) => !avoidKeys.has(i.key));

  const contextDependencies = mergeContexts(profile.contextDependencies || [], r.contextDependencies);

  const takesStage = r.stage !== 'unknown' && r.stageConfidence > (profile.stageConfidence || 0);

  return {
    ...profile,
    profileVersion: PROFILE_VERSION,
    dimensions,
    interests,
    skills,
    avoid,
    contextDependencies,
    stage: takesStage ? r.stage : (profile.stage || 'unknown'),
    stageConfidence: takesStage ? r.stageConfidence : (profile.stageConfidence || 0),
    updatedAt: at,
  };
}

function mergeContexts(existing: ContextDependency[], incoming: ContextDependency[]): ContextDependency[] {
  const out = existing.slice();
  for (const c of incoming) {
    const i = out.findIndex((x) => x.context === c.context);
    if (i < 0) { out.push(c); continue; }
    // The newer quote wins — it is the more recent way the person described the same situation —
    // but the dimensions merge, so an earlier reading of the same context is not lost.
    out[i] = { ...out[i], dimensions: { ...out[i].dimensions, ...c.dimensions }, quote: c.quote };
  }
  return out.slice(-8);
}

/* ------------------------------------------------------------------------------ correcting it */

export type CorrectionVerdict = 'confirm' | 'adjust' | 'reject';

/**
 * "Yes, that's right" / "Adjust this" / "No, not that".
 *
 * A REJECTION IS STORED, NOT ERASED. Deleting a rejected signal would let the very next sentence
 * re-infer it, and the person would watch the same wrong conclusion come back after they told us
 * it was wrong. Marked rejected, it is excluded from matching and from the summary, and only a
 * direct statement from them can revive it.
 */
export function confirmDimension(
  profile: CareerProfile,
  key: string,
  verdict: CorrectionVerdict,
  value?: number,
  at = new Date().toISOString(),
): CareerProfile {
  const current = (profile.dimensions || {})[key];
  if (!current) return profile;
  const confirmation = verdict === 'confirm' ? 'confirmed' : verdict === 'adjust' ? 'adjusted' : 'rejected';
  const next: Signal = {
    ...current,
    value: verdict === 'adjust' && typeof value === 'number' ? clamp01(value) : current.value,
    // A person's own verdict is the firmest evidence in the system. Confirming makes it certain;
    // rejecting makes the exclusion certain too, which is why both go to 1.
    confidence: verdict === 'reject' ? 1 : Math.max(current.confidence, 0.9),
    source: 'stated',
    confirmation,
    at,
  };
  return { ...profile, dimensions: { ...profile.dimensions, [key]: next }, updatedAt: at };
}

/** Confirm, adjust or reject one interest, skill or avoidance. Same rule: rejection is stored. */
export function confirmTag(
  profile: CareerProfile,
  list: 'interests' | 'skills' | 'avoid',
  key: string,
  verdict: CorrectionVerdict,
  at = new Date().toISOString(),
): CareerProfile {
  const items = (profile[list] || []) as Tag[];
  const i = items.findIndex((t) => t.key === key);
  if (i < 0) return profile;
  const confirmation = verdict === 'confirm' ? 'confirmed' : verdict === 'adjust' ? 'adjusted' : 'rejected';
  const next = items.slice();
  next[i] = { ...items[i], confirmation, source: 'stated', confidence: verdict === 'reject' ? 1 : 0.95 };
  return { ...profile, [list]: next, updatedAt: at } as CareerProfile;
}

/** Add something the system never suggested. Free text, their words, their key. */
export function addTag(
  profile: CareerProfile,
  list: 'interests' | 'skills' | 'avoid',
  key: string,
  label: string,
  at = new Date().toISOString(),
): CareerProfile {
  const clean = String(label || '').trim().slice(0, 80);
  if (!clean) return profile;
  const tag: Tag = {
    key: String(key || clean).trim().slice(0, 80),
    label: clean,
    confidence: 0.95,
    source: 'stated',
    confirmation: 'confirmed',
    from: [],
  };
  return { ...profile, [list]: mergeTag((profile[list] || []) as Tag[], tag), updatedAt: at } as CareerProfile;
}

/**
 * Drop one thing they said, and everything that was concluded ONLY from it.
 *
 * The rebuild is a full re-read of the surviving responses rather than a subtraction, because a
 * signal that came from three sentences cannot have one third of itself removed — its value and its
 * confidence were computed from all three together.
 */
export function removeResponse(profile: CareerProfile, id: string, at = new Date().toISOString()): CareerProfile {
  const remaining = (profile.rawResponses || []).filter((r) => r.id !== id);
  if (remaining.length === (profile.rawResponses || []).length) return profile;
  return rebuild(profile, remaining, at);
}

/**
 * Re-read every stored sentence with the CURRENT interpreter, keeping the person's own verdicts.
 *
 * This is what section 26 is for. When the reader improves, the raw responses are still there and
 * this function turns a better reader into a better profile without asking anybody anything again.
 * Confirmed, adjusted and rejected signals survive the rebuild — those are the person's decisions,
 * not the model's, and a new model version does not get to overrule them.
 */
export function rebuild(
  profile: CareerProfile,
  responses: RawResponse[] = profile.rawResponses || [],
  at = new Date().toISOString(),
): CareerProfile {
  const verdicts: Record<string, Signal> = {};
  for (const [k, s] of Object.entries(profile.dimensions || {})) {
    if (s.confirmation === 'confirmed' || s.confirmation === 'adjusted' || s.confirmation === 'rejected') {
      verdicts[k] = s;
    }
  }
  const keptTags = (list: Tag[]) => (list || []).filter(
    (t) => t.confirmation === 'confirmed' || t.confirmation === 'adjusted' || t.confirmation === 'rejected',
  );

  let next: CareerProfile = {
    ...emptyProfile(profile.createdAt || at),
    rawResponses: responses,
    asked: profile.asked || [],
    skipped: profile.skipped || [],
    reflection: profile.reflection || null,
  };

  for (const r of responses) {
    const reading = interpretText(r.text, { questionId: r.questionId, selectedDims: [] });
    next = applyInterpretation(next, reading, r.id, r.at);
  }

  // The person's verdicts go back on top of the fresh reading.
  next.dimensions = { ...next.dimensions, ...verdicts };
  next.interests = mergeVerdicts(next.interests, keptTags(profile.interests));
  next.skills = mergeVerdicts(next.skills, keptTags(profile.skills));
  next.avoid = mergeVerdicts(next.avoid, keptTags(profile.avoid));
  next.updatedAt = at;
  return next;
}

function mergeVerdicts(fresh: Tag[], verdicts: Tag[]): Tag[] {
  const out = fresh.slice();
  for (const v of verdicts) {
    const i = out.findIndex((t) => t.key === v.key);
    if (i < 0) out.push(v); else out[i] = v;
  }
  return out;
}

/** Mark a question as skipped. It is never asked again — that is what skipping means. */
export function skipQuestion(profile: CareerProfile, questionId: string, at = new Date().toISOString()): CareerProfile {
  if (!questionId) return profile;
  return {
    ...profile,
    skipped: Array.from(new Set([...(profile.skipped || []), questionId])),
    asked: Array.from(new Set([...(profile.asked || []), questionId])),
    updatedAt: at,
  };
}

/** Everything gone. Used by the reset control, and by the delete path in the store. */
export function resetProfile(at = new Date().toISOString()): CareerProfile {
  return emptyProfile(at);
}

/* -------------------------------------------------------------------------------- deserialising */

/**
 * Read a profile that came from a browser or from a database row.
 *
 * TOTAL AND SUSPICIOUS. This is the boundary where untrusted JSON becomes a typed profile, and the
 * profile is then used to build a database query. Every field is rebuilt from scratch with its type
 * checked; nothing is spread through. A malformed or hostile document produces an empty profile
 * rather than an exception, because a careers page that 500s on a stale localStorage value is worse
 * than one that starts the conversation again.
 *
 * The lists are capped. A profile is a few dozen signals; anything larger is either a bug or an
 * attempt to make the ranker do unbounded work on a public, unauthenticated endpoint.
 */
export function parseProfile(input: unknown): CareerProfile {
  const now = new Date().toISOString();
  const base = emptyProfile(now);
  if (!input || typeof input !== 'object') return base;
  const o = input as Record<string, any>;

  const str = (v: any, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const num01 = (v: any): number => clamp01(typeof v === 'number' ? v : 0);
  const iso = (v: any): string => {
    const s = str(v, 40);
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : now;
  };
  const conf = (v: any) => (v === 'confirmed' || v === 'adjusted' || v === 'rejected' ? v : 'unconfirmed');
  const src = (v: any) => (v === 'stated' || v === 'selected' ? v : 'inferred');

  const rawResponses: RawResponse[] = Array.isArray(o.rawResponses)
    ? o.rawResponses.slice(0, 40).map((r: any) => ({
      id: str(r?.id, 40) || responseId(now),
      at: iso(r?.at),
      questionId: typeof r?.questionId === 'string' ? r.questionId.slice(0, 60) : null,
      selected: Array.isArray(r?.selected) ? r.selected.slice(0, 12).map((s: any) => str(s, 60)) : [],
      text: str(r?.text, 2000),
      modelVersion: str(r?.modelVersion, 40) || MODEL_VERSION,
    }))
    : [];

  const dimensions: Record<string, Signal> = {};
  if (o.dimensions && typeof o.dimensions === 'object') {
    for (const [k, v] of Object.entries(o.dimensions as Record<string, any>).slice(0, 60)) {
      if (!/^[a-z_]{2,40}$/.test(k) || !v || typeof v !== 'object') continue;
      dimensions[k] = {
        value: num01(v.value),
        confidence: num01(v.confidence),
        source: src(v.source),
        confirmation: conf(v.confirmation),
        modelVersion: str(v.modelVersion, 40) || MODEL_VERSION,
        at: iso(v.at),
        from: Array.isArray(v.from) ? v.from.slice(0, 8).map((x: any) => str(x, 40)) : [],
      };
    }
  }

  const tags = (v: any): Tag[] => (Array.isArray(v) ? v.slice(0, 30) : []).map((t: any) => ({
    key: str(t?.key, 80),
    label: str(t?.label, 80),
    confidence: num01(t?.confidence),
    source: src(t?.source),
    confirmation: conf(t?.confirmation),
    from: Array.isArray(t?.from) ? t.from.slice(0, 8).map((x: any) => str(x, 40)) : [],
  })).filter((t: Tag) => !!t.key);

  const contextDependencies: ContextDependency[] = (Array.isArray(o.contextDependencies) ? o.contextDependencies : [])
    .slice(0, 8)
    .map((c: any) => {
      const dimsIn = (c && typeof c.dimensions === 'object' && c.dimensions) ? c.dimensions : {};
      const dims: Record<string, number> = {};
      for (const [k, v] of Object.entries(dimsIn as Record<string, any>).slice(0, 12)) {
        if (/^[a-z_]{2,40}$/.test(k)) dims[k] = num01(v);
      }
      return { context: str(c?.context, 40), label: str(c?.label, 80), dimensions: dims, quote: str(c?.quote, 400) };
    })
    .filter((c: ContextDependency) => !!c.context);

  const stageIn = str(o.stage, 20);
  const stage: CareerStage = (['student', 'early', 'experienced', 'senior'] as const)
    .includes(stageIn as any) ? (stageIn as CareerStage) : 'unknown';

  const reflection = o.reflection && typeof o.reflection === 'object'
    ? {
      birthDate: typeof o.reflection.birthDate === 'string' ? o.reflection.birthDate.slice(0, 10) : null,
      sign: typeof o.reflection.sign === 'string' ? o.reflection.sign.slice(0, 20) : null,
      excludedFromMatching: true as const,
      at: iso(o.reflection.at),
    }
    : null;

  return {
    profileVersion: PROFILE_VERSION,
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
    rawResponses,
    dimensions,
    contextDependencies,
    interests: tags(o.interests),
    skills: tags(o.skills),
    avoid: tags(o.avoid),
    stage,
    stageConfidence: num01(o.stageConfidence),
    asked: Array.isArray(o.asked) ? o.asked.slice(0, 40).map((x: any) => str(x, 60)).filter(Boolean) : [],
    skipped: Array.isArray(o.skipped) ? o.skipped.slice(0, 40).map((x: any) => str(x, 60)).filter(Boolean) : [],
    reflection,
  };
}

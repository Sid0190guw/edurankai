// src/lib/ask/rephrase.ts — THE MODEL MAY IMPROVE THE WORDS. IT MAY NOT SUPPLY A FACT.
//
// =================================================================================================
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
// =================================================================================================
//
// The answer has already been assembled, from retrieved sources, by src/lib/ask/employee.ts or
// src/lib/ask/visitor.ts. It is correct and it is stiff. This module hands that finished answer to a
// language model and asks it to say the SAME THING more readably.
//
// The model never sees a question it is expected to answer. It never sees an empty answer to fill
// in. It is given prose and asked for prose, and everything it returns is put through a validator
// before a single character of it reaches a person. This is the intent<T>() shape from
// src/lib/aes/providers/foundation.ts: the model proposes, a caller-supplied validator disposes, and
// a proposal that fails validation is a REFUSAL with a reason, never a half-accepted value.
//
// THE VALIDATOR IS THE POINT. Take it away and this is a system that generates answers about
// somebody's pay.
//
// =================================================================================================
// THE FIVE THINGS A REPHRASE MAY NOT DO
// =================================================================================================
//
//   1. INTRODUCE A NUMBER. Every digit run in the output must appear in the input. This is the rule
//      that matters most: "8 days remaining" becoming "18 days remaining" is a single character, it
//      is completely plausible, and the person acts on it. Numbers are compared as SEQUENCES, so
//      re-ordering the sentence is fine and inventing 2026 is not.
//
//   2. INTRODUCE A LINK. Same test, on anything that looks like a path or a URL.
//
//   3. GROW. An answer that comes back materially longer than it went in has had something added,
//      and the only thing a rephrase can add is invention. A generous ceiling, because a genuinely
//      better sentence is sometimes a longer one, and a hard one.
//
//   4. CLAIM TO BE A UNIVERSITY, or to confer a degree. EduRankAI is the technology platform;
//      accredited partners award credentials. This is checked on output as well as instructed in the
//      prompt, because an instruction is a request and a check is a rule.
//
//   5. COME BACK EMPTY, or come back as a refusal, or come back as a conversation about the task.
//      Any of those and the templated answer stands.
//
// WHEN THE VALIDATOR REFUSES, NOTHING IS LOST — the templated answer was already complete, and the
// reader is told which one they are looking at either way. Failure here degrades prose to plainer
// prose; it never degrades an answer to nothing and never to an invention.
import { complete, effectiveConfig, isReady, type LlmConfig } from '@/lib/llm/gateway';
import type { Production } from './types';

/** How much longer than the templated answer a rephrase may be, as a ratio, plus a small constant. */
const MAX_GROWTH = 1.35;
const GROWTH_SLACK = 60;

const FORBIDDEN_CLAIMS: readonly string[] = [
  'our university', 'we are a university', 'this university', 'our degree', 'we award',
  'we confer', 'we grant the degree', 'accredited by us', 'our campus',
];

export interface RephraseVerdict {
  accepted: boolean;
  text: string;
  production: Production;
  /** Always populated. Rendered to the reader, so it is written for a person, not for a log. */
  note: string;
}

/** Every run of digits in a string, as strings. "8 of 12" -> ["8", "12"]. */
export function numbersIn(text: string): string[] {
  return String(text || '').match(/\d+/g) || [];
}

/** Anything that could be followed as a link. Paths and URLs both. */
export function linksIn(text: string): string[] {
  return String(text || '').match(/(https?:\/\/[^\s)]+|\/[a-z0-9][a-z0-9\-/_.]*)/gi) || [];
}

/**
 * DOES THIS REPHRASE SAY THE SAME THING?
 *
 * Pure and synchronous, so it is exhaustively testable — and it is tested, in rephrase.test.ts. The
 * whole safety of letting a model near an answer about somebody's pay rests on this function, and a
 * clamp that cannot be executed in a test is a clamp nobody can trust.
 */
export function validateRephrase(original: string, proposed: string): RephraseVerdict {
  const keep: RephraseVerdict = {
    accepted: false,
    text: original,
    production: 'templated',
    note: '',
  };
  const text = String(proposed || '').trim();

  if (text.length < 20) {
    return { ...keep, note: 'A model was asked to re-word this answer and returned too little to use, so the assembled wording stands.' };
  }
  if (text.length > original.length * MAX_GROWTH + GROWTH_SLACK) {
    return { ...keep, note: 'A model was asked to re-word this answer and returned materially more text than it was given, which is where an invented sentence would be. The assembled wording stands.' };
  }

  const before = numbersIn(original);
  const after = numbersIn(text);
  for (const n of after) {
    if (before.indexOf(n) < 0) {
      return { ...keep, note: 'A model was asked to re-word this answer and its version contained a number that was not in the retrieved sources, so it was discarded. The assembled wording stands.' };
    }
  }

  const linksBefore = linksIn(original);
  for (const l of linksIn(text)) {
    if (linksBefore.indexOf(l) < 0) {
      return { ...keep, note: 'A model was asked to re-word this answer and its version contained a link that was not in the retrieved sources, so it was discarded. The assembled wording stands.' };
    }
  }

  const low = text.toLowerCase();
  for (const claim of FORBIDDEN_CLAIMS) {
    if (low.indexOf(claim) >= 0) {
      return { ...keep, note: 'A model was asked to re-word this answer and its version made a claim about awarding credentials that this platform does not make, so it was discarded. The assembled wording stands.' };
    }
  }

  return {
    accepted: true,
    text,
    production: 'model-rephrased',
    note: 'This answer was assembled from the sources below and then re-worded by a language model. The model was given the assembled answer, not the question, and its version was checked against the sources: any number or link it introduced would have been discarded and the assembled wording kept.',
  };
}

const SYSTEM = [
  'You re-word an answer that has already been written. You are not answering a question.',
  'Rules, in order of importance:',
  '1. Do not add any fact, number, date, amount or link that is not already in the text you are given.',
  '2. Do not remove any number or link that is in it.',
  '3. Do not make it longer. Shorter and clearer is the goal.',
  '4. Never claim this organisation is a university or that it awards or confers a degree. It is a technology platform; accredited partners award credentials.',
  '5. Never name a company or an organisation that is not already named in the text.',
  '6. Reply with the re-worded text only. No preamble, no commentary, no apology, no markdown.',
  'If you cannot improve it, reply with the text exactly as given.',
].join('\n');

export interface RephraseOptions {
  /** The finished, templated answer. */
  text: string;
  /** For the usage log. */
  feature: string;
  /** Signed-in asker, for the gateway's per-user rate limit. Null for a visitor. */
  userId?: string | null;
  /** Resolved once by the caller so a page does not pay for two config reads. */
  config?: LlmConfig | null;
}

/**
 * Try to improve the wording. Never fails the caller.
 *
 * WHEN NO MODEL IS CONFIGURED THIS IS NOT AN ERROR AND NOT A 503. It is the ordinary state of this
 * deployment until somebody configures one at /admin/llm, and the templated answer was always the
 * real answer — src/pages/api/aquintutor/aquin-chat.ts sets `deterministic` and answers anyway for
 * the same reason. The reader is told which they are looking at.
 */
export async function rephrase(opts: RephraseOptions): Promise<RephraseVerdict> {
  const original = String(opts.text || '');
  const templated = (note: string): RephraseVerdict => ({ accepted: false, text: original, production: 'templated', note });

  let cfg: LlmConfig | null = opts.config ?? null;
  if (!cfg) {
    try {
      cfg = await effectiveConfig();
    } catch (e: any) {
      console.error('[ask/rephrase] effectiveConfig', e?.cause?.message || e?.message);
      return templated('This answer was assembled from the sources below. No language model was involved: the model settings could not be read.');
    }
  }
  if (!isReady(cfg)) {
    return templated('This answer was assembled from the sources below, word for word from what was retrieved. No language model was involved — none is configured on this deployment.');
  }

  let r: { ok: boolean; text: string; configured: boolean; error?: string };
  try {
    r = await complete({
      feature: opts.feature,
      system: SYSTEM,
      messages: [{ role: 'user', content: original }],
      userId: opts.userId ?? null,
      maxTokens: 600,
      temperature: 0.2,
      fallback: '',
    });
  } catch (e: any) {
    // NEVER SWALLOWED SILENTLY. The reader is told the model was tried and did not answer, because
    // "assembled" and "assembled after the model failed" are different facts about the same words.
    console.error('[ask/rephrase] complete', e?.cause?.message || e?.message);
    return templated('This answer was assembled from the sources below. A model was asked to re-word it and did not respond, so the assembled wording stands.');
  }

  if (!r.ok || !r.text) {
    return templated('This answer was assembled from the sources below. A model was asked to re-word it and returned nothing usable' + (r.error ? ' (' + String(r.error).slice(0, 120) + ')' : '') + ', so the assembled wording stands.');
  }

  return validateRephrase(original, r.text);
}

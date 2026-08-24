// src/lib/career-intel/questions.ts — WHAT TO ASK NEXT, AND WHEN TO STOP ASKING.
//
// =================================================================================================
// THE RULE THAT DECIDES EVERYTHING HERE
// =================================================================================================
//
//   ASK ONLY WHEN THE ANSWER WOULD CHANGE WHAT WE CAN SHOW.
//
// Not "ask because the field is empty". A questionnaire fills fields; this fills the ONE gap that
// is currently costing the person the most in the quality of what they are shown, and then asks
// whether another one is still worth it. An empty field with no bearing on retrieval is left empty,
// and the person is never told they are incomplete.
//
// Each question carries three things a fixed questionnaire does not have:
//
//   valueFor(profile)  what asking it right now is worth, 0..1. Falls to zero once the thing it
//                      would resolve is already known, which is how the engine stops.
//   whyAsked           the sentence shown next to it. If a question cannot explain itself in one
//                      line, it should not be asked.
//   optional           true for the layers that exist for the person rather than for the matching:
//                      rhythm and behavioural. They are offered only after the useful ones are
//                      exhausted, are labelled as optional, and are never a gate on results.
//
// =================================================================================================
// EVERY QUESTION TAKES THREE KINDS OF ANSWER
// =================================================================================================
//
// Pick one, pick several, or write your own. That is not three UI affordances bolted on — it is a
// property of the model: `multi` is true almost everywhere, every question renders a free-text box,
// and every option list ends with an escape that means "none of these, let me explain". A question
// whose only answers are the four we thought of is a question that manufactures its own answer.
//
// The options carry dimension contributions rather than labels, so picking "Quiet focus" and typing
// "but I like noise when brainstorming" produce readings that COMBINE instead of overwriting: the
// selection sets the scalar and the sentence adds the context dependency beside it.

import {
  profileReadiness, relevanceDimensions, type CareerProfile,
} from './dimensions';
import { OPENING_PATHWAYS, DOMAIN_BY_KEY } from './ontology';

export type QuestionLayer =
  | 'direction'   // what kind of work
  | 'experience'  // what they have done
  | 'workstyle'
  | 'cognitive'
  | 'rhythm'
  | 'behavioural';

export interface QuestionOption {
  id: string;
  label: string;
  /** Dimension contributions this option carries. Empty for options that only name a domain. */
  dims?: Record<string, number>;
  /** Domains this option points at, fed straight into retrieval. */
  domains?: string[];
  /** Set on the "none of these" escape, so the UI can put the free-text box in focus. */
  freeText?: boolean;
}

export interface Question {
  id: string;
  layer: QuestionLayer;
  prompt: string;
  /** The one line that answers "why are you asking me this?". Rendered, not just documented. */
  whyAsked: string;
  options: QuestionOption[];
  /** Nearly always true. A single-choice behavioural question is the thing this system refuses. */
  multi: boolean;
  /** Placeholder for the always-present free-text field. */
  placeholder: string;
  /** Optional layers are for the person, not for the matching. Offered last, labelled as optional. */
  optional: boolean;
  /** 0..1 — what asking this right now is worth. Zero means do not ask. */
  valueFor: (p: CareerProfile) => number;
}

const has = (p: CareerProfile, key: string): boolean => {
  const s = (p.dimensions || {})[key];
  return !!s && s.confirmation !== 'rejected' && s.confidence >= 0.35;
};
const hasAny = (p: CareerProfile, keys: string[]): boolean => keys.some((k) => has(p, k));
const interestCount = (p: CareerProfile): number =>
  (p.interests || []).filter((t) => t.confirmation !== 'rejected').length;

/** The escape hatch, appended to every option list. Its presence is asserted in questions.test.ts. */
const ESCAPE: QuestionOption = {
  id: 'other',
  label: 'None of these — let me explain',
  freeText: true,
};

/** "It depends" is a real answer, not a refusal to answer. It appears wherever it can be true. */
const DEPENDS: QuestionOption = { id: 'depends', label: 'It depends — a mix of these' };

export const QUESTIONS: Question[] = [
  {
    id: 'direction.kind',
    layer: 'direction',
    prompt: 'Which of these feels closest to the work you enjoy?',
    whyAsked: 'It decides which parts of the catalogue we look in first.',
    multi: true,
    placeholder: 'Or describe it in your own words...',
    optional: false,
    options: [
      { id: 'research', label: 'Research and discovering', domains: ['RESEARCH'], dims: { research_orientation: 0.85, ambiguity_tolerance: 0.6 } },
      { id: 'build', label: 'Building technology', domains: ['BUILDING'], dims: { implementation: 0.85, systems_thinking: 0.6 } },
      { id: 'systems', label: 'Solving complex systems', domains: ['HARD_PROBLEMS'], dims: { systems_thinking: 0.82, analytical: 0.75 } },
      { id: 'create', label: 'Creating new experiences', domains: ['CREATING'], dims: { creativity: 0.85 } },
      { id: 'people', label: 'Working with and for people', domains: ['HELPING', 'EDUCATION'], dims: { social_energy: 0.78, collaboration: 0.72 } },
      DEPENDS,
      ESCAPE,
    ],
    valueFor: (p) => (interestCount(p) === 0 ? 1 : hasAny(p, ['research_orientation', 'implementation', 'creativity']) ? 0 : 0.55),
  },
  {
    id: 'direction.problem',
    layer: 'cognitive',
    prompt: 'What kind of difficult problem do you most enjoy?',
    whyAsked: 'Two people who both say "hard problems" often want opposite jobs. This separates them.',
    multi: true,
    placeholder: 'Or tell us about a problem you enjoyed...',
    optional: false,
    options: [
      { id: 'discover', label: 'Discovering something nobody knew', dims: { research_orientation: 0.88, ambiguity_tolerance: 0.7 } },
      { id: 'complex', label: 'Building something complex that works', dims: { implementation: 0.85, systems_thinking: 0.8 } },
      { id: 'optimise', label: 'Making something work far better', dims: { analytical: 0.85, detail_orientation: 0.7 } },
      { id: 'apply', label: 'Applying it to a real-world problem', dims: { implementation: 0.75, pace: 0.62 } },
      { id: 'prove', label: 'Proving why something must be true', dims: { abstraction: 0.88, analytical: 0.85 } },
      DEPENDS,
      ESCAPE,
    ],
    valueFor: (p) => {
      if (hasAny(p, ['abstraction', 'systems_thinking']) && hasAny(p, ['research_orientation', 'implementation'])) return 0;
      return interestCount(p) > 0 ? 0.85 : 0.4;
    },
  },
  {
    id: 'direction.abstraction',
    layer: 'cognitive',
    prompt: 'Do you prefer working with abstract ideas, practical systems, or moving between both?',
    whyAsked: 'Theoretical and applied postings look similar on paper and feel nothing alike.',
    multi: true,
    placeholder: 'Or describe how you actually work...',
    optional: false,
    options: [
      { id: 'abstract', label: 'Abstract ideas', dims: { abstraction: 0.88, analytical: 0.7 } },
      { id: 'practical', label: 'Practical systems', dims: { implementation: 0.85, systems_thinking: 0.7 } },
      { id: 'between', label: 'Moving between both', dims: { abstraction: 0.62, implementation: 0.62, flexibility: 0.7 } },
      DEPENDS,
      ESCAPE,
    ],
    valueFor: (p) => (has(p, 'abstraction') || has(p, 'implementation') ? 0 : 0.7),
  },
  {
    id: 'experience.stage',
    layer: 'experience',
    prompt: 'Where are you right now?',
    whyAsked: 'It decides which rungs of the ladder we show you — not whether you are eligible.',
    multi: false,
    placeholder: 'Or describe your situation...',
    optional: false,
    options: [
      { id: 'student', label: 'Studying' },
      { id: 'early', label: 'Finished studying, starting out' },
      { id: 'experienced', label: 'Working, with some experience' },
      { id: 'senior', label: 'Senior, leading work' },
      ESCAPE,
    ],
    valueFor: (p) => (p.stage === 'unknown' ? 0.95 : 0),
  },
  {
    id: 'experience.what',
    layer: 'experience',
    prompt: 'What have you actually worked with?',
    whyAsked: 'Named tools and subjects sharpen the ranking more than anything else you can tell us.',
    multi: true,
    placeholder: 'Languages, instruments, subjects, projects — anything concrete...',
    optional: false,
    options: [
      { id: 'code', label: 'Writing code', dims: { implementation: 0.8 } },
      { id: 'maths', label: 'Mathematics and analysis', domains: ['MATHEMATICS'], dims: { analytical: 0.8, abstraction: 0.7 } },
      { id: 'lab', label: 'Laboratory or hardware work', dims: { experimental: 0.85 } },
      { id: 'design', label: 'Design or writing', domains: ['CREATING'], dims: { creativity: 0.8 } },
      { id: 'ops', label: 'Running things — operations, events, teams', domains: ['PRODUCT'], dims: { goal_clarity: 0.7 } },
      { id: 'none', label: 'Nothing formal yet', dims: {} },
      ESCAPE,
    ],
    valueFor: (p) => ((p.skills || []).length > 0 ? 0 : interestCount(p) > 0 ? 0.8 : 0.3),
  },
  {
    id: 'workstyle.environment',
    layer: 'workstyle',
    prompt: 'How do you work best?',
    whyAsked: 'It changes which postings we put first, never which ones you are allowed to see.',
    multi: true,
    placeholder: 'If it depends on the task, say so — we keep both answers...',
    optional: false,
    options: [
      { id: 'quiet', label: 'Quiet focus', dims: { deep_focus: 0.88, collaboration: 0.3 } },
      { id: 'collab', label: 'Collaborative environment', dims: { collaboration: 0.85, social_energy: 0.75 } },
      { id: 'flexible', label: 'Flexible structure', dims: { flexibility: 0.85, autonomy: 0.75 } },
      { id: 'clear', label: 'Clear structure', dims: { structure: 0.85, goal_clarity: 0.8 } },
      DEPENDS,
      ESCAPE,
    ],
    valueFor: (p) => {
      const rel = relevanceDimensions(p);
      return (rel.deep_focus || rel.collaboration) ? 0 : 0.6;
    },
  },
  {
    id: 'workstyle.autonomy',
    layer: 'workstyle',
    prompt: 'When you say you want flexibility, what matters most?',
    whyAsked: 'You mentioned flexibility, and it means four different things to four people.',
    multi: true,
    placeholder: 'Or say what it means to you...',
    optional: false,
    options: [
      { id: 'schedule', label: 'A flexible schedule', dims: { flexibility: 0.85 } },
      { id: 'approach', label: 'Freedom in how I approach the work', dims: { autonomy: 0.9 } },
      { id: 'priorities', label: 'Being able to change priorities', dims: { flexibility: 0.8, ambiguity_tolerance: 0.65 } },
      { id: 'where', label: 'Choice of working environment', dims: { flexibility: 0.7 } },
      DEPENDS,
      ESCAPE,
    ],
    // ONLY asked when they used the word. A follow-up to something nobody said is an interrogation.
    valueFor: (p) => {
      const said = (p.rawResponses || []).some((r) => /\bflexib/i.test(r.text));
      if (!said) return 0;
      return has(p, 'autonomy') ? 0 : 0.9;
    },
  },
  {
    id: 'rhythm.peak',
    layer: 'rhythm',
    prompt: 'When do you generally feel most mentally sharp?',
    whyAsked: 'For your own picture only. This never affects which opportunities you are shown.',
    multi: true,
    placeholder: 'For example: nights for creative work, mornings for analysis...',
    optional: true,
    options: [
      { id: 'early', label: 'Early morning', dims: { morning_energy: 0.9 } },
      { id: 'morning', label: 'Morning', dims: { morning_energy: 0.8 } },
      { id: 'afternoon', label: 'Afternoon', dims: {} },
      { id: 'evening', label: 'Evening', dims: { evening_energy: 0.8 } },
      { id: 'late', label: 'Late night', dims: { evening_energy: 0.9 } },
      { id: 'changes', label: 'It changes', dims: {} },
      ESCAPE,
    ],
    valueFor: () => 0.2,
  },
  {
    id: 'rhythm.shape',
    layer: 'rhythm',
    prompt: 'What does a good working stretch look like for you?',
    whyAsked: 'For your own picture only. Not an input to matching.',
    multi: true,
    placeholder: 'Or describe your own rhythm...',
    optional: true,
    options: [
      { id: 'long', label: 'Long uninterrupted stretches', dims: { sustained_focus: 0.88 } },
      { id: 'bursts', label: 'Intense bursts with real breaks', dims: { burst_focus: 0.88 } },
      { id: 'mixed', label: 'A mix, depending on the task', dims: { sustained_focus: 0.55, burst_focus: 0.55 } },
      ESCAPE,
    ],
    valueFor: () => 0.15,
  },
  {
    id: 'behavioural.tendencies',
    layer: 'behavioural',
    prompt: 'Which of these sound like you at work?',
    whyAsked: 'Self-reported tendencies, for your own picture. Not a test, and not used to rank anything.',
    multi: true,
    placeholder: 'Or describe how you actually behave...',
    optional: true,
    options: [
      { id: 'start', label: 'I start things without being asked', dims: { initiative: 0.85 } },
      { id: 'stay', label: 'I stay with a problem after it stops being fun', dims: { persistence: 0.85 } },
      { id: 'argue', label: 'I want my work argued with', dims: { feedback_openness: 0.85 } },
      { id: 'detail', label: 'I notice the small thing that is wrong', dims: { detail_orientation: 0.85 } },
      ESCAPE,
    ],
    valueFor: () => 0.12,
  },
];

export const QUESTION_BY_ID: Record<string, Question> =
  Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));

/**
 * The dimension contributions carried by a set of picked option ids.
 *
 * Returned as an array rather than merged, because two options picked together are two pieces of
 * evidence and the interpreter weights them separately. Unknown ids are dropped in silence: option
 * ids arrive from a public endpoint and a typo must not become an exception.
 */
export function dimsForOptions(questionId: string, selected: string[]): Record<string, number>[] {
  const q = QUESTION_BY_ID[questionId];
  if (!q) return [];
  const out: Record<string, number>[] = [];
  for (const id of selected || []) {
    const opt = q.options.find((o) => o.id === id);
    if (opt?.dims && Object.keys(opt.dims).length) out.push(opt.dims);
  }
  return out;
}

/** Domains named by the picked options, for retrieval. */
export function domainsForOptions(questionId: string, selected: string[]): string[] {
  const q = QUESTION_BY_ID[questionId];
  if (!q) return [];
  const out: string[] = [];
  for (const id of selected || []) {
    const opt = q.options.find((o) => o.id === id);
    for (const d of opt?.domains || []) if (DOMAIN_BY_KEY[d]) out.push(d);
  }
  return Array.from(new Set(out));
}

/** The stage a picked option on the stage question asserts. */
export function stageForOption(questionId: string, selected: string[]): string | null {
  if (questionId !== 'experience.stage') return null;
  const id = (selected || [])[0];
  return ['student', 'early', 'experienced', 'senior'].includes(id) ? id : null;
}

/* ----------------------------------------------------------------------------- the decision */

/**
 * When enough is known that another question would not change what we can show.
 *
 * Deliberately reachable. A system that always has one more question is a questionnaire wearing a
 * conversation's clothes, and this constant is the promise that it stops.
 */
export const ENOUGH = 0.72;

/** Below this, a question is not worth a person's time. */
const WORTH_ASKING = 0.3;

export interface NextQuestion {
  question: Question;
  /** What we would learn. Shown when the person asks why they are being asked. */
  value: number;
  /** True when the core is already satisfied and this is offered for the person's own interest. */
  optional: boolean;
}

/**
 * THE NEXT QUESTION, OR NONE.
 *
 * Returns null when the profile is ready enough, when every worthwhile question has been asked or
 * skipped, or when the best remaining question is not worth asking. Callers treat null as "stop
 * asking and show results", never as an error.
 */
export function nextQuestion(p: CareerProfile): NextQuestion | null {
  const asked = new Set([...(p.asked || []), ...(p.skipped || [])]);
  const ready = profileReadiness(p);

  const candidates = QUESTIONS
    .filter((q) => !asked.has(q.id))
    .map((q) => ({ q, v: clampValue(q.valueFor(p)) }))
    .filter((c) => c.v >= WORTH_ASKING);

  const core = candidates.filter((c) => !c.q.optional).sort((a, b) => b.v - a.v);
  if (core.length && ready < ENOUGH) {
    return { question: core[0].q, value: core[0].v, optional: false };
  }

  // The core is satisfied — or there is nothing left in it worth asking. What remains is offered
  // as what it is: optional, for the person's own picture, and never a condition of seeing results.
  const optional = candidates.filter((c) => c.q.optional).sort((a, b) => b.v - a.v);
  if (optional.length) return { question: optional[0].q, value: optional[0].v, optional: true };

  // Still short of ready and out of core questions? Ask the best remaining one anyway rather than
  // pretending we know enough — but only if it clears the bar.
  if (core.length) return { question: core[0].q, value: core[0].v, optional: false };
  return null;
}

function clampValue(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * Should a CV be offered right now?
 *
 * Section 10: never a wall, never the first screen, and only when it would genuinely help. That
 * means all three of these are true — there is already something to show, the questions have run
 * out of cheap value, and confidence is still short of where it could be.
 */
export function shouldOfferResume(p: CareerProfile): boolean {
  const ready = profileReadiness(p);
  if (ready < 0.3) return false;          // too early — there is nothing to sharpen yet
  if (ready >= ENOUGH) return false;      // sharp enough already; asking would be collecting
  const q = nextQuestion(p);
  return !q || q.optional;                // a cheap question would do the job better; ask that first
}

/** The opening pathway chips. Suggestions, and the page says so beside them. */
export function openingPathways(): { key: string; label: string; blurb: string }[] {
  return OPENING_PATHWAYS
    .map((k) => DOMAIN_BY_KEY[k])
    .filter(Boolean)
    .map((d) => ({ key: d.key, label: d.label, blurb: d.blurb }));
}

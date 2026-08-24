// src/lib/career-intel/personal.ts — THE OPTIONAL LAYER THAT MAY NEVER TOUCH A DECISION.
//
// =================================================================================================
// WHAT THIS REPLACED, AND WHY
// =================================================================================================
//
// This file used to be reflection.ts, and what it held was a birth date and a star sign. The layer
// around it was right — optional, separate, never a ranking input, removable — but the thing it
// asked for was not. A careers page asking for somebody's date of birth in order to tell them
// something about themselves is collecting a piece of identity data it has no use for, and the
// answer it gave back was decided by the calendar rather than by anything the person said.
//
// The same layer now holds things a person actually knows about themselves and might want written
// down: when their day starts, how they would describe their own nature, and — because they were
// asked for — height and weight. Nothing here is derived. Every line in the panel is a line the
// person typed or picked.
//
// =================================================================================================
// THE LINE IS UNCHANGED, AND IS STILL STRUCTURAL
// =================================================================================================
//
// This module is not imported by rank.ts, not by retrieve.ts, not by explain.ts and not by map.ts.
// separation.test.ts reads the source of all four and fails if the import ever appears, under this
// name OR under the old one. A useForMatching:false flag on a field inside the profile would be one
// careless boolean away from being an input to somebody's job prospects; a module the ranker cannot
// reach cannot be one.
//
// THIS MATTERS MORE HERE THAN IT DID FOR A STAR SIGN. Height and weight ARE the kind of thing a
// hiring system can discriminate with, and the only safe place to put them is a module the ranking
// code physically cannot read. That is why they are here and not in dimensions.ts, and why the
// panel says out loud that nothing in this block is used for anything.
//
// WHAT IS JOB-RELEVANT DOES NOT LIVE HERE. Skills and the subjects somebody enjoys DO belong in
// matching — they are in questions.ts (experience.skills, direction.subject), they rank, and they
// are quoted back as the reason a posting was shown. Splitting those off into an ignored block
// would have been the opposite mistake: collecting a real answer and then throwing it away.

import type { PersonalBlock } from './dimensions';

/** THE PROMISE, RENDERED. Shown above the layer, not buried in a policy page. */
export const PERSONAL_DISCLAIMER =
  'None of this is used for anything. It plays no part in which opportunities you are shown, '
  + 'in how they are ranked, or in any application you make. Nobody assessing an application sees it, '
  + 'and it is never sent anywhere - it is held in this browser only. You can skip all of it, and you '
  + 'can remove it at any time.';

export const PERSONAL_TITLE = 'Optional: a few things about you';

export interface Choice { id: string; label: string }

/** When the day starts. Asked as a fact about their day, not as a category of person. */
export const WAKE_CHOICES: Choice[] = [
  { id: 'before5', label: 'Before 5 am' },
  { id: 'five_seven', label: 'Between 5 and 7 am' },
  { id: 'seven_nine', label: 'Between 7 and 9 am' },
  { id: 'nine_eleven', label: 'Between 9 and 11 am' },
  { id: 'later', label: 'Later than 11 am' },
  { id: 'varies', label: 'It varies a lot' },
];

/**
 * NATURE, AS SOMETHING THEY DO — never as something they are. "You are an introvert" is a label;
 * "you would rather listen first" is a description of a preference, and it is the only kind of
 * sentence this system is entitled to hold. separation.test.ts holds the dimension model to that
 * rule and this list follows it by hand.
 */
export const NATURE_CHOICES: Choice[] = [
  { id: 'calm', label: 'I stay calm when things go wrong' },
  { id: 'restless', label: 'I get restless when nothing is moving' },
  { id: 'listen', label: 'I would rather listen first and speak later' },
  { id: 'speak', label: 'I say what I think early' },
  { id: 'plan', label: 'I like knowing the plan before I start' },
  { id: 'improvise', label: 'I would rather work it out as I go' },
  { id: 'alone', label: 'I recover on my own' },
  { id: 'people', label: 'I recover around other people' },
];

const WAKE_BY_ID: Record<string, Choice> = Object.fromEntries(WAKE_CHOICES.map((c) => [c.id, c]));
const NATURE_BY_ID: Record<string, Choice> = Object.fromEntries(NATURE_CHOICES.map((c) => [c.id, c]));

/**
 * A QUESTION PER WAKING TIME, NOT A VERDICT.
 *
 * The old module returned a sentence chosen by a star sign. This returns a sentence chosen by
 * something the person actually told us, and it is still phrased as a question, because a statement
 * about what somebody's morning means for their career would be a claim this page cannot support.
 */
const WAKE_PROMPT: Record<string, string> = {
  before5: 'Your day starts before most people are awake. What do you already do with those hours, and would you want to be paid for it?',
  five_seven: 'You are up early. What is the work you would want to give your first clear hours to?',
  seven_nine: 'What is the first thing you want to think about on a working day? That is often a better guide than a job title.',
  nine_eleven: 'Your best hours are later in the morning. Which kind of work would you want them spent on?',
  later: 'Your day runs late. What is the work you would happily stay up for?',
  varies: 'Your days are not the same shape. Which kind of work would survive that, and which kind would suffer?',
};

export interface PersonalInput {
  wake?: string | null;
  nature?: string[] | null;
  heightCm?: number | string | null;
  weightKg?: number | string | null;
  note?: string | null;
}

/** Numbers are bounded rather than trusted. Out of range is not a guess to correct, it is a drop. */
function measure(v: unknown, min: number, max: number): number | null {
  const raw = typeof v === 'number' ? v : String(v ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 10) / 10;
  if (r < min || r > max) return null;
  return r;
}

/**
 * Build the block stored on a profile. excludedFromMatching is a constant, not a setting.
 *
 * Returns null when nothing was given, so that saving an empty form clears the block rather than
 * storing an empty one that the panel would then render as a heading with nothing under it.
 */
export function buildPersonal(input: PersonalInput, at = new Date().toISOString()): PersonalBlock | null {
  const wake = input.wake && WAKE_BY_ID[String(input.wake)] ? String(input.wake) : null;
  const nature = Array.from(new Set((input.nature || [])
    .map((x) => String(x))
    .filter((x) => !!NATURE_BY_ID[x]))).slice(0, NATURE_CHOICES.length);
  const heightCm = measure(input.heightCm, 50, 260);
  const weightKg = measure(input.weightKg, 20, 400);
  const note = String(input.note || '').trim().slice(0, 600);

  if (!wake && !nature.length && heightCm === null && weightKg === null && !note) return null;
  return { wake, nature, heightCm, weightKg, note, excludedFromMatching: true, at };
}

export interface PersonalView {
  /** Rendered as label/value rows in the panel — exactly what they gave, nothing derived. */
  lines: { label: string; value: string }[];
  /** One reflective question, chosen by what they said. Empty when they said nothing to choose by. */
  prompt: string;
}

/** What to render for a stored block. Null when the person never opted in. */
export function personalFor(block: PersonalBlock | null | undefined): PersonalView | null {
  if (!block) return null;
  const lines: { label: string; value: string }[] = [];

  if (block.wake && WAKE_BY_ID[block.wake]) {
    lines.push({ label: 'You usually wake', value: WAKE_BY_ID[block.wake].label });
  }
  if (block.nature && block.nature.length) {
    const said = block.nature.map((n) => (NATURE_BY_ID[n] ? NATURE_BY_ID[n].label : '')).filter(Boolean);
    if (said.length) lines.push({ label: 'In your own description', value: said.join('; ') });
  }
  if (typeof block.heightCm === 'number') lines.push({ label: 'Height', value: block.heightCm + ' cm' });
  if (typeof block.weightKg === 'number') lines.push({ label: 'Weight', value: block.weightKg + ' kg' });
  if (block.note) lines.push({ label: 'Anything else you added', value: block.note });

  if (!lines.length) return null;
  return { lines, prompt: (block.wake && WAKE_PROMPT[block.wake]) || '' };
}

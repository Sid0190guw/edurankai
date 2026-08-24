// src/lib/career-intel/reflection.ts — THE OPTIONAL LAYER THAT MAY NEVER TOUCH A DECISION.
//
// =================================================================================================
// WHY THIS IS ITS OWN FILE
// =================================================================================================
//
// Because separation you can SEE is the only kind that survives. This module is not imported by
// rank.ts, not imported by retrieve.ts, and not reachable from either — separation.test.ts reads
// the source of both and fails if the import ever appears. Putting a `useForMatching: false` flag
// on an astrology field inside the profile would have been one careless boolean away from being an
// input to somebody's job prospects. A module the ranker cannot reach cannot be one.
//
// =================================================================================================
// WHAT IT IS
// =================================================================================================
//
// A person may, if they want to, give a birth date and get a short reflective prompt back. That is
// the whole feature. It is:
//
//   - entirely optional, and skippable permanently
//   - visually and logically separate from the evidence-based matching
//   - never an input to which postings are shown, in what order, or with what explanation
//   - never a factor in eligibility, and never shown to anyone assessing an application
//
// AND IT SAYS WHAT IT IS. The text below states plainly that this is not evidence and does not
// affect anything. A reflective prompt presented as insight into somebody's suitability for work is
// the harm this module is written to avoid; presented as what it is, it is a horoscope, and people
// are perfectly capable of reading one without mistaking it for a hiring criterion — as long as
// nobody tells them otherwise.
//
// THE APPLICATION FORM ALREADY STORES A BIRTH DATE (applications.dob / birth_time / birth_place).
// This module does not read it, does not write it, and is not connected to it. What somebody types
// into a reflective prompt on a careers page is not part of their application, and joining the two
// would turn an optional curiosity into a field on a hiring record.

import type { ReflectionBlock } from './dimensions';

/** THE PROMISE, RENDERED. Shown above the layer, not buried in a policy page. */
export const REFLECTION_DISCLAIMER =
  'This is a reflection, not evidence. It plays no part in which opportunities you are shown, '
  + 'in how they are ranked, or in any application you make. Nobody assessing an application sees it. '
  + 'You can skip it, and you can remove it at any time.';

export const REFLECTION_TITLE = 'Optional: a reflection';

export interface Sign {
  key: string;
  label: string;
  /** A question to think about. Deliberately a question — a statement would be a claim. */
  prompt: string;
}

/**
 * The twelve, with the date each begins. Dates are the conventional tropical boundaries; a day
 * either side of a cusp is not worth a birth-time field on a careers page, and asking for one would
 * be collecting more personal data for a feature that is explicitly not used for anything.
 */
const SIGNS: (Sign & { from: [number, number] })[] = [
  { key: 'capricorn', label: 'Capricorn', from: [12, 22], prompt: 'What is the long, unglamorous piece of work you would be willing to do for years? Careers are often built out of exactly that.' },
  { key: 'aquarius', label: 'Aquarius', from: [1, 20], prompt: 'What would you change about how your field currently works? The answer often points at the role you should be looking for.' },
  { key: 'pisces', label: 'Pisces', from: [2, 19], prompt: 'What kind of problem makes you lose track of time? That is usually more informative than any job title.' },
  { key: 'aries', label: 'Aries', from: [3, 21], prompt: 'What would you start tomorrow if nobody had to approve it? Some roles are mostly that.' },
  { key: 'taurus', label: 'Taurus', from: [4, 20], prompt: 'What do you want to still be good at in ten years? Depth is a career strategy, not a personality trait.' },
  { key: 'gemini', label: 'Gemini', from: [5, 21], prompt: 'Which two unrelated things do you know well? The interesting roles are often where two fields touch.' },
  { key: 'cancer', label: 'Cancer', from: [6, 21], prompt: 'Whose work would you want to make easier? A lot of good roles are answers to that question.' },
  { key: 'leo', label: 'Leo', from: [7, 23], prompt: 'What would you want your name on? Ownership is a real difference between two otherwise identical jobs.' },
  { key: 'virgo', label: 'Virgo', from: [8, 23], prompt: 'What do you notice that other people miss? It is worth finding the role where that is the job.' },
  { key: 'libra', label: 'Libra', from: [9, 23], prompt: 'What trade-off are you good at arguing about? Some of the best roles are made of exactly those arguments.' },
  { key: 'scorpio', label: 'Scorpio', from: [10, 23], prompt: 'What do you want to understand properly rather than approximately? That is a research question, and there are roles for it.' },
  { key: 'sagittarius', label: 'Sagittarius', from: [11, 22], prompt: 'What would you want to have learned by the end of next year? A role is one of the faster ways to learn it.' },
];

/**
 * The sign for a date. Pure, offline, and no external service — a careers page must not send a
 * visitor's birth date to a third party, and this feature is not important enough to justify it
 * even if it were acceptable.
 *
 * Returns null for anything unparseable rather than guessing.
 */
export function signFor(birthDate: string): Sign | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate || '').trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Walk the boundaries in calendar order and take the last one this date has passed. Capricorn
  // starts in December and runs into January, so a date before 20 January belongs to it.
  let found = SIGNS[0];
  for (const s of SIGNS) {
    const [sm, sd] = s.from;
    if (month > sm || (month === sm && day >= sd)) found = s;
  }
  if (month === 1 && day < 20) found = SIGNS[0];
  return { key: found.key, label: found.label, prompt: found.prompt };
}

/** Build the block stored on a profile. `excludedFromMatching` is a constant, not a setting. */
export function buildReflection(birthDate: string, at = new Date().toISOString()): ReflectionBlock | null {
  const s = signFor(birthDate);
  if (!s) return null;
  return { birthDate: birthDate.slice(0, 10), sign: s.key, excludedFromMatching: true, at };
}

/** What to render for a stored block. Null when the person never opted in. */
export function reflectionFor(block: ReflectionBlock | null | undefined): { label: string; prompt: string } | null {
  if (!block || !block.sign) return null;
  const s = SIGNS.find((x) => x.key === block.sign);
  if (!s) return null;
  return { label: s.label, prompt: s.prompt };
}

export const ALL_SIGNS: Sign[] = SIGNS.map((s) => ({ key: s.key, label: s.label, prompt: s.prompt }));

// src/lib/credit-week-copy.ts — the sentences every weekly-credit screen says, written ONCE.
//
// Four surfaces show weekly credits: the intern's own page, the approver's queue in the portal, the
// HR console, and the completion letter. If each writes its own wording, they drift — and the first
// time an intern's page and a completion letter describe the same credit differently, neither is
// believed again. So the wording lives here.
//
// PURE. No database, no imports beyond the rule module, safe in .astro frontmatter and in tests.
//
// NO EMOJI, and no arrow characters: these strings are rendered inside .astro JSX, where an arrow in
// a string breaks the parse and blames a Fragment somewhere else entirely.
import { INTERN_WEEKLY_HOURS } from '@/lib/credit-week';

/** What a credit IS. Rendered next to every credit figure in the product. */
export const CREDIT_UNIT_SENTENCE =
  'One credit is one completed week. A week is complete when the hours it required were actually '
  + 'measured from check-in and check-out net of breaks, the daily reports were filed, and the work '
  + 'due that week was done. Approved leave and holidays reduce the hours required rather than '
  + 'counting as a shortfall.';

/** The intern week, quoted from the policy rather than restated, so the two cannot drift. */
export const INTERN_WEEK_SENTENCE =
  'For an intern that week is ' + INTERN_WEEKLY_HOURS + ' hours.';

/** What happens automatically, and what does not. */
export const CREDIT_AUTOMATIC_SENTENCE =
  'When both are true the credit is granted automatically: nobody has to click anything, and the '
  + 'record says it was granted automatically and on what evidence. When either is not true the '
  + 'credit is not granted and not refused - it waits for the reporting manager, HR, or a more '
  + 'senior authority above them, who decides it with a written reason.';

/** The three facts every screen has to keep apart. This is the correction, in one paragraph. */
export const CREDIT_THREE_FACTS_SENTENCE =
  'Earned, waiting for a decision, and not measurable are three different things. A day clocked in '
  + 'and never clocked out is not zero hours and not a full day - it is an unfinished record, it is '
  + 'named rather than absorbed into a total, and it is exactly why a person and not a calculation '
  + 'decides that week.';

/** What this record is, and what it is not. EduRankAI is the platform; partners award credentials. */
export const CREDIT_SCOPE_SENTENCE =
  'A credit here is a record of work done at EduRankAI. It is not a qualification and not a claim '
  + 'to confer one - accredited partners award credentials.';

/** "3 credits" / "1 credit" / "none". Never a bare number with no unit beside it. */
export function creditsLabel(n: number | null | undefined): string {
  const c = Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
  if (c <= 0) return 'none';
  return c + (c === 1 ? ' credit' : ' credits');
}

/** "7.5 h", or the honest refusal. Null is a real answer and must never render as 0. */
export function hoursLabel(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return 'not recorded';
  return (Math.round((Number(n) + Number.EPSILON) * 100) / 100) + ' h';
}

/**
 * Plain words for a stored state. Kept here rather than imported into every page so a screen that
 * receives an unexpected value says something rather than rendering a raw enum at a person.
 */
export function stateLabel(state: string | null | undefined): string {
  const s = String(state || '');
  if (s === 'earned-automatically') return 'Earned automatically';
  if (s === 'approved') return 'Credited by decision';
  if (s === 'refused') return 'Not credited';
  if (s === 'pending') return 'Waiting for a decision';
  if (s === 'open') return 'Week in progress';
  return 'Not recorded';
}

/**
 * Colours for a state chip, as a plain object.
 *
 * A FUNCTION AND NOT A TYPED MAP. A `Record<string, string>` declared for use inside .astro JSX
 * breaks the parse in this project, which is why every colour lookup in this codebase is spelled
 * this way.
 */
export function stateTone(state: string | null | undefined) {
  const s = String(state || '');
  if (s === 'earned-automatically' || s === 'approved') {
    return { bg: '#F1F8F3', fg: '#1F5132', bd: '#CBE3D2' };
  }
  if (s === 'refused') return { bg: '#FDF3F2', fg: '#8A2C21', bd: '#EFCFCB' };
  if (s === 'pending') return { bg: '#FBF7F1', fg: '#6D470D', bd: '#EADECD' };
  return { bg: '#F5F4F2', fg: '#564E43', bd: '#DFDCD8' };
}

/** The same three tones for the dark admin surfaces. */
export function stateToneDark(state: string | null | undefined) {
  const s = String(state || '');
  if (s === 'earned-automatically' || s === 'approved') {
    return { bg: 'rgba(16,185,129,0.14)', fg: '#6ee7b7', bd: 'rgba(16,185,129,0.3)' };
  }
  if (s === 'refused') return { bg: 'rgba(220,38,38,0.14)', fg: '#fca5a5', bd: 'rgba(220,38,38,0.3)' };
  if (s === 'pending') return { bg: 'rgba(251,191,36,0.14)', fg: '#fcd34d', bd: 'rgba(251,191,36,0.3)' };
  return { bg: 'rgba(120,120,132,0.16)', fg: '#b4b4be', bd: 'rgba(120,120,132,0.32)' };
}

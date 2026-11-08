// SAMARTH X evaluation: the review criteria, how reviewer scores combine, and the advisory ranking
// for the best-six incubation decision. PURE.
//
// ADVISORY ONLY. The ranking orders candidates for a human panel; it never selects anybody, and
// nothing calls it to change a status. Selection and incubation are recorded by a person through
// the workflow guards in workflow.ts.

export const X_CRITERIA: readonly { key: string; label: string; help: string }[] = [
  { key: 'problem', label: 'Problem significance', help: 'Is the problem real, important and well understood?' },
  { key: 'technical', label: 'Technical depth', help: 'Is the proposed AI or intelligent system technically credible and ambitious?' },
  { key: 'evidence', label: 'Prototype and evidence', help: 'Is there working code, a prototype, data or results?' },
  { key: 'team', label: 'Team capability', help: 'Can this person or team build it?' },
  { key: 'viability', label: 'Market and viability', help: 'Is there a plausible path to users and a sustainable venture?' },
  { key: 'drive', label: 'Entrepreneurial drive', help: 'Evidence of initiative, persistence and ownership.' },
];

export const SCORE_MIN = 0;
export const SCORE_MAX = 5;

export type Scores = Record<string, number>;

/** Clamp a submitted score set to the known criteria and the 0..5 range. Missing criteria are refused. */
export function parseScores(get: (key: string) => unknown): { ok: true; scores: Scores } | { ok: false; error: string } {
  const scores: Scores = {};
  for (const c of X_CRITERIA) {
    const raw = get(c.key);
    const n = Number(raw);
    if (raw === '' || raw == null || !Number.isFinite(n)) return { ok: false, error: 'Score every criterion (' + c.label + ' is missing).' };
    scores[c.key] = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(n)));
  }
  return { ok: true, scores };
}

/** One reviewer's total, 0..30. */
export function reviewTotal(scores: Scores | null | undefined): number {
  return X_CRITERIA.reduce((sum, c) => sum + (Number((scores || {})[c.key]) || 0), 0);
}

export const MAX_TOTAL = X_CRITERIA.length * SCORE_MAX;

export interface Aggregate {
  reviews: number;
  /** Mean of reviewer totals, 0..30, one decimal. null with no reviews. */
  mean: number | null;
  /** Mean per criterion. */
  perCriterion: Record<string, number>;
  /** Largest minus smallest reviewer total: a wide spread means the panel disagrees. */
  spread: number | null;
}

export function aggregate(reviewScores: Scores[]): Aggregate {
  const n = reviewScores.length;
  if (!n) return { reviews: 0, mean: null, perCriterion: {}, spread: null };
  const totals = reviewScores.map(reviewTotal);
  const perCriterion: Record<string, number> = {};
  for (const c of X_CRITERIA) {
    perCriterion[c.key] = Math.round((reviewScores.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) / n) * 10) / 10;
  }
  return {
    reviews: n,
    mean: Math.round((totals.reduce((a, b) => a + b, 0) / n) * 10) / 10,
    perCriterion,
    spread: Math.max(...totals) - Math.min(...totals),
  };
}

/**
 * Advisory order for an incubation panel: highest mean first, more reviews breaking a tie, then
 * the earlier application. Candidates with no reviews sort last and are never "in the top six".
 */
export function rankForIncubation<T extends { id: string; mean: number | null; reviews: number; createdAt: string }>(list: T[], places = 6): (T & { rank: number; inTopPlaces: boolean })[] {
  const sorted = [...list].sort((a, b) => {
    const am = a.mean ?? -1, bm = b.mean ?? -1;
    if (bm !== am) return bm - am;
    if (b.reviews !== a.reviews) return b.reviews - a.reviews;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
  return sorted.map((c, i) => ({ ...c, rank: i + 1, inTopPlaces: c.mean != null && i < places }));
}

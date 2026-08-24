export const DEPT_DB_MAP: Record<string, string> = {
  "Founder's Office": "founders",
  "Executive Leadership": "exec",
  "AI / Model": "ai",
  "Data & Statistics": "data",
  "Infrastructure": "infra",
  "Product & UX": "product",
  "Security & AI Safety": "safety",
  "Quantum Systems": "quantum",
  "Innovation & Research": "research",
  "Data Engine": "dataengine",
  "Form & Database Systems": "formdb",
  "Psychology & Human Factors": "psychology",
  "HR & People": "hr",
  "Legal, Finance & Strategy": "legal",
  "Growth & Marketing": "growth"
};

export const DEPT_DB_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(DEPT_DB_MAP).map(([k, v]) => [v, k])
);

export const TOTAL_STEPS = 6;
// SEVEN entries, one per step, in the order the pages declare via step={n} — not the order the
// files are named. level.astro was inserted as step 2 after these arrays were written, so every
// label from 2 onward pointed at the previous step's name and step 7 rendered undefined: the
// final "Review and Submit" screen showed a blank heading above the form that submits the
// application. Each string here is the same text the page passes as stepTitle, so the rail and
// the page can never disagree again. ApplyLayout reads STEP_LABELS[step-1] and slices STEP_SHORT
// to totalSteps (7), and admin/app-settings renders one editor per entry — all three break the
// moment this array is shorter than the number of steps.
export const STEP_LABELS = ["Personal Info", "Career level", "Role Preference", "Education & Experience", "Skills and Proof of Work", "Motivation and Logistics", "Review and Submit"];
export const STEP_SHORT = ["Info", "Level", "Role", "Edu", "Skills", "Why", "Submit"];

export function isInternOrApprentice(level: string | undefined | null): boolean {
  return level === 'Intern' || level === 'Apprentice';
}

export function safeDraft(data: unknown): Record<string, any> {
  if (!data) return {};
  if (typeof data === 'object') return data as Record<string, any>;
  if (typeof data === 'string') { try { return JSON.parse(data); } catch { return {}; } }
  return {};
}

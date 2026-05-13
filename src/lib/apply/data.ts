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
export const STEP_LABELS = ["Personal Info", "Role Preference", "Education", "Skills and Proof", "Motivation and Logistics", "Review and Submit"];
export const STEP_SHORT = ["Info", "Role", "Edu", "Skills", "Why", "Submit"];

export function isInternOrApprentice(level: string | undefined | null): boolean {
  return level === 'Intern' || level === 'Apprentice';
}

export function safeDraft(data: unknown): Record<string, any> {
  if (!data) return {};
  if (typeof data === 'object') return data as Record<string, any>;
  if (typeof data === 'string') { try { return JSON.parse(data); } catch { return {}; } }
  return {};
}

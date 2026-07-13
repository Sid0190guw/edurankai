// src/lib/credit-transfer.ts — server-side port of AES-100 Vol III P3 Ch11
// (Planetary Education) sovereign recognition + cross-system equivalence + learner
// mobility. This is the SAME algorithm as public/aquin-planetary-edu.js, moved
// server-side so the admin tool runs it on REAL, persisted records rather than an
// in-memory demo. Recognition is a sovereign choice (an institution recognises whom
// it chooses); grades/credits convert through a common quality/learning-hours scale.
//
// HONEST SCOPE: the recognition policy + equivalence math + mobility logic are real;
// cryptographic credential signing and inter-governmental accreditation treaties are
// declared substrates.

export type GradeSystem = 'gpa4' | 'percent' | 'ects100';
export type CreditSystem = 'us' | 'ects' | 'uk';

export interface Institution { id: string; name: string; country: string | null; gradeSystem: GradeSystem; creditSystem: CreditSystem; accreditation: string | null; }
export interface Credential { id: string; issuer: string; learner: string; type: string; credits: number; grade: number | null; }
export interface Recognition { byInst: string; ofInst: string; }

// normalise a grade to a 0..1 quality, and render a quality back in a system
const GRADE: Record<GradeSystem, { toQuality: (g: number) => number; fromQuality: (q: number) => number }> = {
  gpa4: { toQuality: (g) => g / 4, fromQuality: (q) => +(q * 4).toFixed(2) },
  percent: { toQuality: (g) => g / 100, fromQuality: (q) => Math.round(q * 100) },
  ects100: { toQuality: (g) => g / 100, fromQuality: (q) => Math.round(q * 100) },
};
// canonical "learning hours" factor (1 US credit ≈ 2 ECTS ≈ 10 UK credits, illustrative)
const CREDIT: Record<CreditSystem, number> = { us: 1, ects: 0.5, uk: 0.1 };

export interface RecognitionResult { recognized: boolean; reason: string; }
export interface Equivalence { fromGrade: number | null; fromSystem: GradeSystem; toGrade: number | null; toSystem: GradeSystem; fromCredits: string; toCredits: number; toCreditSystem: CreditSystem; }

interface World { institutions: Record<string, Institution>; recognitions: Recognition[]; credentials: Credential[]; }

function recognizes(world: World, byInst: string, ofInst: string): boolean {
  return world.recognitions.some((r) => r.byInst === byInst && r.ofInst === ofInst);
}

// is a credential recognised by an institution? (own / agreement / shared accreditation)
export function recognizedBy(world: World, cred: Credential, byInstId: string): RecognitionResult {
  const b = world.institutions[byInstId];
  const a = world.institutions[cred.issuer];
  if (!b || !a) return { recognized: false, reason: 'unknown institution' };
  if (cred.issuer === byInstId) return { recognized: true, reason: 'own credential' };
  if (recognizes(world, byInstId, cred.issuer)) return { recognized: true, reason: 'recognition agreement' };
  if (a.accreditation && a.accreditation === b.accreditation) return { recognized: true, reason: `shared accreditation body "${a.accreditation}"` };
  return { recognized: false, reason: `"${b.name}" does not recognise "${a.name}" (sovereign choice)` };
}

// convert a credential's grade + credits into a target institution's systems
export function equivalence(world: World, cred: Credential, toInstId: string): Equivalence | null {
  const from = world.institutions[cred.issuer];
  const to = world.institutions[toInstId];
  if (!from || !to) return null;
  const q = cred.grade != null ? GRADE[from.gradeSystem].toQuality(cred.grade) : null;
  const toGrade = q != null ? GRADE[to.gradeSystem].fromQuality(q) : null;
  const toCredits = +(cred.credits * CREDIT[from.creditSystem] / CREDIT[to.creditSystem]).toFixed(2);
  return { fromGrade: cred.grade, fromSystem: from.gradeSystem, toGrade, toSystem: to.gradeSystem, fromCredits: `${cred.credits} ${from.creditSystem}`, toCredits, toCreditSystem: to.creditSystem };
}

export interface MobilityLine { credential: string; type: string; from: string; via?: string; reason?: string; converted?: Equivalence | null; }
export interface MobilityResult { learner: string; to: string; transferred: MobilityLine[]; notRecognized: MobilityLine[]; totalCreditsTransferred: number; }

// learner mobility A -> B: transfer only recognised credentials, converted to B's systems
export function evaluateMobility(world: World, learner: string, toInstId: string): MobilityResult {
  const to = world.institutions[toInstId];
  const mine = world.credentials.filter((c) => c.learner === learner);
  const transferred: MobilityLine[] = [];
  const notRecognized: MobilityLine[] = [];
  let total = 0;
  for (const c of mine) {
    const r = recognizedBy(world, c, toInstId);
    const fromName = world.institutions[c.issuer]?.name || c.issuer;
    if (r.recognized) {
      const conv = equivalence(world, c, toInstId);
      if (conv) total += conv.toCredits;
      transferred.push({ credential: c.id, type: c.type, from: fromName, via: r.reason, converted: conv });
    } else {
      notRecognized.push({ credential: c.id, type: c.type, from: fromName, reason: r.reason });
    }
  }
  return { learner, to: to?.name || toInstId, transferred, notRecognized, totalCreditsTransferred: +total.toFixed(2) };
}

export function buildWorld(institutions: Institution[], recognitions: Recognition[], credentials: Credential[]): World {
  const map: Record<string, Institution> = {};
  for (const i of institutions) map[i.id] = i;
  return { institutions: map, recognitions, credentials };
}

export const GRADE_SYSTEMS: GradeSystem[] = ['gpa4', 'percent', 'ects100'];
export const CREDIT_SYSTEMS: CreditSystem[] = ['us', 'ects', 'uk'];

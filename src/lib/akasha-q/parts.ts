// Akasha-Q Scientific Programme Charter — the part and artifact registry.
//
// The charter is a long-horizon research document series. This file is the single source of truth
// for which Parts exist, which completion artifacts each Part gates, and what state each artifact
// is in. /akasha-q reads it, so adding a Part here makes it reachable — there is no second list.
//
// STATUS DISCIPLINE. `status` is the artifact's real state, not its intended state. Nothing in this
// programme has reached laboratory validation, so no artifact may carry a status implying a result.

export type ArtifactStatus = 'drafted' | 'in-progress' | 'not-started';

export interface CharterArtifact {
  /** Formal programme identifier, e.g. AQ-MSA-001. */
  id: string;
  name: string;
  /** One line: what this document is for. */
  purpose: string;
  status: ArtifactStatus;
}

export interface CharterPart {
  n: number;
  slug: string;
  title: string;
  /** Standfirst shown on the hub and at the top of the part page. */
  summary: string;
  /** The completion criteria — artifacts that must exist before the next Part begins. */
  artifacts: CharterArtifact[];
}

export const EVIDENCE_LEVELS = [
  'Concept', 'Theory', 'Simulation', 'Lab validation',
  'Field validation', 'Dynamic platform', 'Flight / space', 'Operational demonstration',
] as const;

/**
 * The highest evidence level ANY element of the programme has reached.
 * Index into EVIDENCE_LEVELS. Currently 1 ("Theory") — architecture defined, nothing built.
 * This drives the honesty banner on every Akasha-Q surface and must not be advanced by hand
 * without an Experiment Evidence Package supporting it.
 */
export const PROGRAMME_EVIDENCE_INDEX = 1;

export const PARTS: CharterPart[] = [
  {
    n: 12,
    slug: 'master-system-architecture',
    title: 'The Master System Architecture',
    summary:
      'Ten layers, their interfaces, their failure behaviour, and the research question that binds '
      + 'them: whether physical, cryptographic, temporal and historical evidence can be composed into '
      + 'a single continuously-updated system trust state that governs what a distributed node is '
      + 'permitted to do.',
    artifacts: [
      { id: 'AQ-MSA-001', name: 'Master System Architecture Document', purpose: 'The ten layers formalised, with enforcement classification per property.', status: 'drafted' },
      { id: 'AQ-TSM-000', name: 'Trust State Model Specification v0', purpose: 'States, transitions, recovery sequence; every threshold a declared assumption.', status: 'drafted' },
      { id: 'AQ-NRA-001', name: 'AQ-NODE-01 Reference Architecture', purpose: 'Internal blocks, the five trust boundaries, and what enforces each.', status: 'drafted' },
      { id: 'AQ-EFD-000', name: 'Evidence Fabric Data Model v0', purpose: 'Record schema answering the ten questions, with third-party verification.', status: 'drafted' },
      { id: 'AQ-ICD-REG-001', name: 'Interface Control Document Register', purpose: 'Six ICDs, each specifying failure and absence semantics before implementation.', status: 'drafted' },
      { id: 'AQ-Y1A-001', name: 'Year-1 Prototype Architecture', purpose: 'The Y1 subset only, with an explicit exclusions table so scope creep is visible.', status: 'drafted' },
      { id: 'AQ-AAR-001', name: 'Architecture Assumption Register', purpose: 'Every assumption with its consequence if false and the experiment that tests it.', status: 'drafted' },
      { id: 'AQ-ARR-001', name: 'Architecture Risk Register', purpose: 'Architectural risks, including the four thesis falsification modes as tracked risks.', status: 'drafted' },
    ],
  },
  {
    n: 26,
    slug: 'demonstration-and-credibility',
    title: 'Demonstration, Validation & Public Credibility Strategy',
    summary:
      'How the programme shows real progress to executives, scientists, institutions and independent '
      + 'reviewers without a demonstration becoming an argument. Every public claim traceable to an '
      + 'evidence package; every demonstration bound to a registered protocol; every failure recorded '
      + 'rather than re-run.',
    artifacts: [
      { id: 'AQ-SDD-001', name: 'Scientific Demonstration Dossier', purpose: 'Seventeen sections with the pre-registration boundary at section 9.', status: 'drafted' },
      { id: 'AQ-SDD-001-S1', name: 'Worked dossier — Scenario 1', purpose: 'Sections 1-9 as they would be registered before the first run.', status: 'drafted' },
      { id: 'AQ-SCN-002', name: 'Scenario 2 — Degraded information', purpose: 'Five injections, each with the domain it must affect and its failure criterion.', status: 'drafted' },
      { id: 'AQ-SCN-003', name: 'Scenario 3 — Compound system stress', purpose: 'Combined degradation, timing constraint and computational pressure.', status: 'drafted' },
      { id: 'AQ-EVIDENCE-WALL', name: 'Claim register', purpose: 'Seven-field entries; three-step navigation; struck claims stay visible.', status: 'drafted' },
      { id: 'AQ-PUBLIC-CLAIM-GATE', name: 'Claim approval procedure', purpose: 'Six stages, five decision states, independence requirement.', status: 'drafted' },
      { id: 'AQ-CEO-BRIEF-001', name: 'Executive capability briefing', purpose: 'Eight slots with prohibited content named per slot.', status: 'drafted' },
      { id: 'AQ-INST-BRIEF-001', name: 'Institutional briefing', purpose: 'Ten sections plus the six-item pre-collaboration inspection set.', status: 'drafted' },
      { id: 'AQ-IOP-001', name: 'Independent Observer Protocol', purpose: 'Twelve stages including the permanent disagreement record.', status: 'drafted' },
      { id: 'AQ-INDEPENDENT-REVIEW', name: 'Technical reviewer protocol', purpose: 'Seven stages ending in a published-dissent right.', status: 'drafted' },
      { id: 'AQ-DEMO-FAIL-001', name: 'Failed demonstration protocol', purpose: 'Seven steps; no quiet re-run; unreproducible failure is the graver finding.', status: 'drafted' },
      { id: 'AQ-DVC-001', name: 'Demonstration version control', purpose: 'Nine mandatory fields, each tied to the failure it prevents.', status: 'drafted' },
      { id: 'AQ-DEMO-ARCH-001', name: 'AQ-NODE demonstration architecture', purpose: 'The eleven-stage loop and the six distinctions it must make visible.', status: 'drafted' },
      { id: 'AQ-DEMO-UI-001', name: 'Control room panel specification', purpose: 'Twelve panels, each bound to a named data source. Implemented at /akasha-q/demo.', status: 'drafted' },
      { id: 'AQ-UNC-001', name: 'Uncertainty visibility model', purpose: 'Six bands mapped to trust state and operational consequence.', status: 'drafted' },
      { id: 'AQ-LANG-001', name: 'Language discipline standard', purpose: 'Worked pairs of unsupported versus evidence-aligned wording.', status: 'drafted' },
      { id: 'AQ-SHOW-001', name: 'Public research showcase', purpose: 'Ten sections; failures precede evidence, deliberately.', status: 'drafted' },
      { id: 'AQ-DML-001', name: 'Demonstration maturity ladder', purpose: 'DM-0 to DM-6 with claim and non-claim sets per level.', status: 'drafted' },
      { id: 'AQ-CRED-001', name: 'Credibility timeline', purpose: 'Four bands mapped to AQ-GATE-04 through AQ-GATE-08.', status: 'drafted' },
      { id: 'AQ-TRUST-001', name: 'External trust architecture and metrics', purpose: 'Six checkable components; thirteen metrics with no invented targets.', status: 'drafted' },
    ],
  },
];

export function partBySlug(slug: string): CharterPart | null {
  return PARTS.find((p) => p.slug === slug) || null;
}

export function artifactCounts() {
  const all = PARTS.flatMap((p) => p.artifacts);
  return {
    total: all.length,
    drafted: all.filter((a) => a.status === 'drafted').length,
    inProgress: all.filter((a) => a.status === 'in-progress').length,
    notStarted: all.filter((a) => a.status === 'not-started').length,
  };
}

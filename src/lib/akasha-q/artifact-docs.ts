// Metadata only for the 28 charter completion artifacts. The BODY of each document lives in
// src/lib/akasha-q/docs/<ID>.html and is loaded lazily by the route via import.meta.glob, one file
// per request. They were briefly inlined into a single 429 KB TypeScript module; that stalled the
// Vite dev transport for the WHOLE site (every route 500ed, not just these) and pushed the build
// from 80s to 196s. The bodies stay out of the module graph.

export interface ArtifactMeta { id: string; name: string; oneLine: string; }

export const ARTIFACT_META: ArtifactMeta[] = [
 {
  "id": "AQ-AAR-001",
  "name": "Architecture Assumption Register",
  "oneLine": "Every load-bearing assumption in the Part 12 architecture, each with its basis, the consequence if it is false, the experiment that would settle it, an accountable owner and its current evidence level."
 },
 {
  "id": "AQ-ARR-001",
  "name": "Architecture Risk Register",
  "oneLine": "Architectural risks with likelihood, consequence, detectability, mitigation and retiring gate — including the four falsification modes that would invalidate the central thesis of the trust architecture."
 },
 {
  "id": "AQ-CEO-BRIEF-001",
  "name": "Executive capability briefing: structure and prohibited content",
  "oneLine": "The eight-slot executive briefing: timing, the required form of every answer, prohibited content per slot, and the checklist the presenter signs before delivery."
 },
 {
  "id": "AQ-CRED-001",
  "name": "AQ-CRED-001 — Twelve-month credibility timeline and gate mapping",
  "oneLine": "Maps the four AQ-NODE-G0 credibility bands onto gates AQ-GATE-04 through AQ-GATE-08, names the evidence that opens each gate and the public position permitted in each band, and fixes the rule that evidence unlocks a level while elapsed time never does."
 },
 {
  "id": "AQ-DEMO-ARCH-001",
  "name": "AQ-NODE demonstration architecture",
  "oneLine": "The eleven-stage AQ-NODE demonstration loop, the layer and trust boundary owning each stage, and the six distinctions D-1..D-6 the demonstration must make visible to an observer."
 },
 {
  "id": "AQ-DEMO-FAIL-001",
  "name": "Failed demonstration protocol",
  "oneLine": "The binding seven-step sequence for a demonstration that does not produce its asserted result: stop or contain, preserve evidence, declare, investigate, reproduce, correct or revise the claim, decide next action - with named role ownership, four situation handlings, and the rule that an unreproducible failure is the more serious finding."
 },
 {
  "id": "AQ-DEMO-UI-001",
  "name": "Control room panel specification",
  "oneLine": "The twelve control room panels P1..P12 with their exact data-source bindings, required behaviour and prohibited behaviour, under a display binding rule that forbids invented, smoothed or defaulted values."
 },
 {
  "id": "AQ-DML-001",
  "name": "Demonstration maturity ladder DM-0 to DM-6",
  "oneLine": "Seven demonstration maturity levels with observers, required evidence, claim ceilings, prohibited claims and advancement criteria, including the DM-4 observation-is-not-validation rule."
 },
 {
  "id": "AQ-DVC-001",
  "name": "Demonstration version control",
  "oneLine": "The nine mandatory record fields for any Akasha-Q run and the failure each one prevents, the pre-allocated AQ-DEMO-ID scheme and append-only register lifecycle, the NON-EVIDENTIAL RUN marking for communication-only runs, and rule AQ-RL-26.14 separating rehearsal from validation across seven dimensions."
 },
 {
  "id": "AQ-EFD-000",
  "name": "Evidence Fabric Data Model v0",
  "oneLine": "The v0 record schema for the Evidence Fabric: the ten questions every record answers, event identity, time binding with stated confidence, digest chaining and anchoring, DC-1 provenance tagging, raw-data references with retention and expiry, explicit gap records, decision receipts, and a written third-party verification procedure."
 },
 {
  "id": "AQ-EVIDENCE-WALL",
  "name": "AQ-EVIDENCE-WALL — Claim register: format, rules and operation",
  "oneLine": "The seven-field claim entry, the three-step navigation rule that decides whether a claim may stay on the wall, struck-claim handling, and the internal maintenance cycle that runs between showcases."
 },
 {
  "id": "AQ-ICD-REG-001",
  "name": "Interface Control Document Register",
  "oneLine": "The controlling index of the six Akasha-Q interface control documents, the content each must carry before any implementation begins (failure and absence semantics included), and the AQ-NODE / AKQ-NODE identifier equivalence."
 },
 {
  "id": "AQ-INDEPENDENT-REVIEW",
  "name": "AQ-INDEPENDENT-REVIEW Technical Reviewer Protocol",
  "oneLine": "The seven-stage independent technical review: what a reviewer receives and may challenge at IR-1 to IR-7, how reviewers are selected and which conflicts exclude them, and the seven obligations the programme owes a reviewer whose finding it rejects, including published dissent and a contested marker on the claim."
 },
 {
  "id": "AQ-INST-BRIEF-001",
  "name": "Institutional briefing: structure and inspection set",
  "oneLine": "The ten-section institutional briefing, the six-item inspection set released before any collaboration, and the prohibition on strategic, sovereign or defence framing."
 },
 {
  "id": "AQ-IOP-001",
  "name": "AQ-IOP-001 Independent Observer Protocol",
  "oneLine": "How a person outside the programme witnesses an Akasha-Q run: the twelve stages IOP-1 to IOP-12, the five-working-day dossier floor, the ten-working-day evidence export, the nine conditions that void a run's observed status, and the observer's unconditional right to remain unconvinced."
 },
 {
  "id": "AQ-LANG-001",
  "name": "Language discipline standard",
  "oneLine": "Eighteen worked pairs replacing unsupported wording with evidence-aligned wording, plus the four-slot pattern every capability statement must satisfy before it leaves the programme record."
 },
 {
  "id": "AQ-MSA-001",
  "name": "AQ-MSA-001 - Master System Architecture Document",
  "oneLine": "Formalises the ten-layer AQ-NODE-01 stack: per-layer mission, inputs, outputs, trusted assumptions, failure classes, evidence generated, Y1 form and future evolution, with the enforcement classification and the two directional rules (evidence up, policy down)."
 },
 {
  "id": "AQ-NRA-001",
  "name": "AQ-NODE-01 Reference Architecture",
  "oneLine": "Internal block architecture of the AQ-NODE-01 reference article: the five trust boundaries and their enforcement classes, element classification, the deterministic-acquisition rationale, the signature-gated update boundary that can only exit into RECOVERING, and configuration identity."
 },
 {
  "id": "AQ-PUBLIC-CLAIM-GATE",
  "name": "AQ-PUBLIC-CLAIM-GATE — Claim approval procedure and forms",
  "oneLine": "The six-stage approval flow, the five decision states, review composition and the independence requirement, the field-by-field submission form, and the rule that any paraphrase outside the gate is itself an unapproved claim."
 },
 {
  "id": "AQ-SCN-002",
  "name": "Scenario 2 specification: Degraded information",
  "oneLine": "Eleven-field specification for the degraded-information scenario: five bracketed injections (delay, absence, contradiction, staleness, reduced quality) with magnitudes, telemetry labels, expected AQ-TSE-01 transitions and the failure criterion for each."
 },
 {
  "id": "AQ-SCN-003",
  "name": "Scenario 3 specification: Compound system stress",
  "oneLine": "Eleven-field specification for combined information degradation, bounded decision time and computational pressure, defining the oscillation damping window, evidence-store backlog rules, and the programme position that ungraceful degradation is a publishable negative result."
 },
 {
  "id": "AQ-SDD-001",
  "name": "AQ-SDD-001 — Scientific Demonstration Dossier: template and completion rules",
  "oneLine": "The seventeen-section dossier that governs every Akasha-Q demonstration run: what each section must contain, the seal boundary between pre-registered sections 1-9 and post-run sections 10-17, and the acceptance test that lets a section pass review."
 },
 {
  "id": "AQ-SDD-001-S1",
  "name": "AQ-SDD-001-S1 — Worked dossier: Scenario 1, Normal conditions",
  "oneLine": "A fully worked pre-registration of sections 1-9 for the control run of AQ-NODE-01 on the optical bench — objective, question, falsifiable hypothesis, version fields, layers exercised, protocol, no injected faults, and criteria that declare no numeric targets — with sections 10-17 left unfilled and the reason stated."
 },
 {
  "id": "AQ-SHOW-001",
  "name": "First public research showcase architecture",
  "oneLine": "Ten-section architecture, audience journey, staffing, replay stations and exit test for the first public research showcase, with failures deliberately placed before evidence."
 },
 {
  "id": "AQ-TRUST-001",
  "name": "AQ-TRUST-001 — External trust architecture and demonstration metrics",
  "oneLine": "Defines the six compounding components of external trust with the mechanism the programme runs and the check an outsider performs without our cooperation, then the thirteen-metric framework with baseline and target-setting methods rather than invented targets."
 },
 {
  "id": "AQ-TSM-000",
  "name": "AQ-TSM-000 - Trust State Model Specification v0",
  "oneLine": "Defines the five trust states and their transition rules, separates per-domain confidence from system trust, specifies the mandatory seven-step recovery sequence, and carries every threshold as a declared assumption with no measured value."
 },
 {
  "id": "AQ-UNC-001",
  "name": "Uncertainty visibility model",
  "oneLine": "How uncertainty is banded, bound to trust state and command authority, displayed without suppression for any audience, and recorded as a first-class decision when the node abstains."
 },
 {
  "id": "AQ-Y1A-001",
  "name": "Year-1 Prototype Architecture",
  "oneLine": "The Y1 subset only: the elements the bootstrap laboratory will build, each traced to a Part 12 layer and a stage gate, with the observe-only rule for AQ-TSE-01 and an explicit exclusions table so scope creep stays visible."
 }
];

export function metaById(id: string): ArtifactMeta | null {
  const k = String(id || '').toUpperCase();
  return ARTIFACT_META.find((d) => d.id === k) || null;
}

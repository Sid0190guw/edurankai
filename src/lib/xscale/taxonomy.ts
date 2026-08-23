// src/lib/xscale/taxonomy.ts — THE CLASSIFICATION VOCABULARY FOR EXTREME-SCALE RESEARCH ROLES.
//
// Pure data and pure functions. No database, no imports from the rest of the app: this module is
// what every other surface — the careers filters, the division pages, the job detail page, the admin
// editor and the seed catalogue — reads its labels and its ranges from, so that a classification
// means exactly one thing everywhere it appears.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE.
//
// The department is organised across a conceptual span from 10^-100 m to 10^100 m. That span is a
// RESEARCH CLASSIFICATION, not a claim of experimental reach. No laboratory on Earth probes 10^-100
// metres and none is going to; below roughly 10^-19 m nothing has been measured directly, and what
// happens near the Planck length (~1.6 x 10^-35 m) is the subject of competing mathematical
// frameworks with no experiment able to discriminate between them. Anything at 10^26 m and beyond is
// inference from light that reached us, not engineering.
//
// So EVERY posting carries a research classification alongside its scale range, and every public
// surface that shows a scale range must also show what kind of work it actually is. SCALE_DISCLAIMER
// is the sentence that must accompany the range; classificationEvidence() is what turns a posting
// into an honest statement about its evidential standing.
//
// Advertising speculative research as an available technology would be a lie told to somebody
// deciding what to do with several years of their life. That is the harm this module prevents.

// -------------------------------------------------------------------------------------------------
//   RESEARCH CLASSIFICATION
// -------------------------------------------------------------------------------------------------

export type ResearchClassification =
  | 'THEORETICAL'
  | 'MATHEMATICAL'
  | 'COMPUTATIONAL'
  | 'SIMULATION'
  | 'EXPERIMENTAL'
  | 'PROTOTYPE'
  | 'APPLIED_ENGINEERING'
  | 'LONG_HORIZON_FRONTIER';

/**
 * The evidential standing of a body of work, in the five categories the department is required to
 * keep visibly distinct. Deliberately a SEPARATE axis from the classification: computational work on
 * validated physics and computational work on a speculative framework are the same activity with
 * very different standing, and a candidate must be able to tell them apart before applying.
 */
export type EvidenceStatus =
  | 'established'      // Settled science; the work applies it rather than testing it.
  | 'experimental'     // Active experimental research; results are measured against apparatus.
  | 'computational'    // Computational research on models whose underlying physics is established.
  | 'theoretical'      // Theoretical/mathematical research; internal consistency is the test.
  | 'speculative';     // Frontier research with no current experimental discrimination.

export interface ClassificationDef {
  key: ResearchClassification;
  label: string;
  /** One sentence: what a person in this classification actually does. */
  summary: string;
  /** Default evidential standing, before the scale range is taken into account. */
  evidence: EvidenceStatus;
  /** What "done" looks like, and therefore what is reviewed. */
  outputs: string;
}

export const RESEARCH_CLASSIFICATIONS: ClassificationDef[] = [
  {
    key: 'THEORETICAL',
    label: 'Theoretical',
    summary: 'Formulating and analysing physical theories, and deriving what they predict.',
    evidence: 'theoretical',
    outputs: 'Derivations, consistency arguments, predicted observables, written results with stated assumptions.',
  },
  {
    key: 'MATHEMATICAL',
    label: 'Mathematical',
    summary: 'Proving results and building the mathematical structures other work is expressed in.',
    evidence: 'theoretical',
    outputs: 'Theorems and proofs, well-posedness and convergence results, formal statements of method.',
  },
  {
    key: 'COMPUTATIONAL',
    label: 'Computational',
    summary: 'Computing quantities that cannot be obtained in closed form, from established physics.',
    evidence: 'computational',
    outputs: 'Reproducible calculations, convergence and error budgets, released code and datasets.',
  },
  {
    key: 'SIMULATION',
    label: 'Simulation',
    summary: 'Building and running simulations of systems too large or too strongly coupled to solve directly.',
    evidence: 'computational',
    outputs: 'Verified and, where data exists, validated simulation codes, with documented uncertainty.',
  },
  {
    key: 'EXPERIMENTAL',
    label: 'Experimental',
    summary: 'Measuring real systems with real apparatus, and analysing what the apparatus produced.',
    evidence: 'experimental',
    outputs: 'Measurements with calibration and uncertainty, analysis pipelines, negative results included.',
  },
  {
    key: 'PROTOTYPE',
    label: 'Prototype',
    summary: 'Building a working article to find out what the design does outside the model.',
    evidence: 'experimental',
    outputs: 'A built device, a characterisation report, and a written account of where it fails.',
  },
  {
    key: 'APPLIED_ENGINEERING',
    label: 'Applied engineering',
    summary: 'Engineering to a specification, on established science, for something that has to work.',
    evidence: 'established',
    outputs: 'Designs, analyses against requirements, test evidence, and maintainable engineering artefacts.',
  },
  {
    key: 'LONG_HORIZON_FRONTIER',
    label: 'Long-horizon frontier research',
    summary: 'Open questions with no current experimental test, pursued for what the attempt itself yields.',
    evidence: 'speculative',
    outputs: 'Formal results, explicit statements of what would falsify them, and honest accounts of the limits.',
  },
];

const CLASSIFICATION_BY_KEY: Record<string, ClassificationDef> =
  Object.fromEntries(RESEARCH_CLASSIFICATIONS.map((c) => [c.key, c]));

export function isResearchClassification(v: unknown): v is ResearchClassification {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CLASSIFICATION_BY_KEY, v);
}

export function classificationDef(key: string | null | undefined): ClassificationDef | null {
  if (!key) return null;
  return CLASSIFICATION_BY_KEY[String(key).toUpperCase()] || null;
}

export function classificationLabel(key: string | null | undefined): string {
  return classificationDef(key)?.label || '';
}

export interface EvidenceDef {
  key: EvidenceStatus;
  label: string;
  /** The sentence shown to a candidate, written to be read by somebody deciding whether to apply. */
  statement: string;
  /** Ordering, most established first. */
  rank: number;
}

export const EVIDENCE_STATUSES: EvidenceDef[] = [
  {
    key: 'established',
    label: 'Established science',
    rank: 1,
    statement: 'Rests on settled physics and engineering. The work applies it; it is not what is under test here.',
  },
  {
    key: 'experimental',
    label: 'Active experimental research',
    rank: 2,
    statement: 'Involves real apparatus and real measurement. Results are provisional until they are reproduced.',
  },
  {
    key: 'computational',
    label: 'Computational research',
    rank: 3,
    statement: 'Computed from established physics. A computed number is a prediction, and it is only as good as its convergence, its error budget, and whatever data it can be checked against.',
  },
  {
    key: 'theoretical',
    label: 'Theoretical research',
    rank: 4,
    statement: 'Mathematical and theoretical work. Derivation and internal consistency are the standard here; experimental confirmation is not currently available at this scale.',
  },
  {
    key: 'speculative',
    label: 'Speculative frontier research',
    rank: 5,
    statement: 'An open question that no current experiment can decide. Nothing in this area should be described, by us or by you, as a validated or available technology.',
  },
];

const EVIDENCE_BY_KEY: Record<string, EvidenceDef> =
  Object.fromEntries(EVIDENCE_STATUSES.map((e) => [e.key, e]));

export function evidenceDef(key: string | null | undefined): EvidenceDef | null {
  if (!key) return null;
  return EVIDENCE_BY_KEY[String(key)] || null;
}

// -------------------------------------------------------------------------------------------------
//   SCALE BANDS
// -------------------------------------------------------------------------------------------------

/**
 * log10 of the Planck length in metres (1.616 x 10^-35 m), to the exponent. Nothing below this is
 * meaningfully a length in any theory that has been tested.
 */
export const PLANCK_EXP = -35;

/**
 * log10 of the radius of the observable universe in metres (~8.8 x 10^26 m). Beyond this, a distance
 * is a statement about a cosmological model rather than about anything that can be observed.
 */
export const OBSERVABLE_EXP = 26;

/** The smallest length any experiment has probed, roughly, in log10 metres (colliders, ~10^-19 m). */
export const PROBED_MIN_EXP = -19;

export const SCALE_MIN_EXP = -100;
export const SCALE_MAX_EXP = 100;

export interface ScaleBand {
  id: string;
  /** Inclusive lower bound, log10 metres. */
  minExp: number;
  /** Upper bound, log10 metres. */
  maxExp: number;
  label: string;
  /** What actually exists at this scale, in plain language. */
  description: string;
  /** True when apparatus of some kind reaches into this band today. */
  experimentallyAccessible: boolean;
}

export const SCALE_BANDS: ScaleBand[] = [
  {
    id: 'BAND_01', minExp: -100, maxExp: -35,
    label: 'Ultra-fundamental and theoretical',
    description: 'Below the Planck length. No experiment reaches here and none is proposed; work in this band is mathematics and theory about what a physical theory would have to look like at all.',
    experimentallyAccessible: false,
  },
  {
    id: 'BAND_02', minExp: -35, maxExp: -18,
    label: 'Planck, fundamental and high-energy theory',
    description: 'From the Planck length up to the smallest distances probed by collider experiments. Almost all of this band is inferred from theory rather than measured.',
    experimentallyAccessible: false,
  },
  {
    id: 'BAND_03', minExp: -18, maxExp: -12,
    label: 'Subatomic, particle and nuclear',
    description: 'Quarks, nucleons and nuclei. Studied through accelerators, detectors, and the statistical analysis of very large datasets.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_04', minExp: -12, maxExp: -9,
    label: 'Atomic and quantum',
    description: 'Atoms, ions, electronic structure and quantum states. Directly measured with spectroscopy, traps and quantum devices.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_05', minExp: -9, maxExp: -6,
    label: 'Nano',
    description: 'Molecules, nanostructures, two-dimensional materials and quantum dots. Fabricated, imaged and characterised routinely.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_06', minExp: -6, maxExp: -3,
    label: 'Micro',
    description: 'Microelectronics, MEMS, microfluidics and cellular biology. Mature fabrication and metrology.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_07', minExp: -3, maxExp: 0,
    label: 'Meso and human-scale devices',
    description: 'Components, instruments and devices a person can hold. Where most engineering prototypes are built and tested.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_08', minExp: 0, maxExp: 6,
    label: 'Macro, infrastructure and planetary surface',
    description: 'Machines, structures, vehicles, buildings and infrastructure networks, up to regional scale.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_09', minExp: 6, maxExp: 13,
    label: 'Space, planetary and astronomical',
    description: 'Planetary bodies, orbits and the Solar System. Reached by spacecraft and observed directly.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_10', minExp: 13, maxExp: 26,
    label: 'Stellar and galactic modelling',
    description: 'Stars, star systems, galaxies and large-scale structure. Observed remotely and modelled computationally. Nothing at this scale is engineered.',
    experimentallyAccessible: true,
  },
  {
    id: 'BAND_11', minExp: 26, maxExp: 100,
    label: 'Cosmological, theoretical and computational',
    description: 'At and beyond the edge of the observable universe. A statement about this band is a statement about a cosmological model, not about anything that can be observed.',
    experimentallyAccessible: false,
  },
];

const BAND_BY_ID: Record<string, ScaleBand> = Object.fromEntries(SCALE_BANDS.map((b) => [b.id, b]));

export function scaleBand(id: string | null | undefined): ScaleBand | null {
  if (!id) return null;
  return BAND_BY_ID[String(id).toUpperCase()] || null;
}

/** Clamp an exponent into the department's declared span, so bad input cannot widen a claim. */
export function clampExp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(SCALE_MIN_EXP, Math.min(SCALE_MAX_EXP, Math.round(n)));
}

/**
 * Every band a [minExp, maxExp] range touches, ascending.
 *
 * Written with explicit numeric comparisons on named locals rather than inline in a template, for
 * the .astro reason recorded in CLAUDE.md: a `<` inside a JSX expression breaks the parser, and the
 * safe habit is for the comparison to live in a module like this one and never in a page.
 */
export function bandsForRange(minExp: number, maxExp: number): ScaleBand[] {
  const a = clampExp(minExp);
  const b = clampExp(maxExp);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return SCALE_BANDS.filter((band) => {
    // BANDS ARE HALF-OPEN, [minExp, maxExp), AND SO IS A ROLE'S RANGE. That matters: a role declared
    // 10^-9 m to 10^-6 m is the nano band and nothing else. Testing `hi >= band.minExp` put it in
    // the micro band too, on the strength of touching its lower bound at a single point, and a
    // posting appearing under a scale it does not work at is the same misrepresentation this module
    // exists to prevent — just in the other direction.
    //
    // The TOP band's upper bound is inclusive, so a role declared exactly at 10^100 is not silently
    // dropped from every listing. A degenerate range (lo === hi) resolves to its containing band.
    const topInclusive = band.id === 'BAND_11';
    const startsBelowBandTop = lo < band.maxExp || (topInclusive && lo <= band.maxExp);
    if (lo === hi) return startsBelowBandTop && hi >= band.minExp;
    return startsBelowBandTop && hi > band.minExp;
  });
}

/** Does any part of this range sit where an experiment can currently reach? */
export function rangeIsExperimentallyAccessible(minExp: number, maxExp: number): boolean {
  return bandsForRange(minExp, maxExp).some((b) => b.experimentallyAccessible);
}

/**
 * The evidential standing of a specific posting.
 *
 * Classification alone is not sufficient, and this is the function that says why: COMPUTATIONAL work
 * at band 01, below the Planck length, is not "computational research on established physics" — it
 * is speculative frontier work carried out by computer. A posting whose scale range sits entirely
 * where no experiment reaches is reported as speculative or theoretical REGARDLESS of the activity.
 *
 * Deliberately one-directional: this can only make a claim WEAKER, never stronger. There is no input
 * that turns speculative work into established science.
 */
export function classificationEvidence(
  classification: string | null | undefined,
  scaleMinExp?: number | null,
  scaleMaxExp?: number | null,
): EvidenceDef | null {
  const def = classificationDef(classification);
  if (!def) return null;
  const base = evidenceDef(def.evidence);
  if (!base) return null;
  const min = typeof scaleMinExp === 'number' ? clampExp(scaleMinExp) : null;
  const max = typeof scaleMaxExp === 'number' ? clampExp(scaleMaxExp) : null;
  if (min === null || max === null) return base;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (rangeIsExperimentallyAccessible(lo, hi)) return base;

  // Nothing in this range is measured by anything.
  const speculative = EVIDENCE_BY_KEY['speculative'];
  const theoretical = EVIDENCE_BY_KEY['theoretical'];
  // Entirely below the Planck length, or entirely beyond the observable universe.
  const belowPlanck = hi <= PLANCK_EXP;
  const beyondObservable = lo >= OBSERVABLE_EXP;
  if (belowPlanck || beyondObservable) return speculative;
  return base.rank > theoretical.rank ? base : theoretical;
}

/**
 * Plain-text exponent, e.g. "10^-35 m".
 *
 * Deliberately ASCII. This string is used in page titles, meta descriptions, structured data and
 * JSX attributes, and superscript and arrow characters have broken .astro parsing on this project
 * before. Rendered markup uses expParts() where real superscripts are wanted.
 */
export function expText(exp: number, unit = ' m'): string {
  return '10^' + clampExp(exp) + unit;
}

/** The base/exponent split, for surfaces that want superscript markup rather than a caret. */
export function expParts(exp: number): { base: string; exponent: string } {
  return { base: '10', exponent: String(clampExp(exp)) };
}

/** e.g. "10^-9 m to 10^-6 m". No arrow characters — see the .astro rules in CLAUDE.md. */
export function scaleRangeText(minExp: number, maxExp: number, unit = ' m'): string {
  const a = clampExp(minExp);
  const b = clampExp(maxExp);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) return expText(lo, unit);
  return expText(lo, unit) + ' to ' + expText(hi, unit);
}

/** The band names a range covers, as a one-line human summary. */
export function scaleRangeBandLabel(minExp: number, maxExp: number): string {
  const bands = bandsForRange(minExp, maxExp);
  if (!bands.length) return '';
  if (bands.length === 1) return bands[0].label;
  return bands[0].label + ' through ' + bands[bands.length - 1].label.toLowerCase();
}

/**
 * THE SENTENCE THAT MUST ACCOMPANY ANY PUBLISHED SCALE RANGE.
 *
 * Not optional and not a footnote to be trimmed for layout. A scale range printed on its own reads
 * as a claim about what the organisation can build.
 */
export const SCALE_DISCLAIMER =
  'Scale bands are a research classification, not a claim of experimental reach. Most of this span '
  + 'cannot be probed by any apparatus that exists: nothing below about 10^-19 m has been measured '
  + 'directly, and anything at 10^26 m or beyond is inferred from observation rather than engineered. '
  + 'Every opportunity states the kind of work it actually is.';

export const SCALE_DISCLAIMER_SHORT =
  'A research classification, not a claim of experimental access at every scale.';

// -------------------------------------------------------------------------------------------------
//   SKILL TAXONOMY
// -------------------------------------------------------------------------------------------------

export type SkillCategoryKey =
  | 'PHYSICS' | 'MATHEMATICS' | 'CHEMISTRY' | 'BIOLOGY' | 'MATERIALS'
  | 'NANOENGINEERING' | 'QUANTUM' | 'SEMICONDUCTORS' | 'ELECTRONICS'
  | 'COMPUTER_SCIENCE' | 'ARTIFICIAL_INTELLIGENCE' | 'SCIENTIFIC_COMPUTING'
  | 'MECHANICAL_ENGINEERING' | 'CIVIL_ENGINEERING' | 'AEROSPACE'
  | 'ENERGY' | 'ENVIRONMENT' | 'ASTROPHYSICS' | 'COSMOLOGY';

export interface SkillCategory {
  key: SkillCategoryKey;
  label: string;
  /** The concrete, checkable skills this category is made of. Filterable; never re-typed per page. */
  skills: string[];
}

export const SKILL_CATEGORIES: SkillCategory[] = [
  { key: 'PHYSICS', label: 'Physics', skills: [
    'Classical mechanics', 'Electromagnetism', 'Statistical mechanics', 'Thermodynamics',
    'Quantum mechanics', 'Quantum field theory', 'General relativity', 'Condensed matter physics',
    'Particle physics', 'Nuclear physics', 'Optics and photonics', 'Plasma physics',
  ] },
  { key: 'MATHEMATICS', label: 'Mathematics', skills: [
    'Linear algebra', 'Real analysis', 'Complex analysis', 'Abstract algebra',
    'Differential equations', 'Partial differential equations', 'Differential geometry', 'Topology',
    'Tensor calculus', 'Probability', 'Statistics', 'Optimisation',
    'Numerical analysis', 'Dynamical systems', 'Information theory', 'Group and representation theory',
  ] },
  { key: 'CHEMISTRY', label: 'Chemistry', skills: [
    'Physical chemistry', 'Quantum chemistry', 'Density functional theory', 'Molecular dynamics',
    'Reaction kinetics', 'Catalysis', 'Electrochemistry', 'Surface chemistry',
    'Supramolecular chemistry', 'Spectroscopy interpretation',
  ] },
  { key: 'BIOLOGY', label: 'Biology and biotechnology', skills: [
    'Molecular biology', 'Biochemistry', 'Structural biology', 'Computational biology',
    'Bioinformatics', 'Synthetic biology', 'Tissue engineering', 'Biosensing',
    'Microfluidics', 'Biosafety and research ethics',
  ] },
  { key: 'MATERIALS', label: 'Materials science', skills: [
    'Crystallography', 'Phase diagrams', 'Structure-property relationships', 'Mechanical testing',
    'Electronic properties of solids', 'Thin films', 'Metamaterials', 'Composites',
    'X-ray diffraction analysis', 'Electron microscopy analysis', 'Computational materials science',
  ] },
  { key: 'NANOENGINEERING', label: 'Nano engineering', skills: [
    'Nanomaterials synthesis', 'Nanofabrication', 'Lithography', 'Self-assembly',
    'Nanophotonics', 'Nanoelectronics', 'Nanometrology', 'Scanning probe microscopy',
    'Two-dimensional materials', 'Quantum dots and nanowires',
  ] },
  { key: 'QUANTUM', label: 'Quantum engineering', skills: [
    'Quantum information', 'Quantum algorithms', 'Quantum error correction', 'Hamiltonian modelling',
    'Quantum simulation', 'Quantum sensing and metrology', 'Superconducting circuits',
    'Trapped ions and neutral atoms', 'Quantum measurement and tomography', 'Qiskit or an equivalent SDK',
  ] },
  { key: 'SEMICONDUCTORS', label: 'Semiconductors', skills: [
    'Semiconductor device physics', 'TCAD device modelling', 'Process integration',
    'Microfabrication', 'Photolithography', 'Failure analysis', 'Compact modelling', 'Yield analysis',
  ] },
  { key: 'ELECTRONICS', label: 'Electronics', skills: [
    'Analog circuit design', 'Digital design', 'VLSI and RTL', 'SPICE simulation',
    'Signal processing', 'Sensor interfacing', 'Embedded firmware', 'PCB design',
    'RF and microwave design', 'Photonic integrated circuits',
  ] },
  { key: 'COMPUTER_SCIENCE', label: 'Computer science', skills: [
    'Data structures', 'Algorithms', 'Systems programming', 'Concurrency',
    'Linux', 'Git', 'Software testing', 'Profiling and performance analysis',
    'Databases', 'Distributed systems', 'Reproducible computing',
  ] },
  { key: 'ARTIFICIAL_INTELLIGENCE', label: 'Artificial intelligence', skills: [
    'Machine learning', 'Deep learning', 'PyTorch', 'JAX',
    'Physics-informed neural networks', 'Graph neural networks', 'Surrogate modelling',
    'Uncertainty quantification in machine learning', 'Active learning', 'Model evaluation against honest baselines',
  ] },
  { key: 'SCIENTIFIC_COMPUTING', label: 'Scientific computing', skills: [
    'Python', 'C++', 'Julia', 'Fortran',
    'MPI', 'OpenMP', 'CUDA and GPU computing', 'HPC scheduling',
    'Numerical linear algebra', 'Monte Carlo methods', 'Finite element methods', 'Finite volume methods',
    'Symbolic mathematics', 'Workflow orchestration', 'Containerised environments',
  ] },
  { key: 'MECHANICAL_ENGINEERING', label: 'Mechanical engineering', skills: [
    'Solid mechanics', 'Fluid mechanics', 'Heat transfer', 'Finite element analysis',
    'Computational fluid dynamics', 'CAD', 'Multiphysics simulation', 'Precision engineering',
    'Robotics', 'Control systems', 'Advanced manufacturing', 'Multiscale modelling',
  ] },
  { key: 'CIVIL_ENGINEERING', label: 'Civil and structural engineering', skills: [
    'Structural analysis', 'Structural dynamics', 'Construction materials', 'Geotechnical engineering',
    'Structural health monitoring', 'Infrastructure digital twins', 'GIS', 'Seismic design',
    'Climate resilience assessment',
  ] },
  { key: 'AEROSPACE', label: 'Aerospace and space systems', skills: [
    'Orbital mechanics', 'Aerodynamics', 'Propulsion', 'Spacecraft systems engineering',
    'Thermal control', 'Attitude determination and control', 'Space environment effects',
    'Space robotics', 'Mission analysis',
  ] },
  { key: 'ENERGY', label: 'Energy', skills: [
    'Battery materials and electrochemistry', 'Photovoltaics', 'Hydrogen systems', 'Fuel cells',
    'Energy storage modelling', 'Power systems', 'Techno-economic analysis', 'Catalyst design',
  ] },
  { key: 'ENVIRONMENT', label: 'Environment and climate', skills: [
    'Climate system modelling', 'Carbon capture materials', 'Water treatment', 'Life-cycle assessment',
    'Environmental nanotechnology', 'Air and water quality analysis', 'Geospatial analysis',
  ] },
  { key: 'ASTROPHYSICS', label: 'Astrophysics', skills: [
    'Stellar structure and evolution', 'Galactic dynamics', 'Radiative transfer',
    'Gravitational dynamics', 'Time-series and survey analysis', 'Astronomical data pipelines',
    'N-body simulation', 'Magnetohydrodynamics',
  ] },
  { key: 'COSMOLOGY', label: 'Cosmology', skills: [
    'Large-scale structure', 'Cosmological perturbation theory', 'CMB analysis',
    'Bayesian inference and MCMC', 'Cosmological simulation', 'Gravitational lensing',
    'Model comparison and evidence',
  ] },
];

const SKILL_CATEGORY_BY_KEY: Record<string, SkillCategory> =
  Object.fromEntries(SKILL_CATEGORIES.map((c) => [c.key, c]));

export function skillCategory(key: string | null | undefined): SkillCategory | null {
  if (!key) return null;
  return SKILL_CATEGORY_BY_KEY[String(key).toUpperCase()] || null;
}

export function skillCategoryLabel(key: string | null | undefined): string {
  return skillCategory(key)?.label || '';
}

/** Every skill string in the taxonomy, deduplicated and sorted. */
export function allSkills(): string[] {
  const set = new Set<string>();
  for (const c of SKILL_CATEGORIES) for (const s of c.skills) set.add(s);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** The categories a list of skill strings belongs to. Case-insensitive, exact match on the name. */
export function categoriesForSkills(skills: string[]): SkillCategoryKey[] {
  const want = new Set((skills || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean));
  if (!want.size) return [];
  const out: SkillCategoryKey[] = [];
  for (const c of SKILL_CATEGORIES) {
    if (c.skills.some((s) => want.has(s.toLowerCase()))) out.push(c.key);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
//   CAREER LEVEL MATRIX
// -------------------------------------------------------------------------------------------------

/**
 * The department's eleven-rung research ladder, level 0 to level 10.
 *
 * MAPPED, NOT REPLACING. The `roles` table already has a seven-value `role_level` enum that the whole
 * site reads — the careers filters, the offer letters, the engagement policy, the fee logic. This
 * ladder is a SECOND, finer axis stored beside it, and every rung declares which existing enum value
 * it maps onto so that nothing downstream has to learn a new vocabulary.
 *
 * NOT EVERY RUNG EXISTS IN EVERY DIVISION. A division declares which rungs it actually staffs; a
 * "Distinguished Nanofabrication Engineer" nobody is going to hire is an advertisement for a job
 * that does not exist, and this system does not generate one just because the matrix has a row.
 */
export interface CareerRung {
  level: number;
  label: string;
  titles: string[];
  /** The existing site-wide role_level enum value this rung maps onto. */
  roleLevel: 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice';
  /** Measurable experience expectation, written so a candidate can self-assess against it. */
  experience: string;
  /** Education expectation. Never a hard bar where evidence of the work substitutes for it. */
  education: string;
  /** What this rung is accountable for. */
  scope: string;
}

export const CAREER_LADDER: CareerRung[] = [
  {
    level: 0, label: 'Student Researcher', roleLevel: 'Apprentice',
    titles: ['Student Researcher'],
    experience: 'Currently enrolled. No prior research experience required; evidence of self-directed work in the subject is.',
    education: 'Enrolled in an undergraduate programme in a relevant discipline.',
    scope: 'One scoped piece of work under weekly supervision, with a written result at the end of it.',
  },
  {
    level: 1, label: 'Research and Engineering Intern', roleLevel: 'Intern',
    titles: ['Research Intern', 'Engineering Intern'],
    experience: 'No professional experience required. Must be able to show at least one completed project with code or a written result somebody else can read.',
    education: 'Final years of an undergraduate degree, or a postgraduate student, in a relevant discipline.',
    scope: 'One well-defined problem, delivered with a reproducible artefact and a short written report.',
  },
  {
    level: 2, label: 'Junior and Associate', roleLevel: 'Junior',
    titles: ['Junior Engineer', 'Junior Research Scientist', 'Associate Engineer', 'Associate Scientist'],
    experience: 'Up to 2 years, or a completed research degree. Must have written code or analysis that somebody else has used.',
    education: "Bachelor's or Master's degree in a relevant discipline.",
    scope: 'A component of a larger piece of work, with independent responsibility for its correctness.',
  },
  {
    level: 3, label: 'Engineer and Scientist', roleLevel: 'Mid',
    titles: ['Engineer', 'Research Engineer', 'Scientist', 'Research Scientist', 'Computational Scientist'],
    experience: '2 to 5 years of relevant work, or a doctorate in the field.',
    education: "Master's degree or doctorate in a relevant discipline, or equivalent demonstrated research output.",
    scope: 'A whole problem end to end: framing it, doing the work, and reporting the result with its limits.',
  },
  {
    level: 4, label: 'Specialist', roleLevel: 'Mid',
    titles: ['Specialist Engineer', 'Domain Specialist', 'Applied Research Scientist'],
    experience: '4 to 7 years concentrated in one technical area, with demonstrable depth in it.',
    education: 'Doctorate, or equivalent depth demonstrated through published or shipped work.',
    scope: 'The deep technical authority on a specific method or subsystem that other people depend on.',
  },
  {
    level: 5, label: 'Senior', roleLevel: 'Senior',
    titles: ['Senior Engineer', 'Senior Scientist', 'Senior Research Engineer'],
    experience: '6 to 10 years, including work that other people have built on.',
    education: 'Doctorate or an equivalent research record.',
    scope: 'Several related problems at once, and the technical judgement of less experienced colleagues.',
  },
  {
    level: 6, label: 'Lead', roleLevel: 'Lead',
    titles: ['Lead Engineer', 'Research Lead', 'Domain Lead', 'Division Lead'],
    experience: '8 to 12 years, with a record of directing work carried out by other people.',
    education: 'Doctorate or an equivalent research record.',
    scope: 'A research programme or an engineering area: what gets worked on, by whom, and to what standard.',
  },
  {
    level: 7, label: 'Principal', roleLevel: 'Lead',
    titles: ['Principal Engineer', 'Principal Scientist', 'Principal Researcher'],
    experience: '10 or more years, with results that changed how a technical area is approached.',
    education: 'Doctorate or an equivalent research record.',
    scope: 'Technical direction across divisions, and the hardest open problems the department holds.',
  },
  {
    level: 8, label: 'Distinguished and Fellow', roleLevel: 'Lead',
    titles: ['Distinguished Engineer', 'Distinguished Scientist', 'Research Fellow'],
    experience: '12 or more years, with an externally recognised body of work.',
    education: 'Doctorate and a sustained research record.',
    scope: 'A research agenda of their own, and the standard the department is measured against.',
  },
  {
    level: 9, label: 'Architect', roleLevel: 'Lead',
    titles: ['Systems Architect', 'Scientific Architect', 'Research Architect'],
    experience: '12 or more years spanning several of the department’s scales or disciplines.',
    education: 'Doctorate or equivalent, plus demonstrated systems-level responsibility.',
    scope: 'How the department’s computational, experimental and theoretical work fits together.',
  },
  {
    level: 10, label: 'Head and Chief', roleLevel: 'C-Level',
    titles: ['Head of Division', 'Department Director', 'Chief Scientist', 'Chief Engineering Scientist'],
    experience: '15 or more years, including accountability for a research organisation.',
    education: 'Doctorate and a sustained record of research leadership.',
    scope: 'The division or the department: its people, its programme, and its scientific integrity.',
  },
];

const RUNG_BY_LEVEL: Record<number, CareerRung> =
  Object.fromEntries(CAREER_LADDER.map((r) => [r.level, r]));

export function careerRung(level: number | null | undefined): CareerRung | null {
  if (typeof level !== 'number') return null;
  return RUNG_BY_LEVEL[level] || null;
}

/** The site-wide role_level enum value for a ladder rung, for writing into the roles table. */
export function roleLevelForRung(level: number): CareerRung['roleLevel'] {
  return careerRung(level)?.roleLevel || 'Mid';
}

// -------------------------------------------------------------------------------------------------
//   JOB STATUS
// -------------------------------------------------------------------------------------------------

export type JobStatus =
  | 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'PAUSED' | 'CLOSED' | 'ARCHIVED';

export interface JobStatusDef {
  key: JobStatus;
  label: string;
  /** Reachable at its own URL by the public? */
  publiclyVisible: boolean;
  /** Listed in search results and on division pages? */
  listed: boolean;
  /** Accepts new applications? */
  acceptsApplications: boolean;
  /** What a candidate who reaches the posting is told. */
  publicNote: string;
}

export const JOB_STATUSES: JobStatusDef[] = [
  {
    key: 'DRAFT', label: 'Draft',
    publiclyVisible: false, listed: false, acceptsApplications: false, publicNote: '',
  },
  {
    key: 'PENDING_APPROVAL', label: 'Pending approval',
    publiclyVisible: false, listed: false, acceptsApplications: false, publicNote: '',
  },
  {
    key: 'PUBLISHED', label: 'Published',
    publiclyVisible: true, listed: true, acceptsApplications: true, publicNote: '',
  },
  // PAUSED and CLOSED stay VISIBLE but unlisted on purpose. Somebody who already holds the link — a
  // candidate mid-application, a colleague who shared it — is told what happened, instead of being
  // bounced to a page that reads as though the role never existed.
  {
    key: 'PAUSED', label: 'Paused',
    publiclyVisible: true, listed: false, acceptsApplications: false,
    publicNote: 'This opportunity is paused. It is not accepting applications at the moment, and it may reopen.',
  },
  {
    key: 'CLOSED', label: 'Closed',
    publiclyVisible: true, listed: false, acceptsApplications: false,
    publicNote: 'This opportunity is closed and is no longer accepting applications.',
  },
  {
    key: 'ARCHIVED', label: 'Archived',
    publiclyVisible: false, listed: false, acceptsApplications: false, publicNote: '',
  },
];

const JOB_STATUS_BY_KEY: Record<string, JobStatusDef> =
  Object.fromEntries(JOB_STATUSES.map((s) => [s.key, s]));

export function jobStatusDef(key: string | null | undefined): JobStatusDef | null {
  if (!key) return null;
  return JOB_STATUS_BY_KEY[String(key).toUpperCase()] || null;
}

/** The statuses an editor may move a posting into from where it is now. */
export function allowedTransitions(from: string | null | undefined): JobStatus[] {
  switch (String(from || 'DRAFT').toUpperCase()) {
    case 'DRAFT': return ['PENDING_APPROVAL', 'PUBLISHED', 'ARCHIVED'];
    case 'PENDING_APPROVAL': return ['PUBLISHED', 'DRAFT', 'ARCHIVED'];
    case 'PUBLISHED': return ['PAUSED', 'CLOSED', 'ARCHIVED'];
    case 'PAUSED': return ['PUBLISHED', 'CLOSED', 'ARCHIVED'];
    case 'CLOSED': return ['PUBLISHED', 'ARCHIVED'];
    case 'ARCHIVED': return ['DRAFT'];
    default: return ['DRAFT'];
  }
}

/**
 * Resolve the effective status of a posting, deadline included.
 *
 * A DEADLINE THAT HAS PASSED CLOSES THE POSTING, whether or not anybody remembered to change its
 * status. Every gate must ask this function rather than reading the column, because "the deadline
 * passed but the row still says PUBLISHED" is exactly how a system silently accepts an application
 * it was supposed to refuse — the failure PART 13 of the brief names by name.
 */
export function effectiveJobStatus(row: {
  jobStatus?: string | null;
  isOpen?: boolean | null;
  applicationDeadline?: Date | string | null;
}, now: number = Date.now()): JobStatusDef {
  const declared = jobStatusDef(row.jobStatus)
    // A row written before this column existed: is_open is the only truth it carries.
    || (row.isOpen === false ? JOB_STATUS_BY_KEY['CLOSED'] : JOB_STATUS_BY_KEY['PUBLISHED']);
  if (!declared.acceptsApplications) return declared;
  const dl = row.applicationDeadline;
  if (dl) {
    const t = dl instanceof Date ? dl.getTime() : Date.parse(String(dl));
    const expired = Number.isFinite(t) && t < now;
    if (expired) {
      return {
        ...JOB_STATUS_BY_KEY['CLOSED'],
        publicNote: 'The application deadline for this opportunity has passed. It is no longer accepting applications.',
      };
    }
  }
  return declared;
}

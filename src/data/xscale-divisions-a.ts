// src/data/xscale-divisions-a.ts — DIVISIONS 01 TO 08 of the Department of Extreme-Scale, Nano &
// Fundamental Engineering. Divisions 09 to 15 are in ./xscale-divisions-b.ts; both are assembled by
// ./xscale-catalog.ts, which is what turns these definitions into postings.
//
// WHY THE CONTENT LIVES HERE AND THE POSTINGS ARE GENERATED.
//
// A hundred and seventy-nine hand-written job descriptions drift. The third one says "strong
// mathematical background" where the first said "must be able to derive and check a variational
// principle", and within a month the catalogue is advertising vagueness. Everything specific to a
// division is written ONCE here — the domains, the checkable skills, the tools people actually use,
// the mathematics and physics required, what gets delivered, what it is judged on — and the
// generator composes it with the rung the position sits at.
//
// THE REQUIREMENTS RULE. Every entry in mustHave / shouldHave / niceToHave has to be something a
// reader can hold their own experience against and answer yes or no. "Passionate about physics" is
// not a requirement, it is a mood. "Has implemented a numerical PDE solver and can state its
// convergence order" is a requirement.
//
// THE HONESTY RULE. Every division carries an integrityNote, and it is not decoration: it is the
// sentence that stops a scale range being read as a capability. A division working below the Planck
// length says so in the words a physicist would use, not in words that make it sound like a
// laboratory. The published surfaces render this note; it is not optional metadata.
import type { ResearchClassification, SkillCategoryKey } from '@/lib/xscale/taxonomy';

export interface PositionSeed {
  title: string;
  /** A rung on CAREER_LADDER, 0 to 10. Chosen deliberately per position, never inferred. */
  rung: number;
  /** One sentence naming what THIS position works on that its neighbours do not. */
  focus: string;
  /** Overrides the division default when this position is a different kind of work. */
  classification?: ResearchClassification;
  scaleMinExp?: number;
  scaleMaxExp?: number;
  /** Must-have skills specific to this position, added to the division's. */
  extraSkills?: string[];
  openings?: number;
  featured?: boolean;
}

export interface DivisionSeed {
  id: string;
  code: string;
  slug: string;
  name: string;
  /** One paragraph, for a card and a meta description. */
  summary: string;
  /** What the division is for, in a few sentences. Shown at the top of its page. */
  charter: string;
  classification: ResearchClassification;
  scaleMinExp: number;
  scaleMaxExp: number;
  domains: string[];
  skillCategories: SkillCategoryKey[];
  /** Division codes this one works with routinely. */
  collaboratesWith: string[];
  /** The honesty statement. Rendered on every posting in this division. */
  integrityNote: string;
  mustHave: string[];
  shouldHave: string[];
  niceToHave: string[];
  programming: string[];
  tools: string[];
  mathematics: string[];
  physics?: string[];
  chemistry?: string[];
  biology?: string[];
  /** Core responsibilities, shared by every position in the division. */
  whatTheyDo: string[];
  deliverables: string[];
  evaluation: string[];
  keywords: string[];
  positions: PositionSeed[];
}

export const XSCALE_DIVISIONS_A: DivisionSeed[] = [

  // ===============================================================================================
  // DIVISION 01
  // ===============================================================================================
  {
    id: 'xse-d01-fundamental',
    code: 'D01',
    slug: 'ultra-fundamental-mathematical-physics',
    name: 'Ultra-Fundamental & Mathematical Physics',
    summary: 'Mathematical and theoretical work on the structure of spacetime, quantum foundations and the frameworks that attempt to describe physics below the Planck length. Entirely theory, mathematics and computation.',
    charter: 'This division asks what a physical theory would have to look like at scales no instrument reaches. It produces derivations, consistency results and reproducible computations, and it states in every result which parts are established, which are inferred, and which are conjecture. It builds no apparatus and it makes no engineering claim.',
    classification: 'MATHEMATICAL',
    scaleMinExp: -100,
    scaleMaxExp: -35,
    domains: [
      'Mathematical physics', 'Quantum gravity', 'Fundamental spacetime theory', 'Quantum foundations',
      'String-inspired mathematical research', 'Loop quantum gravity', 'Quantum cosmology',
      'High-energy theory', 'Differential geometry', 'Topology', 'Information-theoretic physics',
      'Extreme-scale mathematical modelling',
    ],
    skillCategories: ['MATHEMATICS', 'PHYSICS', 'SCIENTIFIC_COMPUTING', 'COMPUTER_SCIENCE'],
    collaboratesWith: ['D02', 'D09', 'D15'],
    integrityNote:
      'Nothing in this division is experimentally accessible. The Planck length is roughly 10^-35 m; the smallest distance any experiment has probed is around 10^-19 m, sixteen orders of magnitude larger. The frameworks worked on here are mathematically serious and experimentally undecided, and no result produced here should be described, by us or by you, as a demonstrated physical fact or an available technology.',
    mustHave: [
      'Can derive the Euler-Lagrange equations for a field theory from its action and state the symmetries that follow.',
      'Fluent with tensor calculus in index and index-free notation, including covariant differentiation and curvature.',
      'Has taken a graduate course in general relativity or quantum field theory and can reproduce its central derivations.',
      'Can implement a numerical calculation in Python, Julia or C++ and state its convergence behaviour.',
      'Writes results with assumptions listed separately from conclusions.',
    ],
    shouldHave: [
      'Working knowledge of differential geometry: manifolds, connections, fibre bundles.',
      'Familiarity with at least one quantum-gravity programme in enough depth to state its open problems.',
      'Experience with a computer algebra system for tensor manipulation.',
      'Has read and reconstructed a research paper end to end, including the steps it skipped.',
    ],
    niceToHave: [
      'Topology or algebraic geometry beyond a first course.',
      'Experience with lattice or Monte Carlo methods applied to a field theory.',
      'A preprint, thesis chapter or public write-up somebody else can read.',
    ],
    programming: ['Python', 'Julia', 'C++', 'Symbolic mathematics'],
    tools: ['SymPy or Mathematica', 'xAct or an equivalent tensor package', 'NumPy and SciPy', 'LaTeX', 'Git', 'Jupyter'],
    mathematics: [
      'Advanced calculus', 'Linear algebra', 'Abstract algebra', 'Differential geometry',
      'Tensor calculus', 'Topology', 'Functional analysis', 'Numerical analysis',
    ],
    physics: ['Quantum mechanics', 'General relativity', 'Quantum field theory', 'Statistical mechanics'],
    whatTheyDo: [
      'Formulate rigorous mathematical models of the systems the division studies, with assumptions stated explicitly.',
      'Investigate the internal consistency of theoretical frameworks and record precisely where each one breaks.',
      'Develop numerical calculations and simulations where a closed-form result is unavailable.',
      'Derive analytic results and check them against limiting cases that are already known.',
      'Quantify what a result depends on, and identify what would falsify it.',
      'Build reproducible research software that another person can run and obtain the same numbers from.',
      'Classify every claim as established, inferred, or speculative, in writing, before it is published anywhere.',
    ],
    deliverables: [
      'Written derivations with assumptions, limits of validity and known failure modes stated.',
      'Reproducible computational notebooks or codes with a fixed environment and seeded runs.',
      'Internal notes that a colleague in another division can act on without a conversation.',
      'A statement, for each result, of what observation or calculation would contradict it.',
    ],
    evaluation: [
      'Correctness of derivation, checked against known limits.',
      'Reproducibility: does the code produce the reported number on another machine.',
      'Clarity about what is assumed versus what is concluded.',
      'Honesty about negative and inconclusive results, which are reported rather than discarded.',
    ],
    keywords: ['Quantum gravity', 'Mathematical physics', 'Spacetime', 'Quantum foundations', 'Theory', 'Planck scale'],
    positions: [
      { title: 'Ultra-Fundamental Physics Research Intern', rung: 1, focus: 'One scoped calculation inside a chosen quantum-gravity framework, carried through to a written result with its assumptions listed.' },
      { title: 'Mathematical Physics Intern', rung: 1, focus: 'Reconstructing a published derivation in full, including the steps the paper omitted, and writing up where it becomes ambiguous.' },
      { title: 'Quantum Gravity Research Intern', rung: 1, focus: 'A literature-grounded comparison of how two quantum-gravity programmes treat the same limiting case.' },
      { title: 'Theoretical Physics Research Associate', rung: 2, focus: 'Independent responsibility for one component of a larger derivation, and for checking it against its classical limit.' },
      { title: 'Computational Fundamental Physics Engineer', rung: 3, classification: 'COMPUTATIONAL', focus: 'Turning the division\'s derivations into numerical codes that converge, are seeded, and reproduce on another machine.', extraSkills: ['Numerical linear algebra', 'Profiling and performance analysis', 'Software testing'] },
      { title: 'Mathematical Physics Research Scientist', rung: 3, focus: 'Framing and answering a whole mathematical question in the division\'s programme, and reporting its limits.' },
      { title: 'Quantum Gravity Research Scientist', rung: 3, focus: 'Sustained work inside one quantum-gravity framework, including the parts of it that do not work.' },
      { title: 'Spacetime Theory Researcher', rung: 4, focus: 'The technical authority on how the division treats causal structure, horizons and background independence.' },
      { title: 'Quantum Cosmology Scientist', rung: 4, scaleMinExp: -100, scaleMaxExp: 26, classification: 'THEORETICAL', focus: 'The regime where quantum theory and cosmology have to be written in the same equations, and what that costs.' },
      { title: 'Senior Theoretical Physicist', rung: 5, focus: 'Several related theoretical problems at once, and the technical judgement of the researchers working on them.' },
      { title: 'Principal Mathematical Physicist', rung: 7, focus: 'The hardest open problems the division holds, and the standard its derivations are held to.' },
      { title: 'Fundamental Physics Lead', rung: 6, focus: 'What this division works on, who works on it, and the written standard every result meets before it leaves.' },
      { title: 'Extreme-Scale Theory Lead', rung: 6, scaleMinExp: -100, scaleMaxExp: 100, focus: 'The theoretical thread that runs across the department\'s whole declared span, and keeping its claims honest at both ends.' },
    ],
  },

  // ===============================================================================================
  // DIVISION 02
  // ===============================================================================================
  {
    id: 'xse-d02-particle',
    code: 'D02',
    slug: 'particle-high-energy-nuclear-systems',
    name: 'Particle, High-Energy & Nuclear Systems',
    summary: 'Modelling and data analysis for particle, high-energy and nuclear physics: interaction models, Monte Carlo pipelines, detector data, and radiation effects in materials.',
    charter: 'This division works where theory meets very large datasets. It builds simulation pipelines, analyses public and collaboration datasets, quantifies uncertainty honestly, and supports detector and materials research with computation. It does not operate an accelerator.',
    classification: 'COMPUTATIONAL',
    scaleMinExp: -18,
    scaleMaxExp: -12,
    domains: [
      'Particle physics', 'High-energy physics', 'Quantum field theory', 'Nuclear physics',
      'Detector science', 'Computational particle physics', 'Accelerator-related simulation',
      'Radiation and material interaction modelling',
    ],
    skillCategories: ['PHYSICS', 'MATHEMATICS', 'SCIENTIFIC_COMPUTING', 'COMPUTER_SCIENCE'],
    collaboratesWith: ['D01', 'D06', 'D08', 'D09'],
    integrityNote:
      'This is the smallest scale anything has actually been measured at, and the measurement is statistical. Results here are distributions with uncertainties, not single numbers, and a result quoted without its uncertainty is not a result. We analyse public and collaboration datasets; we do not operate accelerator facilities and do not claim to.',
    mustHave: [
      'Can state what a cross-section is, in what units, and how it relates to an event rate.',
      'Has written a Monte Carlo simulation and can explain its variance and how it was reduced.',
      'Competent in statistics: likelihood, confidence intervals, and why a p-value is not a probability that a hypothesis is true.',
      'Can write analysis code in Python or C++ that another person can run on the same data and reproduce.',
      'Reports uncertainty with every number, and separates statistical from systematic.',
    ],
    shouldHave: [
      'A graduate course in quantum field theory or nuclear physics.',
      'Experience with a large dataset that did not fit in memory.',
      'Familiarity with at least one detector simulation or event-generation toolkit.',
      'Version-controlled analysis with a recorded environment.',
    ],
    niceToHave: [
      'Experience on an experimental collaboration, at any level.',
      'HPC or batch-scheduler experience.',
      'Machine learning applied to physics data, with an honest classical baseline alongside it.',
    ],
    programming: ['Python', 'C++', 'Scientific computing'],
    tools: ['ROOT or an equivalent analysis framework', 'Geant4-style detector simulation', 'NumPy and SciPy', 'HPC batch schedulers', 'Git', 'Containerised environments'],
    mathematics: ['Probability', 'Statistics', 'Linear algebra', 'Numerical analysis', 'Monte Carlo methods', 'Differential equations'],
    physics: ['Quantum field theory', 'Statistical mechanics', 'Particle physics', 'Nuclear physics', 'Electromagnetism'],
    whatTheyDo: [
      'Model particle and nuclear interactions and compare the models against measured distributions.',
      'Analyse public and collaboration datasets, with the selection criteria written down before the result is looked at.',
      'Build and maintain simulation pipelines that run reproducibly at scale.',
      'Quantify statistical and systematic uncertainty separately, and report both.',
      'Validate computational results against known cases before trusting them on unknown ones.',
      'Support detector and radiation-damage research with modelling other divisions can use.',
    ],
    deliverables: [
      'Analysis code with a fixed environment, a recorded selection, and a seeded run.',
      'Distributions and fits reported with statistical and systematic uncertainties separated.',
      'Validation notes showing the pipeline reproducing a known result before it was used on a new one.',
      'Simulation configurations another division can run without asking how.',
    ],
    evaluation: [
      'Whether the uncertainty budget is complete and defensible.',
      'Reproducibility of the analysis from a clean checkout.',
      'Validation against a known benchmark before any novel claim.',
      'Resistance to the temptation to tune a selection after seeing the result.',
    ],
    keywords: ['Particle physics', 'High-energy physics', 'Nuclear physics', 'Monte Carlo', 'Detector data', 'Uncertainty quantification'],
    positions: [
      { title: 'Particle Physics Intern', rung: 1, focus: 'One analysis on a public dataset, from selection to a distribution with uncertainties.' },
      { title: 'High-Energy Physics Intern', rung: 1, focus: 'Reproducing a published measurement from open data, and writing up where the reproduction diverges.' },
      { title: 'Nuclear Physics Research Intern', rung: 1, focus: 'A scoped nuclear-structure or reaction-rate calculation checked against tabulated values.' },
      { title: 'Particle Simulation Engineer', rung: 3, classification: 'SIMULATION', focus: 'The Monte Carlo pipelines: correctness, variance reduction, and making them run the same way twice.', extraSkills: ['Monte Carlo methods', 'HPC scheduling'] },
      { title: 'Detector Data Engineer', rung: 3, classification: 'COMPUTATIONAL', focus: 'Turning raw detector output into calibrated, analysable data with the calibration recorded.', extraSkills: ['Databases', 'Workflow orchestration'] },
      { title: 'Computational High-Energy Scientist', rung: 3, focus: 'Computing observables from the theory and confronting them with measured distributions.' },
      { title: 'Nuclear Materials Scientist', rung: 4, classification: 'SIMULATION', scaleMinExp: -12, scaleMaxExp: -6, focus: 'How radiation damages a material over time, modelled at the level where the damage is created.', extraSkills: ['Computational materials science', 'Crystallography'] },
      { title: 'Research Scientist', rung: 3, focus: 'A whole question in the division\'s programme, framed, computed and reported with its limits.' },
      { title: 'Senior Particle Physicist', rung: 5, focus: 'Several analyses at once, and the statistical judgement applied to all of them.' },
      { title: 'Principal High-Energy Scientist', rung: 7, focus: 'The scientific direction of the division\'s computational programme and the standard its results meet.' },
      { title: 'High-Energy Physics Lead', rung: 6, focus: 'What this division analyses, who analyses it, and how uncertainty is reported before anything is published.' },
    ],
  },

  // ===============================================================================================
  // DIVISION 03
  // ===============================================================================================
  {
    id: 'xse-d03-quantum',
    code: 'D03',
    slug: 'quantum-atomic-precision-systems',
    name: 'Quantum, Atomic & Precision Systems',
    summary: 'Quantum information, algorithms, device modelling, sensing and atomic simulation, in the band where quantum states are measured directly rather than inferred.',
    charter: 'This division builds and simulates quantum models, develops algorithms, models devices, and analyses quantum measurements. It benchmarks honestly against classical methods, and it does not describe a simulated device as a built one.',
    classification: 'COMPUTATIONAL',
    scaleMinExp: -12,
    scaleMaxExp: -8,
    domains: [
      'Quantum engineering', 'Quantum information', 'Atomic physics', 'Ion systems',
      'Quantum sensing', 'Quantum simulation', 'Quantum materials', 'Precision measurement',
    ],
    skillCategories: ['QUANTUM', 'PHYSICS', 'MATHEMATICS', 'SCIENTIFIC_COMPUTING'],
    collaboratesWith: ['D04', 'D05', 'D06', 'D07', 'D08'],
    integrityNote:
      'Quantum devices are real, and their present capabilities are narrow. A simulated circuit is not a device; an algorithm with an asymptotic advantage is not an advantage at any size that has been run. Every result from this division states the qubit count, the noise model and the classical baseline it was compared against, and any claim of quantum advantage that omits the classical baseline is treated as unsupported.',
    mustHave: [
      'Can write the state of a two-qubit system, apply a gate to it, and compute a measurement probability by hand.',
      'Comfortable with Hermitian operators, eigendecomposition, tensor products and partial trace.',
      'Has implemented a quantum circuit in Qiskit or an equivalent SDK and interpreted its output including noise.',
      'Can state the difference between a simulated result and a result from hardware, and does so unprompted.',
      'Python to the level of writing tested, reusable numerical code.',
    ],
    shouldHave: [
      'Graduate quantum mechanics, including time-dependent perturbation theory and open-system dynamics.',
      'Familiarity with at least one physical qubit platform in enough detail to name its dominant error source.',
      'Experience benchmarking a quantum method against a competent classical one.',
      'Numerical linear algebra at scale: sparse operators, Krylov methods.',
    ],
    niceToHave: [
      'Quantum error correction beyond the surface-code introduction.',
      'Laboratory experience with lasers, traps or cryogenics.',
      'Experience with quantum-chemistry or many-body simulation packages.',
    ],
    programming: ['Python', 'C++', 'Julia'],
    tools: ['Qiskit or an equivalent SDK', 'QuTiP or an equivalent open-systems package', 'NumPy and SciPy', 'Sparse linear algebra libraries', 'Git', 'Jupyter'],
    mathematics: ['Linear algebra', 'Probability', 'Numerical analysis', 'Group and representation theory', 'Optimisation'],
    physics: ['Quantum mechanics', 'Atomic physics', 'Statistical mechanics', 'Optics and photonics', 'Condensed matter physics'],
    whatTheyDo: [
      'Build and simulate quantum models of the systems the division studies.',
      'Develop and analyse quantum algorithms, including their resource requirements at realistic sizes.',
      'Model devices, including the noise that determines what they can actually do.',
      'Analyse quantum measurement data, with tomography and its error bars.',
      'Benchmark every quantum method against a competent classical baseline and report both.',
      'Support experimental collaborators with modelling where an apparatus exists.',
    ],
    deliverables: [
      'Simulation code with the noise model, the qubit count and the run seed recorded.',
      'Algorithm analyses stating the resource cost at a size that has actually been run.',
      'A classical baseline reported alongside every quantum result.',
      'Measurement analyses with confidence intervals, not point estimates.',
    ],
    evaluation: [
      'Whether the classical baseline is present and competent.',
      'Whether the noise model is stated and justified rather than assumed away.',
      'Reproducibility of the simulation from a clean environment.',
      'Precision about hardware versus simulation in every written claim.',
    ],
    keywords: ['Quantum computing', 'Quantum information', 'Quantum sensing', 'Atomic physics', 'Quantum simulation', 'Precision measurement'],
    positions: [
      { title: 'Quantum Science Intern', rung: 1, focus: 'One quantum system simulated end to end, with a noise model and a classical comparison.' },
      { title: 'Quantum Computing Intern', rung: 1, focus: 'Implementing and analysing a known quantum algorithm at a size that actually runs, and reporting where it stops being an advantage.' },
      { title: 'Quantum Simulation Intern', rung: 1, focus: 'Simulating a small many-body Hamiltonian and checking the result against an exact solution.' },
      { title: 'Atomic Systems Intern', rung: 1, focus: 'An atomic-structure or transition-rate calculation compared against spectroscopic tables.' },
      { title: 'Quantum Engineer', rung: 3, focus: 'Turning a quantum model into working, tested code that other divisions can build on.' },
      { title: 'Quantum Algorithms Engineer', rung: 3, focus: 'Algorithm design and honest resource estimation, including what it would take on hardware that exists.', extraSkills: ['Quantum algorithms', 'Algorithms'] },
      { title: 'Quantum Systems Engineer', rung: 3, classification: 'APPLIED_ENGINEERING', focus: 'The engineering around a quantum experiment: control stacks, calibration routines, data paths.', extraSkills: ['Control systems', 'Embedded firmware'] },
      { title: 'Quantum Sensing Engineer', rung: 3, classification: 'EXPERIMENTAL', focus: 'Sensing schemes and their real noise floors, including where a quantum advantage disappears in practice.', extraSkills: ['Quantum sensing and metrology', 'Signal processing'] },
      { title: 'Atomic Simulation Engineer', rung: 3, classification: 'SIMULATION', focus: 'Many-body and atomic simulations at the sizes that can actually be converged.' },
      { title: 'Quantum Materials Scientist', rung: 4, scaleMinExp: -10, scaleMaxExp: -8, focus: 'Materials whose useful behaviour is quantum, and the calculations that predict it.', extraSkills: ['Condensed matter physics', 'Computational materials science'] },
      { title: 'Senior Quantum Engineer', rung: 5, focus: 'Several quantum workstreams at once, and the benchmarking standard applied to all of them.' },
      { title: 'Principal Quantum Scientist', rung: 7, focus: 'The division\'s scientific direction, and the hardest modelling problems it holds.' },
      { title: 'Quantum Engineering Lead', rung: 6, focus: 'What this division builds, who builds it, and the rule that no quantum claim ships without its classical baseline.' },
    ],
  },

  // ===============================================================================================
  // DIVISION 04
  // ===============================================================================================
  {
    id: 'xse-d04-molecular',
    code: 'D04',
    slug: 'molecular-engineering-computational-chemistry',
    name: 'Molecular Engineering & Computational Chemistry',
    summary: 'Quantum chemistry, molecular dynamics and molecular design: computing what a molecule does, and comparing the prediction with measurement wherever measurement exists.',
    charter: 'This division models molecular systems and designs candidate molecules and materials computationally. Every prediction is reported with the level of theory and the basis set that produced it, and is checked against experimental data where any exists.',
    classification: 'COMPUTATIONAL',
    scaleMinExp: -10,
    scaleMaxExp: -7,
    domains: [
      'Molecular engineering', 'Computational chemistry', 'Quantum chemistry', 'Molecular dynamics',
      'Molecular design', 'Molecular electronics', 'Supramolecular systems', 'Reaction modelling',
      'Catalysis', 'Biomolecular modelling',
    ],
    skillCategories: ['CHEMISTRY', 'PHYSICS', 'SCIENTIFIC_COMPUTING', 'MATERIALS'],
    collaboratesWith: ['D03', 'D05', 'D06', 'D12', 'D13'],
    integrityNote:
      'A computed molecular property is a prediction from a chosen level of theory, not a measurement. Density functional theory results depend on the functional; a number quoted without the functional and basis set is not reproducible. Predictions from this division are candidates for synthesis and testing, and are described that way rather than as discovered materials.',
    mustHave: [
      'Can explain what a basis set is, and what changes when you change one.',
      'Has run a geometry optimisation and can say how convergence was judged.',
      'Understands the difference between a force field and an electronic-structure calculation, and when each is appropriate.',
      'Thermodynamics to the level of relating a free energy difference to an equilibrium constant.',
      'Python for building and analysing simulation workflows.',
    ],
    shouldHave: [
      'Practical experience with a molecular dynamics package, including how an ensemble was chosen.',
      'Density functional theory in enough depth to justify a functional choice in writing.',
      'Statistical mechanics: partition functions, ensembles, free energy methods.',
      'Experience comparing a computed property against experimental data and explaining the gap.',
    ],
    niceToHave: [
      'Enhanced sampling methods.',
      'Machine-learned interatomic potentials, with their validity range stated.',
      'Wet-laboratory experience in synthesis or characterisation.',
    ],
    programming: ['Python', 'C++', 'Scientific computing'],
    tools: ['A DFT package (Quantum ESPRESSO, VASP, ORCA or equivalent)', 'A molecular dynamics engine (GROMACS, LAMMPS or equivalent)', 'RDKit or an equivalent cheminformatics toolkit', 'ASE or an equivalent atomistic framework', 'Workflow orchestration', 'Git'],
    mathematics: ['Linear algebra', 'Differential equations', 'Numerical analysis', 'Statistics', 'Optimisation'],
    physics: ['Quantum mechanics', 'Statistical mechanics', 'Thermodynamics', 'Electromagnetism'],
    chemistry: ['Physical chemistry', 'Quantum chemistry', 'Density functional theory', 'Molecular dynamics', 'Reaction kinetics', 'Catalysis', 'Surface chemistry'],
    whatTheyDo: [
      'Model molecular systems at the level of theory the question actually requires, and justify that choice.',
      'Investigate molecular properties: structure, energetics, spectra, reactivity.',
      'Simulate molecular interactions, including solvent and temperature where they matter.',
      'Develop candidate molecules and materials and rank them by computed properties with uncertainty.',
      'Compare predictions with experimental data whenever data exists, and report the disagreement when it does not agree.',
      'Maintain workflows that another person can rerun and obtain the same numbers from.',
    ],
    deliverables: [
      'Calculations reported with functional, basis set, convergence criteria and software version.',
      'Candidate lists ranked with a stated uncertainty, described as candidates for testing.',
      'Validation against experimental data where it exists, including the cases that disagreed.',
      'Reusable workflows with a recorded environment.',
    ],
    evaluation: [
      'Whether the level of theory is appropriate to the question and justified in writing.',
      'Whether convergence was tested rather than assumed.',
      'Whether an experimental comparison was attempted and honestly reported.',
      'Reproducibility of every reported number.',
    ],
    keywords: ['Computational chemistry', 'Quantum chemistry', 'Molecular dynamics', 'DFT', 'Molecular design', 'Catalysis'],
    positions: [
      { title: 'Computational Chemistry Intern', rung: 1, focus: 'One property computed for a small molecule set, with a convergence study and a comparison to tabulated values.' },
      { title: 'Molecular Engineering Intern', rung: 1, focus: 'A scoped molecular design question, taken from a hypothesis to a ranked candidate list with stated uncertainty.' },
      { title: 'Molecular Simulation Intern', rung: 1, focus: 'A molecular dynamics run set up, equilibrated and analysed, with the ensemble choice justified.' },
      { title: 'Computational Chemist', rung: 3, focus: 'Electronic-structure calculations that answer a question the division actually has, at a defensible level of theory.' },
      { title: 'Molecular Engineer', rung: 3, focus: 'Designing molecules for a target property and handing on candidates a chemist could attempt to make.' },
      { title: 'Molecular Systems Engineer', rung: 3, classification: 'SIMULATION', focus: 'Multi-molecule and supramolecular systems, where the interesting behaviour is collective.' },
      { title: 'Molecular Design Scientist', rung: 4, focus: 'The design methodology itself: how candidates are generated, screened and ranked, and how that is validated.' },
      { title: 'Senior Molecular Engineer', rung: 5, focus: 'Several design and simulation programmes at once, and the standard of theory applied across them.' },
      { title: 'Principal Molecular Scientist', rung: 7, focus: 'The division\'s scientific direction and its hardest modelling problems.' },
      { title: 'Molecular Engineering Lead', rung: 6, focus: 'What this division computes, who computes it, and the rule that a prediction is described as a prediction.' },
    ],
  },

  // ===============================================================================================
  // DIVISION 05
  // ===============================================================================================
  {
    id: 'xse-d05-nano',
    code: 'D05',
    slug: 'nano-engineering-nanotechnology',
    name: 'Nano Engineering & Nanotechnology',
    summary: 'Nanomaterials, nanostructures, nanoelectronics, nanophotonics, sensing and metrology, across the band where structures are fabricated, imaged and characterised routinely.',
    charter: 'This division designs nanoscale systems, models the materials they are made of, develops device concepts, and analyses characterisation data. Fabrication and characterisation are carried out with accredited partner facilities; this division does not claim to own a cleanroom.',
    classification: 'APPLIED_ENGINEERING',
    scaleMinExp: -9,
    scaleMaxExp: -6,
    domains: [
      'Nanomaterials', 'Nanostructures', 'Nanofabrication', 'Nanoelectronics', 'Nanophotonics',
      'Nanosensors', 'Nanometrology', 'Nanobiotechnology', 'Nanoenergy', 'Nano coatings',
      'Two-dimensional materials', 'Carbon nanotechnology', 'Quantum dots', 'Nanowires',
    ],
    skillCategories: ['NANOENGINEERING', 'MATERIALS', 'PHYSICS', 'CHEMISTRY', 'SEMICONDUCTORS'],
    collaboratesWith: ['D03', 'D04', 'D06', 'D07', 'D12', 'D13'],
    integrityNote:
      'This band is real, fabricated and measured every day, and it is also the band most often oversold. A nanomaterial that performs in a characterisation run has not been manufactured at scale, and a device concept that simulates well has not been built. Work from this division states plainly which of the three it is: modelled, made once, or made repeatably.',
    mustHave: [
      'Can explain why a property changes when a material is made small, in terms of surface-to-volume ratio or quantum confinement.',
      'Has interpreted characterisation data — microscopy, diffraction or spectroscopy — and can state what the technique cannot tell you.',
      'Materials science to the level of relating structure to a measurable property.',
      'Can carry out and document a calculation or an analysis in Python that somebody else can rerun.',
      'Distinguishes in writing between a simulated result, a single fabricated sample, and a repeatable process.',
    ],
    shouldHave: [
      'Familiarity with a nanofabrication route — lithography, deposition, etching — in enough detail to state its yield limits.',
      'Semiconductor physics or surface science at graduate level.',
      'Experience with a simulation tool for optical, electronic or mechanical response at the nanoscale.',
      'Statistics sufficient to say whether two samples actually differ.',
    ],
    niceToHave: [
      'Cleanroom experience of any kind.',
      'Scanning probe or electron microscopy hands-on time.',
      'Experience with two-dimensional materials or colloidal synthesis.',
    ],
    programming: ['Python', 'C++', 'MATLAB or an equivalent'],
    tools: ['FDTD or FEM electromagnetic solvers', 'Atomistic simulation packages', 'Image analysis toolchains for microscopy', 'Data analysis in NumPy and SciPy', 'Git', 'Electronic laboratory notebook'],
    mathematics: ['Linear algebra', 'Differential equations', 'Partial differential equations', 'Statistics', 'Numerical analysis'],
    physics: ['Condensed matter physics', 'Electromagnetism', 'Quantum mechanics', 'Optics and photonics', 'Statistical mechanics'],
    chemistry: ['Surface chemistry', 'Physical chemistry', 'Electrochemistry'],
    whatTheyDo: [
      'Design nanoscale systems against a stated performance target, not against a general aspiration.',
      'Model materials and structures, including the fabrication tolerances the design has to survive.',
      'Develop device concepts and carry them to the point where a partner facility could attempt them.',
      'Analyse characterisation data and state what each technique can and cannot establish.',
      'Connect theory, simulation and experiment, and report where they disagree.',
      'Record process conditions well enough that a result can be attempted again.',
    ],
    deliverables: [
      'Designs with tolerances, expected performance, and the fabrication route assumed.',
      'Characterisation analyses with what the technique establishes stated separately from what is inferred.',
      'Process records complete enough for a repeat attempt by somebody else.',
      'An explicit statement of maturity: modelled, made once, or made repeatably.',
    ],
    evaluation: [
      'Whether the design accounts for real fabrication tolerance rather than ideal geometry.',
      'Whether characterisation claims are supported by the technique used.',
      'Repeatability: does the second sample behave like the first, and is that reported.',
      'Precision about maturity in every written claim.',
    ],
    keywords: ['Nanotechnology', 'Nanomaterials', 'Nanofabrication', 'Nanophotonics', '2D materials', 'Nanoelectronics', 'Quantum dots'],
    positions: [
      { title: 'Nano Engineering Intern', rung: 1, focus: 'One nanoscale design question modelled and written up with its fabrication tolerances.' },
      { title: 'Nanotechnology Research Intern', rung: 1, focus: 'A literature-grounded review of one nanomaterial class, separating what has been made repeatably from what has been made once.' },
      { title: 'Nanomaterials Intern', rung: 1, focus: 'Analysing characterisation data for a nanomaterial and stating what the data does and does not establish.' },
      { title: 'Nanofabrication Intern', rung: 1, classification: 'EXPERIMENTAL', focus: 'A fabrication route documented step by step, with its yield-limiting step identified.' },
      { title: 'Nanoelectronics Intern', rung: 1, focus: 'A nanoscale device modelled electrically, with the contact and interface effects included rather than idealised away.' },
      { title: 'Nanophotonics Intern', rung: 1, focus: 'An optical nanostructure simulated and its spectral response compared against an analytic limit.' },
      { title: 'Nano Sensor Intern', rung: 1, focus: 'A sensing mechanism modelled to its noise floor, with the limit of detection derived rather than asserted.' },
      { title: 'Nano Engineer', rung: 3, focus: 'Nanoscale designs taken from a target to something a partner facility could attempt.' },
      { title: 'Nanomaterials Engineer', rung: 3, classification: 'EXPERIMENTAL', focus: 'The materials themselves: what they are, how they are made, and whether the second batch matches the first.' },
      { title: 'Nanofabrication Engineer', rung: 3, classification: 'PROTOTYPE', focus: 'Process development with partner facilities, and the yield data that says whether a route is real.', extraSkills: ['Nanofabrication', 'Lithography', 'Process integration'] },
      { title: 'Nano Device Engineer', rung: 3, classification: 'PROTOTYPE', focus: 'Devices built from nanoscale structures, characterised against the specification they were designed to.' },
      { title: 'Nano Systems Engineer', rung: 4, scaleMinExp: -9, scaleMaxExp: -3, focus: 'How a nanoscale component behaves once it is part of something a person can hold.' },
      { title: 'Senior Nano Engineer', rung: 5, focus: 'Several nanoscale programmes at once, and the maturity claims made about all of them.' },
      { title: 'Principal Nano Engineer', rung: 7, focus: 'The division\'s technical direction and the hardest problems between design and repeatable fabrication.' },
      { title: 'Nano Engineering Lead', rung: 6, focus: 'What this division designs, who designs it, and the rule that maturity is stated in every claim.', featured: true },
    ],
  },

  // ===============================================================================================
  // DIVISION 06
  // ===============================================================================================
  {
    id: 'xse-d06-materials',
    code: 'D06',
    slug: 'materials-advanced-matter',
    name: 'Materials & Advanced Matter',
    summary: 'Materials discovery and modelling across alloys, ceramics, polymers, composites, metamaterials, quantum and energy materials, and materials for extreme environments.',
    charter: 'This division discovers and models materials, builds materials-property datasets, and develops materials for engineering use. Its computational predictions are handed on as candidates for experimental validation, and it reports which of its materials have been measured and which have only been computed.',
    classification: 'COMPUTATIONAL',
    scaleMinExp: -10,
    scaleMaxExp: 0,
    domains: [
      'Materials science', 'Advanced alloys', 'Ceramics', 'Polymers', 'Composites', 'Metamaterials',
      'Two-dimensional materials', 'Quantum materials', 'Energy materials', 'Smart materials',
      'Extreme-environment materials',
    ],
    skillCategories: ['MATERIALS', 'PHYSICS', 'CHEMISTRY', 'SCIENTIFIC_COMPUTING', 'ARTIFICIAL_INTELLIGENCE'],
    collaboratesWith: ['D04', 'D05', 'D07', 'D10', 'D11', 'D13', 'D14'],
    integrityNote:
      'A materials database entry computed by a high-throughput screen is a prediction, and screens are wrong at a rate that is measurable and should be reported. This division states, for every material it puts forward, whether the property was measured, computed, or inferred from a model trained on other materials. A predicted material is a candidate, not a discovery.',
    mustHave: [
      'Can relate a crystal structure to at least one measurable property and explain the mechanism.',
      'Reads a phase diagram and can say what happens on cooling through a boundary.',
      'Has analysed real characterisation data — diffraction, microscopy or mechanical testing — and stated its uncertainty.',
      'Python for data analysis over a materials dataset.',
      'Reports whether a property was measured or computed, every time.',
    ],
    shouldHave: [
      'Thermodynamics and kinetics of phase transformations.',
      'Experience with an electronic-structure or atomistic simulation package.',
      'Statistics sufficient to avoid over-reading a small sample.',
      'Familiarity with an open materials database and its known limitations.',
    ],
    niceToHave: [
      'Machine learning applied to materials property prediction, with a held-out test set.',
      'Hands-on mechanical testing or metallography.',
      'Experience with a high-throughput screening pipeline.',
    ],
    programming: ['Python', 'C++', 'Scientific computing'],
    tools: ['DFT packages', 'Pymatgen or an equivalent materials toolkit', 'Thermodynamic modelling software', 'Scikit-learn or PyTorch for property models', 'Data pipelines', 'Git'],
    mathematics: ['Linear algebra', 'Statistics', 'Numerical analysis', 'Optimisation', 'Differential equations'],
    physics: ['Condensed matter physics', 'Statistical mechanics', 'Thermodynamics', 'Classical mechanics'],
    chemistry: ['Physical chemistry', 'Electrochemistry', 'Surface chemistry'],
    whatTheyDo: [
      'Search for materials with a target property, computationally, and rank candidates with uncertainty.',
      'Model materials at the level the property requires: electronic, atomistic, or continuum.',
      'Build and curate materials-property datasets, with provenance recorded per entry.',
      'Develop materials toward an engineering application in another division, with the requirement stated first.',
      'Support experimental validation and report the cases where measurement disagreed with prediction.',
      'Relate structure to property to performance, and say where the chain of inference weakens.',
    ],
    deliverables: [
      'Candidate materials with computed properties, uncertainty, and the method used.',
      'Datasets with per-entry provenance: measured, computed, or model-inferred.',
      'Validation reports including disagreements between prediction and measurement.',
      'Structure-property-performance write-ups that name the weakest link in the chain.',
    ],
    evaluation: [
      'Whether provenance is recorded for every property.',
      'Whether the model was tested on held-out data rather than on what it was fitted to.',
      'Honesty about screening false-positive rates.',
      'Usefulness of the output to the engineering division that asked for it.',
    ],
    keywords: ['Materials science', 'Metamaterials', 'Composites', 'Quantum materials', 'Materials discovery', 'Characterisation'],
    positions: [
      { title: 'Materials Research Intern', rung: 1, focus: 'One structure-property relationship investigated computationally and checked against measured data.' },
      { title: 'Advanced Materials Intern', rung: 1, focus: 'A scoped review of one advanced-material class, separating measured properties from computed ones.' },
      { title: 'Materials Engineer', rung: 3, classification: 'APPLIED_ENGINEERING', focus: 'Materials selected and specified against an engineering requirement another division has stated.' },
      { title: 'Computational Materials Scientist', rung: 3, focus: 'The calculations: which level of theory, how convergence was tested, what the number is worth.' },
      { title: 'Materials Characterisation Engineer', rung: 3, classification: 'EXPERIMENTAL', focus: 'Turning characterisation runs into defensible property values with uncertainty.', extraSkills: ['X-ray diffraction analysis', 'Electron microscopy analysis', 'Mechanical testing'] },
      { title: 'Thin Film Engineer', rung: 3, classification: 'PROTOTYPE', scaleMinExp: -9, scaleMaxExp: -6, focus: 'Films: deposition conditions, film-substrate interfaces, and whether the properties survive the process.', extraSkills: ['Thin films'] },
      { title: '2D Materials Engineer', rung: 3, scaleMinExp: -10, scaleMaxExp: -7, focus: 'Two-dimensional materials, where the substrate and the edges determine most of what is measured.' },
      { title: 'Quantum Materials Scientist', rung: 4, scaleMinExp: -10, scaleMaxExp: -8, focus: 'Materials whose useful behaviour is quantum, and the calculations and measurements that establish it.' },
      { title: 'Senior Materials Scientist', rung: 5, focus: 'Several materials programmes at once, and the provenance discipline applied across them.' },
      { title: 'Principal Materials Engineer', rung: 7, focus: 'The division\'s technical direction, and the hardest problems between a computed candidate and a usable material.' },
      { title: 'Advanced Materials Lead', rung: 6, focus: 'What this division searches for, who searches, and the rule that a prediction is labelled a prediction.' },
    ],
  },

  // ===============================================================================================
  // DIVISION 07
  // ===============================================================================================
  {
    id: 'xse-d07-semiconductors',
    code: 'D07',
    slug: 'semiconductors-electronics-micro-nano-systems',
    name: 'Semiconductors, Electronics & Micro/Nano Systems',
    summary: 'Device physics, microelectronics and VLSI, MEMS and NEMS, sensors and photonics, in the band where design, simulation and prototype meet.',
    charter: 'This division designs devices, models electronic systems, develops sensors, analyses device performance, and supports prototype development with partner fabrication facilities. It is an engineering division: its work is judged against a specification.',
    classification: 'APPLIED_ENGINEERING',
    scaleMinExp: -6,
    scaleMaxExp: -3,
    domains: [
      'Semiconductor engineering', 'Device physics', 'Nanoelectronics', 'Microelectronics', 'VLSI',
      'MEMS', 'NEMS', 'Sensors', 'Photonics', 'Integrated systems',
    ],
    skillCategories: ['SEMICONDUCTORS', 'ELECTRONICS', 'PHYSICS', 'MATERIALS', 'SCIENTIFIC_COMPUTING'],
    collaboratesWith: ['D03', 'D05', 'D06', 'D08', 'D10', 'D12'],
    integrityNote:
      'Silicon is the most established engineering material there is, and a simulated device is still not a fabricated one. This division separates, in every report, what was simulated in TCAD or SPICE, what was measured on a fabricated part, and what a partner foundry has confirmed it can produce at yield.',
    mustHave: [
      'Can derive or explain the current-voltage characteristic of a diode or a MOSFET from device physics.',
      'Has simulated a circuit in SPICE and compared the result against a hand calculation.',
      'Semiconductor physics: carriers, doping, band structure, junctions.',
      'Can read a datasheet and identify the conditions a specification was measured under.',
      'Documents a design against a written specification rather than against intent.',
    ],
    shouldHave: [
      'Digital or analog design experience beyond coursework.',
      'Familiarity with a microfabrication process flow and its constraints.',
      'Signal processing sufficient to characterise a sensor\'s noise.',
      'Version-controlled design files and a change record.',
    ],
    niceToHave: [
      'RTL and a simulation or synthesis flow.',
      'MEMS design or characterisation experience.',
      'Photonic integrated circuit design.',
      'Cleanroom or test-laboratory experience.',
    ],
    programming: ['Python', 'C++', 'Verilog or VHDL', 'MATLAB or an equivalent'],
    tools: ['SPICE', 'TCAD device simulation', 'FEM multiphysics for MEMS', 'RTL simulation and synthesis tooling', 'PCB design tools', 'Laboratory instrumentation and automation', 'Git'],
    mathematics: ['Linear algebra', 'Differential equations', 'Partial differential equations', 'Probability', 'Statistics', 'Numerical analysis'],
    physics: ['Condensed matter physics', 'Electromagnetism', 'Quantum mechanics', 'Optics and photonics', 'Thermodynamics'],
    whatTheyDo: [
      'Design devices against a written specification with margins stated.',
      'Model electronic and electromechanical systems, including the parasitics that decide whether they work.',
      'Develop sensors and derive their limit of detection rather than asserting it.',
      'Analyse device performance against specification and report where it falls short.',
      'Support prototype fabrication with partner facilities and record what the process actually did.',
      'Maintain design files and change records so a revision can be traced.',
    ],
    deliverables: [
      'Designs with a written specification, margins, and the simulation evidence behind them.',
      'Test reports comparing measured behaviour with simulated behaviour.',
      'Process notes from partner fabrication, including deviations.',
      'A maturity statement per design: simulated, prototyped, or confirmed at yield.',
    ],
    evaluation: [
      'Whether the design meets its written specification with margin.',
      'Whether simulation was validated against measurement where a part exists.',
      'Traceability of design revisions.',
      'Precision about simulated versus fabricated in every claim.',
    ],
    keywords: ['Semiconductors', 'VLSI', 'MEMS', 'Device physics', 'Sensors', 'Photonics', 'Microelectronics'],
    positions: [
      { title: 'Semiconductor Intern', rung: 1, focus: 'One device characteristic derived, simulated, and compared against published measurements.' },
      { title: 'Electronics Intern', rung: 1, focus: 'A circuit designed to a written specification, simulated, and checked by hand calculation.' },
      { title: 'VLSI Intern', rung: 1, focus: 'A small digital block written in RTL, simulated, and verified against a testbench you wrote.' },
      { title: 'MEMS Intern', rung: 1, focus: 'A micromechanical structure modelled in FEM, with its resonance compared against an analytic estimate.' },
      { title: 'Semiconductor Engineer', rung: 3, focus: 'Device design and TCAD modelling against a specification, including process variation.' },
      { title: 'Device Engineer', rung: 3, focus: 'The device as built: characterisation, failure analysis, and why measured differs from simulated.' },
      { title: 'Nanoelectronics Engineer', rung: 3, scaleMinExp: -9, scaleMaxExp: -6, focus: 'Electronics at the scale where interfaces and contacts dominate the electrical behaviour.' },
      { title: 'MEMS/NEMS Engineer', rung: 3, classification: 'PROTOTYPE', scaleMinExp: -9, scaleMaxExp: -3, focus: 'Micro and nanoelectromechanical structures, from multiphysics model to a characterised part.' },
      { title: 'Process Engineer', rung: 3, classification: 'PROTOTYPE', focus: 'The fabrication flow with partner facilities: integration, variation, and yield-limiting steps.', extraSkills: ['Process integration', 'Yield analysis'] },
      { title: 'Photonics Engineer', rung: 3, focus: 'Optical and photonic components, designed and characterised against an optical budget.', extraSkills: ['Optics and photonics', 'Photonic integrated circuits'] },
      { title: 'Senior Semiconductor Engineer', rung: 5, focus: 'Several device programmes at once, and the specification discipline applied across them.' },
      { title: 'Principal Device Engineer', rung: 7, focus: 'The division\'s technical direction and the hardest problems between a model and a manufacturable part.' },
      { title: 'Semiconductor Systems Lead', rung: 6, focus: 'What this division builds, who builds it, and the rule that simulated and fabricated are never conflated.' },
    ],
  },

  // ===============================================================================================
  // DIVISION 08
  // ===============================================================================================
  {
    id: 'xse-d08-computing',
    code: 'D08',
    slug: 'computer-science-ai-scientific-computing',
    name: 'Computer Science, AI & Scientific Computing',
    summary: 'The cross-department division: research software, simulation platforms, HPC, AI for science, digital twins, data pipelines and the reproducibility every other division depends on.',
    charter: 'This division exists to serve all the others. It builds the research software, makes simulations run at the sizes the science needs, develops AI models for scientific problems with honest baselines, and holds the line on reproducibility and code quality across the whole department.',
    classification: 'APPLIED_ENGINEERING',
    scaleMinExp: -100,
    scaleMaxExp: 100,
    domains: [
      'Scientific computing', 'Research software engineering', 'High-performance computing',
      'Simulation platforms', 'AI for science', 'Physics-informed machine learning',
      'Digital twins', 'Scientific data pipelines', 'Reproducible computing',
    ],
    skillCategories: ['COMPUTER_SCIENCE', 'SCIENTIFIC_COMPUTING', 'ARTIFICIAL_INTELLIGENCE', 'MATHEMATICS'],
    collaboratesWith: ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D09', 'D10', 'D11', 'D12', 'D13', 'D14', 'D15'],
    integrityNote:
      'A model that fits is not a model that predicts. Work from this division reports a held-out result and a competent classical or numerical baseline alongside every machine-learning claim, and states the domain a surrogate is valid over. A digital twin is a model of a system, not the system, and is described that way.',
    mustHave: [
      'Fluent in Python, and able to write code somebody else can read, test and extend.',
      'Data structures and algorithms to the level of choosing correctly and justifying the choice.',
      'Comfortable on Linux, and with Git as a working tool rather than a save button.',
      'Has written tests for numerical code and can explain what a tolerance in a test means.',
      'Numerical methods: can state the error behaviour of a scheme they have implemented.',
      'Reports a baseline alongside every model result.',
    ],
    shouldHave: [
      'C++ or Julia for the parts where Python is not enough.',
      'Parallel computing: MPI, OpenMP, or GPU work, with a measured speed-up rather than an assumed one.',
      'PyTorch or JAX, used on a problem with a real held-out evaluation.',
      'Containerised, reproducible environments.',
      'Profiling: has found and fixed a real bottleneck and can say by how much.',
    ],
    niceToHave: [
      'CUDA or another GPU programming model at kernel level.',
      'Distributed systems or workflow engines at scale.',
      'Experience contributing to an open scientific software package.',
      'Physics-informed or geometry-aware model architectures.',
    ],
    programming: ['Python', 'C++', 'Julia', 'Bash'],
    tools: ['Linux', 'Git', 'MPI and OpenMP', 'CUDA', 'PyTorch or JAX', 'HPC schedulers', 'Containers', 'CI pipelines', 'Profilers'],
    mathematics: ['Numerical analysis', 'Linear algebra', 'Probability', 'Statistics', 'Optimisation', 'Differential equations'],
    whatTheyDo: [
      'Build research software that other divisions depend on, to a standard that survives being handed over.',
      'Build and maintain simulation platforms, and make them run at the size the science actually needs.',
      'Optimise scientific workloads with a measured before-and-after, never an asserted one.',
      'Develop AI models for scientific problems, always reported against a competent baseline.',
      'Build digital twins, and state plainly what each one does and does not represent.',
      'Create data pipelines with provenance, so a number can be traced to the run that produced it.',
      'Hold the reproducibility standard: seeds, environments, and a result that comes back the same.',
      'Maintain code quality and testing across the department, including in other divisions\' repositories.',
    ],
    deliverables: [
      'Software with tests, a recorded environment, and documentation another division can act on.',
      'Performance work reported as a measured speed-up with the machine and problem size stated.',
      'Models reported with held-out metrics and a baseline, never with training metrics alone.',
      'Pipelines whose outputs carry provenance back to the run and the code version.',
    ],
    evaluation: [
      'Does somebody else\'s checkout produce the same result.',
      'Is the baseline present, competent, and honestly reported.',
      'Is the performance claim measured rather than asserted.',
      'Would the code survive its author leaving.',
    ],
    keywords: ['Scientific computing', 'HPC', 'AI for science', 'Research software', 'Digital twins', 'Reproducibility', 'Simulation'],
    positions: [
      { title: 'Scientific Computing Intern', rung: 1, focus: 'One numerical method implemented, tested against an analytic case, and profiled.' },
      { title: 'Research Software Intern', rung: 1, focus: 'Taking a working research script and turning it into a tested, documented package somebody else can install.' },
      { title: 'HPC Intern', rung: 1, focus: 'Parallelising one real workload and reporting the measured speed-up and where it stopped scaling.' },
      { title: 'AI for Science Intern', rung: 1, classification: 'COMPUTATIONAL', focus: 'A scientific prediction task with a proper held-out split and a classical baseline reported beside the model.' },
      { title: 'Computational Engineer', rung: 3, classification: 'COMPUTATIONAL', focus: 'The computation another division needs, made correct, fast enough, and reproducible.' },
      { title: 'Scientific Software Engineer', rung: 3, focus: 'Research software built to survive handover: tested, documented, and maintained.' },
      { title: 'HPC Engineer', rung: 3, focus: 'Making the department\'s workloads run at scale, with measured scaling curves rather than claims.', extraSkills: ['MPI', 'OpenMP', 'HPC scheduling'] },
      { title: 'Simulation Engineer', rung: 3, classification: 'SIMULATION', focus: 'Simulation platforms: solvers, verification, and the convergence evidence behind every run.' },
      { title: 'Research ML Engineer', rung: 3, classification: 'COMPUTATIONAL', focus: 'Machine learning on scientific data, with the evaluation designed before the model is chosen.', extraSkills: ['Machine learning', 'PyTorch'] },
      { title: 'AI for Materials Engineer', rung: 4, classification: 'COMPUTATIONAL', scaleMinExp: -10, scaleMaxExp: -6, focus: 'Property prediction and screening for the materials divisions, with false-positive rates reported.' },
      { title: 'Physics-Informed AI Engineer', rung: 4, classification: 'COMPUTATIONAL', focus: 'Models that carry the physics as a constraint, and the honest account of when that helps and when it does not.', extraSkills: ['Physics-informed neural networks'] },
      { title: 'Digital Twin Engineer', rung: 4, classification: 'SIMULATION', scaleMinExp: -3, scaleMaxExp: 6, focus: 'Twins of real systems, with a written statement of what each one represents and where it stops being valid.' },
      { title: 'Senior Scientific Computing Engineer', rung: 5, focus: 'Several divisions\' computational needs at once, and the engineering standard applied across them.' },
      { title: 'Principal AI for Science Engineer', rung: 7, focus: 'How the department applies machine learning to science, and the evidence standard that applies to all of it.' },
      { title: 'Scientific AI Lead', rung: 6, focus: 'What this division builds for the others, who builds it, and the rule that no model ships without its baseline.', featured: true },
    ],
  },
];

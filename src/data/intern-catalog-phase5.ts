// src/data/intern-catalog-phase5.ts — Phase 5: consulting & advisory, international business,
// science & advanced engineering, and creative/media writing.
// Cross-checked against every existing title across role-catalog.ts, intern-catalog.ts, and
// intern-catalog-phase2/3/4.ts. Skipped as already present: Business Transformation, Business
// Excellence, Corporate Strategy, Business Strategy, Strategic Planning, Competitive
// Intelligence, Market Intelligence, Public Sector Consulting, Global Partnerships, Supply
// Chain, Logistics, Procurement, Scientific Computing, Scientific Research, Renewable Energy,
// Technical Writing, Content Writing, Copywriting, Podcast Production, Journalism.
import type { CatalogRole } from './role-catalog';
import { locationLabel } from '@/lib/work-mode';

// Work mode is decided by the one policy module, not by a per-file constant: eleven copies of
// 'Remote / Hybrid (India)' is how every advertised role came to claim remote work. Internships
// and apprenticeships may be on site or hybrid; nothing here is remote.
const TRAINEE_LOCATION = locationLabel('hybrid');

const STANDARD_TERMS = {
  internshipMode: 'Full-Time' as const,
  workingDaysPerWeek: 6,
  hoursPerWeek: 40,
  projectHoursPerDay: 5,
  wellbeingHoursPerDay: 1.67,
  engagementNotes: [
    'Interns are expected to maintain professionalism, creativity, confidentiality, and timely completion of assigned responsibilities.',
    'Weekly mentor reviews and evaluations will be conducted.',
    'Compliance with organizational policies, intellectual property guidelines, and ethical standards is mandatory.',
    'Internship Certificate will be awarded upon successful completion of internship requirements.',
    'Internship does not constitute an offer of employment.',
  ],
};

const STANDARD_PERKS = [
  'Internship Certificate',
  'Letter of Recommendation (Performance Based)',
  'Mentorship from experienced professionals in the field',
  'Exposure to real product, research, and operational work — not simulated exercises',
  'Skill Development Workshops',
  'Outstanding performers may be considered for extended internships, leadership opportunities, or future full-time roles based on organizational requirements.',
];

const ABOUT_INTRO = 'EduRankAI is developing next-generation technologies in Artificial Intelligence, Education Technology, Research, Product Engineering, and Digital Innovation.';

function role(r: {
  slug: string; departmentId: string; title: string; duration?: string; noOfInterns: number;
  about: string; responsibilities: string[]; skills: string[]; learningOutcomes: string[];
  qualificationType: string; qualifications: string[]; specialisations: string[]; keywords: string[];
  eligibilityExtra?: string[]; perksExtra?: string[]; salary?: string;
}): CatalogRole {
  return {
    slug: r.slug,
    departmentId: r.departmentId,
    title: r.title,
    level: 'Intern',
    function: r.about.split('.')[0] + '.',
    engagementType: 'Internship',
    location: TRAINEE_LOCATION,
    duration: r.duration || '3 Months',
    salary: r.salary || 'Unpaid — internship certificate, mentorship, and real project experience',
    about: ABOUT_INTRO + ' ' + r.about,
    responsibilities: r.responsibilities,
    skills: r.skills,
    eligibility: [
      'Students pursuing undergraduate or postgraduate programs from any discipline are encouraged to apply; students from the disciplines listed under Specialisation are especially encouraged.',
      'Available for a full-time, 6-day-per-week internship for the stated duration.',
      ...(r.eligibilityExtra || []),
    ],
    learningOutcomes: r.learningOutcomes,
    qualificationType: r.qualificationType,
    qualifications: r.qualifications,
    specialisations: r.specialisations,
    noOfInterns: r.noOfInterns,
    keywords: r.keywords,
    perks: [...STANDARD_PERKS, ...(r.perksExtra || [])],
    ...STANDARD_TERMS,
  };
}

const UGPG = 'UG / PG';
const STD_QUALIFICATIONS = ["Any Bachelor's Degree", "Any Master's Degree", 'Diploma', 'Integrated Degree'];
const MGMT_QUALIFICATIONS = ['BBA/B.Com', 'MBA/PGDM', "Any Bachelor's Degree", 'Any Relevant Degree'];
const SCI_QUALIFICATIONS = ['B.Sc./M.Sc.', 'B.Tech/B.E.', 'Integrated Degree', 'Any Relevant Degree'];

// =====================================================================================
// CONSULTING & ADVISORY — skipped as already present: Public Sector Consulting, Solutions
// Consulting, Business Transformation, Business Excellence, Process Excellence.
// =====================================================================================
const CONSULTING: CatalogRole[] = [
  role({
    slug: 'management-consulting-intern', departmentId: 'consulting-advisory', title: 'Management Consulting Intern', noOfInterns: 3,
    about: 'Structured problem-solving as a discipline — framing an ambiguous business question, gathering evidence, and reaching a defensible recommendation.',
    responsibilities: ['Structure ambiguous problems into analysable components.', 'Conduct research and analysis to test hypotheses.', 'Build recommendation decks with clear logic chains.', 'Document assumptions, evidence, and confidence honestly.', 'Present findings to internal stakeholders.'],
    skills: ['Problem structuring (issue trees, MECE)', 'Hypothesis-driven analysis', 'Deck building', 'Structured writing', 'Presentation'],
    learningOutcomes: ['Structured Problem Framing', 'Hypothesis-Driven Analysis', 'Recommendation Deck Development', 'Executive Presentation Practice'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Economics', 'Engineering', 'Any Relevant Discipline'],
    keywords: ['Management Consulting', 'Business Consulting', 'Problem Solving', 'Strategy'],
  }),
  role({
    slug: 'strategy-consulting-intern', departmentId: 'consulting-advisory', title: 'Strategy Consulting Intern', noOfInterns: 2,
    about: 'Consulting on strategic questions specifically — market entry, positioning, and long-horizon choices where the answer is genuinely uncertain.',
    responsibilities: ['Support strategic diagnostics and market analysis.', 'Build option frameworks with explicit trade-offs.', 'Research industry structures and comparable strategic moves.', 'Document strategic reasoning and counter-arguments.', 'Present strategic recommendations to stakeholders.'],
    skills: ['Strategy frameworks', 'Market analysis', 'Options framing', 'Structured writing', 'Presentation'],
    learningOutcomes: ['Strategic Diagnostics', 'Option Framework Development', 'Industry Structure Analysis', 'Strategic Recommendation Practice'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Economics', 'Any Relevant Discipline'],
    keywords: ['Strategy Consulting', 'Strategic Advisory', 'Management Consulting', 'Strategy'],
  }),
  role({
    slug: 'technology-consulting-intern', departmentId: 'consulting-advisory', title: 'Technology Consulting Intern', noOfInterns: 3,
    about: 'Advising on technology choices — architecture direction, platform selection, and modernisation paths — where technical depth meets business constraint.',
    responsibilities: ['Support technology assessment and platform-selection analysis.', 'Research modernisation approaches and migration patterns.', 'Assist in building technology recommendation material.', 'Document technical trade-offs honestly, including costs.', 'Present technology recommendations to stakeholders.'],
    skills: ['Technology assessment', 'Architecture literacy', 'Trade-off analysis', 'Technical writing', 'Presentation'],
    learningOutcomes: ['Technology Assessment & Selection', 'Modernisation Path Research', 'Technical Trade-Off Analysis', 'Technology Advisory Practice'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Information Technology', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Technology Consulting', 'IT Consulting', 'Technology Advisory', 'Consulting'],
  }),
  role({
    slug: 'operations-consulting-intern', departmentId: 'consulting-advisory', title: 'Operations Consulting Intern', noOfInterns: 2,
    about: 'Consulting on how work actually gets done — process, cost, and capacity diagnostics that produce measurable operational change.',
    responsibilities: ['Support operational diagnostics and process analysis.', 'Assist in cost and capacity modelling.', 'Research operational benchmarks for comparable organisations.', 'Document improvement recommendations with expected impact.', 'Present operational findings to stakeholders.'],
    skills: ['Operational diagnostics', 'Process analysis', 'Cost/capacity modelling', 'Documentation', 'Presentation'],
    learningOutcomes: ['Operational Diagnostics', 'Cost & Capacity Modelling', 'Operational Benchmarking', 'Impact-Quantified Recommendations'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Industrial Engineering', 'Business Administration', 'Operations Management', 'Any Relevant Discipline'],
    keywords: ['Operations Consulting', 'Operational Excellence', 'Process Consulting', 'Consulting'],
  }),
  role({
    slug: 'digital-transformation-intern', departmentId: 'consulting-advisory', title: 'Digital Transformation Intern', noOfInterns: 3,
    about: 'The digital dimension of organisational change — where technology, process, and adoption have to move together or the programme fails.',
    responsibilities: ['Research digital-transformation frameworks and case studies.', 'Support current-state digital-maturity assessment.', 'Assist in building transformation roadmaps.', 'Document adoption risks and change requirements.', 'Present transformation findings to stakeholders.'],
    skills: ['Digital transformation frameworks', 'Maturity assessment', 'Roadmap development', 'Documentation', 'Communication'],
    learningOutcomes: ['Digital Transformation Frameworks', 'Digital Maturity Assessment', 'Transformation Roadmap Development', 'Adoption Risk Analysis'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Digital Transformation', 'Transformation', 'Change Management', 'Consulting'],
  }),
];

// =====================================================================================
// INTERNATIONAL BUSINESS — skipped as already present: Global Partnerships, Bilateral
// Partnerships, Multilateral Partnerships, International Relations, Global Operations.
// =====================================================================================
const INTERNATIONAL_BUSINESS: CatalogRole[] = [
  role({
    slug: 'global-business-intern', departmentId: 'international-business', title: 'Global Business Intern', noOfInterns: 2,
    about: 'The commercial side of operating internationally — market attractiveness, entry economics, and how business models travel across borders.',
    responsibilities: ['Research international market attractiveness and entry economics.', 'Support comparative analysis of business models across markets.', 'Assist in documenting country-level commercial considerations.', 'Document findings and market recommendations.', 'Present analysis to the partnerships and leadership teams.'],
    skills: ['International market research', 'Comparative business analysis', 'Documentation', 'Cross-cultural awareness', 'Presentation'],
    learningOutcomes: ['International Market Attractiveness Analysis', 'Cross-Border Business Model Comparison', 'Country Commercial Assessment', 'Market Recommendation Writing'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['International Business', 'Business Administration', 'Economics', 'Any Relevant Discipline'],
    keywords: ['Global Business', 'International Business', 'Market Entry', 'Global Strategy'],
  }),
  role({
    slug: 'international-expansion-intern', departmentId: 'international-business', title: 'International Expansion Intern', noOfInterns: 2,
    about: 'The mechanics of entering a new country — entity structures, regulatory prerequisites, localisation, and sequencing an expansion realistically.',
    responsibilities: ['Research entry requirements for target countries (regulatory, entity, tax basics).', 'Support expansion-readiness checklists and sequencing plans.', 'Assist in localisation-requirement research.', 'Document expansion plans, risks, and dependencies.', 'Present expansion analysis to leadership.'],
    skills: ['Expansion research', 'Regulatory research', 'Planning and sequencing', 'Documentation', 'Analytical thinking'],
    learningOutcomes: ['Country Entry Requirement Research', 'Expansion Readiness Planning', 'Localisation Requirement Analysis', 'Expansion Risk Documentation'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['International Business', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['International Expansion', 'Market Entry', 'Global Expansion', 'International Business'],
  }),
  role({
    slug: 'export-operations-intern', departmentId: 'international-business', title: 'Export Operations Intern', noOfInterns: 2,
    about: 'The operational and documentary discipline of exporting — compliance, documentation, and cross-border operational requirements.',
    responsibilities: ['Research export documentation and compliance requirements.', 'Support documentation of export process flows.', 'Assist in evaluating export-facilitation schemes.', 'Document export operational checklists.', 'Support coordination on cross-border operational queries.'],
    skills: ['Export documentation literacy', 'Trade compliance basics', 'Process documentation', 'Attention to detail', 'Coordination'],
    learningOutcomes: ['Export Documentation & Compliance', 'Export Process Flow Documentation', 'Export Facilitation Scheme Research', 'Cross-Border Operational Practice'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['International Business', 'Commerce', 'Any Relevant Discipline'],
    keywords: ['Export Operations', 'Trade Compliance', 'International Trade', 'International Business'],
  }),
  role({
    slug: 'cross-border-business-intern', departmentId: 'international-business', title: 'Cross-Border Business Intern', noOfInterns: 2,
    about: 'The friction points that only appear across borders — payments, data transfer, tax treatment, and contracting across jurisdictions.',
    responsibilities: ['Research cross-border payment, data-transfer, and contracting considerations.', 'Support documentation of jurisdiction-specific constraints.', 'Assist in analysing cross-border operating models.', 'Document findings for the legal, finance, and partnerships teams.', 'Present analysis to relevant stakeholders.'],
    skills: ['Cross-border research', 'Regulatory literacy', 'Documentation', 'Analytical thinking', 'Cross-team coordination'],
    learningOutcomes: ['Cross-Border Payment & Data Research', 'Jurisdictional Constraint Documentation', 'Cross-Border Operating Model Analysis', 'Multi-Team Coordination'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['International Business', 'Law', 'Commerce', 'Any Relevant Discipline'],
    keywords: ['Cross-Border Business', 'International Operations', 'Cross-Border Compliance', 'International Business'],
  }),
];

// =====================================================================================
// SCIENCE & ADVANCED ENGINEERING — skipped as already present: Scientific Computing,
// Scientific Research, Bioinformatics, Biomedical Research, Renewable Energy, Semiconductor
// Research, Chemical Engineering, R&D.
// =====================================================================================
const SCIENCE_ADVANCED: CatalogRole[] = [
  role({
    slug: 'computational-physics-intern', departmentId: 'science-advanced', title: 'Computational Physics Intern', noOfInterns: 2,
    about: 'Physics done through computation — numerical methods, simulation, and modelling physical systems that are analytically intractable.',
    responsibilities: ['Implement and run numerical simulations of physical systems.', 'Support validation of simulation results against known solutions.', 'Research computational-physics methods and libraries.', 'Document simulation methodology and numerical limitations.', 'Present findings to the research team.'],
    skills: ['Python/C++', 'Numerical methods', 'Physics fundamentals', 'Simulation validation', 'Documentation'],
    learningOutcomes: ['Numerical Simulation of Physical Systems', 'Simulation Validation Practice', 'Computational Physics Methods', 'Numerical Limitation Documentation'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Physics', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Computational Physics', 'Numerical Simulation', 'Scientific Computing', 'Physics'],
  }),
  role({
    slug: 'computational-chemistry-intern', departmentId: 'science-advanced', title: 'Computational Chemistry Intern', noOfInterns: 2,
    about: 'Chemistry simulated rather than synthesised — molecular modelling, property prediction, and computational screening.',
    responsibilities: ['Support molecular modelling and property-prediction exercises.', 'Assist in computational screening workflows.', 'Research computational-chemistry methods and toolchains.', 'Document methodology and accuracy limitations.', 'Present findings to the research team.'],
    skills: ['Python', 'Molecular modelling tools', 'Chemistry fundamentals', 'Data analysis', 'Documentation'],
    learningOutcomes: ['Molecular Modelling Practice', 'Computational Property Prediction', 'Computational Screening Workflows', 'Accuracy Limitation Reporting'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Chemistry', 'Chemical Engineering', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Computational Chemistry', 'Molecular Modelling', 'Cheminformatics', 'Chemistry'],
  }),
  role({
    slug: 'computational-biology-intern', departmentId: 'science-advanced', title: 'Computational Biology Intern', noOfInterns: 2,
    about: 'Biology as a computational science — modelling biological systems and processes, broader than the sequence-analysis focus of bioinformatics.',
    responsibilities: ['Support computational modelling of biological systems.', 'Assist in analysing biological datasets with statistical methods.', 'Research computational-biology methods and tools.', 'Document methodology and biological interpretation limits.', 'Present findings to the research team.'],
    skills: ['Python/R', 'Statistical modelling', 'Biology fundamentals', 'Data analysis', 'Documentation'],
    learningOutcomes: ['Biological System Modelling', 'Biological Dataset Analysis', 'Computational Biology Methods', 'Interpretation Limit Documentation'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Biology', 'Biotechnology', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Computational Biology', 'Systems Biology', 'Biological Modelling', 'Life Sciences'],
  }),
  role({
    slug: 'materials-informatics-intern', departmentId: 'science-advanced', title: 'Materials Informatics Intern', noOfInterns: 2,
    about: 'Data-driven materials discovery — applying machine learning to materials property data to narrow the search space before experiment.',
    responsibilities: ['Support building ML models on materials property datasets.', 'Assist in feature engineering for materials descriptors.', 'Research materials-informatics methods and open databases.', 'Document model performance and applicability domain honestly.', 'Present findings to the research team.'],
    skills: ['Python (scikit-learn)', 'Materials science fundamentals', 'Feature engineering', 'Data analysis', 'Documentation'],
    learningOutcomes: ['Materials Property ML Modelling', 'Materials Descriptor Engineering', 'Materials Database Research', 'Applicability Domain Reporting'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Materials Science', 'Metallurgical Engineering', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Materials Informatics', 'Materials Discovery', 'Machine Learning', 'Materials Science'],
  }),
  role({
    slug: 'nanotechnology-intern', departmentId: 'science-advanced', title: 'Nanotechnology Intern', noOfInterns: 2,
    about: 'Science and engineering at the nanoscale — where material behaviour changes and new device possibilities open up.',
    responsibilities: ['Research nanotechnology applications and fabrication approaches.', 'Support literature review on nanoscale material behaviour.', 'Assist in documenting nanotechnology case studies.', 'Document findings for the research team.', 'Present research summaries.'],
    skills: ['Nanotechnology fundamentals', 'Literature review', 'Documentation', 'Analytical thinking', 'Communication'],
    learningOutcomes: ['Nanotechnology Application Research', 'Nanoscale Material Behaviour Review', 'Nanofabrication Approach Research', 'Scientific Documentation'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Physics', 'Materials Science', 'Nanotechnology', 'Any Relevant Discipline'],
    keywords: ['Nanotechnology', 'Nanoscience', 'Nanomaterials', 'Advanced Materials'],
  }),
  role({
    slug: 'biotechnology-intern', departmentId: 'science-advanced', title: 'Biotechnology Intern', noOfInterns: 2,
    about: 'Biotechnology as an applied field — how biological systems get engineered into products and processes across health, agriculture, and industry.',
    responsibilities: ['Research biotechnology applications across sectors.', 'Support literature review on biotech process technologies.', 'Assist in documenting biotechnology case studies.', 'Document findings for the research team.', 'Present research summaries.'],
    skills: ['Biotechnology fundamentals', 'Literature review', 'Documentation', 'Analytical thinking', 'Communication'],
    learningOutcomes: ['Biotechnology Application Research', 'Biotech Process Technology Review', 'Biotech Case-Study Documentation', 'Scientific Communication'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Biotechnology', 'Biology', 'Biochemical Engineering', 'Any Relevant Discipline'],
    keywords: ['Biotechnology', 'Bioprocess', 'Applied Biology', 'Life Sciences'],
  }),
  role({
    slug: 'synthetic-biology-intern', departmentId: 'science-advanced', title: 'Synthetic Biology Intern', noOfInterns: 2,
    about: 'Engineering biology deliberately — designed genetic circuits and standardised biological parts, distinct from classical biotechnology.',
    responsibilities: ['Research synthetic-biology design principles and genetic-circuit models.', 'Support literature review on standardised biological parts.', 'Assist in documenting synthetic-biology case studies and biosafety considerations.', 'Document findings for the research team.', 'Present research summaries.'],
    skills: ['Synthetic biology fundamentals', 'Literature review', 'Biosafety awareness', 'Documentation', 'Analytical thinking'],
    learningOutcomes: ['Synthetic Biology Design Principles', 'Genetic Circuit Model Research', 'Standardised Biological Parts', 'Biosafety Consideration Documentation'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Biotechnology', 'Biology', 'Bioengineering', 'Any Relevant Discipline'],
    keywords: ['Synthetic Biology', 'Genetic Engineering', 'Bioengineering', 'Life Sciences'],
    eligibilityExtra: ['This is a literature-and-computational research role. It involves no wet-lab work and no handling of biological materials.'],
  }),
  role({
    slug: 'neuroscience-ai-intern', departmentId: 'science-advanced', title: 'Neuroscience AI Intern', noOfInterns: 2,
    about: 'The two-way traffic between neuroscience and AI — brain-inspired computation, and what learning research tells us about how people actually learn.',
    responsibilities: ['Research brain-inspired computational models.', 'Support literature review on learning and memory research relevant to our tutoring systems.', 'Assist in documenting neuroscience findings applicable to education technology.', 'Document findings with honest caveats about generalisation.', 'Present research summaries to the AI research team.'],
    skills: ['Neuroscience fundamentals', 'Machine learning fundamentals', 'Literature review', 'Documentation', 'Analytical writing'],
    learningOutcomes: ['Brain-Inspired Computational Models', 'Learning & Memory Research Review', 'Neuroscience-to-EdTech Translation', 'Honest Generalisation Caveats'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Neuroscience', 'Psychology', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Neuroscience AI', 'Computational Neuroscience', 'Brain-Inspired Computing', 'Cognitive Science'],
  }),
  role({
    slug: 'energy-systems-intern', departmentId: 'science-advanced', title: 'Energy Systems Intern', noOfInterns: 2,
    about: 'Energy at a systems level — generation mix, grids, storage, and demand, analysed as one interconnected system.',
    responsibilities: ['Research energy-system architectures and grid models.', 'Support analysis of energy-mix and storage scenarios.', 'Assist in documenting energy-systems case studies.', 'Document findings and modelling assumptions.', 'Present findings to the research team.'],
    skills: ['Energy systems fundamentals', 'Scenario modelling', 'Data analysis', 'Documentation', 'Systems thinking'],
    learningOutcomes: ['Energy System Architecture Research', 'Energy Mix & Storage Scenario Analysis', 'Grid Model Fundamentals', 'Energy Modelling Documentation'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Electrical Engineering', 'Energy Engineering', 'Physics', 'Any Relevant Discipline'],
    keywords: ['Energy Systems', 'Grid Systems', 'Energy Storage', 'Energy Engineering'],
  }),
  role({
    slug: 'fusion-energy-research-intern', departmentId: 'science-advanced', title: 'Fusion Energy Research Intern', noOfInterns: 2,
    about: 'The long-horizon energy question — plasma physics, confinement approaches, and an honest read of where fusion research actually stands.',
    responsibilities: ['Research fusion confinement approaches and plasma-physics fundamentals.', 'Support literature review on fusion research programmes worldwide.', 'Assist in documenting technical milestones and honest timelines.', 'Document findings without overstating readiness.', 'Present research summaries to the research team.'],
    skills: ['Plasma physics fundamentals', 'Literature review', 'Technical writing', 'Documentation', 'Critical evaluation'],
    learningOutcomes: ['Fusion Confinement Approach Research', 'Plasma Physics Fundamentals', 'Global Fusion Programme Review', 'Honest Technology Readiness Reporting'],
    qualificationType: UGPG, qualifications: SCI_QUALIFICATIONS,
    specialisations: ['Physics', 'Nuclear Engineering', 'Any Relevant Discipline'],
    keywords: ['Fusion Energy', 'Plasma Physics', 'Nuclear Fusion', 'Energy Research'],
  }),
];

// =====================================================================================
// CREATIVE & EDITORIAL — skipped as already present: Technical Writing, Content Writing,
// Copywriting, Content Marketing, Journalism, Podcast Production, Creative Strategy,
// Multimedia Production, Documentation Management, Knowledge Management (built in Phase 4).
// =====================================================================================
const CREATIVE_EDITORIAL: CatalogRole[] = [
  role({
    slug: 'scientific-writer-intern', departmentId: 'media-communications', title: 'Scientific Writer Intern', noOfInterns: 2,
    about: 'Writing about science accurately for non-specialists — the hardest kind of clarity, and central to how we explain our research honestly.',
    responsibilities: ['Write accessible explanations of scientific and technical research.', 'Support fact-checking and source verification for science content.', 'Research science-communication best practices.', 'Document sources and confidence levels in all claims.', 'Collaborate with researchers on accuracy review.'],
    skills: ['Science writing', 'Fact-checking', 'Source verification', 'Scientific literacy', 'Editing'],
    learningOutcomes: ['Accessible Science Writing', 'Scientific Fact-Checking', 'Science Communication Practice', 'Source-Backed Claim Discipline'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Science', 'English', 'Communications', 'Any Relevant Discipline'],
    keywords: ['Scientific Writing', 'Science Communication', 'Technical Writing', 'Research Writing'],
  }),
  role({
    slug: 'ux-writer-intern', departmentId: 'design', title: 'UX Writer Intern', noOfInterns: 2,
    about: 'The words inside the product — labels, empty states, and error messages that do real work in reducing confusion.',
    responsibilities: ['Write and refine in-product copy (labels, states, errors, guidance).', 'Support development of a product voice-and-tone guide.', 'Research UX-writing patterns and microcopy standards.', 'Document copy decisions and rationale.', 'Collaborate with design and engineering on copy implementation.'],
    skills: ['UX writing', 'Microcopy craft', 'Voice and tone', 'Documentation', 'Design collaboration'],
    learningOutcomes: ['In-Product Copywriting', 'Voice & Tone Guide Development', 'Microcopy Pattern Research', 'Copy Rationale Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['English', 'Design', 'Communications', 'Any Relevant Discipline'],
    keywords: ['UX Writing', 'Microcopy', 'Content Design', 'Product Writing'],
  }),
  role({
    slug: 'content-strategist-intern', departmentId: 'media-communications', title: 'Content Strategist Intern', noOfInterns: 2,
    about: 'Deciding what content should exist and why — audience mapping, gap analysis, and content planning ahead of any writing.',
    responsibilities: ['Support content audits and gap analysis across surfaces.', 'Assist in building audience and content-need maps.', 'Research content-strategy frameworks.', 'Document content plans and success measures.', 'Coordinate with writing and marketing teams on execution.'],
    skills: ['Content strategy', 'Content audit', 'Audience analysis', 'Documentation', 'Coordination'],
    learningOutcomes: ['Content Audit & Gap Analysis', 'Audience & Content-Need Mapping', 'Content Strategy Frameworks', 'Content Plan Development'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Communications', 'English', 'Marketing', 'Any Relevant Discipline'],
    keywords: ['Content Strategy', 'Content Planning', 'Editorial Strategy', 'Content'],
  }),
  role({
    slug: 'brand-storytelling-intern', departmentId: 'media-communications', title: 'Brand Storytelling Intern', noOfInterns: 2,
    about: 'The narrative work behind a brand — finding true stories and telling them well, without overclaiming or inventing.',
    responsibilities: ['Support development of brand narrative and story material.', 'Research storytelling frameworks and reference work.', 'Assist in sourcing and verifying real stories from our work.', 'Document narrative guidelines and boundaries.', 'Collaborate with design and marketing on story execution.'],
    skills: ['Narrative writing', 'Storytelling frameworks', 'Interviewing and sourcing', 'Editing', 'Integrity in claims'],
    learningOutcomes: ['Brand Narrative Development', 'Storytelling Framework Practice', 'Real-Story Sourcing & Verification', 'Narrative Guideline Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Communications', 'English', 'Marketing', 'Any Relevant Discipline'],
    keywords: ['Brand Storytelling', 'Narrative', 'Brand Communications', 'Content'],
  }),
  role({
    slug: 'digital-publishing-intern', departmentId: 'media-communications', title: 'Digital Publishing Intern', noOfInterns: 2,
    about: 'The publishing pipeline itself — formats, metadata, distribution, and getting content out cleanly across channels.',
    responsibilities: ['Support digital publishing workflows across channels.', 'Assist in managing content formats and metadata standards.', 'Research digital-publishing tooling and distribution models.', 'Document publishing SOPs and quality checks.', 'Support publishing-schedule coordination.'],
    skills: ['Digital publishing workflows', 'Metadata standards', 'Format management', 'Documentation', 'Coordination'],
    learningOutcomes: ['Digital Publishing Workflow Practice', 'Content Format & Metadata Standards', 'Distribution Model Research', 'Publishing SOP Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Communications', 'English', 'Media Studies', 'Any Relevant Discipline'],
    keywords: ['Digital Publishing', 'Publishing Operations', 'Content Distribution', 'Media'],
  }),
];

export const PHASE5_DEPARTMENTS: { id: string; name: string; icon: string; description: string }[] = [
  { id: 'consulting-advisory', name: 'Consulting & Advisory', icon: 'clipboard', description: 'Management, strategy, technology, and operations consulting, plus digital transformation advisory.' },
  { id: 'international-business', name: 'International Business', icon: 'globe', description: 'Global business, international expansion, export operations, and cross-border commercial work.' },
  { id: 'science-advanced', name: 'Science & Advanced Engineering', icon: 'atom', description: 'Computational physics, chemistry and biology, materials informatics, nanotechnology, synthetic biology, neuroscience AI, and energy systems.' },
];

export const INTERN_CATALOG_PHASE5: CatalogRole[] = [
  ...CONSULTING,
  ...INTERNATIONAL_BUSINESS,
  ...SCIENCE_ADVANCED,
  ...CREATIVE_EDITORIAL,
];

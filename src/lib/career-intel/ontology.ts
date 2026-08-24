// src/lib/career-intel/ontology.ts — THE DOMAIN VOCABULARY, AND WHAT EACH DOMAIN MEANS TO A QUERY.
//
// This is the bridge between a sentence a person types and a query this database can answer. It is
// EduRankAI's own vocabulary — not a generic taxonomy, and not one inferred at request time by a
// model. That matters for two reasons:
//
//   1. It is auditable. "Why did you show me this?" resolves to a domain the person named, whose
//      terms are written down here and can be read by anybody.
//   2. It survives the AI being unavailable. A domain maps to a real filter and a real set of
//      search terms, so the same discovery works when nothing is interpreting anything.
//
// THE SKILL CATEGORIES ARE NOT RESTATED. Nineteen research disciplines already exist in
// src/lib/xscale/taxonomy.ts and are already a filterable column on the postings table. Retyping
// them here would create a second list that drifts from the first within a release, so the research
// domains below are GENERATED from that one and carry its key straight through to the filter.
//
// What is added here is the part the research taxonomy does not cover: the pathways a person
// actually says out loud — building, teaching, designing, leading, helping — which are not
// disciplines and do not have a column.

import { SKILL_CATEGORIES, type SkillCategoryKey } from '@/lib/xscale/taxonomy';

export interface InterestDomain {
  key: string;
  label: string;
  /** One line, in the person's language, for a chip or a card. */
  blurb: string;
  /** Matched case-insensitively against what the person wrote. Order does not matter. */
  aliases: string[];
  /** When set, this domain is a real filter on the postings table, not just a search term. */
  skillCategory?: SkillCategoryKey;
  /** Free-text terms handed to the retrieval layer when there is no filterable column. */
  terms: string[];
  /** Dimensions this domain tends to come with. Weak evidence — hints, not conclusions. */
  leans?: Record<string, number>;
}

/* ------------------------------------------------------------- the nineteen research disciplines */

const RESEARCH_ALIASES: Partial<Record<SkillCategoryKey, string[]>> = {
  PHYSICS: ['physics', 'physicist', 'mechanics', 'thermodynamics', 'relativity'],
  MATHEMATICS: ['maths', 'math', 'mathematics', 'mathematical', 'algebra', 'calculus', 'topology', 'probability', 'statistics', 'proofs'],
  CHEMISTRY: ['chemistry', 'chemical', 'catalysis', 'spectroscopy'],
  BIOLOGY: ['biology', 'biotech', 'biotechnology', 'bioinformatics', 'genomics', 'molecular'],
  MATERIALS: ['materials', 'material science', 'crystallography', 'composites'],
  NANOENGINEERING: ['nano', 'nanotech', 'nanotechnology', 'nanoscale', 'nanofabrication'],
  QUANTUM: ['quantum', 'qubit', 'quantum computing'],
  SEMICONDUCTORS: ['semiconductor', 'chip design', 'vlsi', 'fabrication', 'foundry'],
  ELECTRONICS: ['electronics', 'circuits', 'embedded', 'pcb', 'firmware', 'signal processing'],
  COMPUTER_SCIENCE: ['computer science', 'algorithms', 'data structures', 'compilers', 'distributed systems', 'databases', 'operating systems'],
  ARTIFICIAL_INTELLIGENCE: ['ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning', 'neural network', 'nlp', 'computer vision', 'llm', 'reinforcement learning'],
  SCIENTIFIC_COMPUTING: ['scientific computing', 'hpc', 'numerical', 'simulation', 'solver', 'parallel computing'],
  MECHANICAL_ENGINEERING: ['mechanical', 'robotics', 'cad', 'manufacturing', 'mechatronics'],
  CIVIL_ENGINEERING: ['civil', 'structural', 'construction', 'geotechnical'],
  AEROSPACE: ['aerospace', 'space', 'satellite', 'propulsion', 'avionics', 'orbital'],
  ENERGY: ['energy', 'battery', 'solar', 'photovoltaic', 'grid', 'nuclear power'],
  ENVIRONMENT: ['environment', 'climate', 'sustainability', 'ecology', 'carbon'],
  ASTROPHYSICS: ['astrophysics', 'astronomy', 'telescope', 'stellar'],
  COSMOLOGY: ['cosmology', 'universe', 'dark matter', 'dark energy'],
};

const RESEARCH_LEANS: Partial<Record<SkillCategoryKey, Record<string, number>>> = {
  MATHEMATICS: { abstraction: 0.72, analytical: 0.78 },
  PHYSICS: { analytical: 0.74, abstraction: 0.62 },
  ARTIFICIAL_INTELLIGENCE: { analytical: 0.7, implementation: 0.62, research_orientation: 0.6 },
  COMPUTER_SCIENCE: { systems_thinking: 0.68, implementation: 0.68 },
  SCIENTIFIC_COMPUTING: { analytical: 0.7, implementation: 0.6 },
  CHEMISTRY: { experimental: 0.7 },
  BIOLOGY: { experimental: 0.68 },
  MATERIALS: { experimental: 0.66 },
  NANOENGINEERING: { experimental: 0.7 },
  ELECTRONICS: { implementation: 0.7, experimental: 0.6 },
  MECHANICAL_ENGINEERING: { implementation: 0.72 },
  SEMICONDUCTORS: { experimental: 0.62, implementation: 0.62 },
  COSMOLOGY: { abstraction: 0.75, research_orientation: 0.7 },
  ASTROPHYSICS: { analytical: 0.68, research_orientation: 0.66 },
};

const RESEARCH_DOMAINS: InterestDomain[] = SKILL_CATEGORIES.map((c) => ({
  key: c.key,
  label: c.label,
  blurb: c.skills.slice(0, 3).join(' · '),
  aliases: RESEARCH_ALIASES[c.key] || [c.label.toLowerCase()],
  skillCategory: c.key,
  terms: [c.label, ...c.skills.slice(0, 4)],
  leans: RESEARCH_LEANS[c.key],
}));

/* --------------------------------------------------------------- the pathways people say out loud */

const PATHWAY_DOMAINS: InterestDomain[] = [
  {
    key: 'BUILDING',
    label: 'Building things',
    blurb: 'Software, hardware and systems that other people use.',
    aliases: ['build', 'building', 'coding', 'code', 'programming', 'developer', 'engineer', 'engineering', 'software', 'shipping', 'making things'],
    terms: ['Engineer', 'Engineering', 'Developer', 'Platform', 'Systems'],
    leans: { implementation: 0.82, systems_thinking: 0.6 },
  },
  {
    key: 'RESEARCH',
    label: 'Research and discovery',
    blurb: 'Open questions, written results, things nobody has settled yet.',
    aliases: ['research', 'researcher', 'discover', 'discovery', 'science', 'scientific', 'phd', 'publish', 'paper', 'unsolved', 'unanswered', 'frontier'],
    terms: ['Research', 'Scientist', 'Analysis', 'Theory'],
    leans: { research_orientation: 0.85, ambiguity_tolerance: 0.62, deep_focus: 0.6 },
  },
  {
    key: 'CREATING',
    label: 'Designing and creating',
    blurb: 'Interfaces, experiences, writing and the shape of a thing.',
    aliases: ['design', 'designer', 'creative', 'create', 'craft', 'ux', 'ui', 'brand', 'visual', 'writing', 'content', 'storytelling'],
    terms: ['Design', 'Designer', 'Content', 'Creative', 'Brand'],
    leans: { creativity: 0.85, implementation: 0.55 },
  },
  {
    key: 'HARD_PROBLEMS',
    label: 'Difficult problems',
    blurb: 'Work whose difficulty is the point.',
    aliases: ['difficult problem', 'hard problem', 'difficult problems', 'hard problems', 'challenging', 'challenge', 'complex', 'complexity', 'puzzle', 'optimis', 'optimiz', 'solve'],
    terms: ['Optimisation', 'Algorithms', 'Performance', 'Architecture'],
    leans: { analytical: 0.8, deep_focus: 0.66, ambiguity_tolerance: 0.55 },
  },
  {
    key: 'EDUCATION',
    label: 'Education and learning',
    blurb: 'Teaching, curriculum, assessment and how people actually learn.',
    aliases: ['education', 'teaching', 'teacher', 'learning', 'curriculum', 'pedagogy', 'tutor', 'student', 'academic', 'edtech'],
    terms: ['Education', 'Learning', 'Curriculum', 'Assessment', 'Academic'],
    leans: { social_energy: 0.66, creativity: 0.55 },
  },
  {
    key: 'HELPING',
    label: 'Working with people',
    blurb: 'Support, community, recruitment and the people side of the work.',
    aliases: ['help people', 'helping', 'people', 'community', 'support', 'mentor', 'counsel', 'social impact', 'human'],
    terms: ['Community', 'Support', 'People', 'Partnerships'],
    leans: { social_energy: 0.78, collaboration: 0.72 },
  },
  {
    key: 'LEADING',
    label: 'Leading and directing',
    blurb: 'Setting direction, owning outcomes, running a function.',
    aliases: ['lead', 'leading', 'leadership', 'manage', 'management', 'director', 'head of', 'strategy', 'own the', 'run a team'],
    terms: ['Lead', 'Head', 'Director', 'Strategy', 'Manager'],
    leans: { autonomy: 0.72, collaboration: 0.65, goal_clarity: 0.6 },
  },
  {
    key: 'DATA',
    label: 'Data and analysis',
    blurb: 'Measurement, evidence, and what the numbers actually say.',
    aliases: ['data', 'analytics', 'analysis', 'analyst', 'metrics', 'dashboard', 'sql', 'insight'],
    terms: ['Data', 'Analytics', 'Analysis', 'Statistics'],
    leans: { analytical: 0.8 },
  },
  {
    key: 'PRODUCT',
    label: 'Product and operations',
    blurb: 'Deciding what gets built, and keeping it running.',
    aliases: ['product', 'operations', 'ops', 'programme', 'program manage', 'project manage', 'delivery', 'roadmap'],
    terms: ['Product', 'Operations', 'Programme', 'Delivery'],
    leans: { goal_clarity: 0.72, systems_thinking: 0.6, pace: 0.6 },
  },
  {
    key: 'SECURITY',
    label: 'Security and trust',
    blurb: 'Keeping systems, data and people safe.',
    aliases: ['security', 'cyber', 'cybersecurity', 'privacy', 'infosec', 'trust and safety', 'safety'],
    terms: ['Security', 'Privacy', 'Trust', 'Safety'],
    leans: { detail_orientation: 0.7, systems_thinking: 0.66 },
  },
  {
    key: 'POLICY',
    label: 'Policy, law and governance',
    blurb: 'Rules, compliance, and the framework work happens inside.',
    aliases: ['policy', 'legal', 'law', 'compliance', 'governance', 'regulation', 'regulatory'],
    terms: ['Policy', 'Legal', 'Compliance', 'Governance'],
    leans: { detail_orientation: 0.72, analytical: 0.62 },
  },
  {
    key: 'FINANCE',
    label: 'Finance and business',
    blurb: 'Money, models, growth and how the organisation sustains itself.',
    aliases: ['finance', 'financial', 'accounting', 'business', 'commercial', 'sales', 'marketing', 'growth', 'revenue'],
    terms: ['Finance', 'Business', 'Growth', 'Marketing'],
    leans: { goal_clarity: 0.66, pace: 0.6 },
  },
];

/** Every domain the system recognises. Research disciplines first, then the spoken pathways. */
export const INTEREST_DOMAINS: InterestDomain[] = [...RESEARCH_DOMAINS, ...PATHWAY_DOMAINS];

export const DOMAIN_BY_KEY: Record<string, InterestDomain> =
  Object.fromEntries(INTEREST_DOMAINS.map((d) => [d.key, d]));

export function domainLabel(key: string): string {
  return DOMAIN_BY_KEY[key]?.label || key;
}

/**
 * The domains offered as opening pathways on the careers page.
 *
 * A SHORTLIST, AND SAID TO BE ONE. These are the seven starting points most people recognise; the
 * page states plainly that they are suggestions and that free text is always available, because a
 * grid of buttons with no way past it is exactly the box this system exists to avoid.
 */
export const OPENING_PATHWAYS: string[] = [
  'BUILDING', 'RESEARCH', 'CREATING', 'HARD_PROBLEMS', 'EDUCATION', 'HELPING', 'LEADING',
];

/* ------------------------------------------------------------------------------ the skill lexicon */

/**
 * Concrete, checkable things a person names when describing what they have done.
 *
 * NOT a competence claim and never treated as one: a match here means the person used the word, and
 * that is exactly how far it is carried — into `skills` as a tag with source 'stated', which the
 * ranker treats as an interest signal and never as evidence of ability. The same rule the HR
 * matcher already writes down in src/lib/match.ts: a keyword is a claim, not a capability.
 */
export const SKILL_LEXICON: string[] = [
  'python', 'javascript', 'typescript', 'java', 'c++', 'c#', 'rust', 'go', 'julia', 'matlab', 'r',
  'sql', 'html', 'css', 'react', 'node', 'astro', 'postgres', 'postgresql', 'mongodb', 'redis',
  'docker', 'kubernetes', 'linux', 'git', 'aws', 'azure', 'terraform', 'ci/cd',
  'pytorch', 'tensorflow', 'jax', 'numpy', 'pandas', 'scikit-learn', 'huggingface', 'transformers',
  'ros', 'opencv', 'cuda', 'openmp', 'mpi', 'fortran', 'verilog', 'vhdl', 'fpga', 'arduino',
  'raspberry pi', 'solidworks', 'autocad', 'ansys', 'comsol', 'labview', 'spice', 'altium',
  'gis', 'qgis', 'arcgis', 'remote sensing', 'lidar',
  'figma', 'illustrator', 'photoshop', 'blender', 'after effects', 'premiere',
  'excel', 'power bi', 'tableau', 'looker',
  'latex', 'mathematica', 'maple', 'origin',
  'nmr', 'xrd', 'sem', 'tem', 'afm', 'mass spectrometry', 'chromatography', 'pcr', 'crispr',
];

/** Career-stage words, and what they say. Read only as evidence about the person's own stage. */
export const STAGE_PATTERNS: { re: RegExp; stage: 'student' | 'early' | 'experienced' | 'senior'; confidence: number }[] = [
  { re: /\b(school\s?student|undergrad(uate)?|first[-\s]year|second[-\s]year|third[-\s]year|final[-\s]year|b\.?tech|b\.?sc|bachelor|college student|i am a student|i'?m a student|studying)\b/i, stage: 'student', confidence: 0.8 },
  { re: /\b(m\.?tech|m\.?sc|master'?s|postgrad(uate)?|phd|doctoral|research scholar)\b/i, stage: 'student', confidence: 0.62 },
  { re: /\b(fresher|graduating|just graduated|recent graduate|no experience|first job|entry[-\s]level|starting out|early career)\b/i, stage: 'early', confidence: 0.78 },
  { re: /\b(\d+\+?\s*years?\s+(of\s+)?experience|worked (for|at)|previously (at|a)|currently (a|an|working))\b/i, stage: 'experienced', confidence: 0.6 },
  { re: /\b(lead|principal|staff|head of|director|manager|founder|cto|chief)\b/i, stage: 'senior', confidence: 0.55 },
];

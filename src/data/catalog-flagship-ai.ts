// src/data/catalog-flagship-ai.ts — flagship deep-technology programmes.
//
// Two groups:
//  1. FLAGSHIP_AI — the Large Language Model (LLM) Engineering Internship. Kept separate from the
//     bulk intern catalog because its terms are deliberately unlike everything else: 8 months
//     rather than 3, a 7-day week at ~13 hours/day, and a performance-based stipend of up to
//     INR 2,50,000/month. It is NOT the same listing as the existing generic 'LLM Engineer Intern'
//     (intern-catalog.ts) - that one is a standard 3-month unpaid track. The two overlap in
//     subject matter, so the generic one should probably be closed in /admin/roles once this is
//     live, otherwise two LLM internships compete for the same applicants.
//  2. QUANTUM_AI — quantum roles that are genuinely absent from the existing 10. Deliberately
//     SKIPPED as duplicates: Quantum Machine Learning (covered by 'Quantum AI Intern'),
//     Post-Quantum Cryptography (covered by 'Quantum Cryptography Intern'), and Quantum
//     Generative AI / Quantum Reinforcement Learning (both inside 'Quantum AI Intern' scope).
import type { CatalogRole } from './role-catalog';

const REMOTE_IN = 'Remote / Hybrid (India)';
// Fully in person, in India, at a location deliberately not published — this is a high-protocol
// secure programme. careers/[slug].astro detects that no city is named here and emits only
// addressCountry in the JobPosting JSON-LD rather than pushing this whole string into
// addressLocality. Trade-off accepted: without a city the posting cannot match city-level job
// searches, which costs some reach in exchange for not disclosing the site.
const ONSITE_IN = 'On-site, India (exact location disclosed on selection)';

const ABOUT_INTRO = 'EduRankAI is developing next-generation technologies in Artificial Intelligence, Education Technology, Research, Product Engineering, and Digital Innovation.';

const UGPG = 'UG / PG';
const CS_QUALIFICATIONS = ['B.E. / B.Tech.', 'M.E. / M.Tech.', 'MCA', 'M.Sc.', 'B.Sc. (Relevant Disciplines)'];

// Standard terms for the quantum research tracks (mirrors the rest of the intern catalog).
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
    location: REMOTE_IN,
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

// =====================================================================================
// 1. FLAGSHIP — LLM Engineering Internship
// =====================================================================================
// Base definition. The exported FLAGSHIP_AI is assembled at the bottom of this file, where it
// inherits the union of every quantum track's competencies on top of what is written here — the
// programme spans the whole deep-technology stack, quantum AI included, so its criteria are the
// superset. Derived rather than copied so the two can never drift apart.
const LLM_FLAGSHIP_BASE: CatalogRole[] = [
  {
    slug: 'llm-engineering-intern',
    departmentId: 'ai-research',
    title: 'Large Language Model (LLM) Engineering Intern',
    level: 'Intern',
    engagementType: 'Internship',
    function: 'Build foundational AI from first principles — proprietary language models, agentic systems, training infrastructure and the compilers and runtimes beneath them.',
    // FULLY IN PERSON. The pasted terms block said "Mode of Engagement: Fully Online", but that was
    // corrected immediately afterwards to fully in person - the later instruction wins.
    location: ONSITE_IN,
    duration: '8 Months',
    salary: 'Performance-based stipend of up to INR 2,50,000 per month (India) or CHF 25,000 per month (overseas interns), awarded on demonstrated merit',
    isFeatured: true,
    openings: 4,
    // National-security classification. Precise location is a CONDITION of applying to this
    // programme, enforced server-side at submission — see src/lib/role-security.ts. It is disclosed
    // on the form up front so nobody reaches the end and is only then told they cannot be accepted.
    requiresPreciseLocation: true,
    securityNote: 'This programme involves controlled research inside a restricted-protocol zone. Sharing your precise location is a condition of applying and your application cannot be submitted without it. Every other open role at EduRankAI can be applied to without this.',
    about: ABOUT_INTRO + ' Most internships teach you to use AI; this one asks you to help build it. '
      + 'The Large Language Model (LLM) Engineering Internship is one of our flagship research and engineering programmes. '
      + 'It is deliberately not a prompt-engineering, chatbot-integration or API-consumption internship — it is a deep-technology '
      + 'programme focused on building foundational AI from first principles. Interns work alongside researchers and engineers on '
      + 'proprietary large language models, agentic systems, multimodal intelligence, AI infrastructure, distributed training '
      + 'platforms, programming languages, compiler technology, operating systems and next-generation computational architectures. '
      + 'It is intended for people who are drawn to genuinely hard engineering and scientific problems. Only a small number of '
      + 'candidates are selected.',
    responsibilities: [
      'Design, develop, optimise and evaluate large language models and foundation models.',
      'Implement transformer architectures and modern deep-learning techniques from the paper up.',
      'Build data preprocessing and tokenisation pipelines.',
      'Build and operate distributed GPU training runs; optimise training and inference performance.',
      'Develop Retrieval-Augmented Generation (RAG) systems and agentic/autonomous workflows.',
      'Build scalable AI infrastructure, model-serving paths and internal developer tooling.',
      'Read, implement, reproduce and extend state-of-the-art research; run benchmarks and technical validation.',
      'Contribute to AI alignment and safety evaluation of the systems you build.',
      'Write engineering specifications, technical documentation and research reports.',
      'Participate in architecture discussions, code reviews, technical seminars and engineering reviews.',
      'Deliver production-quality software and research prototypes against defined milestones.',
    ],
    skills: [
      'Python', 'PyTorch', 'Transformer architectures', 'Deep learning', 'Natural Language Processing',
      'Distributed training', 'GPU computing', 'CUDA', 'Tokenisation', 'Retrieval-Augmented Generation (RAG)',
      'Reinforcement learning', 'Model optimisation', 'Inference optimisation', 'MLSys',
      'Data structures & algorithms', 'Linear algebra', 'Probability & statistics', 'Optimisation',
      'Distributed systems', 'Operating systems', 'Compiler design', 'Software architecture',
      'Research methodology', 'AI safety & alignment',
    ],
    eligibility: [
      'Currently pursuing or having completed B.E. / B.Tech., M.E. / M.Tech., MCA, M.Sc., or B.Sc. in a relevant discipline.',
      'Available full-time for 8 months on the stated schedule.',
      'Excellent programming ability and strong computer-science fundamentals.',
      'Strong mathematical reasoning and outstanding analytical problem-solving.',
      'Demonstrated ability to learn independently, with genuine curiosity for research.',
      'Additional consideration is given for competitive-programming achievements, research publications, open-source contributions, or prior work on AI systems, developer tools, distributed systems, programming languages or compilers.',
      'Also valued: a background in formal logic, symbolic AI, computational linguistics or knowledge representation; and advanced proficiency in Sanskrit for computational-linguistics and semantic-reasoning work.',
      'Interns may access confidential information, proprietary source code, datasets and research materials, and must maintain strict confidentiality and comply with all intellectual-property and information-security obligations.',
      'This programme is fully in person for its full 8 months — it is not remote or hybrid.',
      'Selected interns must be resident within EduRankAI’s highest-protocol zone for the duration of the programme and comply with its access-control, information-security and conduct requirements.',
      'Open to candidates worldwide. Overseas interns are supported on a separate stipend band (up to CHF 25,000 per month) and are subject to the same in-person and protocol-zone requirements.',
      // Citizenship restriction written verbatim as directed by the founder, on the stated basis
      // that this is a high-protocol, secure programme. A concern was raised that a named
      // nationality exclusion in a publicly indexed JobPosting carries legal exposure in the
      // jurisdictions this posting is intended to reach, and the instruction was reaffirmed with
      // that known. Do not soften or reword this without the founder's explicit sign-off.
      'CITIZENSHIP RESTRICTION: this is a high-protocol, secure programme. Citizens of Pakistan, Turkey (Türkiye) or China, and citizens of any country hostile to Bharat (India), are not eligible for this programme.',
      'Because the programme is performed in person inside a restricted-protocol zone and involves proprietary and controlled research, every offer is additionally conditional on obtaining the security clearance, background verification and work authorisation required for that access. EduRankAI cannot guarantee that a government clearance or employment visa will be granted, and an offer may not be possible where it is not. Applicants are asked to confirm they can satisfy these requirements before applying.',
      'MANDATORY VERIFICATION: candidates must provide complete citizenship and identity documentation. EduRankAI may additionally require a full verified bonafide history covering birth to the present — including residence, education, employment and travel history — and may verify any of it with the issuing authorities. Documents are shared as Google Drive links with "Anyone with the link" access enabled; they are never uploaded to this site.',
      'EduRankAI reserves the absolute and sole right to reject any application, at any stage and without obligation to give reasons, and to withdraw an offer where verification is incomplete, refused, or found to be inaccurate.',
    ],
    learningOutcomes: [
      'Large Language Models & Foundation Models',
      'Transformer Architectures',
      'Deep Learning & Natural Language Processing',
      'Machine Learning Systems (MLSys)',
      'Distributed AI Training & GPU Computing',
      'High-Performance Computing',
      'AI Infrastructure & Model Serving',
      'Reinforcement Learning',
      'Retrieval-Augmented Generation (RAG)',
      'Agentic AI & Multimodal AI',
      'AI Safety & Alignment',
      'Distributed Systems & Software Architecture',
      'Programming Language Design & Compiler Engineering',
      'Operating Systems & Scientific Computing',
      'Research Methodology',
    ],
    qualificationType: UGPG,
    qualifications: CS_QUALIFICATIONS,
    specialisations: [
      'Artificial Intelligence', 'Computer Science & Engineering', 'Software Engineering', 'Data Science',
      'Information Technology', 'Machine Learning', 'Mathematics & Computing',
      'Electronics & Computer Engineering', 'Computational Mathematics', 'Statistics', 'Physics',
      'Computational Linguistics', 'Any related engineering, computing or quantitative discipline',
    ],
    noOfInterns: 4,
    keywords: [
      'LLM', 'Large Language Models', 'Foundation Models', 'Transformers', 'Agentic AI', 'AGI', 'ASI',
      'MLSys', 'AI Infrastructure', 'Distributed Training', 'RAG', 'Deep Learning', 'GPU Computing',
      'Compilers', 'Machine Learning Systems',
    ],
    perks: [
      'Performance-based stipend of up to INR 2,50,000 per month for exceptional performers',
      'Internship Completion Certificate',
      'Performance-based Letter of Recommendation',
      'Direct mentorship from experienced engineers and researchers',
      'Contribute to proprietary AI products and live research',
      'Exposure to large-scale engineering challenges and frontier technology',
      'Development in technical leadership, research methodology, engineering excellence and communication',
      'High performers may be considered for extended internships, research appointments or full-time roles based on organizational requirements.',
    ],
    internshipMode: 'Full-Time',
    workingDaysPerWeek: 7,
    hoursPerWeek: 91,
    projectHoursPerDay: 10,
    wellbeingHoursPerDay: 3,
    engagementNotes: [
      'THIS IS NOT A CONVENTIONAL INTERNSHIP. It is a full-time, fully in-person, research-intensive engineering programme in which interns are treated as contributors to live products and research, structured to match the responsibilities, expectations and working culture of a high-performance technology and research organization.',
      'Structure: Full-time. Fully in person. 8 months. 7 days per week. Approximately 13 hours per day. Approximately 91 hours per week. Approximately 2,900+ hours total programme engagement.',
      'Of each day, approximately 10 hours are for engineering, research, software development, technical learning, project execution, meetings, documentation, experimentation and assigned organizational responsibilities.',
      'The remaining approximately 3 hours per day are a required part of the programme, dedicated to structured physical fitness, strength and endurance training, sport, flexibility and mobility, nutrition and dietary discipline, meditation and mindfulness, reading and continuous learning, leadership development, communication and interpersonal skills, and ethical and professional development. Participation forms part of the overall evaluation.',
      'This is structured as an intensive professional development programme and therefore requires a significant level of commitment, discipline, accountability and consistency.',
      'NATURE OF WORK: interns contribute to live organizational projects and may be assigned responsibilities equivalent to those of software engineers, AI engineers, machine learning engineers, research engineers or systems engineers, depending on organizational requirements and demonstrated capability. Assignments may include production-quality software engineering, building and optimising large language models, developing AI agents and intelligent systems, software architecture and system design, research and implementation of state-of-the-art AI techniques, distributed systems and AI infrastructure, programming language and compiler technologies, operating and runtime systems, research experimentation and benchmarking, technical documentation and design specifications, product development and innovation, cross-functional engineering collaboration, and additional technical, research, engineering or organizational responsibilities assigned during the programme.',
      'PERFORMANCE EXPECTATIONS: deliver high-quality technical work; meet project milestones and deadlines; demonstrate continuous learning and technical growth; participate in engineering reviews and technical discussions; maintain professional communication and collaboration; uphold research integrity and engineering ethics; take ownership of assigned work; participate actively in organizational learning and development.',
      'Performance is evaluated continuously through project outcomes, code quality, engineering reviews, research contributions, technical assessments, presentations, mentor evaluations and overall organizational impact.',
      'STIPEND: this is a paid, performance-based internship. Interns demonstrating exceptional technical capability, engineering excellence, research contribution, innovation, leadership and measurable organizational impact may be awarded up to INR 2,50,000 per month; for overseas interns the corresponding band is up to CHF 25,000 per month. The stipend is awarded solely at the discretion of EduRankAI on demonstrated merit, technical performance, contribution to organizational objectives and applicable policy. Only a limited number of exceptional interns qualify for the maximum band.',
      'SECURITY PROTOCOL: selected interns are required to be resident within EduRankAI’s highest-protocol zone for the duration of the programme, and to comply fully with the access control, information-security and conduct requirements that apply within it.',
      'CONFIDENTIALITY & INTELLECTUAL PROPERTY: interns may be given access to proprietary software, source code, datasets, research materials, documentation, technical designs, business information, internal systems and intellectual property, all of which must be treated as strictly confidential. All software, research, algorithms, models, documentation, datasets, inventions, discoveries, designs and other work products created during the internship in connection with organizational work remain the exclusive intellectual property of EduRankAI unless otherwise agreed in writing.',
      'ZERO TOLERANCE: EduRankAI reserves the absolute right to immediately revoke an internship offer before joining, suspend an intern, terminate the internship without prior notice, discontinue stipend payments, revoke access to organizational systems, withhold internship certification, and initiate appropriate legal, civil, criminal or disciplinary proceedings where an intern is found to have engaged in, attempted, or is reasonably suspected of engaging in: breach of confidentiality or non-disclosure obligations; unauthorised disclosure, copying, downloading, sharing, retention, modification or misuse of organizational information, source code, research materials, datasets, credentials, documentation or intellectual property; sabotage, malicious activity, cybersecurity violations, intentional disruption of organizational systems or interference with research or engineering activities; fraud, plagiarism, fabrication or falsification of research or technical work, impersonation or forgery, or submission of false information; misrepresentation of qualifications, identity, experience, achievements or eligibility; harassment, discrimination, intimidation, abuse or workplace misconduct; violation of organizational policies, information-security requirements, ethical standards, internship agreements or applicable law; persistent indiscipline, insubordination, repeated absenteeism, failure to maintain expected performance standards, or conduct detrimental to the organization; or any act likely to damage the reputation, operations, employees, clients, partners, research initiatives or business interests of EduRankAI.',
      'EduRankAI may investigate any suspected misconduct and take immediate interim action, including suspension of access to all organizational resources, pending completion of the investigation.',
      'CERTIFICATION: interns who complete the programme and satisfy all technical, research, behavioural, attendance, compliance and organizational requirements are awarded an Internship Completion Certificate. Completion does NOT constitute or guarantee employment. Extensions, research appointments, contractual engagements and full-time opportunities depend solely on organizational requirements, role availability, demonstrated performance and overall contribution.',
    ],
  },
];

// =====================================================================================
// 2. QUANTUM AI — the areas not already covered by the 10 existing quantum roles
// =====================================================================================
export const QUANTUM_AI: CatalogRole[] = [
  role({
    slug: 'quantum-nlp-intern', departmentId: 'quantum-tech', title: 'Quantum Natural Language Processing Intern', noOfInterns: 2,
    about: 'The quantum counterpart to a language model — mapping grammatical structure onto entangled quantum states instead of learning it implicitly from data.',
    responsibilities: ['Research quantum natural-language-processing approaches and quantum word embeddings.', 'Build small sentence-classification or sentence-similarity circuits in simulation.', 'Compare parameter counts and behaviour against a classical baseline, honestly.', 'Document methodology, results and the limits of current hardware.', 'Present findings to the quantum and AI research teams.'],
    skills: ['Python', 'Quantum circuit design', 'Lambeq or equivalent QNLP tooling', 'Linear algebra', 'Complex vector spaces', 'NLP fundamentals', 'Documentation'],
    learningOutcomes: ['Quantum NLP Foundations', 'Quantum Word Embeddings', 'Grammar-to-Circuit Mapping', 'Classical vs Quantum Baseline Comparison'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Physics', 'Computer Science', 'Computational Linguistics', 'Mathematics', 'Any Relevant Discipline'],
    keywords: ['QNLP', 'Quantum NLP', 'Quantum Language Models', 'Quantum Machine Learning', 'Quantum Computing'],
  }),
  role({
    slug: 'quantum-optimization-intern', departmentId: 'quantum-tech', title: 'Quantum Optimization Intern', noOfInterns: 2,
    about: 'Combinatorial optimisation on quantum hardware — the class of problem where near-term quantum methods are closest to being genuinely useful.',
    responsibilities: ['Implement and study the Quantum Approximate Optimization Algorithm (QAOA) on small problem instances.', 'Formulate scheduling, routing or allocation problems in QUBO/Ising form.', 'Benchmark quantum and quantum-inspired results against classical solvers.', 'Document formulations, results and where the classical solver still wins.', 'Present findings to the research team.'],
    skills: ['Python', 'QAOA', 'QUBO / Ising formulation', 'Quantum annealing concepts', 'Optimisation theory', 'Benchmarking', 'Documentation'],
    learningOutcomes: ['QAOA Implementation', 'QUBO & Ising Problem Formulation', 'Quantum vs Classical Solver Benchmarking', 'Applied Optimisation Research'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Mathematics', 'Computer Science', 'Physics', 'Operations Research', 'Any Relevant Discipline'],
    keywords: ['Quantum Optimization', 'QAOA', 'QUBO', 'Quantum Annealing', 'Combinatorial Optimization'],
  }),
  role({
    slug: 'quantum-error-correction-intern', departmentId: 'quantum-tech', title: 'Quantum Error Correction Intern', noOfInterns: 2,
    about: 'Noise is the reason quantum computers cannot yet do useful work at scale — this track studies error correction and mitigation on noisy intermediate-scale hardware.',
    responsibilities: ['Research quantum error-correcting codes and near-term error-mitigation techniques.', 'Simulate noise models and measure their effect on small circuits.', 'Study how error rates constrain achievable circuit depth.', 'Document findings and reproducible experiment setups.', 'Present research summaries to the team.'],
    skills: ['Python', 'Quantum error correction', 'Noise modelling', 'NISQ-era constraints', 'Linear algebra', 'Statistical analysis', 'Documentation'],
    learningOutcomes: ['Quantum Error-Correcting Codes', 'Error Mitigation on NISQ Hardware', 'Noise Modelling & Simulation', 'Circuit-Depth Constraint Analysis'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Physics', 'Computer Science', 'Mathematics', 'Any Relevant Discipline'],
    keywords: ['Quantum Error Correction', 'Error Mitigation', 'NISQ', 'Quantum Noise', 'Fault Tolerance'],
  }),
  role({
    slug: 'quantum-chemistry-intern', departmentId: 'quantum-tech', title: 'Quantum Chemistry Intern', noOfInterns: 2,
    about: 'Molecular and materials simulation on quantum hardware — narrower and deeper than general quantum simulation, focused on electronic structure and binding.',
    responsibilities: ['Study Variational Quantum Eigensolver (VQE) methods for small molecules.', 'Run electronic-structure simulations and compare against classical reference values.', 'Research applications in materials and molecular screening.', 'Document methodology, results and error margins.', 'Present findings to the research team.'],
    skills: ['Python', 'VQE', 'Electronic structure methods', 'Quantum chemistry fundamentals', 'Linear algebra', 'Scientific computing', 'Documentation'],
    learningOutcomes: ['Variational Quantum Eigensolvers', 'Electronic Structure Simulation', 'Molecular Screening Methods', 'Quantum-Classical Result Validation'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Chemistry', 'Physics', 'Computational Chemistry', 'Materials Science', 'Any Relevant Discipline'],
    keywords: ['Quantum Chemistry', 'VQE', 'Molecular Simulation', 'Materials Science', 'Computational Chemistry'],
  }),
  role({
    slug: 'quantum-computer-vision-intern', departmentId: 'quantum-tech', title: 'Quantum Computer Vision Intern', noOfInterns: 2,
    about: 'Encoding images as quantum states — how visual data can be represented and classified on quantum hardware, and where that breaks down today.',
    responsibilities: ['Research quantum image-encoding schemes and quantum classifiers for visual data.', 'Implement small image-classification circuits in simulation.', 'Benchmark honestly against a classical CNN baseline on the same task.', 'Document encoding choices, results and scaling limits.', 'Present findings to the research team.'],
    skills: ['Python', 'Quantum circuit design', 'Computer vision fundamentals', 'PennyLane or equivalent', 'Linear algebra', 'Benchmarking', 'Documentation'],
    learningOutcomes: ['Quantum Image Encoding', 'Quantum Classifiers for Visual Data', 'Quantum vs Classical Vision Benchmarking', 'Scaling-Limit Analysis'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Physics', 'Artificial Intelligence', 'Any Relevant Discipline'],
    keywords: ['Quantum Computer Vision', 'Quantum Image Processing', 'Quantum Machine Learning', 'Computer Vision'],
  }),
  role({
    slug: 'quantum-ai-infrastructure-intern', departmentId: 'quantum-tech', title: 'Quantum AI Infrastructure Intern', noOfInterns: 2,
    about: 'The engineering layer beneath quantum AI — hybrid pipelines that split work between classical accelerators and quantum processors, and the tooling that makes them reproducible.',
    responsibilities: ['Research hybrid classical-quantum execution architectures and job orchestration.', 'Build tooling that submits, queues and collects results from quantum simulators.', 'Study how results are made reproducible across simulator backends.', 'Document reference architectures and developer workflows.', 'Support the quantum research team with engineering infrastructure.'],
    skills: ['Python', 'Cloud fundamentals', 'Job orchestration', 'Qiskit / PennyLane SDKs', 'API design', 'Reproducibility practice', 'Documentation'],
    learningOutcomes: ['Hybrid Classical-Quantum Architecture', 'Quantum Job Orchestration', 'Reproducible Quantum Experiments', 'Quantum Developer Tooling'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Physics', 'Any Relevant Discipline'],
    keywords: ['Quantum AI Infrastructure', 'Hybrid Quantum Computing', 'Quantum SDK', 'MLOps', 'Quantum DevOps'],
  }),
  role({
    slug: 'quantum-finance-intern', departmentId: 'quantum-tech', title: 'Quantum Finance Intern', noOfInterns: 2,
    about: 'Quantitative finance problems recast for quantum methods — portfolio optimisation and risk models with many interacting variables.',
    responsibilities: ['Research quantum approaches to portfolio optimisation and risk modelling.', 'Formulate a small portfolio-allocation problem for a quantum optimiser.', 'Benchmark against classical methods and report the gap plainly.', 'Document formulations, assumptions and limitations.', 'Present findings to the research team.'],
    skills: ['Python', 'Quantitative finance fundamentals', 'QAOA / annealing', 'Optimisation', 'Statistics', 'Benchmarking', 'Documentation'],
    learningOutcomes: ['Quantum Portfolio Optimisation', 'Quantum Risk Modelling', 'Financial Problem Formulation for Quantum Solvers', 'Honest Quantum-Classical Comparison'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Finance', 'Mathematics', 'Physics', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Quantum Finance', 'Portfolio Optimization', 'Quantum Risk Analytics', 'Quantitative Finance'],
  }),
];

// =====================================================================================
// 3. Assemble the flagship: its own criteria PLUS the union of all 7 quantum tracks.
// =====================================================================================
const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
const fromQuantum = (pick: (r: CatalogRole) => string[] | undefined) => QUANTUM_AI.flatMap((r) => pick(r) || []);

// Responsibilities are curated rather than unioned: concatenating all seven task lists would add
// ~35 near-identical bullets ("Present findings to the research team" seven times) and bury the
// engineering work. Skills, outcomes, specialisations and keywords ARE unioned in full — breadth
// there is useful to candidates and is what makes the posting findable on those search terms.
const QUANTUM_RESPONSIBILITIES = [
  'Extend the same first-principles approach to quantum AI: implement parameterised quantum circuits and quantum neural networks in simulation.',
  'Study where quantum methods genuinely beat a classical baseline — and report honestly where they do not.',
  'Work across the quantum stack as projects require: quantum NLP, optimisation (QAOA/QUBO), error correction and mitigation on noisy hardware, electronic-structure simulation (VQE), and hybrid classical-quantum execution pipelines.',
];

export const FLAGSHIP_AI: CatalogRole[] = LLM_FLAGSHIP_BASE.map((r) => ({
  ...r,
  responsibilities: uniq([...(r.responsibilities || []), ...QUANTUM_RESPONSIBILITIES]),
  skills: uniq([...(r.skills || []), ...fromQuantum((q) => q.skills)]),
  learningOutcomes: uniq([...(r.learningOutcomes || []), ...fromQuantum((q) => q.learningOutcomes)]),
  specialisations: uniq([...(r.specialisations || []), ...fromQuantum((q) => q.specialisations)]),
  keywords: uniq([...(r.keywords || []), ...fromQuantum((q) => q.keywords)]),
}));

export const CATALOG_FLAGSHIP_AI: CatalogRole[] = [...FLAGSHIP_AI, ...QUANTUM_AI];

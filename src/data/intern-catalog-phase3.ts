// src/data/intern-catalog-phase3.ts — Phase 3, Batch 1: Artificial Intelligence, Cyber Intelligence,
// Data, and Cloud & Infrastructure. Cross-checked against the full existing catalog first (role-
// catalog.ts + intern-catalog.ts + intern-catalog-phase2.ts) — every role below is genuinely new,
// not a re-listing of an existing title under a different name.
import type { CatalogRole } from './role-catalog';

const REMOTE_IN = 'Remote / Hybrid (India)';

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
    keywords: r.keywords,
    noOfInterns: r.noOfInterns,
    perks: [...STANDARD_PERKS, ...(r.perksExtra || [])],
    ...STANDARD_TERMS,
  };
}

const UGPG = 'UG / PG';
const STD_QUALIFICATIONS = ["Any Bachelor's Degree", "Any Master's Degree", 'Diploma', 'Integrated Degree'];
const CS_QUALIFICATIONS = ['B.Tech/B.E.', "Master's Degree", 'Any Relevant Degree'];

// =====================================================================================
// ARTIFICIAL INTELLIGENCE (fits the existing ai-research department)
// =====================================================================================
const ARTIFICIAL_INTELLIGENCE: CatalogRole[] = [
  role({
    slug: 'generative-ai-intern', departmentId: 'ai-research', title: 'Generative AI Intern', noOfInterns: 4,
    about: 'Generative AI sits at the centre of our tutoring, content, and simulation research — where models generate explanations, practice problems, and adaptive feedback rather than just classify or retrieve.',
    responsibilities: ['Support fine-tuning and prompt-engineering experiments for generative models.', 'Assist in building evaluation harnesses for generated educational content.', 'Research generative-AI architectures (diffusion, autoregressive, retrieval-augmented).', 'Document experiment results and failure modes honestly.', 'Support integration of generative outputs into AquinTutor prototypes.'],
    skills: ['Python', 'Prompt engineering', 'Fine-tuning (LoRA/PEFT basics)', 'Evaluation design', 'Generative model architectures', 'Documentation'],
    learningOutcomes: ['Generative Model Experimentation', 'Prompt Engineering', 'Evaluation Harness Design', 'Applied Generative AI in Education'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Artificial Intelligence', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['Generative AI', 'LLMs', 'Diffusion Models', 'Fine-Tuning', 'Prompt Engineering'],
  }),
  role({
    slug: 'agentic-ai-intern', departmentId: 'ai-research', title: 'Agentic AI Intern', noOfInterns: 3,
    about: 'Agentic systems — models that plan, call tools, and take multi-step actions — underlie our roadmap for autonomous tutoring workflows and internal automation.',
    responsibilities: ['Research agentic-AI frameworks (tool use, planning, multi-step reasoning).', 'Support building and testing simple agent prototypes.', 'Assist in evaluating agent reliability and failure modes.', 'Document safety and reliability findings.', 'Collaborate with the AI research team on agent-architecture decisions.'],
    skills: ['Python', 'Agent frameworks (LangChain/LlamaIndex or equivalent)', 'Tool-use/function-calling patterns', 'Evaluation design', 'Documentation'],
    learningOutcomes: ['Agentic AI Architecture', 'Tool-Use & Planning Systems', 'Agent Reliability Evaluation', 'Applied Agent Prototyping'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Artificial Intelligence', 'Any Relevant Discipline'],
    keywords: ['Agentic AI', 'AI Agents', 'Tool Use', 'Autonomous Systems', 'LLM Agents'],
  }),
  role({
    slug: 'multimodal-ai-intern', departmentId: 'ai-research', title: 'Multimodal AI Intern', noOfInterns: 3,
    about: 'Multimodal models — reasoning across text, image, audio, and video together — are directly relevant to how AquinTutor teaches with diagrams, voice, and visual explanations.',
    responsibilities: ['Research multimodal model architectures and training approaches.', 'Support experiments combining text, image, and audio inputs.', 'Assist in building evaluation sets for multimodal understanding tasks.', 'Document findings and model limitations.', 'Support integration explorations with the tutoring platform.'],
    skills: ['Python', 'PyTorch/TensorFlow', 'Multimodal model architectures', 'Data preprocessing (image/audio/text)', 'Evaluation design'],
    learningOutcomes: ['Multimodal Model Architecture', 'Cross-Modal Evaluation Design', 'Applied Multimodal Research', 'Model Limitation Analysis'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Artificial Intelligence', 'Any Relevant Discipline'],
    keywords: ['Multimodal AI', 'Vision-Language Models', 'Cross-Modal Learning', 'Deep Learning'],
  }),
  role({
    slug: 'llm-engineer-intern', departmentId: 'ai-research', title: 'LLM Engineer Intern', noOfInterns: 4,
    about: 'The engineering side of large language models — serving, optimising, and integrating them reliably — distinct from the research side; for students who want to build production LLM systems.',
    responsibilities: ['Support building and testing LLM inference pipelines.', 'Assist in optimising latency and cost for LLM-serving infrastructure.', 'Help integrate LLM APIs (self-hosted and third-party) into product features.', 'Debug and document LLM-serving issues.', 'Support load-testing and reliability work for LLM endpoints.'],
    skills: ['Python', 'LLM APIs (OpenAI-compatible/self-hosted)', 'Inference optimisation basics', 'API integration', 'Debugging & testing'],
    learningOutcomes: ['LLM Serving & Inference', 'Latency/Cost Optimisation', 'Production LLM Integration', 'Reliability Engineering for AI Systems'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['LLM Engineering', 'LLM Serving', 'Inference Optimisation', 'AI Infrastructure'],
  }),
  role({
    slug: 'ai-safety-intern', departmentId: 'ai-research', title: 'AI Safety Intern', noOfInterns: 2,
    about: 'As we deploy AI directly to learners, safety — preventing harmful, incorrect, or manipulative outputs — is a genuine research and engineering concern, not an afterthought.',
    responsibilities: ['Research AI-safety frameworks and failure-mode taxonomies relevant to educational AI.', 'Support red-teaming exercises on our own AI features.', 'Assist in building safety evaluation test suites.', 'Document safety findings and recommend mitigations.', 'Present findings to the research and product teams.'],
    skills: ['AI safety fundamentals', 'Red-teaming basics', 'Python', 'Evaluation design', 'Critical thinking', 'Documentation'],
    learningOutcomes: ['AI Safety Frameworks', 'Red-Teaming Methodology', 'Safety Evaluation Design', 'Risk-Mitigation Recommendations'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Artificial Intelligence', 'Ethics', 'Any Relevant Discipline'],
    keywords: ['AI Safety', 'Red-Teaming', 'Responsible AI', 'AI Risk'],
  }),
  role({
    slug: 'ai-alignment-intern', departmentId: 'ai-research', title: 'AI Alignment Intern', noOfInterns: 2,
    about: 'Alignment research — making model behaviour match intended goals, especially in a tutoring context where "helpful" must also mean "pedagogically honest" — is a distinct research thread from general safety.',
    responsibilities: ['Research alignment techniques (RLHF, constitutional methods, preference learning).', 'Support small-scale alignment experiments on our own models.', 'Assist in defining what "aligned tutoring behaviour" means concretely.', 'Document experiments and honest limitations.', 'Collaborate with the AI research team on alignment roadmap input.'],
    skills: ['Python', 'Alignment techniques (RLHF basics)', 'Preference-learning concepts', 'Research literature review', 'Documentation'],
    learningOutcomes: ['AI Alignment Techniques', 'Preference Learning', 'Applied Alignment Experimentation', 'Pedagogical-Alignment Definition'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Artificial Intelligence', 'Philosophy', 'Any Relevant Discipline'],
    keywords: ['AI Alignment', 'RLHF', 'Preference Learning', 'AI Research'],
  }),
  role({
    slug: 'responsible-ai-intern', departmentId: 'ai-research', title: 'Responsible AI Intern', noOfInterns: 3,
    about: 'Responsible AI — bias, fairness, transparency, and accountability in the models we ship to learners — is a practical governance discipline that complements our safety and alignment research.',
    responsibilities: ['Research responsible-AI frameworks and regulatory guidance relevant to education.', 'Support bias and fairness audits of our own models and datasets.', 'Assist in drafting model documentation (model cards, data sheets).', 'Document findings for the research and governance teams.', 'Support responsible-AI training material for internal teams.'],
    skills: ['Responsible AI frameworks', 'Bias/fairness evaluation basics', 'Python', 'Documentation', 'Research literature review'],
    learningOutcomes: ['Responsible AI Frameworks', 'Bias & Fairness Auditing', 'Model Documentation Standards', 'AI Governance Awareness'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Ethics', 'Public Policy', 'Any Relevant Discipline'],
    keywords: ['Responsible AI', 'AI Ethics', 'Bias & Fairness', 'AI Governance'],
  }),
  role({
    slug: 'ai-evaluation-intern', departmentId: 'ai-research', title: 'AI Evaluation Intern', noOfInterns: 3,
    about: 'Rigorous evaluation — knowing whether a model actually got better, not just different — is the unglamorous discipline that makes every other AI claim credible.',
    responsibilities: ['Build and maintain evaluation benchmarks for our AI features.', 'Support automated regression-testing pipelines for model changes.', 'Assist in designing human-evaluation protocols where automated metrics fall short.', 'Document evaluation methodology and results.', 'Flag regressions and false-positive improvements honestly.'],
    skills: ['Python', 'Evaluation metric design', 'Statistical testing basics', 'Benchmark construction', 'Documentation'],
    learningOutcomes: ['AI Evaluation Methodology', 'Benchmark Construction', 'Regression-Testing Pipelines', 'Human-Evaluation Protocol Design'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Data Science', 'Statistics', 'Any Relevant Discipline'],
    keywords: ['AI Evaluation', 'Model Benchmarking', 'Regression Testing', 'ML Evaluation'],
  }),
  role({
    slug: 'ai-infrastructure-intern', departmentId: 'ai-research', title: 'AI Infrastructure Intern', noOfInterns: 3,
    about: 'The infrastructure behind AI research — training pipelines, experiment tracking, compute scheduling — determines how fast the research team can actually iterate.',
    responsibilities: ['Support building and maintaining ML training/experiment pipelines.', 'Assist in setting up experiment-tracking and reproducibility tooling.', 'Help manage compute scheduling for training and inference jobs.', 'Document infrastructure setup and troubleshooting guides.', 'Support cost/performance monitoring of AI infrastructure.'],
    skills: ['Python', 'ML pipeline tools (MLflow/Weights & Biases or equivalent)', 'Docker basics', 'Cloud/GPU compute basics', 'Documentation'],
    learningOutcomes: ['ML Pipeline Engineering', 'Experiment Tracking & Reproducibility', 'Compute Scheduling', 'AI Infrastructure Cost Monitoring'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['AI Infrastructure', 'MLOps', 'ML Pipelines', 'Experiment Tracking'],
  }),
  role({
    slug: 'ai-research-scientist-intern', departmentId: 'ai-research', title: 'AI Research Scientist Intern', noOfInterns: 3,
    about: 'A research-track internship for students aiming at genuine scientific contribution — designing experiments, forming hypotheses, and writing up results to the standard of a workshop paper.',
    responsibilities: ['Design and run original AI research experiments under mentor supervision.', 'Conduct thorough literature review to position new work correctly.', 'Support writing up results in paper-style format.', 'Present findings in internal research seminars.', 'Maintain rigorous experiment logs and reproducibility standards.'],
    skills: ['Python', 'Research methodology', 'Experimental design', 'Academic writing', 'Statistics', 'Literature review'],
    learningOutcomes: ['Original AI Research Design', 'Academic-Style Research Writing', 'Experimental Rigor & Reproducibility', 'Research Presentation'],
    qualificationType: UGPG, qualifications: ["Master's Degree", 'PhD Candidate', "Bachelor's Degree (final year)"],
    specialisations: ['Computer Science', 'Artificial Intelligence', 'Machine Learning', 'Any Relevant Discipline'],
    keywords: ['AI Research', 'Research Scientist', 'Machine Learning Research', 'Academic Research'],
  }),
];

// =====================================================================================
// CYBER INTELLIGENCE (fits the existing cybersecurity department)
// =====================================================================================
const CYBER_INTELLIGENCE: CatalogRole[] = [
  role({
    slug: 'threat-intelligence-intern', departmentId: 'cybersecurity', title: 'Threat Intelligence Intern', noOfInterns: 3,
    about: 'Understanding attacker tactics before they hit us — tracking threat actors, indicators of compromise, and emerging attack patterns relevant to an education platform holding sensitive applicant and student data.',
    responsibilities: ['Research current threat-actor tactics, techniques, and procedures (TTPs).', 'Support tracking of indicators of compromise (IoCs) relevant to our stack.', 'Assist in building threat-intelligence briefs for the security team.', 'Document findings and recommended defensive measures.', 'Support threat-modelling exercises for new features.'],
    skills: ['Threat intelligence frameworks (MITRE ATT&CK)', 'OSINT research', 'Security fundamentals', 'Documentation', 'Analytical thinking'],
    learningOutcomes: ['Threat Actor & TTP Research', 'IoC Tracking', 'Threat-Intelligence Briefing', 'Threat Modelling'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Threat Intelligence', 'MITRE ATT&CK', 'OSINT', 'Cybersecurity'],
  }),
  role({
    slug: 'digital-forensics-intern', departmentId: 'cybersecurity', title: 'Digital Forensics Intern', noOfInterns: 2,
    about: 'Digital forensics — reconstructing what happened after a security incident — is a precise, evidence-driven discipline students can practise on real (sanitised) case studies.',
    responsibilities: ['Support forensic analysis of security incidents (log analysis, timeline reconstruction).', 'Assist in maintaining chain-of-custody documentation practices.', 'Research forensic tools and methodologies.', 'Document findings clearly for both technical and non-technical audiences.', 'Support tabletop incident-response exercises.'],
    skills: ['Digital forensics fundamentals', 'Log analysis', 'Linux command line', 'Documentation', 'Attention to detail'],
    learningOutcomes: ['Forensic Analysis Methodology', 'Log Analysis & Timeline Reconstruction', 'Chain-of-Custody Documentation', 'Incident Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Digital Forensics', 'Incident Response', 'Log Analysis', 'Cybersecurity'],
  }),
  role({
    slug: 'malware-analysis-intern', departmentId: 'cybersecurity', title: 'Malware Analysis Intern', noOfInterns: 2,
    about: 'Understanding how malware works — statically and dynamically — in a safe, sandboxed environment, building the analytical skill that underlies effective defence.',
    responsibilities: ['Support static and dynamic analysis of malware samples in sandboxed environments.', 'Assist in documenting malware behaviour and indicators.', 'Research malware families and evasion techniques.', 'Maintain strict lab-safety and containment practices.', 'Document analysis reports for the security team.'],
    skills: ['Malware analysis fundamentals', 'Sandboxing tools', 'Reverse-engineering basics', 'Documentation', 'Lab-safety discipline'],
    learningOutcomes: ['Static & Dynamic Malware Analysis', 'Sandboxed Lab Practices', 'Malware Behaviour Documentation', 'Evasion-Technique Awareness'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Malware Analysis', 'Reverse Engineering', 'Sandboxing', 'Cybersecurity'],
  }),
  role({
    slug: 'soc-analyst-intern', departmentId: 'cybersecurity', title: 'SOC Analyst Intern', noOfInterns: 3,
    about: 'Security Operations Centre work — monitoring, triaging, and escalating alerts — is the frontline discipline of practical cybersecurity, applied to our own live systems.',
    responsibilities: ['Monitor security alerts and logs for anomalies.', 'Support triage and escalation of security events.', 'Assist in tuning alert rules to reduce false positives.', 'Document incident-response runbooks.', 'Support shift handover reporting practices.'],
    skills: ['SIEM tools basics', 'Log monitoring', 'Alert triage', 'Security fundamentals', 'Documentation'],
    learningOutcomes: ['SOC Monitoring & Triage', 'Alert Rule Tuning', 'Incident Runbook Documentation', 'Security Operations Practice'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['SOC Analyst', 'SIEM', 'Security Monitoring', 'Cybersecurity'],
  }),
  role({
    slug: 'penetration-testing-intern', departmentId: 'cybersecurity', title: 'Penetration Testing Intern', noOfInterns: 3,
    about: 'Authorised, scoped penetration testing of our own systems — finding weaknesses before an attacker does, under strict rules of engagement.',
    responsibilities: ['Support scoped, authorised penetration tests of internal systems.', 'Assist in vulnerability identification and exploitation (within approved scope).', 'Document findings with clear reproduction steps and severity ratings.', 'Support remediation verification after fixes are applied.', 'Follow strict rules-of-engagement and authorisation protocols at all times.'],
    skills: ['Penetration testing fundamentals', 'Common vulnerability classes (OWASP Top 10)', 'Security tools (Burp Suite/nmap or equivalent)', 'Report writing', 'Ethical discipline'],
    learningOutcomes: ['Authorised Penetration Testing Methodology', 'Vulnerability Identification & Reporting', 'Remediation Verification', 'Ethical Security Practice'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Penetration Testing', 'Ethical Hacking', 'OWASP', 'Vulnerability Assessment'],
    eligibilityExtra: ['All testing is strictly scoped and authorised in writing; interns work only within approved boundaries.'],
  }),
  role({
    slug: 'incident-response-intern', departmentId: 'cybersecurity', title: 'Incident Response Intern', noOfInterns: 2,
    about: 'When something does go wrong, structured incident response — containment, eradication, recovery, and honest post-mortems — is what limits real-world damage.',
    responsibilities: ['Support incident-response process documentation and drills.', 'Assist in post-incident review and root-cause analysis.', 'Research incident-response frameworks and best practices.', 'Document lessons learned and remediation action items.', 'Support communication templates for incident stakeholders.'],
    skills: ['Incident response frameworks (NIST/SANS)', 'Root-cause analysis', 'Documentation', 'Crisis communication basics', 'Process design'],
    learningOutcomes: ['Incident Response Process Design', 'Root-Cause Analysis', 'Post-Incident Review', 'Incident Communication'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Incident Response', 'Security Operations', 'Root Cause Analysis', 'Cybersecurity'],
  }),
  role({
    slug: 'cloud-security-intern', departmentId: 'cybersecurity', title: 'Cloud Security Intern', noOfInterns: 3,
    about: 'Our infrastructure runs on cloud platforms — securing that surface (access controls, misconfigurations, secrets management) is where most real-world breaches actually happen.',
    responsibilities: ['Support cloud-configuration security reviews (access controls, network rules).', 'Assist in identifying and remediating cloud misconfigurations.', 'Research cloud-security best practices (CIS benchmarks or equivalent).', 'Support secrets-management and least-privilege access reviews.', 'Document findings and remediation guidance.'],
    skills: ['Cloud platforms (AWS/GCP/Azure basics)', 'IAM/access-control concepts', 'Cloud security benchmarks', 'Documentation', 'Analytical thinking'],
    learningOutcomes: ['Cloud Configuration Security Review', 'Misconfiguration Remediation', 'IAM & Least-Privilege Practices', 'Cloud Security Benchmarking'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Cloud Computing', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Cloud Security', 'AWS Security', 'IAM', 'Cybersecurity'],
  }),
  role({
    slug: 'identity-access-management-intern', departmentId: 'cybersecurity', title: 'Identity & Access Management Intern', noOfInterns: 2,
    about: 'Who can access what, and why — IAM is the quiet discipline behind our own self-built authentication (WebAuthn, TOTP, face 2FA) and every internal system permission.',
    responsibilities: ['Support access-review audits across internal systems.', 'Assist in documenting role-based access control (RBAC) policies.', 'Research IAM best practices and standards (OAuth2/OIDC).', 'Support least-privilege access recommendations.', 'Document IAM findings and remediation guidance.'],
    skills: ['IAM fundamentals', 'RBAC concepts', 'OAuth2/OIDC awareness', 'Access-review methodology', 'Documentation'],
    learningOutcomes: ['IAM Access-Review Methodology', 'RBAC Policy Documentation', 'OAuth2/OIDC Standards', 'Least-Privilege Design'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Cybersecurity', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Identity & Access Management', 'IAM', 'RBAC', 'OAuth2', 'Cybersecurity'],
  }),
];

// =====================================================================================
// DATA (new department: data-platform)
// =====================================================================================
const DATA_PLATFORM: CatalogRole[] = [
  role({
    slug: 'data-governance-intern', departmentId: 'data-platform', title: 'Data Governance Intern', noOfInterns: 2,
    about: 'As our data footprint grows across applications, HR, and research, data governance — ownership, access policy, retention — becomes a genuine operational need.',
    responsibilities: ['Support documentation of data-ownership and stewardship policies.', 'Assist in mapping data flows across our systems.', 'Research data-governance frameworks relevant to education platforms.', 'Support data-retention and deletion-policy documentation.', 'Coordinate with engineering on governance implementation.'],
    skills: ['Data governance fundamentals', 'Data mapping', 'Policy documentation', 'Stakeholder coordination', 'Analytical thinking'],
    learningOutcomes: ['Data Governance Frameworks', 'Data Flow Mapping', 'Retention Policy Design', 'Cross-Team Governance Coordination'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Information Systems', 'Any Relevant Discipline'],
    keywords: ['Data Governance', 'Data Policy', 'Data Stewardship', 'Data Management'],
  }),
  role({
    slug: 'data-stewardship-intern', departmentId: 'data-platform', title: 'Data Stewardship Intern', noOfInterns: 2,
    about: 'Hands-on data stewardship — the day-to-day work of keeping datasets accurate, documented, and trustworthy for the teams that rely on them.',
    responsibilities: ['Support data-dictionary and metadata documentation.', 'Assist in identifying and resolving data-quality issues.', 'Coordinate with data owners across teams on stewardship practices.', 'Document data lineage for key datasets.', 'Support onboarding material for new data consumers.'],
    skills: ['Data stewardship practices', 'Metadata documentation', 'SQL basics', 'Data-quality checks', 'Communication'],
    learningOutcomes: ['Data Stewardship Practice', 'Metadata & Data-Dictionary Documentation', 'Data-Quality Issue Resolution', 'Data Lineage Tracking'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Information Systems', 'Any Relevant Discipline'],
    keywords: ['Data Stewardship', 'Metadata Management', 'Data Quality', 'Data Governance'],
  }),
  role({
    slug: 'master-data-management-intern', departmentId: 'data-platform', title: 'Master Data Management Intern', noOfInterns: 2,
    about: 'Master data management — keeping one trustworthy version of core entities (users, roles, institutions) instead of conflicting copies scattered across systems.',
    responsibilities: ['Support identification of master-data entities across our systems (users, roles, institutions).', 'Assist in de-duplication and data-matching exercises.', 'Research MDM tools and methodologies.', 'Document master-data models and ownership.', 'Support data-quality reporting for master datasets.'],
    skills: ['MDM fundamentals', 'Data matching/de-duplication', 'SQL', 'Data modelling basics', 'Documentation'],
    learningOutcomes: ['Master Data Management Fundamentals', 'Data Matching & De-duplication', 'Master Data Modelling', 'Data Quality Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Master Data Management', 'MDM', 'Data Modelling', 'Data Quality'],
  }),
  role({
    slug: 'data-quality-intern', departmentId: 'data-platform', title: 'Data Quality Intern', noOfInterns: 2,
    about: 'Building automated checks that catch bad data before it reaches a dashboard or a decision — a foundational discipline for every downstream analytics and AI effort.',
    responsibilities: ['Build and maintain automated data-quality checks/tests.', 'Support root-cause investigation of data-quality issues.', 'Assist in defining data-quality metrics and SLAs.', 'Document data-quality monitoring dashboards.', 'Coordinate with engineering teams on upstream fixes.'],
    skills: ['SQL', 'Python', 'Data-quality frameworks (Great Expectations or equivalent)', 'Root-cause analysis', 'Dashboarding basics'],
    learningOutcomes: ['Automated Data-Quality Testing', 'Data-Quality Metric Design', 'Root-Cause Investigation', 'Data-Quality Monitoring'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Data Quality', 'Data Testing', 'Data Engineering', 'Data Monitoring'],
  }),
  role({
    slug: 'big-data-engineering-intern', departmentId: 'data-platform', title: 'Big Data Engineering Intern', noOfInterns: 3,
    about: 'As our platform data grows (applications, learning events, assessments), building pipelines that scale becomes a real engineering problem, not a theoretical one.',
    responsibilities: ['Support building and maintaining data pipelines for growing platform datasets.', 'Assist in optimising query and pipeline performance at scale.', 'Research big-data tools relevant to our scale (not over-engineering for a scale we do not have).', 'Document pipeline architecture and data flow.', 'Support data-pipeline monitoring and alerting.'],
    skills: ['Python/SQL', 'Data pipeline tools (Airflow or equivalent)', 'Distributed data-processing basics', 'Performance optimisation', 'Documentation'],
    learningOutcomes: ['Data Pipeline Engineering', 'Pipeline Performance Optimisation', 'Big-Data Tooling Evaluation', 'Pipeline Monitoring'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Data Engineering', 'Any Relevant Discipline'],
    keywords: ['Big Data Engineering', 'Data Pipelines', 'Airflow', 'Data Engineering'],
  }),
  role({
    slug: 'data-platform-intern', departmentId: 'data-platform', title: 'Data Platform Intern', noOfInterns: 2,
    about: 'Supporting the shared infrastructure — warehouses, access layers, tooling — that every team\'s analytics and AI work depends on.',
    responsibilities: ['Support maintenance of the data warehouse/platform infrastructure.', 'Assist in provisioning data access for internal teams.', 'Research data-platform tooling and cost-optimisation opportunities.', 'Document platform architecture and runbooks.', 'Support platform reliability monitoring.'],
    skills: ['SQL', 'Data warehousing concepts', 'Cloud data platforms basics', 'Documentation', 'Reliability monitoring basics'],
    learningOutcomes: ['Data Platform Architecture', 'Data Access Provisioning', 'Platform Cost Optimisation', 'Platform Reliability Monitoring'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Data Platform', 'Data Warehousing', 'Data Infrastructure', 'Data Engineering'],
  }),
  role({
    slug: 'data-visualization-intern', departmentId: 'data-platform', title: 'Data Visualization Intern', noOfInterns: 3,
    about: 'Turning raw platform data — applications, learning progress, HR metrics — into dashboards that actually help people make decisions, not just look impressive.',
    responsibilities: ['Build dashboards and visualisations for internal stakeholders.', 'Support requirements-gathering with dashboard users.', 'Assist in choosing the right chart/visualisation for each question.', 'Document dashboard definitions and data sources.', 'Iterate on dashboards based on user feedback.'],
    skills: ['Data visualisation tools (Power BI/Tableau/Looker or equivalent)', 'SQL', 'Visual design principles', 'Stakeholder communication', 'Documentation'],
    learningOutcomes: ['Dashboard Design & Development', 'Visualisation Best Practices', 'Stakeholder Requirements Gathering', 'Iterative Dashboard Improvement'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Design', 'Any Relevant Discipline'],
    keywords: ['Data Visualization', 'Dashboards', 'Power BI', 'Tableau', 'Data Analytics'],
  }),
  role({
    slug: 'decision-intelligence-intern', departmentId: 'data-platform', title: 'Decision Intelligence Intern', noOfInterns: 2,
    about: 'Beyond dashboards — decision intelligence combines data, models, and business context to actually recommend a decision, not just report a number.',
    responsibilities: ['Support building decision-support models for internal business questions.', 'Assist in framing ambiguous business problems as data questions.', 'Research decision-intelligence frameworks and case studies.', 'Document model assumptions and limitations honestly.', 'Present recommendations to stakeholders with clear reasoning.'],
    skills: ['Python/R', 'Statistics', 'Decision-modelling frameworks', 'Business-problem framing', 'Communication'],
    learningOutcomes: ['Decision Intelligence Frameworks', 'Business-Problem Framing', 'Decision-Support Modelling', 'Recommendation Communication'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Business Analytics', 'Any Relevant Discipline'],
    keywords: ['Decision Intelligence', 'Decision Support', 'Data Science', 'Business Analytics'],
  }),
];

// =====================================================================================
// CLOUD & INFRASTRUCTURE (fits the existing engineering department)
// =====================================================================================
const CLOUD_INFRASTRUCTURE: CatalogRole[] = [
  role({
    slug: 'platform-engineering-intern', departmentId: 'engineering', title: 'Platform Engineering Intern', noOfInterns: 3,
    about: 'Platform engineering builds the internal tools and paved paths that let our product teams ship faster and more safely — a distinct discipline from application feature work.',
    responsibilities: ['Support building internal developer tools and platform capabilities.', 'Assist in improving CI/CD pipelines for product teams.', 'Research platform-engineering patterns (self-service infrastructure, golden paths).', 'Document platform tooling and onboarding guides.', 'Support developer-experience feedback loops.'],
    skills: ['CI/CD tools', 'Infrastructure as code basics', 'Scripting (Python/Bash)', 'Developer-tooling design', 'Documentation'],
    learningOutcomes: ['Platform Engineering Patterns', 'CI/CD Pipeline Improvement', 'Internal Developer Tooling', 'Developer Experience Design'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['Platform Engineering', 'CI/CD', 'Developer Experience', 'Infrastructure'],
  }),
  role({
    slug: 'site-reliability-engineering-intern', departmentId: 'engineering', title: 'Site Reliability Engineering (SRE) Intern', noOfInterns: 3,
    about: 'Keeping the platform actually up — monitoring, incident response, and reliability engineering for real production systems serving real applicants and students.',
    responsibilities: ['Support uptime/reliability monitoring for production systems.', 'Assist in defining and tracking SLOs/SLIs.', 'Support incident-response and post-mortem documentation.', 'Research reliability-engineering best practices.', 'Support capacity-planning and load-testing exercises.'],
    skills: ['Monitoring/observability tools', 'Linux fundamentals', 'Incident-response practices', 'SLO/SLI concepts', 'Scripting'],
    learningOutcomes: ['SRE Practices & SLO Design', 'Production Monitoring', 'Incident Response & Post-Mortems', 'Capacity Planning'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['Site Reliability Engineering', 'SRE', 'Observability', 'Incident Response'],
  }),
  role({
    slug: 'infrastructure-engineering-intern', departmentId: 'engineering', title: 'Infrastructure Engineering Intern', noOfInterns: 3,
    about: 'The foundational infrastructure — servers, networking, deployment pipelines — that everything else at EduRankAI runs on top of.',
    responsibilities: ['Support infrastructure provisioning and configuration management.', 'Assist in maintaining deployment pipelines.', 'Research infrastructure-as-code tools and practices.', 'Document infrastructure architecture and runbooks.', 'Support infrastructure cost and performance monitoring.'],
    skills: ['Infrastructure as code (Terraform or equivalent)', 'Linux fundamentals', 'Networking basics', 'Cloud platforms', 'Documentation'],
    learningOutcomes: ['Infrastructure as Code', 'Deployment Pipeline Management', 'Infrastructure Architecture', 'Cost/Performance Monitoring'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['Infrastructure Engineering', 'Terraform', 'Cloud Infrastructure', 'DevOps'],
  }),
  role({
    slug: 'kubernetes-intern', departmentId: 'engineering', title: 'Kubernetes Intern', noOfInterns: 2,
    about: 'Hands-on container-orchestration internship — deploying, scaling, and debugging services on Kubernetes, a genuinely deep and marketable skill.',
    responsibilities: ['Support deployment and configuration of services on Kubernetes.', 'Assist in debugging pod/service issues.', 'Research Kubernetes best practices (resource limits, autoscaling, networking).', 'Document Kubernetes runbooks and troubleshooting guides.', 'Support cluster monitoring and cost optimisation.'],
    skills: ['Kubernetes fundamentals', 'Docker', 'YAML/Helm basics', 'Linux', 'Debugging'],
    learningOutcomes: ['Kubernetes Deployment & Configuration', 'Container Debugging', 'Cluster Resource Management', 'Kubernetes Networking Basics'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['Kubernetes', 'Container Orchestration', 'Docker', 'DevOps'],
  }),
  role({
    slug: 'cloud-architecture-intern', departmentId: 'engineering', title: 'Cloud Architecture Intern', noOfInterns: 2,
    about: 'Designing how systems should be structured in the cloud — a design discipline distinct from day-to-day infrastructure operations.',
    responsibilities: ['Support architecture design for new cloud-based features.', 'Assist in evaluating trade-offs between cloud services and patterns.', 'Research cloud-architecture reference patterns relevant to our scale.', 'Document architecture decision records.', 'Support cost-modelling for proposed architectures.'],
    skills: ['Cloud architecture patterns', 'System design fundamentals', 'Cost modelling', 'Documentation', 'Trade-off analysis'],
    learningOutcomes: ['Cloud Architecture Design', 'System Design Trade-Off Analysis', 'Architecture Decision Records', 'Cloud Cost Modelling'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['Cloud Architecture', 'System Design', 'Cloud Computing', 'Architecture Design'],
  }),
  role({
    slug: 'finops-intern', departmentId: 'engineering', title: 'FinOps Intern', noOfInterns: 2,
    about: 'FinOps — making cloud spending visible, accountable, and optimised — matters directly to us as a self-funded company where every rupee of infrastructure cost is real.',
    responsibilities: ['Support cloud-cost analysis and reporting.', 'Assist in identifying cost-optimisation opportunities (rightsizing, reserved capacity).', 'Research FinOps frameworks and tooling.', 'Document cost-allocation practices across teams/products.', 'Present cost-savings recommendations to engineering leadership.'],
    skills: ['Cloud billing/cost tools', 'Spreadsheet modelling', 'FinOps fundamentals', 'Analytical thinking', 'Communication'],
    learningOutcomes: ['FinOps Fundamentals', 'Cloud Cost Analysis', 'Cost-Optimisation Recommendations', 'Cost Allocation Practices'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Finance', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['FinOps', 'Cloud Cost Optimisation', 'Cloud Financial Management', 'Cost Analysis'],
  }),
  role({
    slug: 'observability-intern', departmentId: 'engineering', title: 'Observability Intern', noOfInterns: 2,
    about: 'Building the logs, metrics, and traces that let engineers actually understand what a distributed system is doing — the difference between guessing and knowing during an incident.',
    responsibilities: ['Support instrumentation of services with logs, metrics, and traces.', 'Assist in building observability dashboards and alerts.', 'Research observability tools and best practices (OpenTelemetry or equivalent).', 'Document observability standards for engineering teams.', 'Support root-cause investigation using observability data.'],
    skills: ['Observability tools (Prometheus/Grafana/OpenTelemetry or equivalent)', 'Logging/metrics/tracing concepts', 'Scripting', 'Documentation', 'Analytical thinking'],
    learningOutcomes: ['Service Instrumentation', 'Observability Dashboard & Alert Design', 'Observability Standards', 'Root-Cause Investigation Using Telemetry'],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Software Engineering', 'Any Relevant Discipline'],
    keywords: ['Observability', 'OpenTelemetry', 'Monitoring', 'DevOps'],
  }),
];

export const INTERN_CATALOG_PHASE3_BATCH1: CatalogRole[] = [
  ...ARTIFICIAL_INTELLIGENCE,
  ...CYBER_INTELLIGENCE,
  ...DATA_PLATFORM,
  ...CLOUD_INFRASTRUCTURE,
];

export const PHASE3_DEPARTMENTS_BATCH1 = [
  { id: 'data-platform', name: 'Data Platform & Governance', icon: 'database', description: 'Data governance, quality, master-data management, and the platform infrastructure every analytics and AI effort depends on.' },
];

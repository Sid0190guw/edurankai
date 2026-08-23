// src/data/intern-catalog-biz2.ts — Commercial, competitive and corporate intelligence.
// Twelve roles covering the evidence side of commercial work: buying conditions, customer and
// revenue evidence, entity-level corporate records, strategic foresight, the contact record layer,
// account dossiers, the sales fact base, an internal information service, reproducible
// benchmarking, transaction diligence, and contact coverage building.
// Cross-checked against the existing catalog (role-catalog.ts, intern-catalog.ts and
// intern-catalog-phase2..phase5.ts) before writing: every slug below is new, and where a title sits
// next to an existing one — Business Intelligence, Competitive Intelligence, Market Intelligence,
// Executive Intelligence, Revenue Strategy, Sales Operations, Sales Enablement — the about text
// states the boundary explicitly rather than restating the neighbouring role.
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
    keywords: r.keywords,
    noOfInterns: r.noOfInterns,
    perks: [...STANDARD_PERKS, ...(r.perksExtra || [])],
    ...STANDARD_TERMS,
  };
}

const UGPG = 'UG / PG';
const BIZ_QUALIFICATIONS = ["Any Bachelor's Degree", 'BBA / B.Com / BA', 'MBA / PGDM', "Any Master's Degree"];
const ANALYTIC_QUALIFICATIONS = ["Any Bachelor's Degree", 'B.Sc. in Statistics, Economics or Mathematics', 'MBA / PGDM', "Any Master's Degree"];
const LEGAL_QUALIFICATIONS = ['LLB / BA LLB', 'B.Com / BBA', 'Company Secretaryship or Chartered Accountancy (pursuing or qualified)', "Any Master's Degree"];
const INFO_QUALIFICATIONS = ["Any Bachelor's Degree", 'Bachelor or Master of Library and Information Science', "Any Master's Degree", 'Diploma'];

// =====================================================================================
// COMMERCIAL, COMPETITIVE AND CORPORATE INTELLIGENCE
// =====================================================================================
export const INTERN_CATALOG_BIZ2: CatalogRole[] = [
  role({
    slug: 'commercial-intelligence-intern', departmentId: 'sales-bd', title: 'Commercial Intelligence Intern', noOfInterns: 3,
    about: 'Commercial intelligence is the read on how institutions actually buy — procurement calendars, tender notices, budget release cycles, and the commercial terms that appear in published contracts. This role is deliberately narrower than market or competitive intelligence: it is about buying conditions and commercial terms, not category size or rival positioning. You will track public tender portals, university and state-board procurement announcements and published pricing schedules, and turn them into a commercial picture the partnerships team can act on. All work is public-source; nothing here involves misrepresentation or approaching a party under a false description.',
    responsibilities: [
      'Monitor public tender and procurement portals for education, training and technology notices relevant to our programmes, logging each with deadline, value band and issuing body.',
      'Maintain a rolling calendar of institutional budget and procurement cycles so proposals are timed to when funds are actually allocated.',
      'Extract commercial terms from published contracts and tender documents — payment schedules, service levels, penalty clauses — into a single comparable structure.',
      'Build and maintain a reference file of publicly observable pricing and packaging models in adjacent education and training categories.',
      'Flag eligibility criteria such as turnover thresholds, prior-experience requirements and empanelment rules that would exclude us from a tender, and raise them early.',
      'Prepare a fortnightly commercial briefing covering new opportunities, closing windows and terms worth negotiating.',
      'Record the source and retrieval date for every fact, so any statement in a briefing can be traced back to its document.',
    ],
    skills: ['Public tender and procurement research', 'Document analysis and clause extraction', 'Structured note-taking with source citation', 'Advanced spreadsheet work including pivots and lookups', 'Commercial and pricing literacy', 'Briefing writing', 'Deadline tracking', 'Research ethics and public-source discipline', 'Basic contract vocabulary', 'Time management'],
    learningOutcomes: ['Public Procurement and Tender Analysis', 'Commercial Terms Interpretation', 'Pricing and Packaging Research', 'Briefing Writing for Commercial Decisions', 'Source Traceability Discipline'],
    qualificationType: UGPG, qualifications: BIZ_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Commerce', 'Economics', 'Public Policy', 'Any Relevant Discipline'],
    keywords: ['Commercial Intelligence', 'Tender Research', 'Procurement Analysis', 'Bid Intelligence', 'Pricing Research', 'Contract Terms', 'Budget Cycles', 'Public Sources', 'Business Research', 'Commercial Briefing'],
  }),
  role({
    slug: 'customer-intelligence-intern', departmentId: 'operations', title: 'Customer Intelligence Intern', noOfInterns: 3,
    about: 'Customer intelligence is the evidence base about the learners and institutions already using our platform — who they are, how they behave, and why they stay or leave. The customer success and support teams resolve individual cases; this role looks across all of them and finds the pattern. You will code support tickets and interview transcripts into consistent themes, maintain segment profiles, and identify the behavioural signals that appear before an account disengages. Findings go to product and operations as documented evidence rather than opinion.',
    responsibilities: [
      'Code support tickets, cancellation reasons and interview transcripts against a documented theme taxonomy, and keep that taxonomy maintained.',
      'Build and refresh segment profiles for our main learner and institutional customer types each month.',
      'Analyse product-usage data to identify behavioural signals that precede disengagement, dormancy or renewal.',
      'Run structured customer interviews from a prepared discussion guide and write neutral, quotable summaries.',
      'Maintain a searchable repository of customer evidence so teams can find what has already been asked before commissioning new research.',
      'Track satisfaction and effort measures over time and explain movements with supporting evidence rather than speculation.',
      'Present a monthly customer-intelligence review to the product and operations teams.',
      'Handle all customer data under our privacy rules, including anonymisation and aggregation in anything shared internally.',
    ],
    skills: ['Qualitative coding and thematic analysis', 'Customer interviewing', 'Survey design', 'SQL or spreadsheet-based analysis', 'Cohort and retention analysis basics', 'Data-privacy awareness', 'Report writing', 'Dashboard building', 'Repository and note discipline', 'Neutrality in reporting'],
    learningOutcomes: ['Qualitative Coding and Thematic Analysis', 'Customer Segmentation', 'Churn-Signal Identification', 'Evidence Repository Design', 'Privacy-Aware Customer Reporting'],
    qualificationType: UGPG, qualifications: ANALYTIC_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Psychology', 'Statistics', 'Sociology', 'Marketing', 'Any Relevant Discipline'],
    keywords: ['Customer Intelligence', 'Voice of Customer', 'Segmentation', 'Churn Analysis', 'Qualitative Coding', 'Customer Insights', 'Retention Analysis', 'Survey Research', 'Interview Research', 'Customer Analytics'],
  }),
  role({
    slug: 'revenue-intelligence-intern', departmentId: 'sales-bd', title: 'Revenue Intelligence Intern', noOfInterns: 2,
    about: 'Revenue intelligence instruments the revenue motion that already exists — where deals slow, where value leaks between quote and collection, and which reasons genuinely explain a loss. It is separate from revenue strategy, which plans where future revenue should come from, and from sales operations, which runs the systems; this role interrogates the recorded evidence of what actually happened. You will reconstruct stage-by-stage conversion, measure cycle length by segment, and code win and loss reasons from call notes into categories that survive scrutiny. Everything published is reconciled against finance records first.',
    responsibilities: [
      'Reconstruct the pipeline funnel stage by stage and calculate conversion, drop-off and cycle length for each segment.',
      'Code closed-won and closed-lost deals against a documented reason taxonomy, using call notes and correspondence rather than a one-line summary.',
      'Quantify revenue leakage across quote, contract, invoice and collection, and identify where the largest losses occur.',
      'Publish a monthly revenue-intelligence pack containing the three findings most likely to change a decision, each with its evidence.',
      'Reconcile every figure against finance records before publication and document each reconciliation difference.',
      'Test forecast accuracy after the fact by comparing what was predicted with what closed, and report the gap honestly.',
      'Maintain the metric definitions document so terms such as qualified, committed and closed mean the same thing to every team.',
    ],
    skills: ['SQL', 'Advanced spreadsheet modelling', 'Funnel and cohort analysis', 'Win and loss analysis methodology', 'CRM data structures', 'Data reconciliation', 'Dashboard and report building', 'Statistical literacy', 'Written analysis', 'Healthy scepticism about data quality'],
    learningOutcomes: ['Pipeline and Funnel Analysis', 'Win and Loss Methodology', 'Revenue Leakage Detection', 'Forecast-Accuracy Measurement', 'Metric Definition Governance'],
    qualificationType: UGPG, qualifications: ANALYTIC_QUALIFICATIONS,
    specialisations: ['Commerce', 'Economics', 'Statistics', 'Business Analytics', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Revenue Intelligence', 'Pipeline Analysis', 'Win Loss Analysis', 'Conversion Analysis', 'Forecast Accuracy', 'Revenue Leakage', 'Sales Analytics', 'Funnel Metrics', 'CRM Data', 'Metric Definitions'],
  }),
  role({
    slug: 'corporate-intelligence-intern', departmentId: 'governance-affairs', title: 'Corporate Intelligence Intern', noOfInterns: 2,
    about: 'Corporate intelligence is entity-level fact-finding: who actually owns and controls the organisations we partner with, buy from or sell to. You will work from public registry filings, annual returns, accreditation registers and court listings to build standing profiles of corporate and institutional entities, and keep those profiles current as directors change and groups restructure. This is a continuous monitoring role; the bounded, transaction-specific diligence pack is a separate role in this catalogue. Every finding must be tied to a dated source document, and inference must never be presented as verified fact.',
    responsibilities: [
      'Build standing entity profiles from public registry filings covering incorporation details, registered office, directors, shareholding and group structure.',
      'Map corporate group relationships including holding, subsidiary and associate links, and represent them so a non-specialist can follow them.',
      'Monitor public court listings, regulatory orders and accreditation registers for changes affecting entities on our watchlist.',
      'Maintain the watchlist with defined triggers, so a change in directorship or registration status raises an alert rather than being noticed months later.',
      'Verify claims made by counterparties about size, ownership or accreditation against primary records.',
      'Write entity notes that separate verified facts, unverified claims and open questions into distinct sections.',
      'Keep an audit trail for every source document, including retrieval date and how it was accessed.',
      'Escalate findings with legal or reputational implications to the governance team promptly and without editorialising.',
    ],
    skills: ['Company registry research', 'Reading annual returns and financial statements', 'Corporate structure mapping', 'Public records and court-listing research', 'Source verification', 'Structured note-writing', 'Records management', 'Attention to detail', 'Discretion and confidentiality', 'Basic corporate law vocabulary'],
    learningOutcomes: ['Corporate Registry Research', 'Ownership and Group-Structure Mapping', 'Public-Records Verification', 'Watchlist and Monitoring Design', 'Separating Fact from Claim in Reporting'],
    qualificationType: UGPG, qualifications: LEGAL_QUALIFICATIONS,
    specialisations: ['Law', 'Commerce', 'Company Secretaryship', 'Business Administration', 'Economics', 'Any Relevant Discipline'],
    keywords: ['Corporate Intelligence', 'Company Records', 'Registry Research', 'Ownership Structure', 'Entity Profiling', 'Public Records', 'Compliance Research', 'Watchlist Monitoring', 'Corporate Governance', 'Counterparty Verification'],
  }),
  role({
    slug: 'strategic-intelligence-intern', departmentId: 'executive-office', title: 'Strategic Intelligence Intern', noOfInterns: 2,
    about: 'Strategic intelligence works on an eighteen to thirty-six month horizon: regulatory direction, technology trajectories, demographic and enrolment shifts, and what each would mean for us. It is not the daily executive briefing, which another role in this catalogue covers; here the output is written scenarios, early-warning indicators and the assumptions underneath them. You will define indicator sets that show when a scenario is becoming more likely, and revisit them on a schedule so change is noticed before it is obvious. Briefs are expected to state plainly what evidence would change our mind.',
    responsibilities: [
      'Track regulatory consultations, policy drafts and standards work relevant to education, credentials and applied AI.',
      'Maintain a small set of written scenarios for how our operating environment could develop, each with its assumptions named.',
      'Define early-warning indicators for each scenario and report movement against them monthly.',
      'Produce horizon-scanning notes on technology and demographic trends that distinguish evidence from extrapolation.',
      'Challenge internal strategic assumptions in writing where the available evidence does not support them.',
      'Maintain a register of institutions, journals, statistical releases and public datasets worth watching, pruning sources that go stale.',
      'Prepare a quarterly strategic brief for the executive office, closing with the conditions that would falsify its conclusions.',
    ],
    skills: ['Horizon scanning', 'Scenario planning', 'Policy and regulatory reading', 'Trend analysis with public datasets', 'Structured analytic techniques', 'Assumption testing', 'Executive-level writing', 'Presentation', 'Source evaluation', 'Long-form synthesis'],
    learningOutcomes: ['Scenario Planning', 'Horizon Scanning', 'Early-Warning Indicator Design', 'Structured Analytic Techniques', 'Executive Brief Writing'],
    qualificationType: UGPG, qualifications: BIZ_QUALIFICATIONS,
    specialisations: ['Economics', 'Public Policy', 'Political Science', 'Business Administration', 'International Relations', 'Any Relevant Discipline'],
    keywords: ['Strategic Intelligence', 'Horizon Scanning', 'Scenario Planning', 'Policy Analysis', 'Early Warning Indicators', 'Trend Analysis', 'Strategic Foresight', 'Executive Brief', 'Assumption Testing', 'Risk Outlook'],
  }),
  role({
    slug: 'contact-intelligence-intern', departmentId: 'growth', title: 'Contact Intelligence Intern', noOfInterns: 3,
    about: 'Contact intelligence is the accuracy and governance of the people records we already hold — several thousand named individuals across institutions in India. People change roles, departments merge and address conventions change, so a contact record decays quickly if nobody maintains it. You will verify held records against primary institutional sources, correct and retire stale entries, and record the lawful basis and consent status behind each one. Finding entirely new contacts is a separate role in this catalogue; your work is making the existing record layer trustworthy and measurable.',
    responsibilities: [
      'Verify held contact records against official institutional pages and directories, stamping each with a verification date.',
      'Detect and merge duplicate records, and retire contacts who have left an institution rather than quietly keeping them on file.',
      'Maintain department and reporting-line mapping for priority institutions so outreach reaches the appropriate level.',
      'Record source, lawful basis and consent status for every contact in line with our data-protection policy, and action opt-outs immediately.',
      'Measure and report record quality by segment: verification age, bounce rate, duplicate rate and field completeness.',
      'Write and maintain the data-entry standard so contacts are captured consistently by every team that adds them.',
      'Run a scheduled decay review, prioritising the segments where accuracy has the greatest commercial consequence.',
    ],
    skills: ['Data verification', 'Deduplication and record matching', 'CRM record management', 'Advanced spreadsheet work', 'Data-protection and consent awareness', 'Data-quality measurement', 'Attention to detail', 'Process documentation', 'Basic scripting for bulk checks', 'Sustained precision on repetitive work'],
    learningOutcomes: ['Contact Data Governance', 'Deduplication and Record Matching', 'Consent and Lawful-Basis Handling', 'Data-Quality Measurement', 'Data Standard Documentation'],
    qualificationType: UGPG, qualifications: BIZ_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Information Management', 'Commerce', 'Statistics', 'Any Relevant Discipline'],
    keywords: ['Contact Intelligence', 'Data Quality', 'CRM Hygiene', 'Data Verification', 'Deduplication', 'Consent Management', 'Data Governance', 'Contact Records', 'Data Enrichment', 'Database Maintenance'],
  }),
  role({
    slug: 'prospect-intelligence-intern', departmentId: 'sales-bd', title: 'Prospect Intelligence Intern', noOfInterns: 3,
    about: 'Prospect intelligence produces the dossier that exists before a first meeting: what one named institution is trying to achieve, what it has publicly committed to, who decides, and what it is most likely to object to. The work is per-account and on request, not list building. You will read annual reports, governing-body minutes, accreditation submissions, press coverage and departmental pages, then compress them into a one-page brief a colleague can absorb in four minutes before a call. After each meeting you check which parts of the dossier proved accurate and improve the template accordingly.',
    responsibilities: [
      'Produce one-page prospect dossiers on named institutions ahead of first meetings, to a fixed template and a fixed deadline.',
      'Identify the decision unit for each account: who signs, who influences, who can block, and what each of them cares about.',
      'Summarise the institution stated priorities from public documents such as annual reports, strategic plans and accreditation submissions.',
      'Anticipate likely objections and prepare an evidence-backed response to each, marking clearly where we do not have a good answer.',
      'Track account triggers including leadership changes, new campuses, accreditation cycles and funding announcements.',
      'Debrief with the colleague after each meeting to test which parts of the dossier held up, and refine the template from that feedback.',
      'Maintain a dossier library so the same institution is never researched from scratch twice.',
    ],
    skills: ['Account research', 'Reading annual reports and institutional documents', 'Stakeholder and decision-unit mapping', 'Concise briefing writing', 'Objection anticipation', 'Public-source research ethics', 'Template and library maintenance', 'Debrief interviewing', 'Time-boxed research', 'Verbal presentation'],
    learningOutcomes: ['Account Research and Dossier Writing', 'Decision-Unit Mapping', 'Institutional Document Analysis', 'Objection Anticipation', 'Research Feedback Loops'],
    qualificationType: UGPG, qualifications: BIZ_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Marketing', 'Economics', 'Education', 'Any Relevant Discipline'],
    keywords: ['Prospect Research', 'Account Intelligence', 'Account Based Selling', 'Stakeholder Mapping', 'Dossier Writing', 'Pre Meeting Briefing', 'Institutional Research', 'Buyer Research', 'Trigger Events', 'Sales Research'],
  }),
  role({
    slug: 'sales-intelligence-intern', departmentId: 'sales-bd', title: 'Sales Intelligence Intern', noOfInterns: 3,
    about: 'Sales intelligence keeps the fact base behind live sales conversations correct and current. Enablement trains the team and sales operations runs the systems; this role owns the content of what is claimed — comparison sheets, capability statements and objection banks — and the public signals that tell a colleague when to make contact. You will fact-check every claim against a citable source before it enters a battlecard, and retire claims that have quietly stopped being true. Comparative material must be accurate and fair, drawn from public sources, with no disparagement and no unverifiable assertion about anyone else.',
    responsibilities: [
      'Maintain battlecards and capability comparison sheets, with a citable source and a review date behind every individual claim.',
      'Audit existing sales material each quarter and correct or remove claims that can no longer be evidenced.',
      'Build an objection bank from real recorded conversations, grouped by theme, with an approved response for each.',
      'Monitor public trigger signals such as leadership changes, new programmes and expansion announcements, and route them to the right colleague within the week.',
      'Answer time-sensitive research questions raised during active pursuits, always stating a confidence level with the answer.',
      'Track which material is actually used in deals and retire what nobody opens.',
      'Uphold the ethical rules for comparative claims: public sources only, accurate representation, no disparagement.',
    ],
    skills: ['Fact-checking and source citation', 'Comparative research', 'Battlecard and sales-content writing', 'Objection analysis', 'Signal monitoring and alerting', 'Working to short deadlines', 'Content maintenance discipline', 'Usage analytics basics', 'Judgement on ethical comparative claims', 'Collaboration with sales colleagues'],
    learningOutcomes: ['Sales Fact-Base Curation', 'Battlecard Development', 'Objection Bank Construction', 'Trigger-Signal Monitoring', 'Ethical Comparative Claims'],
    qualificationType: UGPG, qualifications: BIZ_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Marketing', 'Communication', 'Economics', 'Any Relevant Discipline'],
    keywords: ['Sales Intelligence', 'Battlecards', 'Objection Handling', 'Fact Checking', 'Competitive Positioning', 'Trigger Signals', 'Sales Content', 'Deal Support', 'Claim Verification', 'Sales Research'],
  }),
  role({
    slug: 'business-information-analyst-intern', departmentId: 'research', title: 'Business Information Analyst Intern', noOfInterns: 2,
    about: 'This is an internal information service role: colleagues arrive with a question and you return a defensible answer together with the sources that support it. The discipline is information science — reference interviewing, search strategy, source evaluation, taxonomy and citation — applied to commercial and operational questions rather than academic ones. You will build a catalogued internal reference collection so the same question is never researched twice, and run short sessions teaching colleagues to search well themselves. Where the evidence is thin, the answer says so.',
    responsibilities: [
      'Run reference interviews that turn vague requests into scoped, answerable research questions.',
      'Search public statistical releases, regulatory registers, industry publications and academic literature to answer them.',
      'Evaluate each source for authority, currency and method, and state explicitly where the evidence base is weak.',
      'Maintain a catalogued internal reference collection with a controlled vocabulary so material can be retrieved months later.',
      'Write answer notes in a consistent structure: question, method, findings, limitations and sources.',
      'Track turnaround time and requester feedback, and report on service quality monthly.',
      'Run short internal sessions teaching colleagues how to search and cite the sources they use most often.',
      'Keep a register of licence terms and permitted use for any subscribed source.',
    ],
    skills: ['Reference interviewing', 'Advanced search technique including Boolean and field syntax', 'Source evaluation', 'Taxonomy and controlled vocabulary design', 'Citation standards', 'Statistical data literacy', 'Technical writing', 'Knowledge-base curation', 'Copyright and licensing awareness', 'Service-level tracking', 'Teaching and demonstration'],
    learningOutcomes: ['Reference Interviewing', 'Advanced Search and Retrieval', 'Source Evaluation and Citation', 'Taxonomy Design', 'Research Service Management'],
    qualificationType: UGPG, qualifications: INFO_QUALIFICATIONS,
    specialisations: ['Library and Information Science', 'Economics', 'Statistics', 'Business Administration', 'Journalism', 'Any Relevant Discipline'],
    keywords: ['Business Information', 'Research Service', 'Information Science', 'Source Evaluation', 'Reference Interview', 'Taxonomy', 'Secondary Research', 'Knowledge Management', 'Citation Standards', 'Desk Research'],
  }),
  role({
    slug: 'competitive-benchmarking-intern', departmentId: 'product-programs', title: 'Competitive Benchmarking Intern', noOfInterns: 2,
    about: 'Benchmarking is the measurement side of competitive work: the same metrics, measured the same way, on a fixed schedule, so that a change in a number actually means something. Competitive intelligence in this catalogue produces the narrative of how the landscape is moving; this role produces the reproducible numbers underneath it and the methodology that makes them checkable. You will define metric sets and scoring rubrics, run each cycle identically, capture raw evidence with dates, and publish the method alongside the results. Subjective scores are cross-rated by a second person and the disagreement rate is reported.',
    responsibilities: [
      'Define metric sets and scoring rubrics for feature, performance, pricing and accessibility comparisons.',
      'Run benchmarking cycles on a published schedule using an identical method each time.',
      'Document the method in enough detail that another person could reproduce the results independently.',
      'Record raw evidence such as screenshots, timings and published figures, each with its capture date.',
      'Analyse cycle-over-cycle movement and explain what changed rather than only reporting the difference.',
      'Maintain the comparison matrix and mark clearly where a value is estimated, unavailable or out of date.',
      'Apply inter-rater checks to subjective scores and report the disagreement rate openly.',
      'Use only publicly available material and lawful access; nothing is obtained by misrepresentation.',
    ],
    skills: ['Benchmarking methodology', 'Rubric and scoring design', 'Quantitative comparison', 'Basic statistics including inter-rater agreement', 'Spreadsheet and charting', 'Evidence capture and versioning', 'Technical writing', 'Reproducibility discipline', 'Product and web research', 'Research ethics'],
    learningOutcomes: ['Benchmarking Methodology', 'Rubric and Scoring Design', 'Reproducible Research Practice', 'Comparative Data Analysis', 'Evidence Documentation'],
    qualificationType: UGPG, qualifications: ANALYTIC_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Statistics', 'Computer Science', 'Economics', 'Design', 'Any Relevant Discipline'],
    keywords: ['Competitive Benchmarking', 'Benchmarking Methodology', 'Feature Comparison', 'Scoring Rubrics', 'Reproducible Research', 'Comparative Analysis', 'Metrics Design', 'Evidence Capture', 'Landscape Measurement', 'Inter Rater Reliability'],
  }),
  role({
    slug: 'due-diligence-research-intern', departmentId: 'finance-legal', title: 'Due Diligence Research Intern', noOfInterns: 2,
    about: 'Due diligence here is a bounded process attached to a specific decision — a partnership, a content acquisition, a supplier appointment — that ends in a diligence pack and a recommendation. Corporate intelligence in this catalogue maintains standing entity profiles continuously; this role assembles, tests and closes a file against a checklist within a deadline. You will verify accreditation and registration status, search litigation and regulatory history, review documents in the data room, and write red flags in plain language with their severity stated. Confidentiality and conflict-of-interest rules apply to every file you touch.',
    responsibilities: [
      'Maintain and apply diligence checklists covering legal, financial, accreditation, reputational and operational areas.',
      'Verify registration, accreditation and approval status of prospective partner institutions against official registers.',
      'Search litigation records, regulatory action and adverse media, recording what was searched as well as what was found.',
      'Index and review data-room documents, tracking every outstanding request until it is answered or formally closed.',
      'Draft red-flag summaries stating severity, supporting evidence and the residual open question, without softening the language.',
      'Assemble the final diligence pack with an evidence appendix and a clear, reasoned recommendation.',
      'Track closure of all open items and record where a matter was knowingly accepted as a residual risk.',
      'Observe strict confidentiality and declare any conflict of interest before starting a file.',
    ],
    skills: ['Diligence checklist application', 'Legal and regulatory register research', 'Adverse-media searching', 'Document review and indexing', 'Financial statement reading', 'Risk articulation', 'Report writing', 'Confidentiality discipline', 'Deadline management', 'Attention to detail'],
    learningOutcomes: ['Due Diligence Process', 'Regulatory and Accreditation Verification', 'Adverse-Media and Litigation Research', 'Red-Flag Reporting', 'Data-Room Document Review'],
    qualificationType: UGPG, qualifications: LEGAL_QUALIFICATIONS,
    specialisations: ['Law', 'Commerce', 'Finance', 'Company Secretaryship', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Due Diligence', 'Background Research', 'Adverse Media', 'Regulatory Verification', 'Risk Assessment', 'Document Review', 'Data Room', 'Partner Screening', 'Compliance Research', 'Red Flag Reporting'],
  }),
  role({
    slug: 'contact-discovery-intern', departmentId: 'growth', title: 'Contact Discovery Intern', noOfInterns: 4,
    about: 'Contact discovery is coverage building: finding the named, currently serving decision-makers at institutions where we hold no usable contact at all. It is the opposite end of the pipeline from contact intelligence, which maintains and governs records that already exist. You will work from published institutional directories, departmental pages, conference programmes, official registers and public announcements, capture the source for every record, and hand over only what has been checked against a primary page. Volume matters here, but a record that cannot be traced to its source does not count.',
    responsibilities: [
      'Build target institution lists from official registers and directories and prioritise them against agreed criteria.',
      'Find named role holders such as heads of department, placement officers, registrars and training coordinators from published institutional sources.',
      'Verify each new record against a primary institutional page before it enters the system, storing the source link.',
      'Infer and test institutional address conventions where individual details are not published, and label inferred values clearly as unverified.',
      'Report coverage by segment so gaps are visible and effort goes where records are missing.',
      'Collect only professional contact details in line with our data-protection policy, excluding anything personal or sensitive.',
      'Log weekly volume, verification rate and rejection reasons, and use those numbers to improve the method.',
    ],
    skills: ['Public directory and web research', 'Systematic search technique', 'Data entry accuracy', 'Spreadsheet and CRM import handling', 'Address-pattern verification methods', 'Data-protection awareness', 'Basic scripting or automation for repetitive lookups', 'Process documentation', 'Persistence', 'Self-managed throughput tracking'],
    learningOutcomes: ['Systematic Contact Discovery', 'Source Verification Practice', 'Coverage Measurement', 'Compliant Data Collection', 'Research Throughput Management'],
    qualificationType: UGPG, qualifications: BIZ_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Marketing', 'Commerce', 'Information Management', 'Any Relevant Discipline'],
    keywords: ['Contact Discovery', 'Lead Research', 'List Building', 'Prospect Lists', 'Data Sourcing', 'Public Directories', 'Coverage Analysis', 'Outbound Research', 'Record Verification', 'Database Building'],
  }),
];

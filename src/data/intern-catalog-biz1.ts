// src/data/intern-catalog-biz1.ts — Business & Institutional Research, and Research Analytics.
// Thirteen intern roles covering business, strategic, industry, company, institutional, corporate,
// enterprise, public-records and organizational research, plus the analytics and insight roles that
// sit downstream of them. Cross-checked against the full existing catalog first (role-catalog.ts +
// intern-catalog.ts + intern-catalog-phase2.ts + intern-catalog-phase3.ts + intern-catalog-phase4.ts):
// every slug and title below is new. Where a title sits next to an existing one — Market Research
// Intern, Market Intelligence Intern, Competitive Intelligence Intern, Business Intelligence Intern,
// Data Analytics Intern, Organizational Development Intern, Records & Archives Intern — the about
// text states plainly what this role does instead, so the two do not overlap in practice.
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
const MGMT_QUALIFICATIONS = ['BBA/B.Com', 'MBA/PGDM', "Any Bachelor's Degree", 'Any Relevant Degree'];
const LAW_QUALIFICATIONS = ['LLB/BA LLB', 'BBA/B.Com', "Any Bachelor's Degree", 'Any Relevant Degree'];
const QUANT_QUALIFICATIONS = ["Any Bachelor's Degree", "Any Master's Degree", 'Any Relevant Degree'];

// =====================================================================================
// BUSINESS & INSTITUTIONAL RESEARCH
// =====================================================================================
const BUSINESS_RESEARCH: CatalogRole[] = [
  role({
    slug: 'business-research-intern', departmentId: 'research', title: 'Business Research Intern', noOfInterns: 4,
    about: 'Business research answers the commercial questions behind our products — how organisations in education and skilling actually earn revenue, what their cost base looks like, and which business models hold up once the initial funding runs out. This is deliberately narrower than the market research role, which studies competitors and users; here you study the economics of a business model itself, including the conditions under which each one fails. You will build evidence files a decision-maker can act on, with every figure traceable to a named public source. Where public evidence is genuinely thin, you record that plainly instead of filling the gap with a convenient assumption.',
    responsibilities: [
      'Research how organisations in education, skilling, and adjacent sectors generate revenue, and document each model with its cost base and margin behaviour.',
      'Build evidence files on pricing structures, contract terms, and payment cycles observed in publicly available disclosures.',
      'Size specific commercial opportunities using bottom-up methods, stating every assumption and where it came from.',
      'Maintain a source register so that any figure in a research note can be traced back to the document it was taken from.',
      'Test business assumptions proposed by internal teams against published evidence and report where the evidence does not support them.',
      'Write short research notes of two to three pages that end with a recommendation rather than a summary.',
      'Flag the questions where public evidence does not exist, instead of estimating around the gap.',
      'Present findings to the research and strategy teams in fortnightly review sessions.',
    ],
    skills: ['Business model analysis', 'Bottom-up market sizing', 'Financial statement reading', 'Spreadsheet modelling', 'Public-source secondary research', 'Source verification and citation discipline', 'Structured research note writing', 'Assumption testing', 'Analytical reasoning', 'Presentation skills'],
    learningOutcomes: ['Business Model and Unit Economics Analysis', 'Bottom-Up Sizing Methodology', 'Evidence Traceability and Source Registers', 'Decision-Oriented Research Writing', 'Assumption Testing Discipline'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Economics', 'Commerce', 'Finance', 'Any Relevant Discipline'],
    keywords: ['Business Research', 'Business Model Analysis', 'Unit Economics', 'Market Sizing', 'Secondary Research', 'Commercial Research', 'Research Notes', 'Evidence-Based Analysis', 'Business Analysis', 'Pricing Research'],
  }),
  role({
    slug: 'strategic-research-intern', departmentId: 'executive-office', title: 'Strategic Research Intern', noOfInterns: 2,
    about: 'Strategic research supports the decisions that are hard to reverse — whether to build, buy, or partner, which segment to enter next, and what would have to be true for a plan to work at all. You will hold a small number of named questions at a time, each running for several weeks, and the output is a decision memo rather than a deck. The discipline that defines this role is the written pre-mortem: before recommending a course of action, you set down what would make it fail and what early signal would tell us it is failing. Work is confidential by default and is reviewed directly by the executive office.',
    responsibilities: [
      'Take a named strategic question, scope it into researchable sub-questions, and agree upfront which decision it must inform.',
      'Build the evidence base for build, buy, and partner options, including what each option costs and what it forecloses.',
      'Write decision memos that state the recommendation first, then the reasoning, then the supporting evidence.',
      'Run a written pre-mortem for every recommendation, covering the failure modes and the earliest observable warning signs.',
      'Maintain a register of past strategic decisions and revisit them against what actually happened.',
      'Research regulatory, structural, and demographic shifts that could invalidate the assumptions behind current plans.',
      'Prepare briefing notes ahead of executive discussions and capture the decisions taken afterwards.',
      'Handle all material as confidential and follow the information-handling rules of the executive office.',
    ],
    skills: ['Strategic analysis', 'Research question scoping', 'Decision memo writing', 'Pre-mortem and scenario analysis', 'Secondary research', 'Trade-off analysis', 'Executive briefing', 'Confidentiality and discretion', 'Structured thinking', 'Decision capture and minuting'],
    learningOutcomes: ['Strategic Question Framing', 'Build, Buy and Partner Evaluation', 'Decision Memo Writing', 'Pre-Mortem and Scenario Analysis', 'Executive Briefing Practice'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Economics', 'Public Policy', 'Law', 'Any Relevant Discipline'],
    keywords: ['Strategic Research', 'Corporate Strategy', 'Decision Memos', 'Scenario Analysis', 'Strategy Analyst', 'Build vs Buy', 'Strategic Planning', 'Executive Support', 'Pre-Mortem Analysis'],
    eligibilityExtra: ['This role handles confidential internal material; a signed confidentiality undertaking is a condition of the internship.'],
  }),
  role({
    slug: 'industry-research-intern', departmentId: 'research', title: 'Industry Research Intern', noOfInterns: 3,
    about: 'Industry research looks at whole sectors rather than individual organisations — how a value chain is structured, who holds bargaining power within it, how it is regulated, and where the hiring and the spending actually sit. You will cover the sectors our learners are trained for, including manufacturing, healthcare delivery, logistics, construction and financial services, and produce a standing sector file for each. The work depends heavily on official statistical sources such as national accounts, industrial classification data, labour force surveys and regulator publications, and on reading them correctly rather than repeating headline claims. Sector files are refreshed on a published schedule so they remain usable when a decision comes up months later.',
    responsibilities: [
      'Build and maintain standing sector files covering value chain structure, major segments, regulation, and employment patterns.',
      'Work directly with official statistical sources including national accounts, industrial classification data, and labour force surveys.',
      'Track regulatory changes affecting each sector and record what they change in practice, not merely when they were notified.',
      'Analyse skill and hiring demand within each sector so programme teams know what employers are actually recruiting for.',
      'Reconcile conflicting sector figures from different sources and explain which figure is more reliable and why.',
      'Refresh every sector file on a published schedule so that it never goes stale without anyone noticing.',
      'Write sector briefs pitched at internal readers who are not specialists in that industry.',
      'Present sector findings to the research, programmes, and partnerships teams.',
    ],
    skills: ['Industry and sector analysis', 'Value chain mapping', 'Official statistics interpretation', 'Industrial classification systems', 'Labour market data analysis', 'Regulatory tracking', 'Data reconciliation', 'Technical writing for non-specialists', 'Spreadsheet analysis', 'Source evaluation'],
    learningOutcomes: ['Sector and Value Chain Analysis', 'Official Statistics Interpretation', 'Regulatory Change Tracking', 'Skill and Hiring Demand Analysis', 'Maintaining Living Research Files'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Economics', 'Business Administration', 'Statistics', 'Public Policy', 'Any Relevant Discipline'],
    keywords: ['Industry Research', 'Sector Analysis', 'Value Chain Mapping', 'Official Statistics', 'Labour Market Research', 'Regulatory Research', 'Industry Briefs', 'Secondary Research', 'Skill Demand Analysis'],
  }),
  role({
    slug: 'company-research-intern', departmentId: 'sales-bd', title: 'Company Research Intern', noOfInterns: 5,
    about: 'Company research builds and maintains the verified account list that our partnerships and business development work runs on. You will hold a list of five hundred or more target organisations — institutions, employers, and training providers — and keep it accurate as they merge, rename, relocate, change leadership, or close. Each record carries a firmographic profile, a decision-making structure drawn only from public or freely provided sources, and a dated evidence note behind every field. The measure of this role is not how many records you add but how few of them are wrong when a colleague relies on one in a meeting.',
    responsibilities: [
      'Build and maintain a verified list of five hundred or more target organisations, each with a full firmographic profile.',
      'Re-verify records on a rolling schedule and correct entries where an organisation has merged, renamed, relocated, or shut down.',
      'Profile each organisation by size, structure, locations, programme or product lines, and recent public announcements.',
      'Map decision-making structures using only publicly available or freely provided information.',
      'Record a dated source against every field so that any record can be audited by someone else later.',
      'Score each record for data confidence and flag those that have not been checked within the agreed window.',
      'Prepare short pre-meeting company briefs for the partnerships and business development teams.',
      'Follow data-protection rules strictly, and never use scraped or purchased personal contact data.',
    ],
    skills: ['Company and firmographic research', 'Data verification and re-verification', 'CRM record hygiene', 'Public filings and disclosure reading', 'Spreadsheet management', 'Entity matching and deduplication', 'Data confidence scoring', 'Brief writing', 'Attention to detail', 'Data protection awareness'],
    learningOutcomes: ['Account List Building and Maintenance', 'Firmographic Profiling', 'Entity Matching and Deduplication', 'Data Confidence Scoring', 'Ethical Research Practice'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Commerce', 'Marketing', 'Economics', 'Any Relevant Discipline'],
    keywords: ['Company Research', 'Account Research', 'Firmographics', 'Prospect Research', 'Data Verification', 'Account List Building', 'Business Development Research', 'CRM Data Quality', 'Company Profiling'],
    eligibilityExtra: ['Research must rely strictly on publicly available or freely provided information; the role involves no purchase of personal contact data and no attempt to obtain confidential information from any organisation.'],
  }),
  role({
    slug: 'institutional-research-intern', departmentId: 'education-learning', title: 'Institutional Research Intern', noOfInterns: 3,
    about: 'Institutional research is the higher-education discipline of studying institutions themselves — their statutory approvals, programme portfolios, intake, progression, and published outcomes. Because we are the technology platform behind partner universities rather than an awarding body ourselves, we need an accurate and current picture of how partner and prospective partner institutions are structured and regulated. You will work with regulator listings, approval notifications, accreditation grades and institutional disclosures, and reconcile them when they disagree with each other. The output is a set of institution files the academic and partnerships teams can rely on without having to re-check the basics.',
    responsibilities: [
      'Maintain institution files covering statutory approvals, accreditation status, programme portfolios, and published intake figures.',
      'Track regulator notifications and accreditation cycles, and record the date on which any institutional status changed.',
      'Reconcile differences between self-published institutional data and regulator listings, recording which source was used and why.',
      'Analyse programme-level progression and completion data wherever it has been publicly disclosed.',
      'Prepare comparison notes on how similar institutions structure equivalent programmes and credit loads.',
      'Support the academic team with evidence for programme mapping and credit-recognition discussions.',
      'Document methodology so that another researcher can reproduce the same institution file from scratch.',
      'Use precise language throughout about which body awards a qualification and which body provides the technology behind it.',
    ],
    skills: ['Institutional research methods', 'Higher-education regulatory literacy', 'Accreditation and approval frameworks', 'Enrolment and progression data analysis', 'Data reconciliation', 'Records and documentation discipline', 'Spreadsheet analysis', 'Academic writing', 'Attention to regulatory language', 'Source verification'],
    learningOutcomes: ['Institutional Research Methods', 'Higher-Education Regulatory Literacy', 'Accreditation and Approval Analysis', 'Progression and Outcome Data Analysis', 'Reproducible Research Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Education', 'Public Policy', 'Statistics', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Institutional Research', 'Higher Education Research', 'Accreditation Research', 'Programme Portfolio Analysis', 'Enrolment Data', 'Progression Analysis', 'Regulatory Listings', 'Education Policy Research', 'Institution Profiling'],
  }),
  role({
    slug: 'corporate-research-intern', departmentId: 'governance-affairs', title: 'Corporate Research Intern', noOfInterns: 2,
    about: 'Corporate research is due diligence on legal entities — who owns an organisation, who directs it, what it has filed, and whether anything already on the public record should give us pause before we sign an agreement with it. You will work with company registry filings, annual returns, charge and security registers, public litigation listings, and regulatory penalty orders. Every due-diligence pack states findings as facts with a filing reference attached, and keeps those facts visually separate from any interpretation you offer. Nothing in this role involves approaching the subject organisation or gathering information from anywhere other than records that are open to the public.',
    responsibilities: [
      'Prepare entity due-diligence packs on organisations we are considering contracting or partnering with.',
      'Trace ownership and directorship structures through registry filings, including holding and subsidiary relationships.',
      'Review annual returns and financial filings for signs of distress, registered charges, or unusual related-party activity.',
      'Search public litigation and regulatory penalty listings and summarise anything material to the proposed relationship.',
      'Separate verified fact from inference in every pack, and cite the filing reference behind each fact.',
      'Maintain a register of entities already researched, with the date each pack was prepared and by whom.',
      'Escalate findings that warrant legal or finance review rather than making the judgement call yourself.',
      'Maintain strict confidentiality on both the subjects and the outcomes of due-diligence work.',
    ],
    skills: ['Corporate registry research', 'Ownership and directorship tracing', 'Financial filing review', 'Litigation and regulatory record searching', 'Due-diligence pack preparation', 'Citation discipline', 'Risk flagging and escalation', 'Legal document reading', 'Confidentiality practice', 'Attention to detail'],
    learningOutcomes: ['Entity Due Diligence', 'Ownership Structure Tracing', 'Public Filing Analysis', 'Risk Flagging and Escalation', 'Confidential Research Handling'],
    qualificationType: UGPG, qualifications: LAW_QUALIFICATIONS,
    specialisations: ['Commerce', 'Law', 'Business Administration', 'Finance', 'Any Relevant Discipline'],
    keywords: ['Corporate Research', 'Due Diligence', 'Company Filings', 'Ownership Structure', 'Directorship Research', 'Entity Verification', 'Corporate Governance Research', 'Risk Screening', 'Registry Research'],
    eligibilityExtra: ['Research must rely strictly on publicly available records; the role involves no contact with the subject organisation and no attempt to obtain confidential information.'],
  }),
  role({
    slug: 'enterprise-research-intern', departmentId: 'sales-bd', title: 'Enterprise Research Intern', noOfInterns: 2,
    about: 'Enterprise research studies how large organisations actually buy — the procurement route, the approval thresholds, the vendor empanelment steps, the security and compliance questionnaires, and the budget calendar that decides when anything can be signed at all. Where the company research role keeps the account list accurate, this role explains the process behind a single large agreement so that our team does not discover a mandatory step three months late. You will build process maps for enterprise and public-sector buying, collect the standard documentation such buyers request, and maintain a reusable answer library for the questionnaire items that recur every time. All of it is drawn from published tender documents, procurement manuals, and openly stated vendor requirements.',
    responsibilities: [
      'Map end-to-end buying processes for large enterprise and public-sector organisations, including approval thresholds and empanelment steps.',
      'Research published tender and procurement documentation to identify mandatory vendor eligibility requirements.',
      'Maintain a reusable answer library for recurring security, compliance, and capability questionnaire items.',
      'Document budget and procurement calendars so that outreach timing is informed rather than guessed.',
      'Identify the roles that typically sit on a buying committee for our category and what each of them is accountable for.',
      'Track changes in public procurement rules that affect our eligibility to bid.',
      'Write process briefs detailed enough that a colleague can follow them without repeating your research.',
      'Flag requirements we cannot currently meet, honestly and early enough to do something about them.',
    ],
    skills: ['Enterprise procurement research', 'Process mapping', 'Tender documentation analysis', 'Vendor empanelment requirements', 'Questionnaire response management', 'Buying committee stakeholder mapping', 'Public procurement rules awareness', 'Technical writing', 'Spreadsheet tracking', 'Attention to detail'],
    learningOutcomes: ['Enterprise Buying Process Mapping', 'Procurement and Tender Analysis', 'Buying Committee Stakeholder Mapping', 'Questionnaire Answer Library Management', 'Requirement Gap Reporting'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Commerce', 'Public Policy', 'Law', 'Any Relevant Discipline'],
    keywords: ['Enterprise Research', 'Procurement Research', 'Tender Analysis', 'Vendor Empanelment', 'RFP Research', 'Buying Committee Mapping', 'Public Procurement', 'B2B Research', 'Sales Enablement Research'],
  }),
  role({
    slug: 'public-records-research-intern', departmentId: 'governance-affairs', title: 'Public Records Research Intern', noOfInterns: 2,
    about: 'Public records research is the craft of finding what is already on the record — gazette notifications, government orders, tender portals, statutory registers, court listings and open data releases — and retrieving it reliably rather than hopefully. This is not internal records management: you are not filing our own documents but working outward into public archives, including the right-to-information route where a record has not been published. You will maintain a retrieval log capturing which source was searched, on what date, with what query and what result, so that a nil finding is as trustworthy as a positive one. Requests are drafted precisely, because a loosely worded request wastes weeks and often returns nothing usable.',
    responsibilities: [
      'Locate and retrieve public records across gazettes, government orders, statutory registers, tender portals, and open data releases.',
      'Draft precise information requests where a record has not been published, and track each one through to a response.',
      'Maintain a retrieval log capturing the source searched, the date, the query used, and the result including nil results.',
      'Verify the authenticity and currency of a retrieved record before anyone relies on it.',
      'Summarise long official documents into short factual notes without adding interpretation of your own.',
      'Build a catalogued internal library of retrieved records so the same document is never sourced twice.',
      'Advise colleagues on which public source is likely to hold a given type of record, and how long retrieval usually takes.',
      'Respect the boundaries of what is lawfully public, and decline requests that would go beyond them.',
    ],
    skills: ['Public records retrieval', 'Right-to-information request drafting', 'Gazette and government order research', 'Tender and procurement portal navigation', 'Document authentication', 'Search strategy design', 'Retrieval logging', 'Factual summarisation', 'Cataloguing and indexing', 'Research ethics'],
    learningOutcomes: ['Public Records Retrieval Methods', 'Information Request Drafting', 'Search Strategy and Retrieval Logging', 'Document Verification', 'Public Source Cataloguing'],
    qualificationType: UGPG, qualifications: LAW_QUALIFICATIONS,
    specialisations: ['Law', 'Public Policy', 'Political Science', 'Library and Information Science', 'Any Relevant Discipline'],
    keywords: ['Public Records Research', 'Right to Information', 'Government Records', 'Gazette Research', 'Open Data', 'Statutory Registers', 'Document Retrieval', 'Archival Research', 'Public Source Research'],
  }),
  role({
    slug: 'organizational-research-intern', departmentId: 'people', title: 'Organizational Research Intern', noOfInterns: 3,
    about: 'Organizational research builds the evidence base behind how we structure and run the company — team sizes, spans of control, meeting load, decision rights, distributed working practice, and what the published research says actually works. This is the study side rather than the intervention side: you gather and analyse the evidence, and the people team decides what to change on the strength of it, which is what separates this role from organizational development. You will run internal instruments such as short pulse surveys and time-use studies alongside a serious review of the organisational behaviour literature, and report honestly when a popular management claim does not survive scrutiny. Every internal dataset you touch is anonymised and reported only in aggregate.',
    responsibilities: [
      'Review organisational behaviour and management research, and summarise what is well evidenced and what is merely widely repeated.',
      'Design and run short internal instruments including pulse surveys, time-use studies, and structured interviews.',
      'Analyse anonymised internal data on team structure, spans of control, and meeting load.',
      'Study how distributed and hybrid working practices affect coordination across a team that rarely shares a room.',
      'Document decision rights and handover points between teams, and identify where they are ambiguous in practice.',
      'Report findings in aggregate only, suppressing small groups so that no individual can be identified.',
      'Write findings notes that state the strength of the evidence alongside the finding itself.',
      'Hand findings to the people team for action rather than running interventions yourself.',
    ],
    skills: ['Organisational behaviour research', 'Survey design', 'Structured interviewing', 'Qualitative coding', 'Descriptive statistics', 'Anonymisation and aggregate reporting', 'Literature review', 'Research ethics', 'Report writing', 'Confidentiality practice'],
    learningOutcomes: ['Organisational Research Design', 'Survey and Interview Instrument Design', 'Qualitative Coding and Synthesis', 'Anonymised Aggregate Reporting', 'Evidence Strength Assessment'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Psychology', 'Human Resource Management', 'Sociology', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Organizational Research', 'Organisational Behaviour', 'People Analytics Research', 'Pulse Surveys', 'Workplace Research', 'Employee Research', 'Qualitative Research', 'Survey Design', 'Evidence-Based HR'],
  }),
];

// =====================================================================================
// RESEARCH ANALYTICS & INSIGHTS
// =====================================================================================
const RESEARCH_ANALYTICS: CatalogRole[] = [
  role({
    slug: 'research-analytics-intern', departmentId: 'research', title: 'Research Analytics Intern', noOfInterns: 3,
    about: 'Research analytics is the quantitative engine room of the research function — the sampling plans, weighting, significance testing and reproducible analysis scripts that decide whether a research claim can be trusted at all. You will mostly work on studies run by other people across the company: cleaning and weighting survey data, coding open-ended responses, checking whether a reported difference is real, and rebuilding an analysis from raw data when a published number is questioned. Every analysis is delivered as a script plus a data dictionary, so that it can be rerun months later and produce the same figure. Where a sample cannot support the claim being made of it, you say so before publication rather than after.',
    responsibilities: [
      'Design sampling plans and calculate the sample sizes a study would need to answer its stated question.',
      'Clean, weight, and document survey and study datasets before any analysis begins.',
      'Run significance and effect-size testing, and report confidence intervals rather than bare percentages.',
      'Code open-ended survey responses into analysable categories using a documented coding frame.',
      'Deliver every analysis as a reproducible script with a data dictionary, so results can be regenerated on demand.',
      'Rebuild disputed analyses from raw data to confirm or correct the published figure.',
      'Review draft research outputs and flag claims that the underlying sample cannot support.',
      'Maintain the shared analysis repository, its version history, and its documentation.',
    ],
    skills: ['Sampling and study design', 'Survey weighting', 'Significance and effect-size testing', 'Python or R for analysis', 'SQL', 'Reproducible analysis practice', 'Qualitative coding frames', 'Data cleaning', 'Data dictionary documentation', 'Statistical writing'],
    learningOutcomes: ['Sampling and Sample Size Design', 'Survey Weighting and Data Cleaning', 'Significance and Effect Size Testing', 'Reproducible Analysis Pipelines', 'Statistical Claim Review'],
    qualificationType: UGPG, qualifications: QUANT_QUALIFICATIONS,
    specialisations: ['Statistics', 'Economics', 'Data Science', 'Psychology', 'Any Relevant Discipline'],
    keywords: ['Research Analytics', 'Survey Analysis', 'Statistical Analysis', 'Sampling Design', 'Reproducible Research', 'Significance Testing', 'Data Cleaning', 'Quantitative Research', 'Research Methods'],
  }),
  role({
    slug: 'business-analytics-intern', departmentId: 'operations', title: 'Business Analytics Intern', noOfInterns: 4,
    about: 'Business analytics answers specific commercial questions with numbers — what a learner cohort is worth over time, where an enrolment funnel leaks, which programmes carry their own costs, and what a price change would plausibly do to volume. This is analysis rather than reporting: the existing analytics and business intelligence roles maintain the dashboards and the metric definitions, while this role starts from an open commercial question and builds a model to answer it. You will work in SQL and spreadsheets, build cohort and contribution models, and write up each answer with its assumptions on the first page. A model whose assumptions are buried is treated here as unfinished work.',
    responsibilities: [
      'Take open commercial questions from the operations and finance teams and turn them into analyses with an agreed answer format.',
      'Build cohort and retention analyses showing how learner behaviour changes over the months after enrolment.',
      'Model contribution margin at programme level, including the costs usually left out of a headline figure.',
      'Analyse conversion from first visit through application, admission, and completion, and locate the largest losses.',
      'Build scenario models for pricing, capacity, and volume changes, expressed as sensitivity ranges rather than single numbers.',
      'Write up every analysis with its assumptions, data sources, and limitations stated at the front.',
      'Validate results against a second independent data source before they are circulated.',
      'Correct or withdraw earlier analyses when newer data shows they were wrong.',
    ],
    skills: ['SQL', 'Spreadsheet and financial modelling', 'Cohort and retention analysis', 'Funnel and conversion analysis', 'Contribution margin analysis', 'Scenario and sensitivity modelling', 'Python or R at a basic level', 'Data validation', 'Analytical writing', 'Commercial reasoning'],
    learningOutcomes: ['Commercial Question Framing', 'Cohort and Funnel Analysis', 'Contribution Margin Modelling', 'Scenario and Sensitivity Analysis', 'Transparent Assumption Reporting'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Economics', 'Statistics', 'Commerce', 'Any Relevant Discipline'],
    keywords: ['Business Analytics', 'Cohort Analysis', 'Funnel Analysis', 'Unit Economics', 'Contribution Margin', 'Scenario Modelling', 'SQL Analysis', 'Commercial Analysis', 'Retention Analysis'],
  }),
  role({
    slug: 'business-insights-intern', departmentId: 'product-programs', title: 'Business Insights Intern', noOfInterns: 3,
    about: 'Business insights is the last mile of analysis — taking findings that already exist across analytics, research, and support, and turning them into something a team will actually act on this week. The role exists because most organisations generate far more analysis than they ever use. You will run an insight backlog, chase each finding to a named owner and a specific decision, and write the monthly insight review that connects what the numbers said to what changed afterwards. Success here is measured in decisions influenced and closed, not in slides produced.',
    responsibilities: [
      'Maintain an insight backlog drawing on analytics outputs, research findings, support tickets, and user feedback.',
      'Synthesise findings from different sources into one narrative when they point at the same underlying issue.',
      'Give each insight a named owner and a specific decision it is meant to inform, and follow it through to closure.',
      'Write the monthly insight review, including which previous insights led to a change and which quietly did not.',
      'Interview internal teams to learn which questions they are stuck on and would genuinely act on an answer to.',
      'Reduce long analyses into one-page summaries that lead with the implication rather than the method.',
      'Track what happened after a decision was taken on an insight, and report plainly when the expected effect did not appear.',
      'Retire insights that have gone stale, so the backlog stays worth reading.',
    ],
    skills: ['Insight synthesis', 'Cross-source analysis', 'Stakeholder interviewing', 'Narrative and summary writing', 'Backlog management', 'Prioritisation', 'Data literacy', 'Presentation skills', 'Follow-through and coordination', 'Critical evaluation'],
    learningOutcomes: ['Insight Synthesis Across Sources', 'Insight Backlog Management', 'Decision Follow-Through Tracking', 'One-Page Summary Writing', 'Honest Outcome Reporting'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Economics', 'Communication', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['Business Insights', 'Insight Synthesis', 'Decision Support', 'Analytics Translation', 'Stakeholder Communication', 'Insight Backlog', 'Business Storytelling', 'Cross-Functional Analysis', 'Reporting'],
  }),
  role({
    slug: 'market-insights-intern', departmentId: 'growth', title: 'Market Insights Intern', noOfInterns: 4,
    about: 'Market insights sits between what the market says and what the go-to-market team does about it — turning demand signals, learner conversations, partner feedback and segment data into a clear recommendation about where to focus next. It is deliberately distinct from market research, which designs and runs the studies, and from market intelligence, which maintains continuous tracking; this role consumes the output of both and produces a decision. You will build segment profiles for learner and institutional audiences, test whether the language in our messaging matches the language those audiences actually use, and report where demand differs by geography and segment. Telling the growth team that a segment is not worth pursuing is an expected part of the job, not a failure of it.',
    responsibilities: [
      'Build and maintain segment profiles for learner and institutional audiences, including what each segment is genuinely trying to achieve.',
      'Synthesise demand signals from enquiry data, search behaviour, partner conversations, and published sector data.',
      'Compare the language used in our messaging with the language the audience uses, and report the gaps concretely.',
      'Analyse demand differences by geography and segment, and recommend where effort should concentrate next quarter.',
      'Run short structured conversations with learners and partner staff to test an emerging insight before anyone acts on it.',
      'Produce a quarterly market insights note carrying explicit recommendations, each with a stated confidence level.',
      'Advise the growth team when a segment is not worth pursuing, and set out the evidence behind that view.',
      'Keep all audience research consent-based, and free of any personal data that was not freely given.',
    ],
    skills: ['Segmentation analysis', 'Demand signal synthesis', 'Message and language gap analysis', 'Structured customer conversations', 'Qualitative and quantitative synthesis', 'Geographic demand analysis', 'Recommendation writing', 'Spreadsheet analysis', 'Data literacy', 'Research ethics'],
    learningOutcomes: ['Audience Segmentation', 'Demand Signal Synthesis', 'Message and Market Fit Analysis', 'Geographic Demand Analysis', 'Confidence-Weighted Recommendations'],
    qualificationType: UGPG, qualifications: MGMT_QUALIFICATIONS,
    specialisations: ['Marketing', 'Business Administration', 'Economics', 'Psychology', 'Any Relevant Discipline'],
    keywords: ['Market Insights', 'Customer Segmentation', 'Demand Analysis', 'Voice of Customer', 'Go-to-Market Research', 'Audience Research', 'Messaging Research', 'Growth Insights', 'Segment Analysis'],
    eligibilityExtra: ['Audience research must be consent-based; the role involves no collection of personal data that has not been freely provided by the individual.'],
  }),
];

export const INTERN_CATALOG_BIZ1: CatalogRole[] = [
  ...BUSINESS_RESEARCH,
  ...RESEARCH_ANALYTICS,
];

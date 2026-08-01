// src/data/intern-catalog-biz4.ts — Business Batch 4: Data research, databases, and data
// operations. Twelve roles covering the full life of a record — sourcing it, collecting it,
// verifying it against a primary source, storing it in a well-designed database, running that
// database, and administering access to it. Cross-checked against the existing catalog
// (role-catalog.ts + intern-catalog.ts + intern-catalog-phase2/3/4/5.ts): none of these slugs or
// titles already exist, and each role below is deliberately scoped away from the neighbouring
// titles that do exist (Data Science, Data Analytics, Data Engineering, Data Quality, Data
// Governance, Data Stewardship, Master Data Management, Business Intelligence, Market Research,
// Information Architecture).
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

export const INTERN_CATALOG_BIZ4: CatalogRole[] = [
  // ===================================================================================
  // 1. Data Research Intern — sourcing and appraising external datasets for research use.
  // ===================================================================================
  role({
    slug: 'data-research-intern', departmentId: 'research', title: 'Data Research Intern', noOfInterns: 4,
    about: 'This role finds and appraises the external datasets our research programme runs on, rather than analysing our own product data. You will hunt down public and licensed sources on education enrolment, skills demand, employment outcomes and assessment performance, then establish for each one who published it, how it was collected, what its licence permits, and where it is quietly wrong. Every dataset you clear is written up in a provenance note that a researcher can cite two years later without re-doing your work. This is deliberately upstream of the existing Data Science and Data Analytics internships, which begin once a trustworthy dataset already exists.',
    responsibilities: [
      'Search government portals, statistical agencies, open-data repositories and published research for datasets relevant to live research questions.',
      'Appraise each candidate dataset for collection method, sample frame, reporting period, known revisions and coverage gaps before it is used.',
      'Read and record the licence or terms of use for every source, and flag anything that cannot be redistributed or used commercially.',
      'Write a one-page provenance note per approved dataset covering publisher, methodology, update cadence, caveats and citation format.',
      'Cross-check overlapping sources against each other and document where two published figures for the same quantity disagree.',
      'Maintain a searchable register of approved, rejected and pending datasets so that no source is appraised twice.',
      'Convert cleared sources into a consistent tabular format with a data dictionary for the research team.',
      'Present a short monthly summary of new sources found and sources that have been withdrawn or changed methodology.',
    ],
    skills: [
      'Secondary research and source discovery',
      'Dataset appraisal and methodology reading',
      'Spreadsheet proficiency (pivot tables, lookups)',
      'SQL fundamentals',
      'Basic Python for reading and reshaping files',
      'Statistical literacy (sampling, weighting, base rates)',
      'Licence and terms-of-use interpretation',
      'Technical writing and citation discipline',
      'Attention to numerical detail',
      'Record-keeping and register maintenance',
    ],
    learningOutcomes: [
      'Dataset Discovery and Source Appraisal',
      'Provenance and Methodology Documentation',
      'Data Licensing and Permitted-Use Assessment',
      'Cross-Source Reconciliation of Published Figures',
      'Research Data Register Management',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Statistics', 'Economics', 'Data Science', 'Library and Information Science', 'Social Sciences', 'Any Relevant Discipline'],
    keywords: ['Data Research', 'Dataset Sourcing', 'Secondary Research', 'Data Provenance', 'Open Data', 'Research Methodology', 'Data Appraisal', 'Statistical Sources', 'Data Licensing', 'Research Internship'],
  }),

  // ===================================================================================
  // 2. Data Collection & Verification Intern — designs the capture, then checks a sample.
  // ===================================================================================
  role({
    slug: 'data-collection-verification-intern', departmentId: 'research', title: 'Data Collection & Verification Intern', noOfInterns: 4,
    about: 'This role builds the instruments that bring new data in, and then proves that what came in is true. You will design structured capture forms, survey instruments and scraping or extraction specifications for information that does not yet exist in any dataset, run the collection to a defined schedule, and then pull a statistical sample of what was captured and re-check it against the original source. The two halves belong together deliberately: whoever designs a capture form should have to live with the error rate it produces. Where the Data Research role appraises datasets that already exist, this role creates them.',
    responsibilities: [
      'Design structured collection instruments — forms, field definitions, dropdown vocabularies and validation rules — before any collection begins.',
      'Write a collection specification for each exercise stating the source, the fields, the acceptance rules and the target volume.',
      'Run scheduled collection rounds and keep a daily log of volume captured, sources unavailable and fields left blank.',
      'Draw a random sample of at least ten per cent of each batch and re-verify it field by field against the original source.',
      'Calculate and publish a per-batch error rate, split by field, so that the worst-performing fields can be redesigned.',
      'Trace recurring errors back to their cause — an ambiguous field label, a source that changed layout, an unclear instruction — and fix the cause.',
      'Document the full collection method so an independent person could repeat the exercise and get the same result.',
      'Hand verified batches to the downstream research and operations teams with a signed-off quality summary.',
    ],
    skills: [
      'Survey and form instrument design',
      'Sampling methodology for quality checks',
      'Structured web and document data extraction',
      'Spreadsheet validation rules and data types',
      'SQL fundamentals',
      'Basic scripting for repetitive capture tasks',
      'Error-rate calculation and reporting',
      'Root-cause analysis',
      'Meticulous attention to detail',
      'Process documentation',
      'Written communication',
    ],
    learningOutcomes: [
      'Collection Instrument and Field Design',
      'Sampling-Based Verification Method',
      'Error-Rate Measurement and Reporting',
      'Root-Cause Correction of Capture Defects',
      'Reproducible Collection Documentation',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Statistics', 'Social Sciences', 'Data Science', 'Commerce', 'Psychology', 'Any Relevant Discipline'],
    keywords: ['Data Collection', 'Data Verification', 'Survey Design', 'Sampling', 'Error Rate', 'Data Capture', 'Field Research', 'Quality Checks', 'Research Operations', 'Data Accuracy'],
  }),

  // ===================================================================================
  // 3. Data Verification Intern — verification only, against authoritative primary sources.
  // ===================================================================================
  role({
    slug: 'data-verification-intern', departmentId: 'operations', title: 'Data Verification Intern', noOfInterns: 5,
    about: 'This is a verification-only role: you do not collect or research new data, you establish whether records already in our systems are true. The queue is real — institution and accreditation status, employer and organisation details, applicant-declared credentials, and contact records that people have asked us to correct. Each record is checked against an authoritative primary source, given a disposition code, and closed with an evidence trail showing what was checked, where, and on what date. Because verification outcomes can affect a real person or a real partner, the standard here is evidence over inference, and anything ambiguous is escalated rather than guessed.',
    responsibilities: [
      'Work a daily verification queue, checking each record against an authoritative primary source such as an official register or the issuing body itself.',
      'Apply a fixed set of disposition codes — verified, contradicted, source unavailable, insufficient evidence — with no informal categories.',
      'Record an evidence trail for every decision: source consulted, date consulted, the exact value found, and the checker identity.',
      'Escalate ambiguous or conflicting cases to a reviewer instead of resolving them on judgement alone.',
      'Meet a stated turnaround target per record and report daily on queue age, throughput and backlog.',
      'Re-verify a rotating sample of previously closed records to confirm the checks themselves remain reliable.',
      'Flag records that require periodic re-verification because their underlying status can lapse or be withdrawn.',
      'Maintain the verification handbook, including the current list of accepted primary sources for each record type.',
    ],
    skills: [
      'Primary-source verification technique',
      'Working with official registers and public records',
      'Evidence documentation and audit trails',
      'Disposition coding and consistent classification',
      'Queue and turnaround management',
      'Spreadsheet and internal tooling proficiency',
      'Careful reading and discrepancy spotting',
      'Confidentiality and data-handling discipline',
      'Escalation judgement',
      'Clear written notes',
    ],
    learningOutcomes: [
      'Primary-Source Verification Practice',
      'Evidence Trail and Audit Documentation',
      'Disposition Coding and Consistency',
      'Verification Turnaround and Queue Management',
      'Re-Verification and Check Reliability Sampling',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Commerce', 'Law', 'Business Administration', 'Library and Information Science', 'Any Relevant Discipline'],
    keywords: ['Data Verification', 'Record Verification', 'Primary Source Checking', 'Evidence Trail', 'Audit Documentation', 'Verification Queue', 'Credential Checking', 'Back Office Operations', 'Accuracy', 'Compliance Support'],
  }),

  // ===================================================================================
  // 4. Business Data Research Intern — account-level firmographic data for outreach.
  // ===================================================================================
  role({
    slug: 'business-data-research-intern', departmentId: 'sales-bd', title: 'Business Data Research Intern', noOfInterns: 4,
    about: 'This role owns the account-level data our partnerships team works from, which is a different job from market research. Market research asks how large a segment is and where it is going; this role answers who specifically is in it — building and maintaining a verified list of several hundred target institutions, training providers and employer organisations, with their size, programme mix, region, accreditation status and the roles of the people who actually decide. The hard part is not building the list, it is keeping it true as organisations merge, rename, relocate, change leadership and close. You will also measure how stale the list is and report that number honestly.',
    responsibilities: [
      'Build and maintain a verified account list of target institutions, training providers and employer organisations, with a documented inclusion rule.',
      'Capture firmographic fields for each account: size, programme or service mix, region, ownership type, accreditation or registration status.',
      'Map decision-making roles at each account by title and function, without collecting personal information beyond a professional business context.',
      'Detect and process changes — mergers, renames, relocations, closures, leadership changes — and record the effective date of each change.',
      'Run a scheduled freshness audit and report the percentage of records not confirmed within the review window.',
      'Segment the list into prioritised tiers using agreed criteria, and document why each tier exists.',
      'Produce short account briefs for the partnerships team ahead of first conversations.',
      'Keep the list compliant with data-protection expectations, including honouring removal requests promptly.',
    ],
    skills: [
      'Firmographic and account research',
      'Public register and filings research',
      'Spreadsheet and CRM data hygiene',
      'De-duplication and entity matching',
      'Segmentation and prioritisation logic',
      'Data freshness measurement',
      'Business writing for account briefs',
      'Data-protection awareness in business contexts',
      'Attention to detail',
      'Independent working to a schedule',
    ],
    learningOutcomes: [
      'Account List Construction and Maintenance',
      'Firmographic Research Technique',
      'Entity Change Tracking and De-duplication',
      'Data Freshness Auditing',
      'Account Segmentation and Briefing',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Commerce', 'Economics', 'Marketing', 'Any Relevant Discipline'],
    keywords: ['Business Data Research', 'Account Research', 'Firmographics', 'Lead Data', 'CRM Data Hygiene', 'Entity Matching', 'Segmentation', 'Partnerships Research', 'Data Freshness', 'Business Development Support'],
  }),

  // ===================================================================================
  // 5. Database Development Intern — schema, migrations, indexes, queries.
  // ===================================================================================
  role({
    slug: 'database-development-intern', departmentId: 'engineering', title: 'Database Development Intern', noOfInterns: 4,
    about: 'This is a build role inside a large, live relational database that already carries well over two hundred tables. You will model new entities, write forward-only migrations, choose keys and constraints that make invalid states impossible, add the indexes a query plan actually needs, and write the SQL behind product features. The emphasis is on correctness at the schema level: a constraint that rejects bad data at write time is worth more than a report that finds it a month later. This is distinct from the Data Engineering internship, which moves data between systems; here you design and change the store itself.',
    responsibilities: [
      'Model new entities and relationships, and produce an entity-relationship diagram before writing any migration.',
      'Write forward-only schema migrations with a tested rollback plan, and never apply an untested migration to shared environments.',
      'Choose primary keys, foreign keys, unique constraints and check constraints that make invalid states unrepresentable.',
      'Add and justify indexes by reading query plans, and remove indexes that no query uses.',
      'Write and review SQL for product features, including joins, aggregates and window functions.',
      'Build views and stored logic where they simplify application code, and document what each one is for.',
      'Write seed and fixture data so that new environments and tests start from a known state.',
      'Maintain a data dictionary describing every table and column added during the internship.',
    ],
    skills: [
      'SQL (joins, aggregates, window functions)',
      'Relational data modelling and normalisation',
      'PostgreSQL fundamentals',
      'Schema migration authoring',
      'Indexing and query-plan reading',
      'Constraint and referential-integrity design',
      'Transactions and isolation basics',
      'Version control with Git',
      'Test fixtures and seed data',
      'Technical documentation',
      'Debugging',
    ],
    learningOutcomes: [
      'Relational Schema Design and Normalisation',
      'Safe Migration Authoring and Rollback Planning',
      'Index Design from Query Plans',
      'Constraint-Driven Data Integrity',
      'Production SQL Development',
    ],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Information Technology', 'Software Engineering', 'Computer Applications', 'Any Relevant Discipline'],
    keywords: ['Database Development', 'SQL', 'PostgreSQL', 'Schema Design', 'Database Migrations', 'Indexing', 'Data Modelling', 'Referential Integrity', 'Query Writing', 'Backend Engineering'],
  }),

  // ===================================================================================
  // 6. Database Research Intern — benchmarking and evidence for database decisions.
  // ===================================================================================
  role({
    slug: 'database-research-intern', departmentId: 'engineering', title: 'Database Research Intern', noOfInterns: 3,
    about: 'This role produces the evidence behind database decisions rather than shipping schema changes itself. Real questions are waiting: whether a partial index beats a composite one for our largest tables, how a pooled connection layer behaves under concurrency, when full-text search stops being enough and a vector index earns its cost, whether partitioning a growing event table is worth the operational burden yet. You will build reproducible benchmarks on realistic synthetic data, publish the numbers with the conditions under which they hold, and state plainly when a result does not generalise. A benchmark nobody can re-run is not a finding.',
    responsibilities: [
      'Turn open database questions from the engineering team into precise, testable comparisons with stated success criteria.',
      'Generate realistic synthetic datasets at several scales so results can be shown as a curve rather than a single number.',
      'Build reproducible benchmark harnesses that record hardware, configuration, dataset size and repeat count alongside every result.',
      'Measure indexing strategies, query rewrites, connection pooling behaviour, partitioning and search approaches under controlled load.',
      'Report latency distributions rather than averages alone, including tail behaviour under concurrency.',
      'Review vendor-neutral literature and documentation on the technique being tested and cite it in each report.',
      'Write a short recommendation for each study, including the conditions under which the recommendation stops being valid.',
      'Maintain a benchmark archive so future teams can re-run any study after a version upgrade.',
    ],
    skills: [
      'SQL and query-plan analysis',
      'PostgreSQL internals fundamentals',
      'Benchmark design and controlled experimentation',
      'Synthetic data generation',
      'Python or shell scripting for harnesses',
      'Statistical reporting (percentiles, variance)',
      'Concurrency and load-testing basics',
      'Technical literature review',
      'Reproducibility discipline',
      'Analytical writing',
    ],
    learningOutcomes: [
      'Database Benchmark Design and Reproducibility',
      'Index, Partitioning and Pooling Evaluation',
      'Latency Distribution and Tail Analysis',
      'Evidence-Based Technical Recommendation',
      'Synthetic Dataset Construction at Scale',
    ],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Information Technology', 'Software Engineering', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['Database Research', 'Database Benchmarking', 'Query Optimisation', 'Indexing Strategies', 'Partitioning', 'Connection Pooling', 'PostgreSQL', 'Performance Analysis', 'Reproducible Experiments', 'Systems Research'],
  }),

  // ===================================================================================
  // 7. Database Operations Intern — keeping a live database healthy.
  // ===================================================================================
  role({
    slug: 'database-operations-intern', departmentId: 'engineering', title: 'Database Operations Intern', noOfInterns: 3,
    about: 'This role keeps a live production database healthy, which is a different discipline from designing or benchmarking one. The work is backups that have actually been restored, slow queries caught before users notice, connection pools that do not saturate at peak, migrations deployed in a window with a rehearsed way back, and capacity forecasts made before disk becomes urgent. You will also write the runbooks that let someone else do this correctly at two in the morning. Nothing here is simulated: the systems you monitor serve real applicants, learners and partner institutions.',
    responsibilities: [
      'Run scheduled backups and, more importantly, perform restore drills that prove each backup can actually be recovered.',
      'Monitor slow-query logs, lock waits and connection-pool utilisation, and raise the ones that are trending in the wrong direction.',
      'Support migration deployment windows, including pre-checks, monitoring during the change and a rehearsed rollback path.',
      'Track table and index growth, and produce a capacity forecast before storage or memory becomes an incident.',
      'Maintain routine maintenance tasks such as statistics refresh, bloat monitoring and retention cleanups.',
      'Write and keep current the database runbooks for backup, restore, failover rehearsal and common incident types.',
      'Participate in post-incident reviews for database-related events and record the follow-up actions honestly.',
      'Report weekly on database health with a small set of consistent metrics rather than a changing dashboard.',
    ],
    skills: [
      'PostgreSQL administration fundamentals',
      'Backup and restore procedures',
      'Slow-query and lock diagnosis',
      'Connection pooling behaviour',
      'Monitoring and alert configuration',
      'Linux command line',
      'Shell scripting for routine tasks',
      'Capacity planning basics',
      'Runbook writing',
      'Incident discipline and calm under pressure',
      'Change-window planning',
    ],
    learningOutcomes: [
      'Backup, Restore and Recovery Verification',
      'Live Database Monitoring and Diagnosis',
      'Migration Deployment and Rollback Practice',
      'Capacity Forecasting for Data Growth',
      'Runbook Authoring and Incident Review',
    ],
    qualificationType: UGPG, qualifications: CS_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Information Technology', 'Software Engineering', 'Computer Applications', 'Any Relevant Discipline'],
    keywords: ['Database Operations', 'Database Administration', 'Backup and Restore', 'Query Performance', 'Monitoring', 'Capacity Planning', 'Runbooks', 'PostgreSQL', 'Production Support', 'Reliability Engineering'],
  }),

  // ===================================================================================
  // 8. Information Research Intern — sourced desk research on rules, standards, literature.
  // ===================================================================================
  role({
    slug: 'information-research-intern', departmentId: 'research', title: 'Information Research Intern', noOfInterns: 4,
    about: 'This role researches information rather than numbers: regulations, accreditation frameworks, technical standards, published literature and official guidance that shape what an education technology platform is allowed to build and claim. A typical week might mean establishing what a particular qualifications framework actually requires, tracing a rule to its originating notification rather than a news summary, and turning both into a briefing note a product or legal reader can act on. Every claim carries a citation to a source someone else can open. This complements Information Architecture, which organises our own content; here you are sourcing and appraising the outside world.',
    responsibilities: [
      'Answer defined research questions from the product, academic and governance teams with sourced, dated briefing notes.',
      'Trace every claim to a primary document — the gazette notification, the standard itself, the published paper — rather than to secondary commentary.',
      'Read and summarise regulations, accreditation frameworks and technical standards into plain, non-legal English.',
      'Conduct structured literature searches and record the search terms and databases used so the search can be repeated.',
      'Flag where sources conflict or where the position is genuinely unsettled, rather than presenting false certainty.',
      'Build and curate an internal reference library with consistent citation records and access notes.',
      'Track amendments to previously researched rules and issue short update notes when a position changes.',
      'Brief stakeholders verbally on findings and record the questions they raise for follow-up research.',
    ],
    skills: [
      'Structured literature and desk research',
      'Primary-source tracing',
      'Regulatory and standards reading',
      'Citation management and referencing standards',
      'Summarising complex text into plain English',
      'Search strategy design',
      'Critical appraisal of source reliability',
      'Reference library curation',
      'Briefing note writing',
      'Verbal presentation',
    ],
    learningOutcomes: [
      'Structured Research and Search Strategy',
      'Primary-Source Tracing and Citation Discipline',
      'Regulatory and Standards Interpretation',
      'Briefing Note Writing for Decision-Makers',
      'Reference Library Curation',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Library and Information Science', 'Law', 'Public Policy', 'Social Sciences', 'Education', 'Any Relevant Discipline'],
    keywords: ['Information Research', 'Desk Research', 'Literature Review', 'Regulatory Research', 'Standards Research', 'Citation Management', 'Briefing Notes', 'Knowledge Curation', 'Policy Research', 'Research Internship'],
  }),

  // ===================================================================================
  // 9. Data Entry Intern — accurate structured capture into internal systems.
  // ===================================================================================
  role({
    slug: 'data-entry-intern', departmentId: 'administration', title: 'Data Entry Intern', noOfInterns: 6,
    about: 'This role is accurate structured capture, and it is judged on accuracy far more than on speed. You will key course and programme metadata, role and department records, attendance and register information, and content sent to us in inconsistent formats, into internal systems that other teams depend on being right. The craft lies in normalisation: the same institution written four ways becomes one entry, dates and units follow one convention, and free text is coded to an agreed vocabulary. Where a record is unclear you raise a query rather than inventing a plausible value, and every batch you complete is spot-checked before it is accepted.',
    responsibilities: [
      'Key structured records into internal systems from source documents, exports and forms, following the field definitions exactly.',
      'Normalise names, dates, units, addresses and codes to the agreed house conventions rather than copying source inconsistencies.',
      'Apply controlled vocabularies when coding free-text fields, and propose new vocabulary terms instead of improvising.',
      'Run double-entry or read-back checks on high-risk fields such as identifiers, amounts and dates.',
      'Raise a query on any unclear, missing or contradictory source value instead of entering a best guess.',
      'Log daily volume, query count and rework so that accuracy can be measured over time.',
      'Maintain entry templates and shortcut lists that reduce keystrokes without reducing accuracy.',
      'Keep all source material confidential and handle personal information strictly according to internal policy.',
    ],
    skills: [
      'Fast, accurate keyboard data entry',
      'Spreadsheet proficiency and data validation',
      'Data normalisation conventions',
      'Controlled vocabulary coding',
      'Double-entry and read-back checking',
      'Document handling and file organisation',
      'Confidentiality and personal-data care',
      'Consistency and sustained concentration',
      'Query logging and escalation',
      'Basic reporting of daily throughput',
    ],
    learningOutcomes: [
      'High-Accuracy Structured Data Capture',
      'Data Normalisation and House Conventions',
      'Controlled Vocabulary Coding',
      'Self-Checking and Query Escalation Practice',
      'Confidential Record Handling',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Commerce', 'Business Administration', 'Computer Applications', 'Arts', 'Any Relevant Discipline'],
    keywords: ['Data Entry', 'Records Capture', 'Data Normalisation', 'Spreadsheet Skills', 'Accuracy', 'Back Office', 'Administrative Support', 'Controlled Vocabulary', 'Document Handling', 'Confidentiality'],
  }),

  // ===================================================================================
  // 10. Data Operations Intern — running scheduled data workflows in production.
  // ===================================================================================
  role({
    slug: 'data-operations-intern', departmentId: 'operations', title: 'Data Operations Intern', noOfInterns: 4,
    about: 'This role runs the data workflows that are already in production, rather than building new ones. Scheduled jobs export, sync, reconcile and refresh data across our systems every day, and someone has to know by mid-morning whether they all completed, which ones failed, what the failure means for the teams downstream, and whether a safe reprocess will fix it. You will hold the exception queue, chase records that fell out of a job, publish a daily run summary, and improve the runbooks each time a failure turns out to be poorly documented. Success looks unremarkable: jobs finish, numbers reconcile, and nobody downstream is surprised.',
    responsibilities: [
      'Monitor scheduled data jobs daily and confirm completion, record counts and expected run duration for each one.',
      'Triage failed and partially completed runs, decide between reprocessing, skipping and escalating, and record the decision.',
      'Hold and work the exception queue of records rejected by validation rules until each is corrected or formally closed.',
      'Run reconciliation checks between source and destination systems and investigate any count or total that does not match.',
      'Publish a short daily operations summary covering runs, failures, exceptions cleared and open issues.',
      'Track service levels for data delivery and report where a downstream team received data late.',
      'Improve runbooks after each incident so the next person can resolve the same failure without help.',
      'Coordinate planned data changes with the teams that consume the affected datasets before, not after, the change.',
    ],
    skills: [
      'SQL for reconciliation and record chasing',
      'Job scheduling and workflow monitoring concepts',
      'Exception queue handling',
      'Reconciliation and control-total techniques',
      'Incident triage and escalation',
      'Runbook maintenance',
      'Spreadsheet reporting',
      'Basic scripting for repetitive checks',
      'Stakeholder communication',
      'Reliability under routine pressure',
    ],
    learningOutcomes: [
      'Production Data Job Monitoring and Triage',
      'Exception Queue and Reprocessing Practice',
      'Source-to-Destination Reconciliation',
      'Data Service Level Reporting',
      'Operational Runbook Improvement',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Applications', 'Information Technology', 'Business Administration', 'Statistics', 'Any Relevant Discipline'],
    keywords: ['Data Operations', 'DataOps', 'Job Monitoring', 'Reconciliation', 'Exception Handling', 'Runbooks', 'Data Reliability', 'Operations Support', 'SQL', 'Service Levels'],
  }),

  // ===================================================================================
  // 11. Data Processing Intern — turning messy incoming files into clean outputs.
  // ===================================================================================
  role({
    slug: 'data-processing-intern', departmentId: 'operations', title: 'Data Processing Intern', noOfInterns: 4,
    about: 'This role turns messy incoming files into clean, structured output that other systems can accept. The input is whatever partners and internal teams actually send — spreadsheets with merged cells, character-encoding damage, dates in three formats in one column, exports where a heading repeats halfway down the file. You will write repeatable transformation scripts rather than fixing files by hand, encode the parsing and cleaning rules so the same file arriving next month needs no rework, and reconcile row counts and control totals so that nothing is silently dropped in transit. It is the transformation step specifically, sitting between capture and the systems that consume the data.',
    responsibilities: [
      'Parse incoming files in varied formats and encodings into a single defined output schema.',
      'Write repeatable transformation scripts instead of manual one-off fixes, and keep them in version control.',
      'Encode cleaning rules for dates, numbers, units, names and addresses so that the same rule is applied identically every time.',
      'De-duplicate records using agreed matching rules and keep a record of what was merged and why.',
      'Reconcile input and output row counts and control totals for every batch, and investigate any difference.',
      'Quarantine rows that fail validation with a clear reason code rather than discarding them.',
      'Profile each new input source before writing a transformation, and document its quirks for the next person.',
      'Report processing time and failure reasons per batch so that recurring input problems can be raised with the sender.',
    ],
    skills: [
      'Python for data processing (pandas or equivalent)',
      'SQL',
      'Regular expressions',
      'Character encoding and file format handling',
      'Data cleaning and standardisation rules',
      'De-duplication and record matching',
      'Control totals and batch reconciliation',
      'Data profiling',
      'Version control with Git',
      'Scripting for automation',
      'Documentation',
    ],
    learningOutcomes: [
      'Repeatable Data Transformation Scripting',
      'Cleaning and Standardisation Rule Design',
      'De-duplication and Record Matching',
      'Batch Reconciliation and Quarantine Handling',
      'Input Source Profiling',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Computer Applications', 'Statistics', 'Data Science', 'Information Technology', 'Any Relevant Discipline'],
    keywords: ['Data Processing', 'Data Cleaning', 'Data Transformation', 'Python', 'Pandas', 'Regular Expressions', 'De-duplication', 'File Parsing', 'Batch Reconciliation', 'Data Standardisation'],
  }),

  // ===================================================================================
  // 12. Data Administration Intern — the register, access requests, retention, archiving.
  // ===================================================================================
  role({
    slug: 'data-administration-intern', departmentId: 'administration', title: 'Data Administration Intern', noOfInterns: 3,
    about: 'This role administers data as an asset that has to be registered, accessed, retained and eventually disposed of correctly. You will maintain the register of internal datasets and who owns each one, process access requests through a documented approval path, run periodic access reviews to remove permissions people no longer need, apply retention schedules, and prepare archive and disposal records that stand up to inspection. Where the existing Data Governance role writes policy, this role is the administration that makes the policy visible in practice — the register that is actually current, and the access list that actually matches who works here today.',
    responsibilities: [
      'Maintain the register of internal datasets, recording owner, purpose, sensitivity level, location and review date.',
      'Process data access requests end to end: capture the request, obtain the documented approval, and record what was granted.',
      'Run periodic access reviews with dataset owners and remove permissions that are no longer justified.',
      'Apply retention schedules, identify records due for archive or disposal, and prepare the disposal record for approval.',
      'Keep an auditable log of grants, revocations, archives and disposals with dates and approvers.',
      'Track licence and agreement terms attached to externally supplied datasets and diarise their renewal or expiry.',
      'Prepare periodic reports on register completeness, overdue reviews and outstanding access requests.',
      'Support internal audit and compliance queries by producing the relevant records promptly and accurately.',
    ],
    skills: [
      'Data register and asset catalogue maintenance',
      'Access request and approval workflow administration',
      'Access review and least-privilege practice',
      'Retention schedule application',
      'Records archiving and disposal procedure',
      'Audit log discipline',
      'Spreadsheet and tracker management',
      'Confidentiality and data-protection awareness',
      'Stakeholder follow-up and chasing',
      'Report preparation',
    ],
    learningOutcomes: [
      'Data Asset Register Administration',
      'Access Request and Review Workflow',
      'Retention, Archiving and Disposal Practice',
      'Auditable Record-Keeping',
      'Compliance Reporting Support',
    ],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Library and Information Science', 'Business Administration', 'Commerce', 'Law', 'Information Systems', 'Any Relevant Discipline'],
    keywords: ['Data Administration', 'Data Register', 'Access Management', 'Access Reviews', 'Retention Schedules', 'Records Management', 'Archiving', 'Audit Logs', 'Data Custodianship', 'Administrative Support'],
  }),
];

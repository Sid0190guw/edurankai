// src/data/intern-catalog-biz5.ts — Business Batch 5: Information Governance, Growth, Outreach and
// Partnerships. Twelve roles covering the operational management of data, information and records;
// community and ecosystem growth; and the research desks behind outreach, partnerships, government,
// institutional and corporate engagement. Cross-checked against the full existing catalog
// (role-catalog.ts + intern-catalog.ts + intern-catalog-phase2/3/4/5.ts) before writing: where a
// neighbouring title already exists — Data Governance, Data Stewardship, Data Quality, Information
// Architecture, Records & Archives, Community Marketing, Growth Marketing, Partnership Development,
// Government Relations, Institutional Partnerships, Corporate Affairs, Process Improvement — the
// role below states plainly what it does differently, and does not restate the neighbour.
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
const STD_QUALIFICATIONS = ["Any Bachelor's Degree", "Any Master's Degree", 'Diploma', 'Integrated Degree'];

// =====================================================================================
// INFORMATION GOVERNANCE — the custody of data, information and records.
// Deliberately separated: Data Management runs structured operational datasets; Information
// Management runs unstructured knowledge assets and their access links; Records Management runs
// the statutory record lifecycle and its evidence trail.
// =====================================================================================
const INFORMATION_GOVERNANCE: CatalogRole[] = [
  role({
    slug: 'data-management-intern', departmentId: 'data-platform', title: 'Data Management Intern', noOfInterns: 4,
    about: 'This is the hands-on custody of the operational datasets the company runs on — applications, candidates, roles, institution lists, and the internal reporting tables built from them. It is deliberately distinct from the existing Data Governance role, which writes policy, from Data Stewardship, which documents metadata, and from Data Quality, which builds automated tests: this role does the daily work of importing, correcting, merging and reconciling live records. Every bulk change is treated as a controlled operation with an authorisation, a row count and a route back. The intern will spend most of their time inside real production data, which is why care matters more here than speed.',
    responsibilities: [
      'Run intake for internal data requests — extracts, corrections, bulk updates — and track each one to closure with a written audit note.',
      'Prepare and validate bulk imports before they reach production: column mapping, encoding, date formats, phone and email normalisation.',
      'Reconcile the same entity across systems where the values disagree, and settle the correct value with the owning team rather than guessing.',
      'Maintain matching and de-duplication rules for people and institution records, and merge duplicates without losing linked history.',
      'Keep a change log for every bulk operation recording what changed, how many rows, who authorised it and how it can be reversed.',
      'Publish a weekly data-health summary covering row counts, null rates, orphaned references and anything that moved unexpectedly.',
      'Support extract and archive routines for datasets that are no longer active but must remain retrievable.',
      'Document each managed dataset with its owner, refresh cadence and agreed source of truth.',
    ],
    skills: ['SQL (SELECT, JOIN, UPDATE with care)', 'Advanced spreadsheet work (lookups, pivots, validation)', 'CSV and delimited-file wrangling', 'Data normalisation and formatting rules', 'Record matching and de-duplication', 'Scripting basics (Python) for one-off transformations', 'Change control and reversibility discipline', 'Written documentation', 'Attention to detail under repetition', 'Confidentiality with personal data', 'Stakeholder communication'],
    learningOutcomes: ['Operational Data Management Practice', 'Controlled Bulk Import and Migration', 'Record Matching and De-duplication', 'Cross-System Data Reconciliation', 'Change Logging and Reversibility', 'Data-Health Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Information Systems', 'Data Science', 'Computer Applications', 'Statistics', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Data Management', 'Data Operations', 'Bulk Import', 'Data Reconciliation', 'De-duplication', 'SQL', 'Data Hygiene', 'Master Records', 'Data Custody', 'Information Governance'],
  }),
  role({
    slug: 'information-management-intern', departmentId: 'operations', title: 'Information Management Intern', noOfInterns: 3,
    about: 'Most of what an organisation knows never reaches a database table — it sits in briefs, specifications, research notes, handbooks and shared links, and it quietly rots. This role manages those unstructured information assets: what exists, who owns it, who can open it, when it was last reviewed and whether it is still true. Because company documents are held as access-controlled shared links rather than uploaded files, the register of those links and their permissions is effectively the information system, and keeping it honest is the core of the job. It is distinct from the existing Information Architecture role, which designs navigation and structure for product surfaces, and from Data Management, which handles structured records.',
    responsibilities: [
      'Maintain the register of company information assets held as shared links, recording owner, access level, purpose and next review date.',
      'Audit link permissions on a regular cycle and flag anything shared more widely than intended, or any link that has gone dead.',
      'Build and maintain the internal naming convention and taxonomy so material can be found by someone who did not create it.',
      'Consolidate duplicate and superseded versions into one current copy, marking older versions clearly rather than deleting them silently.',
      'Run a periodic information review with each team covering what is current, what is obsolete and what is missing entirely.',
      'Write short orientation guides that tell a new joiner where to find the material their role depends on.',
      'Chase owners of internal handbooks and specifications that are past their stated review date.',
      'Tag material with consistent keywords so internal search returns the right document rather than the most recent one.',
    ],
    skills: ['Information and knowledge management fundamentals', 'Taxonomy and metadata tagging', 'Document control and versioning', 'Access-permission auditing', 'Technical and plain-English writing', 'Spreadsheet-based registers', 'Requirement elicitation through interviews', 'Attention to detail', 'Confidentiality judgement', 'Organisation across many small items', 'Follow-up persistence'],
    learningOutcomes: ['Information Asset Register Design', 'Taxonomy and Metadata Practice', 'Access and Permission Auditing', 'Document Version Control', 'Findability and Search Improvement'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Library and Information Science', 'Information Systems', 'Business Administration', 'English and Communication', 'Any Relevant Discipline'],
    keywords: ['Information Management', 'Knowledge Management', 'Document Control', 'Taxonomy', 'Metadata', 'Access Audit', 'Version Control', 'Findability', 'Information Governance', 'Internal Documentation'],
  }),
  role({
    slug: 'records-management-intern', departmentId: 'administration', title: 'Records Management Intern', noOfInterns: 3,
    about: 'Certain records must be produced on demand, kept for a defined period, and destroyed defensibly when that period ends — internship applications, offer and completion letters, issued certificates, consent records and statutory registers. The existing Records and Archives role designs the retention schedule and organises the archive; this role executes that schedule day to day and produces the evidence that it was followed. That means disposition lists, legal holds, approval records and access requests handled inside stated timelines. It suits a student who takes satisfaction in an audit trail that survives scrutiny.',
    responsibilities: [
      'Apply the approved retention schedule to live record classes and prepare disposition lists for review before anything is acted on.',
      'Maintain the legal-hold list so records under dispute, audit or investigation are never destroyed on their normal schedule.',
      'Log every disposition with what was archived or destroyed, on whose authority, on what date and with what approval reference.',
      'Support record access and correction requests from candidates and staff, tracking each against its response deadline.',
      'Verify that issued documents such as certificates and letters carry a recorded, verifiable reference number.',
      'Spot-check a monthly sample of records for completeness and report gaps with the process that caused them.',
      'Assemble record packs for audits and statutory filings so nothing is gathered in a panic at the deadline.',
      'Keep the record inventory current as new processes introduce new record types.',
    ],
    skills: ['Records lifecycle management', 'Retention and disposition practice', 'Legal hold concepts', 'Audit-trail documentation', 'Data-protection awareness', 'Register and log maintenance', 'Working to statutory deadlines', 'Meticulous attention to detail', 'Discretion with confidential material', 'Clear written communication'],
    learningOutcomes: ['Record Lifecycle Execution', 'Defensible Disposition and Audit Trails', 'Legal Hold Practice', 'Record Access Request Handling', 'Audit and Filing Pack Preparation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Library and Information Science', 'Law', 'Business Administration', 'Commerce', 'Any Relevant Discipline'],
    keywords: ['Records Management', 'Retention Schedule', 'Disposition', 'Legal Hold', 'Audit Trail', 'Statutory Records', 'Compliance Administration', 'Record Inventory', 'Document Retention', 'Information Governance'],
  }),
];

// =====================================================================================
// GROWTH, OUTREACH AND ECOSYSTEM — the people-facing side: growing the community,
// making first contact, and cultivating the wider network the platform sits inside.
// =====================================================================================
const GROWTH_AND_OUTREACH: CatalogRole[] = [
  role({
    slug: 'community-growth-intern', departmentId: 'growth', title: 'Community Growth Intern', noOfInterns: 4,
    about: 'This role grows the learner and instructor community itself — the path from first visit to a member who returns without being prompted. It is not the existing Community Marketing role, which runs campaigns and content, and it is not Community Support, which answers questions: the measure here is activation and retention by cohort. Work includes onboarding sequences, small recurring rituals that give people a reason to come back, and campus chapters run by students rather than by us. Honest numbers matter more than large ones, and a cohort that quietly stopped participating is treated as the most important thing to explain.',
    responsibilities: [
      'Run onboarding sequences for new members and measure how many reach a first meaningful activity rather than merely signing up.',
      'Track activation and retention by weekly cohort, and report what changed with a stated reason rather than a shrug.',
      'Recruit and support campus chapter leads, giving them a repeatable playbook instead of one-off help.',
      'Design and run small community rituals such as study rooms, question threads and showcase sessions, and measure real attendance.',
      'Interview lapsed members to find the actual reason they stopped, and write it up even when it is unflattering.',
      'Maintain the community calendar and coordinate the contributors who make each session happen.',
      'Pass recurring member requests to the product team with frequency counts and quotes as evidence.',
      'Draft updates to community guidelines as the group grows, and escalate moderation cases through the agreed policy rather than acting alone.',
    ],
    skills: ['Community management', 'Cohort and funnel analysis', 'Spreadsheet reporting and simple dashboards', 'Clear written communication', 'Event facilitation', 'User interviewing', 'De-escalation and conflict handling', 'Social listening', 'Content scheduling', 'Volunteer and contributor coordination', 'Empathy with new learners'],
    learningOutcomes: ['Activation and Retention Measurement', 'Cohort Onboarding Design', 'Chapter and Ambassador Programme Operations', 'Community Ritual Design', 'Evidence-Based Product Feedback'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Marketing', 'Business Administration', 'Psychology', 'Mass Communication', 'Any Relevant Discipline'],
    keywords: ['Community Growth', 'Community Building', 'Member Activation', 'Retention', 'Cohort Analysis', 'Campus Chapters', 'Ambassador Programme', 'Community Engagement', 'Onboarding', 'Learner Community'],
  }),
  role({
    slug: 'strategic-outreach-intern', departmentId: 'growth', title: 'Strategic Outreach Intern', noOfInterns: 4,
    about: 'Strategic outreach is the discipline of first contact — approaching named organisations and named people with a specific reason, then handling whatever comes back. It sits before partnership development, which negotiates once a conversation exists, and beside marketing, which broadcasts to an audience rather than writing to one person. The intern builds sequences, tests message variants, books meetings and reports reply rates including the ones that embarrass the current approach. Courtesy is non-negotiable: a suppression list exists and is respected absolutely.',
    responsibilities: [
      'Build target lists of named organisations with the specific person to approach and a written reason each one is a genuine fit.',
      'Draft and test outreach messages, running at least two variants and reporting reply rates honestly including the failures.',
      'Maintain a sequenced follow-up cadence so nobody is contacted twice in a week and nobody is forgotten after a single email.',
      'Log every response — positive, negative or silent — in the CRM with the next action and the date it falls due.',
      'Prepare short briefing notes and book meetings for the colleagues who take the conversation forward.',
      'Maintain the suppression list of organisations that have asked not to be contacted, and check every send against it.',
      'Report weekly on outreach volume, reply rate, meeting rate and the reasons given for refusal.',
      'Refine targeting each fortnight based on which segments actually reply, and retire the segments that do not.',
    ],
    skills: ['Professional written English', 'Outreach sequencing and cadence design', 'CRM hygiene and pipeline discipline', 'Prospect research', 'Message testing and comparison', 'Spreadsheet reporting', 'Objection handling', 'Calendar and meeting coordination', 'Polite persistence', 'Accurate note-taking', 'Basic funnel analytics'],
    learningOutcomes: ['Structured Outreach Programme Design', 'Message Testing and Reply-Rate Analysis', 'CRM and Pipeline Discipline', 'Meeting Preparation and Briefing', 'Segment-Level Targeting Refinement'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Marketing', 'Mass Communication', 'International Relations', 'Any Relevant Discipline'],
    keywords: ['Strategic Outreach', 'Business Outreach', 'Cold Outreach', 'Lead Generation', 'CRM', 'Message Testing', 'Meeting Booking', 'Prospecting', 'Reply Rate', 'Outreach Analytics'],
  }),
  role({
    slug: 'partnership-research-intern', departmentId: 'sales-bd', title: 'Partnership Research Intern', noOfInterns: 3,
    about: 'This is the diligence that should happen before anyone is approached. The intern profiles candidate partner organisations — legal standing, approvals held, programmes offered, scale, funding basis — maps who actually signs and which committee approves, and scores fit against an agreed rubric. It is distinct from the existing Partnership Development role, which negotiates and manages the relationship, and from Market Research, which works at sector level rather than on named organisations. Every claim in a profile carries a source, because a briefing that cannot be re-verified is worse than no briefing at all.',
    responsibilities: [
      'Build partner profiles covering legal entity, approvals and recognitions held, size, programmes offered, geography and funding basis.',
      'Map the decision structure: who signs, who influences, which committee approves, and how often that committee meets.',
      'Check for existing exclusive arrangements or conflicts of interest before an organisation is approached.',
      'Score candidates against an agreed fit rubric and be able to defend each score with evidence rather than impression.',
      'Track renewal dates, leadership changes and policy shifts that alter a candidate readiness or timing.',
      'Compress each profile into a one-page brief the business development team can actually use inside a meeting.',
      'Maintain a source citation for every factual claim so any profile can be re-verified months later.',
      'Flag reputational or regulatory risk findings promptly, factually and without editorialising.',
    ],
    skills: ['Structured desk research', 'Primary-source verification', 'Regulatory and accreditation literacy', 'Stakeholder and decision-maker mapping', 'Fit-scoring rubric design', 'Spreadsheet modelling', 'Concise business writing', 'Critical evaluation of sources', 'Risk flagging judgement', 'Confidentiality', 'Meeting-ready summarisation'],
    learningOutcomes: ['Partner Due-Diligence Research', 'Decision-Maker and Committee Mapping', 'Fit-Scoring Methodology', 'One-Page Briefing Craft', 'Source Verification Discipline'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Economics', 'Law', 'International Business', 'Any Relevant Discipline'],
    keywords: ['Partnership Research', 'Partner Due Diligence', 'Stakeholder Mapping', 'Fit Scoring', 'Business Development Research', 'Organisation Profiling', 'Decision Mapping', 'Briefing Notes', 'Source Verification', 'Partner Intelligence'],
  }),
  role({
    slug: 'ecosystem-development-intern', departmentId: 'growth', title: 'Ecosystem Development Intern', noOfInterns: 3,
    about: 'Around any learning platform sits an ecosystem that no single agreement can capture — student clubs, teaching co-operatives, independent tool builders, incubators, alumni networks and subject associations. None of them is a partner in the contractual sense, yet together they decide whether the platform is adopted or ignored. This role maps that ecosystem, connects its parts to each other, and runs small pilot programmes to test what actually creates activity. It differs from partnership work by being many-to-many rather than one-to-one, and it is judged on whether the programmes keep running after the intern leaves.',
    responsibilities: [
      'Map the ecosystem: which groups are genuinely active, who convenes them, how they are funded and what they currently lack.',
      'Identify pairs of ecosystem members who would benefit from knowing each other, and make the introduction properly.',
      'Design and run one small pilot programme, such as a club toolkit, a builder challenge or an alumni mentoring loop, and report what worked.',
      'Maintain an ecosystem directory recording contact, activity level, last interaction and what each group cares about.',
      'Track the third-party tools and open standards our users already rely on, and note where an integration would remove real friction.',
      'Represent the platform at student and community events, then write up what was learned rather than only what was said.',
      'Report ecosystem health using a small number of honest indicators instead of a large number of vanity counts.',
      'Document each programme thoroughly enough that a successor can run it from the notes alone.',
    ],
    skills: ['Ecosystem and network mapping', 'Programme design and pilot evaluation', 'Relationship management across many small groups', 'Event participation and representation', 'Written reporting', 'Directory and spreadsheet maintenance', 'Facilitation', 'Desk research', 'Public speaking basics', 'Awareness of integrations and open standards', 'Self-directed initiative'],
    learningOutcomes: ['Ecosystem Mapping', 'Programme Design and Pilot Evaluation', 'Multi-Stakeholder Relationship Management', 'Ecosystem Health Indicators', 'Programme Handover Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Entrepreneurship', 'Sociology', 'Marketing', 'Any Relevant Discipline'],
    keywords: ['Ecosystem Development', 'Ecosystem Mapping', 'Community Networks', 'Student Clubs', 'Alumni Networks', 'Programme Design', 'Pilot Programmes', 'Developer Ecosystem', 'Network Building', 'Growth Programmes'],
  }),
];

// =====================================================================================
// RESEARCH DESKS — four distinct research functions that supply evidence to the people who
// hold relationships. None of these roles represents the company externally; each is defined
// by the specific body of source material it reads and the specific brief it produces.
// =====================================================================================
const RELATIONS_RESEARCH: CatalogRole[] = [
  role({
    slug: 'government-relations-research-intern', departmentId: 'governance-affairs', title: 'Government Relations Research Intern', noOfInterns: 3,
    about: 'This is the research desk behind government engagement, not the engagement itself — the existing Government Relations role holds the conversations, while this role supplies the evidence those conversations depend on. The source material is public and specific: gazette notifications, department circulars, scheme guidelines, tender documents, consultation papers and committee reports touching education, skilling and technology. The intern turns each into a short brief that quotes the text rather than paraphrasing it loosely, and maintains the calendar of deadlines that makes the difference between a considered response and a missed window. A firm line is kept between what a document says and what we infer from it.',
    responsibilities: [
      'Monitor central and state notifications, gazettes and departmental circulars relevant to education, skilling and technology.',
      'Track open public consultations with their deadlines and summarise what a credible response would need to address.',
      'Read scheme and tender documents and extract eligibility, timelines, documentation and evaluation criteria into a comparable table.',
      'Maintain a calendar of policy deadlines, scheme windows and published committee sittings.',
      'Write two-page briefs with direct quotations and working source links for every material claim.',
      'Maintain a register of relevant ministries and departments with their published mandates and current office-bearers by post.',
      'Flag any change affecting our compliance obligations to the governance team within the same week it is published.',
      'Keep inference visibly separate from citation in every note, so a reader always knows which is which.',
    ],
    skills: ['Policy and legislative document research', 'Navigation of official gazettes and government portals', 'Tender and scheme comprehension', 'Precise summarising without distortion', 'Citation discipline', 'Deadline and calendar tracking', 'Plain-English drafting for busy readers', 'Comparative tabulation', 'Critical reading', 'Discretion'],
    learningOutcomes: ['Policy Monitoring Methodology', 'Scheme and Tender Document Analysis', 'Regulatory Briefing Writing', 'Consultation Tracking', 'Source-Faithful Summarising'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Public Policy', 'Political Science', 'Law', 'Economics', 'Any Relevant Discipline'],
    keywords: ['Government Relations Research', 'Policy Research', 'Public Policy', 'Gazette Monitoring', 'Scheme Analysis', 'Tender Analysis', 'Consultation Tracking', 'Regulatory Briefing', 'Government Affairs', 'Policy Calendar'],
  }),
  role({
    slug: 'institutional-relations-research-intern', departmentId: 'governance-affairs', title: 'Institutional Relations Research Intern', noOfInterns: 3,
    about: 'Recognition in education is granted by councils, accreditation bodies, examination boards and professional associations, each with its own approval pathway, evidence requirements and renewal cycle. This research role maps those pathways precisely, because our partner institutions award qualifications and we do not — so knowing exactly what each body requires of a partner is central to how we work. It differs from Government Relations Research, which reads state policy, and from the existing Institutional Partnerships role, which holds the relationship. Everything is verified against the body own published handbook rather than a secondary summary.',
    responsibilities: [
      'Map recognition and accreditation bodies by sector, recording precisely what each one approves and, equally important, what it does not.',
      'Document approval pathways step by step: forms, fees, inspection stages, typical timelines and renewal cycles.',
      'Track amendments to regulations and handbooks issued by these bodies, recording the effective date of each change.',
      'Compare requirements across bodies to show where a single piece of evidence satisfies several applications.',
      'Maintain a register of member or affiliated institutions under each body, with their published standing where available.',
      'Prepare readiness checklists showing what a prospective partner would need in place before an application is viable.',
      'Verify every claim against the published material of the body itself, and record where it was found.',
      'Highlight any place where our own public wording risks overstating who awards a qualification.',
    ],
    skills: ['Regulatory and accreditation research', 'Careful reading of statutes, handbooks and circulars', 'Comparative requirement analysis', 'Process and checklist documentation', 'Register maintenance', 'Structured writing', 'Citation discipline', 'Attention to effective dates and versions', 'Discretion', 'Accuracy under ambiguity'],
    learningOutcomes: ['Accreditation and Recognition Landscape Mapping', 'Approval Pathway Documentation', 'Comparative Regulatory Analysis', 'Partner Readiness Checklists', 'Primary-Source Verification'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Education', 'Law', 'Public Policy', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Institutional Relations Research', 'Accreditation Research', 'Recognition Bodies', 'Approval Pathways', 'Regulatory Mapping', 'Compliance Research', 'Education Regulation', 'Partner Readiness', 'Professional Bodies', 'Institutional Research'],
  }),
  role({
    slug: 'university-outreach-research-intern', departmentId: 'growth', title: 'University Outreach Research Intern', noOfInterns: 4,
    about: 'The single most useful asset an outreach team can have is an accurate list of who to talk to, and the single most common reason outreach fails is that the list has quietly decayed. This role builds and maintains a verified account list of 500 or more universities and colleges, and keeps it accurate as institutions merge, rename, change affiliation, stop admitting students or replace the officer whose name is in the record. It works at breadth and hygiene, where the Partnership Research role works at depth on a shortlist. Success is measured by a sampled error rate that is reported openly, not by the size of the list.',
    responsibilities: [
      'Build and maintain a verified list of 500 or more universities and colleges with department structure, campus locations and student scale.',
      'Verify each record against the institution own website or an official register, recording the source and the date of verification.',
      'Keep the list current through mergers, renamings, changes of affiliation and closures rather than letting stale rows accumulate.',
      'Record functional contacts by role — placement cell, training and placement officer, department head — so a record survives staff turnover.',
      'Capture academic calendars and admission windows so outreach lands at a useful moment and not during examinations.',
      'Segment the list by discipline mix, region, language of instruction and existing digital-learning maturity.',
      'Run a monthly decay check on a random sample and publish the measured error rate instead of assuming the list is clean.',
      'Hand outreach-ready segments to the outreach team with notes explaining what makes each segment distinct.',
    ],
    skills: ['High-volume desk research', 'Verification against official registers', 'Data hygiene and decay management', 'Large list and spreadsheet management', 'Segmentation logic', 'Ethical contact research', 'Sampling and error-rate reporting', 'Basic SQL or advanced filtering', 'Regional and language awareness across India', 'Sustained attention to detail', 'Concise written handover notes'],
    learningOutcomes: ['Institution List Building and Verification', 'Data Decay Management', 'Segmentation for Outreach', 'Ethical Contact Research', 'Sampling-Based Error Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Education', 'Marketing', 'Statistics', 'Any Relevant Discipline'],
    keywords: ['University Outreach Research', 'Institution Database', 'Account List Building', 'Higher Education Research', 'Data Verification', 'Contact Research', 'Market Segmentation', 'Placement Cells', 'List Hygiene', 'Campus Outreach'],
  }),
  role({
    slug: 'corporate-affairs-research-intern', departmentId: 'governance-affairs', title: 'Corporate Affairs Research Intern', noOfInterns: 3,
    about: 'Corporate affairs decisions are only as good as the briefing behind them. This role runs the monitoring and briefing desk: a daily sweep of sector news and regulatory announcements, issue trackers for topics that may require a company position, stakeholder maps, and briefing packs prepared before external meetings and interviews. The existing Corporate Affairs role represents the organisation and speaks for it; this role researches so that it can. Every note distinguishes verified fact from reported claim from rumour, and our own past public statements are archived so future positions stay consistent with them.',
    responsibilities: [
      'Run a daily monitoring sweep of sector news, regulatory announcements and public commentary, and circulate a short digest.',
      'Maintain issue trackers for topics likely to need a company position, recording the current state of public debate on each.',
      'Research industry bodies and forums: membership criteria, cost, obligations and what membership would realistically deliver.',
      'Prepare briefing packs before external meetings covering the counterpart, their recent public statements and the likely questions.',
      'Compile comparative reviews of how peer organisations disclose governance and impact information, kept internal and unattributed in published material.',
      'Maintain a stakeholder map recording interest, influence and current sentiment for each group.',
      'Archive our own public statements and positions so later communications do not contradict earlier ones.',
      'Separate verified fact, reported claim and rumour explicitly in every note that goes to leadership.',
    ],
    skills: ['Media and information monitoring', 'Issue tracking and analysis', 'Stakeholder mapping', 'Briefing pack preparation', 'Comparative disclosure analysis', 'Precise business writing under time pressure', 'Source triage and verification', 'Editorial judgement', 'Discretion with sensitive material', 'Research tooling and alerts', 'Reliable daily delivery'],
    learningOutcomes: ['Issue Monitoring and Tracking', 'Stakeholder Mapping and Sentiment Analysis', 'Executive Briefing Preparation', 'Disclosure Practice Research', 'Source Triage and Verification'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Mass Communication', 'Public Policy', 'Business Administration', 'Journalism', 'Any Relevant Discipline'],
    keywords: ['Corporate Affairs Research', 'Issue Monitoring', 'Stakeholder Mapping', 'Executive Briefing', 'Media Monitoring', 'Reputation Research', 'Industry Bodies', 'Corporate Communications Research', 'Disclosure Research', 'Public Affairs'],
  }),
];

// =====================================================================================
// PROCESS — establishing the documented baseline of how work actually happens.
// =====================================================================================
const PROCESS: CatalogRole[] = [
  role({
    slug: 'business-process-intern', departmentId: 'operations', title: 'Business Process Intern', noOfInterns: 3,
    about: 'Before a process can be improved it has to be written down as it truly runs, including the undocumented workarounds nobody mentions in a meeting. This role produces that baseline: process maps with real handoffs, standard operating procedures a new joiner can follow unaided, responsibility assignments confirmed by their owners, and measured cycle times. It is deliberately separate from the existing Process Improvement and Process Excellence roles, which redesign and optimise; this one establishes and maintains the record they redesign from. A frequent and valuable output is the discovery that a critical process exists only in one person memory.',
    responsibilities: [
      'Interview the people who actually do the work and map each process as it truly runs, including undocumented steps and workarounds.',
      'Produce process maps with clear swim lanes, decision points and the handoffs between teams where delay usually hides.',
      'Write standard operating procedures in plain language that a new joiner can follow without asking anyone.',
      'Record who is responsible, accountable, consulted and informed at each step, and have each owner confirm it in writing.',
      'Measure baseline cycle time and rework rate for two or three core processes so later changes can be judged against evidence.',
      'Maintain a single procedure library with version numbers and review dates, retiring superseded copies rather than leaving them in circulation.',
      'Identify any process that depends on one person memory and raise it as a continuity risk with a suggested mitigation.',
      'Convert repeatable processes into checklists that can be followed inside the internal admin console.',
    ],
    skills: ['Process mapping and flowchart notation', 'Process interviewing and observation', 'Standard operating procedure authoring', 'Responsibility assignment documentation', 'Cycle-time and rework measurement', 'Diagramming tools', 'Plain-English technical writing', 'Spreadsheet analysis', 'Version control of documents', 'Stakeholder management', 'Patience with detail'],
    learningOutcomes: ['As-Is Process Mapping', 'Standard Operating Procedure Authoring', 'Responsibility and Handoff Documentation', 'Baseline Cycle-Time Measurement', 'Continuity Risk Identification'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Industrial Engineering', 'Operations Management', 'Commerce', 'Any Relevant Discipline'],
    keywords: ['Business Process', 'Process Mapping', 'Standard Operating Procedures', 'SOP Documentation', 'Process Documentation', 'Cycle Time', 'Workflow Analysis', 'Operations Documentation', 'Process Baseline', 'Business Analysis'],
  }),
];

export const INTERN_CATALOG_BIZ5: CatalogRole[] = [
  ...INFORMATION_GOVERNANCE,
  ...GROWTH_AND_OUTREACH,
  ...RELATIONS_RESEARCH,
  ...PROCESS,
];

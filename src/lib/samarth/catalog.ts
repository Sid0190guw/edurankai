// SAMARTH service architecture (spec Parts 4, 5, 7, 8, 9, 10 and 15.4). PURE DATA: every public
// SAMARTH page renders from this file, so a service described here is described identically on the
// hub, its sector page, its topic page and in its structured data.
//
// COPY RULES, ENFORCED BY src/lib/samarth/samarth.test.ts:
//   - no emoji, no arrow characters
//   - no named competitor, company, accelerator or vendor
//   - no claim of a licence, certification, accreditation, case study or past client: SAMARTH is a
//     new initiative and none have been verified, so none are stated
//   - regulated work (nuclear, grid, other licensed facilities) is described as delivered THROUGH
//     appropriately licensed and authorised partners, never as SAMARTH's own authority
//   - global: SAMARTH serves organisations in every country. Nothing here limits it to India.

export const SAMARTH = {
  name: 'SAMARTH',
  parent: 'EduRankAI',
  tagline: 'From Research to Reality. From Technology to Transformation.',
  statement:
    'We bring together advanced technologies, research, engineering capabilities and specialised talent to help businesses, governments, manufacturers and institutions conceptualise, develop and implement the intelligent systems and infrastructure of tomorrow.',
  philosophy: 'We identify the opportunity, understand the challenge, mobilise the best expertise and engineer the future.',
  description:
    'SAMARTH is the research, technology consulting, engineering, technology transfer, intelligent infrastructure and venture-building initiative of EduRankAI. It works with governments, public bodies, businesses, manufacturers, universities, research institutions and individuals worldwide.',
  reach: 'Based in India. Working with organisations in every country.',
};

export interface Sector {
  id: 'tertiary' | 'secondary' | 'manufacturing';
  title: string;
  lead: string;
  industries: string[];
  solutions: string[];
}

export const SECTORS: readonly Sector[] = [
  {
    id: 'tertiary',
    title: 'Services and the tertiary sector',
    lead: 'Organisations whose product is a service: care, learning, money, movement, communication and public administration.',
    industries: ['Healthcare', 'Education', 'Financial services', 'Banking', 'Insurance', 'Logistics', 'Transportation', 'Telecommunications', 'Retail', 'Commerce', 'Hospitality', 'Professional services', 'Government administration'],
    solutions: ['Intelligent service systems', 'AI applications', 'Business process automation', 'Enterprise intelligence', 'Predictive analytics', 'Decision-support systems', 'Digital infrastructure', 'Intelligent customer service', 'Institutional management systems'],
  },
  {
    id: 'secondary',
    title: 'Industry and the secondary sector',
    lead: 'Organisations that build, process and power: construction, energy, chemicals, materials, electronics and heavy industry.',
    industries: ['Industrial engineering', 'Construction', 'Infrastructure', 'Energy', 'Electronics', 'Chemical engineering', 'Materials science', 'Heavy industries', 'Industrial automation', 'Engineering and production'],
    solutions: ['Intelligent industrial systems', 'Process automation', 'Computational engineering', 'Simulation', 'Robotics', 'Predictive maintenance', 'Industrial IoT', 'Advanced materials applications', 'Energy optimisation'],
  },
  {
    id: 'manufacturing',
    title: 'Manufacturing',
    lead: 'A dedicated vertical for turning conventional production into connected, intelligent, technology-driven operations.',
    industries: ['Discrete manufacturing', 'Process manufacturing', 'Batch production', 'Contract manufacturing', 'Component and assembly plants'],
    solutions: ['Intelligent manufacturing', 'Smart factories', 'Robotics', 'Autonomous production', 'Computer vision quality inspection', 'Predictive maintenance', 'Production optimisation', 'Digital twins', 'Supply chain intelligence', 'Industrial IoT', 'Manufacturing execution systems', 'Automated monitoring'],
  },
];

/** The industry list the requirements form offers. */
export const INDUSTRIES: readonly string[] = Array.from(new Set([
  ...SECTORS.flatMap((s) => s.industries),
  'Research and academia', 'Public sector', 'Public safety', 'Agriculture and food', 'Media and creative', 'Other',
]));

// -------------------------------------------------------------------------------------------------
// GOVERNMENT (Part 5), worded for any country
// -------------------------------------------------------------------------------------------------

export const GOVERNMENT_ENGAGEMENTS: readonly string[] = [
  'Local governments and municipal bodies',
  'District, county and regional administrations',
  'State and provincial departments',
  'State and provincial governments',
  'National ministries, departments and agencies',
  'International and intergovernmental bodies',
  'Public-sector undertakings and state-owned enterprises',
  'Public universities',
  'Public hospitals and health services',
  'Public research institutions',
  'Publicly funded organisations',
];

export const GOVERNMENT_DOMAINS: readonly { title: string; items: string[] }[] = [
  { title: 'Digital governance', items: ['E-governance', 'Integrated government platforms', 'Administrative workflow automation', 'Citizen service delivery', 'Digital records', 'Government data integration'] },
  { title: 'Intelligent government systems', items: ['AI-based administrative systems', 'Decision-support systems', 'Intelligent command and control centres', 'Predictive governance analytics', 'Integrated monitoring systems'] },
  { title: 'Digital infrastructure', items: ['Government cloud', 'Data centres', 'Secure networking', 'GPU and AI infrastructure', 'Data integration', 'Disaster recovery', 'Digital public infrastructure'] },
  { title: 'Education and research', items: ['AI-enabled university systems', 'Digital university transformation', 'Virtual laboratories', 'Research computing', 'Institutional management systems'] },
  { title: 'Healthcare', items: ['Hospital information systems', 'Integrated healthcare infrastructure', 'Medical research systems', 'Healthcare analytics'] },
  { title: 'Urban and regional infrastructure', items: ['Smart cities', 'Intelligent transportation', 'Municipal technology', 'Smart energy', 'Public infrastructure monitoring'] },
  { title: 'Industrial and economic development', items: ['Industrial clusters', 'Small-enterprise technology transformation', 'Intelligent manufacturing', 'Regional innovation infrastructure'] },
];

/** Complexity and engagement classifications, NOT price tiers (Part 5.3). */
export const GOVERNMENT_PROJECT_LEVELS: readonly { level: number; title: string; detail: string }[] = [
  { level: 1, title: 'Advisory and assessment', detail: 'Technology audits, feasibility, assessment and transformation roadmaps.' },
  { level: 2, title: 'Individual system development', detail: 'Specific government applications, portals and departmental platforms.' },
  { level: 3, title: 'Departmental transformation', detail: 'Integrated departmental architecture and intelligent systems.' },
  { level: 4, title: 'District, county or regional transformation', detail: 'Region-wide digital administration and connected departmental infrastructure.' },
  { level: 5, title: 'State or provincial transformation', detail: 'State-wide or province-wide digital architecture and integrated government infrastructure.' },
  { level: 6, title: 'National, multi-state and international transformation', detail: 'Large-scale national platforms, multi-state or cross-border integration and public digital infrastructure.' },
];

export const GOVERNMENT_LIFECYCLE: readonly string[] = [
  'Opportunity identification', 'Stakeholder identification', 'Requirement collection', 'Preliminary assessment',
  'Technical feasibility', 'Project architecture', 'Detailed project report, where required', 'Cost estimation',
  'Proposal preparation', 'Procurement and tender compliance', 'Partner selection', 'Contracting and approvals',
  'Engineering and implementation', 'Testing and commissioning', 'Training and handover', 'Maintenance and support',
];

// -------------------------------------------------------------------------------------------------
// ENGINEERING, TECHNOLOGY TRANSFER, INFRASTRUCTURE (Part 7)
// -------------------------------------------------------------------------------------------------

export const ENGINEERING_DOMAINS: readonly { id: string; title: string; items: string[] }[] = [
  { id: 'software', title: 'Software and digital products', items: ['Websites', 'Web applications', 'Mobile applications', 'Enterprise software', 'SaaS platforms', 'ERP and CRM', 'Custom digital ecosystems', 'API infrastructure', 'Data engineering'] },
  { id: 'ai', title: 'Artificial intelligence and intelligent systems', items: ['AI systems', 'Intelligent agents', 'Machine learning', 'Computer vision', 'Predictive analytics', 'Decision intelligence', 'Intelligent automation', 'Enterprise AI applications'] },
  { id: 'computing', title: 'Advanced computing', items: ['GPU computing', 'High-performance computing', 'AI computing clusters', 'Data centres', 'Cloud infrastructure', 'Distributed computing', 'Scientific computing', 'Quantum technology applications'] },
  { id: 'industrial', title: 'Engineering and industrial systems', items: ['Robotics', 'Autonomous systems', 'Industrial automation', 'Embedded systems', 'Electronics', 'Digital twins', 'Industrial IoT', 'Hardware and software integration'] },
  { id: 'energy', title: 'Energy and specialised infrastructure', items: ['Renewable energy infrastructure', 'Power generation', 'Electrical grids', 'Smart energy management', 'Energy storage', 'Advanced power systems', 'Nuclear energy infrastructure', 'Other specialised industrial and engineering facilities'] },
];

export const REGULATED_WORK_NOTICE =
  'For nuclear power and similarly regulated infrastructure, SAMARTH works only through appropriately licensed, qualified and authorised engineering, technology and institutional partners. SAMARTH may facilitate early project discovery, feasibility coordination, technology assessment, stakeholder coordination and project management. It does not hold regulatory authority or nuclear operating licences, and it does not itself design or construct regulated nuclear facilities. All such work must meet the statutory, safety, environmental, procurement and regulatory requirements of the country concerned.';

export const TECHNOLOGY_TRANSFER: readonly string[] = [
  'Technology acquisition', 'Technology licensing', 'Research-to-industry transfer', 'University and laboratory partnerships',
  'Intellectual property arrangements', 'Technology localisation', 'Adapting existing technology', 'Third-party integration',
  'Technical due diligence', 'Research commercialisation',
];

export const INTELLIGENT_INFRASTRUCTURE: readonly string[] = [
  'Smart manufacturing facilities', 'GPU and AI computing infrastructure', 'Data centres', 'Smart campuses', 'Intelligent hospitals',
  'Smart energy systems', 'Industrial infrastructure', 'Connected logistics', 'Research laboratories', 'Institutional computing systems',
];

export const INFRASTRUCTURE_LIFECYCLE: readonly string[] = [
  'Requirement discovery', 'Site assessment', 'Feasibility', 'Technical architecture', 'Technology selection', 'Vendor selection',
  'Cost estimation', 'Procurement planning', 'Engineering', 'Installation', 'Testing', 'Commissioning', 'Training', 'Handover', 'Maintenance',
];

// -------------------------------------------------------------------------------------------------
// DELIVERY AND CLIENT EMPOWERMENT (Parts 8 and 9)
// -------------------------------------------------------------------------------------------------

export const DELIVERY_MODELS: readonly { value: 'internal' | 'partner' | 'joint'; title: string; detail: string }[] = [
  { value: 'internal', title: 'Internal engineering', detail: 'Delivered by SAMARTH research and engineering teams.' },
  { value: 'partner', title: 'Selected external partners', detail: 'SAMARTH identifies and selects the best-qualified companies, engineers, laboratories, manufacturers and technology providers for the work.' },
  { value: 'joint', title: 'Joint execution', detail: 'SAMARTH and selected partners deliver together. SAMARTH may act as principal consultant, technology architect, systems integrator or delivery coordinator, as the contract states.' },
];

export function deliveryModelLabel(v: unknown): string {
  return DELIVERY_MODELS.find((d) => d.value === v)?.title || '';
}

export const ACCOUNTABILITY_NOTICE =
  'Every quotation states who is responsible for each part of the work, which parts are subcontracted and to whom, and who is accountable for delivery. No partner is awarded work automatically.';

export const CLIENT_EMPOWERMENT: readonly string[] = [
  'Technical training', 'Knowledge transfer', 'Documentation', 'Internal team enablement', 'Maintenance procedures',
  'Operational support', 'Capacity building', 'Technology optimisation', 'Long-term support agreements',
];

// -------------------------------------------------------------------------------------------------
// SAMARTH X (Part 10)
// -------------------------------------------------------------------------------------------------

export const SAMARTH_X = {
  lead: 'A selective venture-building and incubation programme for exceptional people and teams building AI systems, intelligent systems, advanced technology products and scalable startups.',
  noFee: 'There is no participation fee and no incubation fee. SAMARTH X is not a paid internship and not a paid accelerator.',
  channels: [
    { title: 'Hiring and recruitment', detail: 'Engineers, researchers, developers and builders who show exceptional ability in EduRankAI recruitment assessments may be invited to propose or build a venture. Recruitment and venture selection remain separate decisions.' },
    { title: 'Events and competitions', detail: 'Outstanding participants in hackathons, AI challenges, intelligent-systems competitions, research events and startup challenges may be nominated into the evaluation pipeline.' },
    { title: 'Expression of interest', detail: 'Anyone may apply as an individual or a team. An expression of interest is an application for consideration, not admission.' },
  ],
  resources: ['Cloud infrastructure', 'GPU resources', 'AI models and APIs', 'Software and development tools', 'Research facilities', 'Technical mentorship', 'Engineering support', 'Product architecture assistance', 'Business guidance', 'Industry access', 'Institutional partnerships', 'Workspace and laboratory access, where available'],
  responsibilities: ['Identify meaningful problems', 'Develop innovative technological solutions', 'Build functioning AI or intelligent systems', 'Develop prototypes', 'Demonstrate technical excellence', 'Develop viable startup models', 'Demonstrate entrepreneurial capability', 'Work towards commercialisation'],
  incubation: 'The best six ventures in each cohort receive formal incubation: technical infrastructure, mentorship, engineering support, commercialisation guidance and industry connections. Intellectual property ownership, resource commitments and any equity arrangement are set out in a written agreement before incubation begins. EduRankAI takes no equity automatically.',
};

// -------------------------------------------------------------------------------------------------
// TOPIC PAGES (Part 15.4): one substantive page per capability, no thin duplicates
// -------------------------------------------------------------------------------------------------

export interface Topic {
  slug: string;
  title: string;
  /** <= 160 characters, used as the meta description. */
  description: string;
  lead: string;
  problems: string[];
  scope: string[];
  approach: { step: string; detail: string }[];
  deliverables: string[];
  boundaries: string[];
  faq: { q: string; a: string }[];
  related: string[];
}

const DISCOVERY_STEP = { step: 'Consultation', detail: 'Every engagement begins with a registered consultation request and a call with a SAMARTH consultant, who confirms what is actually needed.' };
const QUOTE_STEP = { step: 'Proposal and quotation', detail: 'Any work beyond the consultation is proposed separately, with its own scope, price, terms and an internally approved quotation.' };

export const TOPICS: readonly Topic[] = [
  {
    slug: 'technology-consultancy',
    title: 'Technology consultancy',
    description: 'Independent technology consultancy: assessments, architecture, AI and automation opportunities, and roadmaps for organisations in any sector or country.',
    lead: 'Technology decisions are expensive to reverse. SAMARTH consultancy gives an organisation an independent view of where technology can change its operations, what it would take, and in what order to do it.',
    problems: ['A digital programme that has stalled or overrun', 'Uncertainty about where AI genuinely helps and where it does not', 'Disconnected systems that nobody can see across', 'A board or ministry asking for a roadmap that can be defended'],
    scope: ['Business and technology assessment', 'Workflow and process analysis', 'AI and automation opportunity mapping', 'Enterprise and technical architecture', 'Feasibility studies', 'Implementation planning and sequencing'],
    approach: [DISCOVERY_STEP, { step: 'Assessment', detail: 'Interviews, a review of current systems and data, and an analysis of the workflows that matter most.' }, { step: 'Options', detail: 'Alternatives compared on cost, risk, time and the capability the organisation keeps afterwards.' }, { step: 'Roadmap', detail: 'A sequenced plan with dependencies, decision points and measurable outcomes.' }],
    deliverables: ['Assessment report', 'Opportunity register with effort and impact', 'Target architecture', 'Implementation roadmap'],
    boundaries: ['Consultancy fees never include engineering, licences or transfer of intellectual property.', 'Recommendations are made by human consultants, not generated automatically.'],
    faq: [
      { q: 'How does a consultancy engagement start?', a: 'You register, describe your organisation and project, pay the consultation booking fee, and book a call. A SAMARTH consultant is assigned to you. Any package or further work is quoted separately after that call.' },
      { q: 'Can you work with organisations outside India?', a: 'Yes. SAMARTH works with organisations in every country. Fees can be priced in your currency, and the conversion is shown before you pay.' },
    ],
    related: ['ai-engineering', 'intelligent-systems', 'government-digital-infrastructure'],
  },
  {
    slug: 'ai-engineering',
    title: 'AI engineering',
    description: 'Designing, building and integrating AI systems that run in production: models, retrieval, agents, evaluation and the data pipelines underneath them.',
    lead: 'A model that works in a notebook is the beginning of an AI system, not the end. AI engineering is the work of making it reliable, measurable, secure and maintainable inside a real organisation.',
    problems: ['Pilots that never reach production', 'No way to tell whether an AI system is improving or degrading', 'Sensitive data that cannot leave the organisation', 'Integration with systems that were never designed for it'],
    scope: ['Use-case selection and feasibility', 'Model selection, including open-weight models run on your own infrastructure', 'Retrieval and knowledge systems', 'Agents and tool-using systems with human approval points', 'Evaluation, monitoring and drift detection', 'Integration with existing applications and data'],
    approach: [DISCOVERY_STEP, { step: 'Evaluation design', detail: 'Before building, agree how success is measured on your own data.' }, { step: 'Build and integrate', detail: 'Iterative delivery against the agreed evaluation, with security review at each stage.' }, QUOTE_STEP],
    deliverables: ['Working system in your environment', 'Evaluation suite and baseline results', 'Operating and monitoring runbooks', 'Handover training for your team'],
    boundaries: ['Automated outputs that affect people are designed to inform a human decision, not replace it.', 'No model is described as more capable than its evaluation shows.'],
    faq: [
      { q: 'Can the system run without sending our data to an outside AI provider?', a: 'Often yes. Open-weight models can be hosted on infrastructure you control. Whether that suits your use case is assessed during the consultation.' },
      { q: 'Who owns what is built?', a: 'Ownership and licensing are set out in the quotation and contract for each engagement. Nothing is transferred by default.' },
    ],
    related: ['intelligent-systems', 'gpu-computing', 'enterprise-software'],
  },
  {
    slug: 'intelligent-systems',
    title: 'Intelligent systems',
    description: 'Decision-support, prediction, monitoring and automation systems that combine data, models and human judgement for services, industry and government.',
    lead: 'An intelligent system senses, predicts, recommends and sometimes acts. The engineering problem is doing that safely: knowing what the system is confident about, and keeping people in charge of the decisions that matter.',
    problems: ['Decisions made on stale or incomplete information', 'Monitoring that raises too many alarms to act on', 'Forecasts nobody trusts', 'Manual triage that does not scale'],
    scope: ['Decision-support systems', 'Predictive analytics and forecasting', 'Integrated monitoring and alerting', 'Intelligent process automation', 'Command and control dashboards', 'Human-in-the-loop review design'],
    approach: [DISCOVERY_STEP, { step: 'Decision mapping', detail: 'Identify which decisions the system informs, who makes them and what evidence they need.' }, { step: 'Data and model build', detail: 'Assemble the data, build and validate the models, and design the interface people act from.' }, QUOTE_STEP],
    deliverables: ['Deployed decision-support or monitoring system', 'Documented model limits and confidence', 'Escalation and review procedures', 'Training for operators'],
    boundaries: ['Advisory outputs are labelled as advisory; a person decides.', 'Systems are evaluated against held-out data before any claim is made about accuracy.'],
    faq: [
      { q: 'Is an intelligent system the same as automation?', a: 'Not necessarily. Many of the most valuable systems recommend rather than act. The level of automation is a design decision made with you.' },
      { q: 'Do you build for public-sector use?', a: 'Yes, subject to the procurement, data-protection and security rules of the jurisdiction concerned.' },
    ],
    related: ['ai-engineering', 'government-digital-infrastructure', 'intelligent-infrastructure'],
  },
  {
    slug: 'industrial-automation',
    title: 'Industrial automation',
    description: 'Process automation, industrial IoT, control integration, simulation and predictive maintenance for industrial and engineering operations.',
    lead: 'Industrial automation joins the physical process to the information about it. Done well, it raises throughput, lowers risk to people and makes equipment failures predictable instead of sudden.',
    problems: ['Unplanned downtime from equipment failures', 'Manual readings and paper logs', 'Process variation that causes waste', 'Safety exposure in repetitive or hazardous tasks'],
    scope: ['Process automation design', 'Industrial IoT and sensor networks', 'Integration with existing control systems', 'Simulation and computational engineering', 'Predictive maintenance', 'Energy optimisation'],
    approach: [DISCOVERY_STEP, { step: 'Site and process survey', detail: 'Map the process, the equipment, the existing controls and the data already available.' }, { step: 'Pilot', detail: 'Automate or instrument one bounded part of the process and measure the result.' }, QUOTE_STEP],
    deliverables: ['Automation and instrumentation design', 'Pilot results against agreed measures', 'Scale-up plan', 'Operator and maintenance training'],
    boundaries: ['Work on safety-critical controls is carried out with qualified, authorised engineers under the applicable standards of the site.', 'Hardware is procured under a separate, quoted engagement.'],
    faq: [
      { q: 'Can you work with our existing equipment?', a: 'Usually. Retrofitting sensors and integrating with existing controllers is often cheaper than replacement. The survey establishes what is feasible.' },
      { q: 'Who performs the installation?', a: 'SAMARTH engineers, selected partners or both, as the quotation states. Responsibility for each part of the work is written down.' },
    ],
    related: ['manufacturing-transformation', 'robotics', 'energy-technology'],
  },
  {
    slug: 'manufacturing-transformation',
    title: 'Manufacturing transformation',
    description: 'Smart factories, computer-vision quality inspection, digital twins, MES and supply-chain intelligence for conventional manufacturers.',
    lead: 'Most manufacturers do not need a new factory. They need to see their existing one clearly, connect what is disconnected, and automate the steps where people are doing work a machine does better.',
    problems: ['Quality escapes found by customers', 'No live view of production', 'Planning done on spreadsheets', 'Supply disruptions discovered too late'],
    scope: ['Smart factory roadmaps', 'Computer vision quality inspection', 'Manufacturing execution systems', 'Digital twins of lines and plants', 'Production optimisation', 'Supply chain intelligence', 'Robotics and autonomous production', 'Automated monitoring'],
    approach: [DISCOVERY_STEP, { step: 'Plant assessment', detail: 'Observe the line, measure losses and identify the constraint that limits output.' }, { step: 'Connected pilot', detail: 'Instrument and connect one line, then prove the gain before scaling.' }, QUOTE_STEP],
    deliverables: ['Plant assessment with measured losses', 'Transformation roadmap', 'Pilot system and results', 'Training and maintenance procedures'],
    boundaries: ['Gains are reported as measured on your line, not as industry averages.', 'Equipment purchases are quoted separately.'],
    faq: [
      { q: 'We are a small manufacturer. Is this for us?', a: 'Yes. The approach starts with the single biggest loss on one line, which is affordable at any size.' },
      { q: 'How long does a pilot take?', a: 'It depends on the line and the data available. The consultation produces a realistic estimate before anything is quoted.' },
    ],
    related: ['industrial-automation', 'robotics', 'intelligent-infrastructure'],
  },
  {
    slug: 'government-digital-infrastructure',
    title: 'Government digital infrastructure',
    description: 'Digital governance, citizen services, government cloud, data integration and decision support for public bodies at every level, in any country.',
    lead: 'Public digital infrastructure has to serve everyone, survive changes of administration and meet procurement and security rules that private systems never face. SAMARTH supports public bodies from a single departmental system to national platforms.',
    problems: ['Citizen services spread across disconnected portals', 'Departmental data that cannot be shared lawfully or technically', 'Legacy systems with no maintainer', 'Projects that must survive procurement and audit'],
    scope: ['E-governance and citizen service platforms', 'Administrative workflow automation', 'Government data integration', 'Government cloud, secure networking and disaster recovery', 'Decision support and integrated monitoring', 'Detailed project reports and procurement support'],
    approach: [DISCOVERY_STEP, { step: 'Assessment and feasibility', detail: 'Stakeholders, current systems, legal constraints and the procurement route are established first.' }, { step: 'Architecture and proposal', detail: 'A project architecture, cost estimate and, where required, a detailed project report.' }, { step: 'Procurement and delivery', detail: 'Delivery follows the contracting body\'s procurement and approval process. A proposal is never presented as an award.' }],
    deliverables: ['Assessment and feasibility report', 'Project architecture', 'Detailed project report where required', 'Delivery, testing, training and handover under contract'],
    boundaries: ['Every engagement complies with the procurement, financial, security and statutory rules that apply to the contracting body.', 'A proposal, meeting or expression of interest is never described as an awarded project.'],
    faq: [
      { q: 'Do government applicants pay the consultation booking fee?', a: 'Yes. Every applicant, including governments and public-sector bodies, registers and pays the booking fee before a formal consultation call. Payment against an invoice is available where your rules require it.' },
      { q: 'Which levels of government do you work with?', a: 'Local, district or county, state or provincial, national and international bodies, in any country.' },
    ],
    related: ['data-centres', 'intelligent-systems', 'research-infrastructure'],
  },
  {
    slug: 'enterprise-software',
    title: 'Enterprise software',
    description: 'Web, mobile and enterprise applications, SaaS platforms, ERP and CRM, APIs and data engineering, built to be owned and maintained by the client.',
    lead: 'From a website to an enterprise platform, software is only finished when the organisation that owns it can run, change and secure it. SAMARTH builds with that handover in mind from the first week.',
    problems: ['Off-the-shelf tools that fit badly', 'Spreadsheets doing the job of a system', 'Several systems holding conflicting versions of the truth', 'A vendor nobody can replace'],
    scope: ['Websites and web applications', 'Mobile applications', 'Enterprise software and SaaS platforms', 'ERP and CRM implementation and integration', 'API infrastructure', 'Data engineering and integration'],
    approach: [DISCOVERY_STEP, { step: 'Requirements and design', detail: 'Users, workflows, data and integrations are documented and agreed.' }, { step: 'Iterative delivery', detail: 'Working software in short increments, reviewed with your team.' }, QUOTE_STEP],
    deliverables: ['Source code and deployment configuration', 'Technical and user documentation', 'Automated tests', 'Handover and training'],
    boundaries: ['Licensing and ownership of code are set in each contract.', 'Hosting costs are your own unless the quotation states otherwise.'],
    faq: [
      { q: 'Can you take on something as small as a website?', a: 'Yes. Projects of any size start the same way: registration, the booking fee and a consultation call.' },
      { q: 'Will we be locked in?', a: 'Systems are built on open standards where possible, documented, and handed over so another team could maintain them.' },
    ],
    related: ['ai-engineering', 'technology-consultancy', 'intelligent-systems'],
  },
  {
    slug: 'gpu-computing',
    title: 'GPU computing',
    description: 'Planning, building and operating GPU and AI computing capacity: sizing, architecture, networking, scheduling and utilisation.',
    lead: 'GPU capacity is expensive to buy and easy to waste. The right answer depends on the workloads, the data, the power available and how the capacity will be shared.',
    problems: ['Uncertainty between buying, renting or sharing capacity', 'Clusters that sit idle or are always queued', 'Power and cooling limits discovered late', 'Researchers who cannot get access when they need it'],
    scope: ['Workload analysis and capacity sizing', 'Cluster and network architecture', 'Storage and data pipeline design', 'Scheduling and fair-share policies', 'Utilisation monitoring', 'Facility, power and cooling requirements'],
    approach: [DISCOVERY_STEP, { step: 'Workload study', detail: 'Measure or estimate the real workloads before sizing anything.' }, { step: 'Architecture and options', detail: 'Owned, colocated, cloud and hybrid options compared on total cost and risk.' }, QUOTE_STEP],
    deliverables: ['Capacity and workload analysis', 'Reference architecture', 'Procurement specification', 'Operations and scheduling design'],
    boundaries: ['Hardware is procured through a separate quoted engagement or by the client directly.', 'Performance figures are stated as measured or as vendor-specified, and labelled which.'],
    faq: [
      { q: 'Do you sell GPUs?', a: 'No. SAMARTH helps you decide what to acquire and can coordinate procurement and installation through selected partners under a separate engagement.' },
      { q: 'Can a university share one cluster across departments?', a: 'Yes. Scheduling and fair-share policy design is part of the scope.' },
    ],
    related: ['data-centres', 'research-infrastructure', 'ai-engineering'],
  },
  {
    slug: 'data-centres',
    title: 'Data centres',
    description: 'Data centre and cloud infrastructure: requirements, site assessment, architecture, vendor selection, commissioning and handover, through qualified partners.',
    lead: 'A data centre is a power, cooling, connectivity and security project before it is a computing project. SAMARTH coordinates it from requirement discovery to handover.',
    problems: ['Capacity running out with no plan', 'Sovereignty or residency rules for data', 'Disaster recovery that has never been tested', 'Facility projects that overrun'],
    scope: ['Requirement discovery and capacity planning', 'Site assessment and feasibility', 'Technical architecture and technology selection', 'Vendor selection and procurement planning', 'Installation, testing and commissioning coordination', 'Disaster recovery design'],
    approach: [DISCOVERY_STEP, { step: 'Feasibility', detail: 'Site, power, connectivity, permits and budget are tested before design.' }, { step: 'Design and vendors', detail: 'Architecture, specifications and a vendor selection on the record.' }, { step: 'Build and commission', detail: 'Delivered through qualified partners, with SAMARTH coordinating under contract.' }],
    deliverables: ['Feasibility report', 'Architecture and specifications', 'Vendor evaluation', 'Commissioning and handover documentation'],
    boundaries: ['Construction and electrical work are performed by appropriately licensed contractors.', 'Each party\'s responsibility is written into the contract.'],
    faq: [
      { q: 'Do you build data centres yourselves?', a: 'Construction and installation are carried out by licensed, selected partners. SAMARTH can act as consultant, architect or delivery coordinator, as the contract states.' },
      { q: 'Can you help with government cloud?', a: 'Yes, within the security, residency and procurement rules of the jurisdiction concerned.' },
    ],
    related: ['gpu-computing', 'intelligent-infrastructure', 'government-digital-infrastructure'],
  },
  {
    slug: 'research-infrastructure',
    title: 'Research infrastructure',
    description: 'Research computing, virtual laboratories, data platforms and institutional computing for universities, laboratories and research institutions.',
    lead: 'Research infrastructure has to serve many groups with different needs on a fixed budget. The aim is capacity that researchers actually use, with data that survives the end of each grant.',
    problems: ['Each research group running its own fragile servers', 'Data with no long-term home', 'Long queues for shared computing', 'Laboratories that cannot be accessed remotely'],
    scope: ['Research computing and HPC', 'Virtual laboratories', 'Research data platforms and retention', 'Institutional computing systems', 'Identity and access for research collaboration', 'Instrument and laboratory integration'],
    approach: [DISCOVERY_STEP, { step: 'Needs survey', detail: 'Survey groups, workloads, data volumes and collaboration patterns.' }, { step: 'Shared design', detail: 'A shared platform with clear allocation and governance.' }, QUOTE_STEP],
    deliverables: ['Needs survey', 'Platform architecture', 'Governance and allocation model', 'Training for research staff'],
    boundaries: ['Funding applications remain the institution\'s own; SAMARTH can provide technical input.', 'Hardware procurement is a separate engagement.'],
    faq: [
      { q: 'Can you work with a public university?', a: 'Yes. Public institutions register and follow the same consultation process, with their procurement requirements recorded.' },
      { q: 'Do you provide the computing capacity?', a: 'SAMARTH designs and coordinates. Capacity is acquired by the institution or through a separate quoted engagement.' },
    ],
    related: ['gpu-computing', 'data-centres', 'technology-transfer'],
  },
  {
    slug: 'technology-transfer',
    title: 'Technology transfer',
    description: 'Technology acquisition, licensing, research commercialisation, localisation and technical due diligence between laboratories, universities and industry.',
    lead: 'A technology that works in a laboratory, or in another country, does not automatically work in your organisation. Technology transfer is the technical, legal and organisational work of making it yours.',
    problems: ['A promising technology with unclear ownership', 'Research results that never reach a product', 'Imported technology that does not fit local conditions', 'Acquisitions made without technical due diligence'],
    scope: ['Technology scouting and acquisition', 'Licensing support', 'Research-to-industry transfer', 'University and laboratory partnerships', 'Technology localisation and adaptation', 'Technical due diligence'],
    approach: [DISCOVERY_STEP, { step: 'Assessment', detail: 'Maturity, ownership, dependencies and the effort to adapt are assessed.' }, { step: 'Structure', detail: 'The transfer route, the parties and the arrangements for intellectual property are proposed.' }, QUOTE_STEP],
    deliverables: ['Technology assessment', 'Due diligence report', 'Transfer and adaptation plan', 'Integration support under contract'],
    boundaries: ['Legal agreements are drafted and reviewed by qualified lawyers.', 'No intellectual property moves without a written agreement between its owners.'],
    faq: [
      { q: 'Can SAMARTH license technology to us?', a: 'Where SAMARTH or EduRankAI owns a technology, terms are set in a written agreement. For third-party technology, SAMARTH facilitates between you and the owner.' },
      { q: 'Do you work across borders?', a: 'Yes, subject to the export-control and regulatory rules of every country involved.' },
    ],
    related: ['research-infrastructure', 'technology-consultancy', 'enterprise-software'],
  },
  {
    slug: 'robotics',
    title: 'Robotics',
    description: 'Robotics and autonomous systems for manufacturing, logistics, inspection and research: feasibility, integration, safety and handover.',
    lead: 'Robots succeed where the task is well defined and the environment is controlled, and struggle elsewhere. The first question is always whether the task is ready for a robot.',
    problems: ['Repetitive tasks with high staff turnover', 'Hazardous inspection work', 'Inconsistent handling causing damage', 'A robot cell that was bought and never productive'],
    scope: ['Task and feasibility analysis', 'Robot and end-effector selection', 'Vision and sensing integration', 'Cell design and safety assessment', 'Integration with production systems', 'Autonomous inspection and logistics'],
    approach: [DISCOVERY_STEP, { step: 'Feasibility', detail: 'Cycle time, variability, safety and return on investment assessed for the specific task.' }, { step: 'Proof of concept', detail: 'Demonstrate the task on representative parts before committing to a cell.' }, QUOTE_STEP],
    deliverables: ['Feasibility study', 'Cell design and safety assessment', 'Integrated system', 'Operator and maintenance training'],
    boundaries: ['Safety assessments follow the standards that apply where the cell is installed.', 'Robots and equipment are procured under a separate quoted engagement.'],
    faq: [
      { q: 'Do we need to replace our line?', a: 'Rarely. Most projects integrate a robot into an existing line.' },
      { q: 'Who maintains the system?', a: 'Your team, after training, with a support agreement if you want one.' },
    ],
    related: ['manufacturing-transformation', 'industrial-automation', 'intelligent-infrastructure'],
  },
  {
    slug: 'intelligent-infrastructure',
    title: 'Intelligent infrastructure',
    description: 'Smart campuses, intelligent hospitals, connected logistics, smart energy and industrial facilities: from requirement discovery to maintenance.',
    lead: 'Intelligent infrastructure is a building, campus or network that measures itself and can be managed from that information. It is planned across the whole lifecycle, not just the build.',
    problems: ['Facilities that cannot report their own condition', 'Energy use that nobody can explain', 'Separate building systems that do not talk to each other', 'Assets maintained by calendar instead of condition'],
    scope: ['Smart campuses and intelligent hospitals', 'Smart manufacturing and industrial facilities', 'Connected logistics', 'Smart energy systems', 'Research laboratories and institutional computing', 'Lifecycle planning from discovery to maintenance'],
    approach: [DISCOVERY_STEP, { step: 'Discovery and site assessment', detail: 'Requirements, site conditions and existing systems are recorded first.' }, { step: 'Architecture and vendors', detail: 'Technology selection, vendor selection, cost estimation and procurement planning.' }, { step: 'Delivery and handover', detail: 'Engineering, installation, testing, commissioning, training and handover, then maintenance.' }],
    deliverables: ['Requirements and site assessment', 'Technical architecture', 'Procurement plan', 'Commissioning, training and handover records'],
    boundaries: ['Construction and electrical work are done by licensed contractors.', 'Each party\'s responsibility is set out in the contract.'],
    faq: [
      { q: 'What does the lifecycle cover?', a: 'Requirement discovery, site assessment, feasibility, architecture, technology and vendor selection, cost estimation, procurement planning, engineering, installation, testing, commissioning, training, handover and maintenance.' },
      { q: 'Can you take over an existing facility?', a: 'Yes. Many projects start by instrumenting and connecting what is already there.' },
    ],
    related: ['data-centres', 'energy-technology', 'manufacturing-transformation'],
  },
  {
    slug: 'energy-technology',
    title: 'Energy technology',
    description: 'Renewable energy, storage, smart energy management, grids and advanced power systems, with regulated work delivered through licensed partners.',
    lead: 'Energy projects combine engineering, regulation and finance. SAMARTH helps organisations assess, plan and coordinate them, and works through appropriately licensed partners wherever the work is regulated.',
    problems: ['Rising energy costs with no visibility of where they come from', 'Renewable generation that cannot be used when it is produced', 'Grid connection and approval uncertainty', 'Large regulated projects that need a credible early-stage partner'],
    scope: ['Energy audits and smart energy management', 'Renewable generation and storage feasibility', 'Grid integration studies', 'Advanced power systems', 'Early-stage discovery for regulated facilities', 'Stakeholder and project coordination'],
    approach: [DISCOVERY_STEP, { step: 'Assessment', detail: 'Demand, generation potential, storage options, grid constraints and regulatory route are assessed.' }, { step: 'Partners', detail: 'Licensed and authorised partners are identified for any regulated scope.' }, QUOTE_STEP],
    deliverables: ['Energy assessment', 'Feasibility study', 'Regulatory pathway summary prepared with qualified partners', 'Coordinated project plan'],
    boundaries: [REGULATED_WORK_NOTICE],
    faq: [
      { q: 'Can SAMARTH build a nuclear power plant?', a: 'No. SAMARTH can support early-stage discovery, feasibility coordination, technology assessment, stakeholder coordination and project management through licensed, authorised partners. It does not hold nuclear licences or authority to design or construct regulated nuclear facilities.' },
      { q: 'Do you work on smaller energy projects?', a: 'Yes, from a single building\'s energy management upward.' },
    ],
    related: ['intelligent-infrastructure', 'industrial-automation', 'data-centres'],
  },
];

export function topicBySlug(slug: unknown): Topic | null {
  return TOPICS.find((t) => t.slug === slug) || null;
}

/** How a consultation actually proceeds. Describes what the software does, not a policy. */
export const CONSULTATION_PROCESS: readonly { step: string; detail: string }[] = [
  { step: 'Registration', detail: 'Tell us who you are, your country and your applicant category. You receive a reference and a private link to continue.' },
  { step: 'Applicant details', detail: 'Your organisation and contact details. Government and public-sector applicants also give department details, an authorised representative and any procurement requirements.' },
  { step: 'Project requirements', detail: 'What you want to build, improve, transform or achieve, and what you already have. Questions adapt to your kind of project.' },
  { step: 'Booking fee', detail: 'The consultation booking fee for your category and currency is shown with any tax, any payment charge and its terms before you commit. Pay online or against an invoice.' },
  { step: 'Call booking', detail: 'Once the payment is confirmed by the payment provider or recorded against your invoice, you give your preferred times and time zone.' },
  { step: 'Consultant assignment', detail: 'A human SAMARTH consultant is assigned and confirms the call. All professional advice comes from people, not software.' },
];

export const AI_ASSISTANCE_NOTICE =
  'AI may help you complete your registration and describe your requirements. It is not a consultant: it gives no professional advice, makes no commitments on SAMARTH\'s behalf, and every consultation, recommendation and commercial decision is made by a human SAMARTH consultant.';

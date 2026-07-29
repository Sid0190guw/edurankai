// src/data/intern-catalog-phase2.ts — Phase 2 domain-specific internship verticals (10 categories,
// ~46 roles), added after the original 20-category catalog (src/data/intern-catalog.ts) was fully
// imported. Every role here already exists on AICTE's internship portal for a comparable listing;
// titles that exactly duplicate a Phase-1 role (Medical AI, Clinical Research, Quantum Computing,
// Autonomous Systems, Embedded Systems Intern) were deliberately left out — see the Phase-1 file.
//
// Framing note: EduRankAI is a frontier AI research lab + AquinTutor (education) + a handful of
// named ventures (Karate.support, Sancharan, Sampark, Sambandh, Viśvambhara, HEI). It does not
// operate farms, hospitals, cities, or power grids. Every role below is honestly framed as our
// actual work — applying reasoning-model research, AquinTutor's curriculum/labs, or the Holistic
// Education Index's institutional data — to that domain, not as if we run the domain's industry.
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

// =====================================================================================
// 21. HEALTHCARE & LIFE SCIENCES (extends the existing healthcare-biotech department —
//     Medical AI Intern and Clinical Research Intern already exist there, skipped here)
// =====================================================================================
const HEALTHCARE_LIFE_SCIENCES: CatalogRole[] = [
  role({
    slug: 'digital-health-intern',
    departmentId: 'healthcare-biotech', title: 'Digital Health Intern', noOfInterns: 4,
    about: 'Digital health sits where our AI-tutoring and assessment research meets health-education content — nutrition, wellbeing, and public-health literacy modules inside AquinTutor. This internship explores how reasoning models can make health information genuinely understandable, not just accessible.',
    responsibilities: [
      'Research digital-health product patterns (telehealth, remote monitoring, patient-facing apps) relevant to our health-education content.',
      'Support the design of health-literacy learning modules within AquinTutor.',
      'Assist in structuring health datasets for research use, respecting privacy and consent.',
      'Prototype simple digital-health information tools under mentor supervision.',
      'Document findings on digital-health UX and accessibility patterns.',
      'Coordinate with the education-content team on medically-reviewed material.',
    ],
    skills: ['Digital health landscape awareness', 'Health literacy design', 'Basic data structuring', 'UX research basics', 'Documentation', 'Cross-functional coordination'],
    learningOutcomes: ['Digital Health Product Landscape', 'Health-Literacy Content Design', 'Health Data Handling Basics', 'Digital-Health UX Patterns', 'Cross-Functional Coordination'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Public Health', 'Biomedical Engineering', 'Health Informatics', 'Life Sciences', 'Any Relevant Discipline'],
    keywords: ['Digital Health', 'Health Education', 'Telehealth Awareness', 'Health Literacy', 'Public Health'],
  }),
  role({
    slug: 'health-informatics-intern',
    departmentId: 'healthcare-biotech', title: 'Health Informatics Intern', noOfInterns: 3,
    about: 'Health informatics — structuring and standardising health-related data so it can be reasoned over — connects directly to our data-engineering work. This internship gives students hands-on exposure to health data models and terminology standards, applied to research-grade datasets.',
    responsibilities: [
      'Assist in structuring and cleaning health-related research datasets.',
      'Study health-data standards (e.g. HL7/FHIR concepts) and summarise applicability to our work.',
      'Support the tagging and classification of health-education content by clinical topic.',
      'Help build simple data-quality checks for health datasets.',
      'Document data dictionaries and terminology mappings.',
    ],
    skills: ['Health data standards awareness (HL7/FHIR concepts)', 'Data cleaning', 'SQL basics', 'Medical terminology basics', 'Data documentation'],
    learningOutcomes: ['Health Data Standards', 'Clinical Terminology Mapping', 'Data Cleaning & Quality Checks', 'Health Data Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Health Informatics', 'Biomedical Engineering', 'Computer Science', 'Public Health', 'Any Relevant Discipline'],
    keywords: ['Health Informatics', 'HL7', 'FHIR', 'Medical Data', 'Health Data Standards'],
  }),
  role({
    slug: 'biomedical-data-science-intern',
    departmentId: 'healthcare-biotech', title: 'Biomedical Data Science Intern', noOfInterns: 4,
    about: 'Biomedical data science applies our reasoning-model and statistical toolkit to biological and clinical datasets — an extension of our core AI research into a domain with real evidentiary standards. Interns work alongside our research team on real biomedical data analysis.',
    responsibilities: [
      'Clean and preprocess biomedical/clinical datasets for analysis.',
      'Apply statistical and machine-learning methods to biomedical questions under mentor guidance.',
      'Support literature review for biomedical data science methodology.',
      'Visualise biomedical analysis results for research reporting.',
      'Document methodology and reproducibility notes for every analysis.',
    ],
    skills: ['Python (pandas/numpy)', 'Statistics', 'Biomedical dataset handling', 'Data visualisation', 'Machine learning basics', 'Scientific writing'],
    learningOutcomes: ['Biomedical Data Preprocessing', 'Applied Statistics on Health Data', 'ML for Biomedical Questions', 'Research Documentation & Reproducibility'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Biomedical Engineering', 'Bioinformatics', 'Data Science', 'Life Sciences', 'Statistics', 'Any Relevant Discipline'],
    keywords: ['Biomedical Data Science', 'Bioinformatics', 'Clinical Data', 'Python', 'Machine Learning'],
  }),
  role({
    slug: 'healthcare-operations-intern',
    departmentId: 'healthcare-biotech', title: 'Healthcare Operations Intern', noOfInterns: 3,
    about: 'Every healthcare-adjacent research or content initiative needs sound operational support — coordination, documentation, compliance tracking. This internship suits students interested in the operational and administrative side of healthcare-related projects.',
    responsibilities: [
      'Support coordination of healthcare-related research and content projects.',
      'Track compliance and documentation requirements for health-data work.',
      'Assist in scheduling and logistics for healthcare-adjacent initiatives.',
      'Prepare status reports and operational trackers.',
      'Liaise between research, content, and legal/compliance teams as needed.',
    ],
    skills: ['Operations coordination', 'Documentation', 'Compliance awareness', 'Scheduling', 'Stakeholder communication', 'MS Excel/Sheets'],
    learningOutcomes: ['Healthcare Project Coordination', 'Compliance Documentation', 'Operational Reporting', 'Cross-Team Liaison'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Healthcare Management', 'Public Health', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Healthcare Operations', 'Healthcare Administration', 'Compliance', 'Project Coordination'],
  }),
];

// =====================================================================================
// 22. SPORTS TECHNOLOGY (natural extension of Karate.support, our global martial-arts platform)
// =====================================================================================
const SPORTS_TECHNOLOGY: CatalogRole[] = [
  role({
    slug: 'sports-analytics-intern',
    departmentId: 'sports-tech', title: 'Sports Analytics Intern', noOfInterns: 4,
    about: 'Karate.support tracks schools, students, tournaments, and progression across the global karate community — a real sports dataset. This internship applies analytics to that data: performance trends, tournament patterns, and progression benchmarks.',
    responsibilities: [
      'Analyse student progression and tournament participation data from Karate.support.',
      'Build dashboards and reports summarising performance and engagement trends.',
      'Support the design of belt-progression and performance benchmarks.',
      'Clean and validate sports datasets before analysis.',
      'Present analytical findings to the product team.',
    ],
    skills: ['SQL', 'Python or R for analytics', 'Data visualisation (Power BI/Tableau/matplotlib)', 'Statistics', 'Sports-domain data literacy'],
    learningOutcomes: ['Sports Data Analysis', 'Dashboarding & Reporting', 'Performance Benchmarking', 'Data Validation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Statistics', 'Sports Science', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Sports Analytics', 'Sports Data', 'Karate.support', 'Performance Analysis', 'Dashboards'],
  }),
  role({
    slug: 'sports-ai-intern',
    departmentId: 'sports-tech', title: 'Sports AI Intern', noOfInterns: 3,
    about: 'Applying our reasoning-model research to sport — technique analysis, progression prediction, personalised training feedback — grounded in the real Karate.support community rather than a generic sports dataset.',
    responsibilities: [
      'Research AI applications in sports (technique analysis, progression prediction, personalised feedback).',
      'Prototype simple models for progression or performance prediction using anonymised platform data.',
      'Support evaluation of model outputs against coach/instructor judgement.',
      'Document experiments and findings.',
      'Collaborate with the Karate.support product team on feasibility.',
    ],
    skills: ['Python', 'Machine learning fundamentals', 'Data preprocessing', 'Model evaluation', 'Research documentation'],
    learningOutcomes: ['AI-in-Sport Research', 'Predictive Modelling for Athlete Progression', 'Model Evaluation Against Domain Expertise', 'Applied ML Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Data Science', 'Artificial Intelligence', 'Sports Science', 'Any Relevant Discipline'],
    keywords: ['Sports AI', 'Machine Learning', 'Athlete Performance', 'Predictive Modelling'],
  }),
  role({
    slug: 'sports-performance-intern',
    departmentId: 'sports-tech', title: 'Sports Performance Intern', noOfInterns: 3,
    about: 'A domain-knowledge-heavy internship for students of sports science who want to shape how Karate.support measures and communicates athlete performance and progression.',
    responsibilities: [
      'Research performance-tracking methodologies used in martial arts and other sports.',
      'Help define progression and performance metrics for the platform.',
      'Support content on training, conditioning, and injury-prevention best practices.',
      'Assist in reviewing performance-tracking features for accuracy against real coaching practice.',
      'Document performance-metric definitions for the product team.',
    ],
    skills: ['Sports science fundamentals', 'Performance metric design', 'Research skills', 'Content review', 'Communication with domain experts'],
    learningOutcomes: ['Performance Metric Design', 'Sports Science Applied to Product', 'Injury-Prevention Content Research', 'Domain-Expert Collaboration'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Sports Science', 'Physical Education', 'Kinesiology', 'Any Relevant Discipline'],
    keywords: ['Sports Performance', 'Athlete Training', 'Sports Science', 'Martial Arts'],
  }),
  role({
    slug: 'sports-data-science-intern',
    departmentId: 'sports-tech', title: 'Sports Data Science Intern', noOfInterns: 3,
    about: 'A hands-on data science internship using real Karate.support tournament and progression data — from data pipeline to statistical model.',
    responsibilities: [
      'Build and maintain data pipelines for tournament and progression data.',
      'Apply statistical methods to identify performance and engagement patterns.',
      'Support A/B-test design for product features using sports data.',
      'Assist in building predictive models for tournament outcomes or dropout risk.',
      'Document data pipeline and modelling decisions.',
    ],
    skills: ['Python (pandas/scikit-learn)', 'SQL', 'Statistics', 'Data pipeline basics', 'A/B testing fundamentals'],
    learningOutcomes: ['Sports Data Pipeline Development', 'Statistical Pattern Analysis', 'A/B Test Design', 'Predictive Modelling for Sports Outcomes'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Statistics', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Sports Data Science', 'Data Pipelines', 'Predictive Modelling', 'Statistics'],
  }),
  role({
    slug: 'sports-product-management-intern',
    departmentId: 'sports-tech', title: 'Sports Product Management Intern', noOfInterns: 2,
    about: 'Product management for a real, live sports-community platform — Karate.support — spanning schools, students, tournaments, and progression tracking worldwide.',
    responsibilities: [
      'Support product discovery through user (student/instructor/school) research.',
      'Help prioritise the Karate.support feature roadmap.',
      'Write user stories and acceptance criteria for sports-platform features.',
      'Coordinate with engineering and design on feature delivery.',
      'Track and report on feature adoption and user feedback.',
    ],
    skills: ['Product management fundamentals', 'User research', 'Roadmap prioritisation', 'Cross-functional coordination', 'Written communication'],
    learningOutcomes: ['Sports-Platform Product Discovery', 'Roadmap Prioritisation', 'User-Story Writing', 'Feature Adoption Tracking'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Business Administration', 'Product Management', 'Sports Management', 'Any Relevant Discipline'],
    keywords: ['Sports Product Management', 'Product Discovery', 'Karate.support', 'Roadmap'],
  }),
  role({
    slug: 'sports-technology-intern',
    departmentId: 'sports-tech', title: 'Sports Technology Intern', noOfInterns: 3,
    about: 'A generalist sports-tech internship — research and light prototyping across wearables, video analysis, and community-platform features for Karate.support and adjacent sports-technology research.',
    responsibilities: [
      'Research emerging sports-technology trends (wearables, video analysis, athlete tracking).',
      'Support prototyping of small sports-tech features or proofs of concept.',
      'Assist in technical evaluation of third-party sports-tech tools and APIs.',
      'Document technical findings and recommendations.',
      'Collaborate with the Karate.support engineering team.',
    ],
    skills: ['Sports-technology landscape awareness', 'Basic prototyping', 'API evaluation', 'Technical documentation', 'Communication'],
    learningOutcomes: ['Sports-Technology Landscape Research', 'Rapid Prototyping', 'Third-Party Tool Evaluation', 'Technical Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Sports Engineering', 'Any Relevant Discipline'],
    keywords: ['Sports Technology', 'Wearables', 'Video Analysis', 'Sports Tech Research'],
  }),
];

// =====================================================================================
// 23. AGRICULTURE & FOOD TECHNOLOGY (research-domain application of our reasoning-model work)
// =====================================================================================
const AGRICULTURE_FOOD_TECH: CatalogRole[] = [
  role({
    slug: 'agritech-intern',
    departmentId: 'agri-food-tech', title: 'AgriTech Intern', noOfInterns: 3,
    about: 'As part of exploring how our reasoning systems generalise beyond education, this internship researches agricultural-technology applications — from crop-advisory reasoning to farm-data structuring — as a domain case study for our research team.',
    responsibilities: [
      'Research existing AgriTech approaches (crop advisory, yield prediction, farm management software).',
      'Support structuring of open agricultural datasets for research use.',
      'Assist in prototyping simple crop-advisory reasoning demos.',
      'Document domain findings for the research team.',
      'Collaborate with mentors on feasibility assessments.',
    ],
    skills: ['AgriTech landscape research', 'Data structuring', 'Basic prototyping', 'Documentation', 'Domain research'],
    learningOutcomes: ['AgriTech Landscape Research', 'Agricultural Data Structuring', 'Applied Reasoning Prototypes', 'Research Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Agricultural Engineering', 'Computer Science', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['AgriTech', 'Agricultural Technology', 'Crop Advisory', 'Farm Data'],
  }),
  role({
    slug: 'precision-agriculture-intern',
    departmentId: 'agri-food-tech', title: 'Precision Agriculture Intern', noOfInterns: 2,
    about: 'Precision agriculture — using data (soil, weather, satellite) to make farming decisions field-by-field — is a rich reasoning-and-data problem. Interns research this domain as a case study in applied AI reasoning.',
    responsibilities: [
      'Research precision-agriculture data sources (soil sensors, satellite imagery, weather data).',
      'Support analysis of public agricultural datasets.',
      'Assist in documenting precision-agriculture decision models.',
      'Summarise relevant academic literature for the research team.',
      'Support internal knowledge-sharing sessions on findings.',
    ],
    skills: ['Data analysis', 'GIS/remote-sensing basics', 'Research literature review', 'Documentation', 'Python or R basics'],
    learningOutcomes: ['Precision Agriculture Data Sources', 'Public Agricultural Data Analysis', 'Literature Review', 'Applied Research Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Agricultural Engineering', 'Environmental Science', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['Precision Agriculture', 'Remote Sensing', 'Agricultural Data', 'Farming Technology'],
  }),
  role({
    slug: 'smart-farming-intern',
    departmentId: 'agri-food-tech', title: 'Smart Farming Intern', noOfInterns: 2,
    about: 'Smart farming applies IoT and automation reasoning to agricultural operations. This internship researches the domain and supports lightweight proof-of-concept work for our applied-AI research pipeline.',
    responsibilities: [
      'Research IoT and automation approaches used in smart farming.',
      'Support documentation of smart-farming system architectures.',
      'Assist in evaluating open-source smart-farming tools and datasets.',
      'Contribute to research notes on applicability of our reasoning models to farm automation.',
      'Present findings to the research team.',
    ],
    skills: ['IoT landscape awareness', 'Systems research', 'Documentation', 'Basic data analysis', 'Presentation skills'],
    learningOutcomes: ['Smart Farming Systems Research', 'IoT-in-Agriculture Landscape', 'Open-Source Tool Evaluation', 'Applied AI Feasibility Notes'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Agricultural Engineering', 'IoT', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Smart Farming', 'IoT', 'Agricultural Automation', 'Farm Technology'],
  }),
  role({
    slug: 'food-technology-intern',
    departmentId: 'agri-food-tech', title: 'Food Technology Intern', noOfInterns: 2,
    about: 'Food technology and food-systems research — supply chains, safety standards, nutrition data — connects to our education-content work on nutrition literacy and to broader applied-research case studies.',
    responsibilities: [
      'Research food-technology and food-systems trends relevant to education content.',
      'Support structuring of nutrition and food-safety datasets.',
      'Assist in fact-checking food-related educational content.',
      'Document research findings for the content and research teams.',
      'Support literature review on food-supply-chain technology.',
    ],
    skills: ['Food-science research', 'Data structuring', 'Fact-checking', 'Documentation', 'Literature review'],
    learningOutcomes: ['Food Technology Landscape Research', 'Nutrition Data Structuring', 'Educational Content Fact-Checking', 'Food Systems Research'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Food Technology', 'Food Science', 'Nutrition', 'Any Relevant Discipline'],
    keywords: ['Food Technology', 'Food Science', 'Nutrition', 'Food Safety'],
  }),
  role({
    slug: 'agricultural-ai-intern',
    departmentId: 'agri-food-tech', title: 'Agricultural AI Intern', noOfInterns: 2,
    about: 'Applying our AI reasoning-model research to agricultural problems — yield prediction, pest/disease detection from imagery, advisory reasoning — as a domain case study for the research team.',
    responsibilities: [
      'Research applications of AI/ML in agriculture (yield prediction, pest detection, advisory systems).',
      'Support data preprocessing for agricultural imagery or tabular datasets.',
      'Assist in prototyping simple ML models for agricultural questions.',
      'Evaluate model outputs against domain literature.',
      'Document experiments and findings.',
    ],
    skills: ['Python', 'Machine learning fundamentals', 'Computer vision basics (for imagery)', 'Data preprocessing', 'Research documentation'],
    learningOutcomes: ['AI-in-Agriculture Research', 'Agricultural Data Preprocessing', 'Applied ML Prototyping', 'Model Evaluation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Artificial Intelligence', 'Agricultural Engineering', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['Agricultural AI', 'Machine Learning', 'Yield Prediction', 'Pest Detection', 'AgriTech'],
  }),
];

// =====================================================================================
// 24. GIS & GEOSPATIAL TECHNOLOGIES (mapping our partner/campus/HEI institutional network)
// =====================================================================================
const GIS_GEOSPATIAL: CatalogRole[] = [
  role({
    slug: 'gis-analyst-intern',
    departmentId: 'geospatial', title: 'GIS Analyst Intern', noOfInterns: 3,
    about: 'Our Holistic Education Index and AquinTutor partner network span institutions across geographies. This internship applies GIS analysis to map and visualise that institutional and partner footprint.',
    responsibilities: [
      'Build and maintain GIS layers for partner-institution and campus locations.',
      'Support spatial analysis of institutional coverage and accessibility.',
      'Create maps and visualisations for internal and public reporting.',
      'Clean and geocode location datasets.',
      'Document GIS workflows and data sources.',
    ],
    skills: ['QGIS/ArcGIS', 'Geocoding', 'Spatial analysis basics', 'Data visualisation', 'Data cleaning'],
    learningOutcomes: ['GIS Layer Development', 'Spatial Analysis', 'Map Visualisation', 'Geocoding Workflows'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Geoinformatics', 'Geography', 'Civil Engineering', 'Urban Planning', 'Any Relevant Discipline'],
    keywords: ['GIS', 'Geospatial Analysis', 'QGIS', 'ArcGIS', 'Mapping'],
  }),
  role({
    slug: 'remote-sensing-intern',
    departmentId: 'geospatial', title: 'Remote Sensing Intern', noOfInterns: 2,
    about: 'Remote sensing — extracting information from satellite and aerial imagery — is a research domain we explore as an application of our computer-vision and reasoning work.',
    responsibilities: [
      'Research remote-sensing data sources and processing techniques.',
      'Support preprocessing of satellite/aerial imagery datasets.',
      'Assist in applying basic image-classification techniques to remote-sensing data.',
      'Document methodology and findings.',
      'Support literature review on remote-sensing applications.',
    ],
    skills: ['Remote sensing fundamentals', 'Python (rasterio/GDAL basics)', 'Image processing basics', 'Data documentation', 'Literature review'],
    learningOutcomes: ['Remote Sensing Data Processing', 'Satellite Imagery Preprocessing', 'Applied Image Classification', 'Research Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Geoinformatics', 'Remote Sensing', 'Computer Science', 'Environmental Science', 'Any Relevant Discipline'],
    keywords: ['Remote Sensing', 'Satellite Imagery', 'GIS', 'Image Processing'],
  }),
  role({
    slug: 'drone-mapping-intern',
    departmentId: 'geospatial', title: 'Drone Mapping Intern', noOfInterns: 2,
    about: 'Drone-based mapping and photogrammetry research — a hands-on complement to our GIS and remote-sensing work, useful for campus/facility mapping and broader geospatial research.',
    responsibilities: [
      'Research drone-mapping workflows and photogrammetry techniques.',
      'Support processing of drone-captured imagery into maps/models.',
      'Assist in evaluating drone-mapping software and tools.',
      'Document mapping workflows and quality checks.',
      'Support small-scale mapping projects under supervision.',
    ],
    skills: ['Photogrammetry basics', 'Drone-mapping software (Pix4D/DroneDeploy awareness)', 'GIS basics', 'Documentation', 'Attention to detail'],
    learningOutcomes: ['Drone-Mapping Workflows', 'Photogrammetry Processing', 'Mapping Software Evaluation', 'Quality-Checked Mapping Outputs'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Geoinformatics', 'Civil Engineering', 'Surveying', 'Any Relevant Discipline'],
    keywords: ['Drone Mapping', 'Photogrammetry', 'UAV', 'GIS'],
  }),
  role({
    slug: 'geospatial-ai-intern',
    departmentId: 'geospatial', title: 'Geospatial AI Intern', noOfInterns: 2,
    about: 'Combining our AI reasoning research with geospatial data — spatial pattern detection, location-intelligence reasoning — applied to institutional-network and research use cases.',
    responsibilities: [
      'Research applications of AI/ML to geospatial data (spatial clustering, location intelligence).',
      'Support building simple geospatial-AI prototypes.',
      'Assist in evaluating open geospatial-AI tools and libraries.',
      'Document experiments and findings.',
      'Collaborate with the research team on feasibility.',
    ],
    skills: ['Python (geopandas)', 'Machine learning fundamentals', 'GIS basics', 'Spatial statistics basics', 'Documentation'],
    learningOutcomes: ['Geospatial AI Research', 'Spatial Pattern Detection', 'Applied Geospatial-ML Prototyping', 'Tool Evaluation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Geoinformatics', 'Data Science', 'Artificial Intelligence', 'Any Relevant Discipline'],
    keywords: ['Geospatial AI', 'Location Intelligence', 'Spatial Data Science', 'GIS'],
  }),
  role({
    slug: 'spatial-data-science-intern',
    departmentId: 'geospatial', title: 'Spatial Data Science Intern', noOfInterns: 2,
    about: 'A data-science internship focused on spatial datasets — building analysis pipelines that combine location data with our institutional and research datasets.',
    responsibilities: [
      'Build spatial-data analysis pipelines using institutional/partner-location data.',
      'Apply spatial statistics to identify patterns in institutional coverage.',
      'Support visualisation of spatial-analysis outputs.',
      'Clean and validate spatial datasets.',
      'Document methodology and reproducibility.',
    ],
    skills: ['Python (geopandas/pandas)', 'Spatial statistics', 'SQL', 'Data visualisation', 'Data cleaning'],
    learningOutcomes: ['Spatial Data Pipeline Development', 'Applied Spatial Statistics', 'Spatial Visualisation', 'Reproducible Analysis'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Geoinformatics', 'Statistics', 'Any Relevant Discipline'],
    keywords: ['Spatial Data Science', 'Geospatial Analysis', 'GIS', 'Data Pipelines'],
  }),
];

// =====================================================================================
// 25. SMART CITIES & INFRASTRUCTURE (institutional-network analytics — Holistic Education Index)
// =====================================================================================
const SMART_CITIES_INFRASTRUCTURE: CatalogRole[] = [
  role({
    slug: 'smart-city-intern',
    departmentId: 'smart-cities', title: 'Smart City Intern', noOfInterns: 2,
    about: 'Smart-city systems — how data and connectivity improve urban services — is studied here as a research domain informing how the Holistic Education Index thinks about institutional and regional infrastructure.',
    responsibilities: [
      'Research smart-city frameworks and case studies globally.',
      'Support analysis of how urban infrastructure data relates to institutional/education access.',
      'Assist in summarising smart-city technology trends for internal research notes.',
      'Document findings for the research and HEI teams.',
      'Support literature review on smart-city governance models.',
    ],
    skills: ['Urban-systems research', 'Data analysis basics', 'Documentation', 'Literature review', 'Presentation skills'],
    learningOutcomes: ['Smart City Framework Research', 'Urban-Infrastructure Data Analysis', 'Technology Trend Summarisation', 'Governance-Model Research'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Urban Planning', 'Civil Engineering', 'Public Policy', 'Any Relevant Discipline'],
    keywords: ['Smart Cities', 'Urban Technology', 'Infrastructure', 'Urban Planning'],
  }),
  role({
    slug: 'urban-analytics-intern',
    departmentId: 'smart-cities', title: 'Urban Analytics Intern', noOfInterns: 2,
    about: 'Urban analytics applied to institutional-access questions — where are education gaps, where does infrastructure limit access — directly supporting Holistic Education Index research.',
    responsibilities: [
      'Analyse publicly available urban and institutional datasets.',
      'Support building visualisations of education-access and infrastructure patterns.',
      'Assist in identifying data gaps in urban/institutional datasets.',
      'Document analysis methodology.',
      'Present findings to the HEI research team.',
    ],
    skills: ['Python/R for analytics', 'SQL', 'Data visualisation', 'Public dataset research', 'Statistics'],
    learningOutcomes: ['Urban Dataset Analysis', 'Education-Access Visualisation', 'Data-Gap Identification', 'Analytical Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Urban Planning', 'Data Science', 'Public Policy', 'Any Relevant Discipline'],
    keywords: ['Urban Analytics', 'Education Access', 'Infrastructure Data', 'Public Policy'],
  }),
  role({
    slug: 'transportation-systems-intern',
    departmentId: 'smart-cities', title: 'Transportation Systems Intern', noOfInterns: 2,
    about: 'Transportation and accessibility research — understanding how commute and connectivity affect access to education and institutions — as a research domain for the HEI team.',
    responsibilities: [
      'Research transportation-accessibility frameworks relevant to education access.',
      'Support analysis of commute/connectivity data relative to institutional locations.',
      'Assist in documenting transportation-systems research findings.',
      'Support literature review on transportation and equity.',
      'Coordinate with the GIS/geospatial team on location data.',
    ],
    skills: ['Transportation research', 'Data analysis basics', 'GIS awareness', 'Documentation', 'Literature review'],
    learningOutcomes: ['Transportation Accessibility Research', 'Connectivity Data Analysis', 'Equity-in-Transportation Research', 'Cross-Team Coordination'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Civil Engineering', 'Urban Planning', 'Transportation Engineering', 'Any Relevant Discipline'],
    keywords: ['Transportation Systems', 'Urban Mobility', 'Accessibility', 'Infrastructure'],
  }),
  role({
    slug: 'digital-infrastructure-intern',
    departmentId: 'smart-cities', title: 'Digital Infrastructure Intern', noOfInterns: 2,
    about: 'Digital infrastructure — connectivity, digital-access gaps — directly shapes who can reach AquinTutor and our other products. This internship researches digital-divide and infrastructure questions relevant to our access mission.',
    responsibilities: [
      'Research digital-infrastructure and connectivity-gap data relevant to education access.',
      'Support analysis of how connectivity affects platform usage and reach.',
      'Assist in documenting digital-divide research findings.',
      'Support the offline/low-bandwidth product research (already part of AquinTutor).',
      'Present findings to product and research teams.',
    ],
    skills: ['Digital-divide research', 'Data analysis basics', 'Documentation', 'Literature review', 'Communication'],
    learningOutcomes: ['Digital Infrastructure Research', 'Connectivity-Gap Analysis', 'Access-Focused Product Research', 'Cross-Team Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Public Policy', 'Telecommunications', 'Any Relevant Discipline'],
    keywords: ['Digital Infrastructure', 'Digital Divide', 'Connectivity', 'Education Access'],
  }),
  role({
    slug: 'infrastructure-analytics-intern',
    departmentId: 'smart-cities', title: 'Infrastructure Analytics Intern', noOfInterns: 2,
    about: 'A data-analytics internship applying our analytics toolkit to institutional and physical-infrastructure datasets that inform Holistic Education Index research.',
    responsibilities: [
      'Build analytics pipelines for institutional/infrastructure datasets.',
      'Support statistical analysis of infrastructure-quality indicators.',
      'Assist in visualising infrastructure-analytics outputs.',
      'Clean and validate infrastructure datasets.',
      'Document methodology for reproducibility.',
    ],
    skills: ['Python/R', 'SQL', 'Data visualisation', 'Statistics', 'Data cleaning'],
    learningOutcomes: ['Infrastructure Data Pipelines', 'Infrastructure-Quality Statistical Analysis', 'Analytics Visualisation', 'Reproducible Methodology'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Data Science', 'Civil Engineering', 'Statistics', 'Any Relevant Discipline'],
    keywords: ['Infrastructure Analytics', 'Data Pipelines', 'Institutional Data', 'Statistics'],
  }),
];

// =====================================================================================
// 26. QUANTUM TECHNOLOGIES (Quantum Computing Intern already exists in Phase 1 — skipped)
// =====================================================================================
const QUANTUM_TECHNOLOGIES: CatalogRole[] = [
  role({
    slug: 'quantum-ai-intern',
    departmentId: 'quantum-tech', title: 'Quantum AI Intern', noOfInterns: 2,
    about: 'At the intersection of our AI-reasoning research and quantum computing: exploring where quantum approaches might genuinely help reasoning-model research, distinguishing real potential from hype.',
    responsibilities: [
      'Research quantum-machine-learning literature and summarise findings for the team.',
      'Support small-scale experiments using quantum-computing simulators.',
      'Assist in evaluating quantum-AI frameworks (Qiskit, PennyLane, etc.).',
      'Document findings honestly, including where quantum approaches do NOT yet outperform classical methods.',
      'Present research summaries to the AI research team.',
    ],
    skills: ['Python', 'Quantum computing fundamentals', 'Linear algebra', 'Machine learning basics', 'Research writing'],
    learningOutcomes: ['Quantum Machine Learning Literature', 'Quantum Simulator Experimentation', 'Quantum-AI Framework Evaluation', 'Honest Research Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Physics', 'Computer Science', 'Quantum Computing', 'Mathematics', 'Any Relevant Discipline'],
    keywords: ['Quantum AI', 'Quantum Machine Learning', 'Qiskit', 'Quantum Computing'],
  }),
  role({
    slug: 'quantum-software-intern',
    departmentId: 'quantum-tech', title: 'Quantum Software Intern', noOfInterns: 2,
    about: 'Hands-on quantum software development — writing and testing quantum circuits on open simulators — for students building real quantum-programming skill.',
    responsibilities: [
      'Write and test quantum circuits using open-source quantum SDKs.',
      'Support debugging and optimisation of quantum-circuit code.',
      'Assist in documenting quantum-software design patterns.',
      'Research quantum-software-development best practices.',
      'Contribute to internal knowledge-sharing on quantum programming.',
    ],
    skills: ['Python', 'Qiskit/Cirq/PennyLane basics', 'Quantum circuit design', 'Software testing', 'Documentation'],
    learningOutcomes: ['Quantum Circuit Development', 'Quantum SDK Proficiency', 'Quantum Software Debugging', 'Best-Practice Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Physics', 'Quantum Computing', 'Any Relevant Discipline'],
    keywords: ['Quantum Software', 'Quantum Programming', 'Qiskit', 'Quantum Circuits'],
  }),
  role({
    slug: 'quantum-algorithms-intern',
    departmentId: 'quantum-tech', title: 'Quantum Algorithms Intern', noOfInterns: 2,
    about: 'Theory-leaning internship studying and implementing known quantum algorithms, for students strong in mathematics and theoretical computer science.',
    responsibilities: [
      'Study and summarise foundational quantum algorithms (Grover, Shor, VQE, QAOA).',
      'Implement selected algorithms on quantum simulators.',
      'Support complexity and performance comparison against classical algorithms.',
      'Document theoretical findings clearly for a technical but non-specialist audience.',
      'Present findings to the research team.',
    ],
    skills: ['Quantum algorithms theory', 'Python', 'Linear algebra', 'Complexity analysis', 'Technical writing'],
    learningOutcomes: ['Quantum Algorithm Theory', 'Algorithm Implementation on Simulators', 'Classical-vs-Quantum Complexity Analysis', 'Technical Communication'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Physics', 'Mathematics', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Quantum Algorithms', 'Quantum Computing Theory', 'Grover', 'Shor', 'QAOA'],
  }),
  role({
    slug: 'quantum-research-intern',
    departmentId: 'quantum-tech', title: 'Quantum Research Intern', noOfInterns: 2,
    about: 'A broader research internship tracking the quantum-computing field — hardware, software, and applications — to inform our long-term research roadmap.',
    responsibilities: [
      'Track and summarise developments across the quantum-computing field.',
      'Support literature reviews on quantum-computing applications relevant to our research.',
      'Assist in preparing internal research briefs on quantum trends.',
      'Document open questions and areas of genuine (vs. hyped) promise.',
      'Collaborate with the broader research team on roadmap input.',
    ],
    skills: ['Research literature review', 'Quantum computing fundamentals', 'Technical writing', 'Critical evaluation', 'Presentation skills'],
    learningOutcomes: ['Quantum Field Tracking', 'Literature Review Methodology', 'Research Brief Writing', 'Critical Technology Evaluation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Physics', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Quantum Research', 'Quantum Computing', 'Technology Trends', 'Research'],
  }),
];

// =====================================================================================
// 27. ROBOTICS & AUTONOMOUS SYSTEMS (Robotics Software + Autonomous Systems already exist
//     in Phase 1 under different framing — skipped where titles collide)
// =====================================================================================
const ROBOTICS_AUTONOMOUS: CatalogRole[] = [
  role({
    slug: 'ros-development-intern',
    departmentId: 'robotics-autonomous', title: 'ROS Development Intern', noOfInterns: 2,
    about: 'Hands-on Robot Operating System (ROS) development — nodes, topics, simulation — for students building real robotics-software skill.',
    responsibilities: [
      'Write and test ROS nodes for simple robotics tasks.',
      'Work with robotics simulators (Gazebo/RViz) to validate code.',
      'Support integration of sensor data (LIDAR/camera) into ROS pipelines.',
      'Debug and document ROS-based systems.',
      'Collaborate with mentors on robotics-software best practices.',
    ],
    skills: ['ROS/ROS2', 'Python or C++', 'Gazebo/RViz simulation', 'Sensor integration basics', 'Linux fundamentals'],
    learningOutcomes: ['ROS Node Development', 'Robotics Simulation', 'Sensor-Data Integration', 'Robotics Software Debugging'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Robotics Engineering', 'Computer Science', 'Mechatronics', 'Any Relevant Discipline'],
    keywords: ['ROS', 'Robot Operating System', 'Robotics Software', 'Gazebo'],
  }),
  role({
    slug: 'computer-vision-robotics-intern',
    departmentId: 'robotics-autonomous', title: 'Computer Vision Robotics Intern', noOfInterns: 2,
    about: 'Applying our computer-vision research to robotics perception — object detection, tracking, navigation-relevant vision — bridging two of our core research areas.',
    responsibilities: [
      'Implement and test computer-vision models for robotics perception tasks.',
      'Support integration of vision models with robotics platforms/simulators.',
      'Evaluate vision-model accuracy and latency for robotics use cases.',
      'Document experiments and findings.',
      'Collaborate with the AI research and robotics teams.',
    ],
    skills: ['Python', 'OpenCV', 'Deep learning for vision (PyTorch/TensorFlow)', 'Robotics perception basics', 'Model evaluation'],
    learningOutcomes: ['Robotics Perception Model Development', 'Vision-Robotics Integration', 'Model Latency/Accuracy Evaluation', 'Applied Research Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Computer Science', 'Robotics Engineering', 'Artificial Intelligence', 'Any Relevant Discipline'],
    keywords: ['Computer Vision', 'Robotics', 'Perception', 'OpenCV', 'Deep Learning'],
  }),
  role({
    slug: 'mechatronics-ai-intern',
    departmentId: 'robotics-autonomous', title: 'Mechatronics AI Intern', noOfInterns: 2,
    about: 'Where mechanical/electronic systems meet AI reasoning — control systems, sensor fusion, intelligent automation — for students spanning hardware and AI.',
    responsibilities: [
      'Support integration of AI/ML models with mechatronic/control systems.',
      'Assist in sensor-fusion experiments for intelligent automation prototypes.',
      'Research applications of AI in mechatronics and industrial automation.',
      'Document hardware-software integration findings.',
      'Collaborate with the electronics/mechanical engineering interns and mentors.',
    ],
    skills: ['Mechatronics fundamentals', 'Python/C++', 'Sensor fusion basics', 'Control systems basics', 'Machine learning fundamentals'],
    learningOutcomes: ['AI-Mechatronics Integration', 'Sensor Fusion Experimentation', 'Intelligent Automation Research', 'Hardware-Software Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Mechatronics Engineering', 'Robotics Engineering', 'Electrical Engineering', 'Any Relevant Discipline'],
    keywords: ['Mechatronics', 'AI', 'Sensor Fusion', 'Control Systems', 'Automation'],
  }),
];

// =====================================================================================
// 28. SEMICONDUCTOR & EMBEDDED SYSTEMS (Embedded Systems Intern already exists in Phase 1
//     under engineering-disciplines — skipped here)
// =====================================================================================
const SEMICONDUCTOR_EMBEDDED: CatalogRole[] = [
  role({
    slug: 'vlsi-design-intern',
    departmentId: 'semiconductor-embedded', title: 'VLSI Design Intern', noOfInterns: 2,
    about: 'VLSI (Very Large Scale Integration) chip-design fundamentals — RTL design, verification basics — for students building real digital-design skill on standard EDA tooling.',
    responsibilities: [
      'Write and simulate RTL designs (Verilog/VHDL) for digital circuits.',
      'Support basic functional-verification exercises.',
      'Assist in documenting design specifications and test benches.',
      'Research VLSI design flow and industry-standard tooling.',
      'Support debugging of simulation mismatches under mentor guidance.',
    ],
    skills: ['Verilog/VHDL', 'Digital logic design', 'RTL simulation', 'Functional verification basics', 'EDA tool familiarity'],
    learningOutcomes: ['RTL Design & Simulation', 'Functional Verification Basics', 'VLSI Design Flow', 'Test-Bench Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electronics Engineering', 'VLSI Design', 'Computer Engineering', 'Any Relevant Discipline'],
    keywords: ['VLSI', 'Verilog', 'RTL Design', 'Chip Design', 'Digital Logic'],
  }),
  role({
    slug: 'fpga-development-intern',
    departmentId: 'semiconductor-embedded', title: 'FPGA Development Intern', noOfInterns: 2,
    about: 'Hands-on FPGA development — implementing and testing designs on real programmable hardware — for students who want to move from simulation to working hardware.',
    responsibilities: [
      'Implement digital designs on FPGA development boards.',
      'Support timing-constraint and resource-utilisation analysis.',
      'Assist in debugging FPGA designs using on-board tools.',
      'Document FPGA design and testing workflows.',
      'Research FPGA applications relevant to our hardware-adjacent work.',
    ],
    skills: ['Verilog/VHDL', 'FPGA toolchains (Xilinx/Intel)', 'Timing analysis basics', 'Hardware debugging', 'Documentation'],
    learningOutcomes: ['FPGA Implementation', 'Timing & Resource Analysis', 'Hardware Debugging', 'FPGA Workflow Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electronics Engineering', 'Computer Engineering', 'VLSI Design', 'Any Relevant Discipline'],
    keywords: ['FPGA', 'Verilog', 'Xilinx', 'Hardware Development', 'Digital Design'],
  }),
  role({
    slug: 'pcb-design-intern',
    departmentId: 'semiconductor-embedded', title: 'PCB Design Intern', noOfInterns: 3,
    about: 'Focused PCB (printed-circuit-board) design internship — schematic capture through layout — for our internal prototypes and lab equipment, distinct from the broader Electronics Engineering internship.',
    responsibilities: [
      'Design PCB schematics and layouts for internal prototypes using standard EDA tools.',
      'Support component footprint selection and library management.',
      'Assist in design-rule checks (DRC) and manufacturability review.',
      'Document bill of materials and fabrication notes.',
      'Support bring-up and testing of fabricated boards.',
    ],
    skills: ['PCB design (KiCad/Eagle/Altium)', 'Schematic capture', 'Component library management', 'Design-rule checking', 'BOM documentation'],
    learningOutcomes: ['PCB Schematic & Layout Design', 'Manufacturability Review', 'Component Library Management', 'Board Bring-Up & Testing'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electronics Engineering', 'Electronics & Communication Engineering', 'Any Relevant Discipline'],
    keywords: ['PCB Design', 'KiCad', 'Altium', 'Schematic Capture', 'Hardware Design'],
  }),
  role({
    slug: 'semiconductor-research-intern',
    departmentId: 'semiconductor-embedded', title: 'Semiconductor Research Intern', noOfInterns: 2,
    about: 'A research-track internship tracking semiconductor-industry trends and fundamentals — device physics, fabrication basics, industry landscape — to inform our hardware-adjacent research notes.',
    responsibilities: [
      'Research semiconductor device fundamentals and fabrication processes.',
      'Track industry trends relevant to our hardware-adjacent research.',
      'Support literature review on emerging semiconductor technologies.',
      'Document findings for internal research briefs.',
      'Present research summaries to the team.',
    ],
    skills: ['Semiconductor fundamentals', 'Research literature review', 'Technical writing', 'Industry-trend tracking', 'Presentation skills'],
    learningOutcomes: ['Semiconductor Device Fundamentals', 'Fabrication Process Awareness', 'Industry Trend Research', 'Technical Brief Writing'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electronics Engineering', 'Materials Science', 'Physics', 'Any Relevant Discipline'],
    keywords: ['Semiconductor', 'Chip Fabrication', 'Device Physics', 'Semiconductor Industry'],
  }),
];

// =====================================================================================
// 29. CLIMATE & SUSTAINABILITY (research-domain application + our own ESG/governance work)
// =====================================================================================
const CLIMATE_SUSTAINABILITY: CatalogRole[] = [
  role({
    slug: 'climate-technology-intern',
    departmentId: 'climate-sustainability', title: 'Climate Technology Intern', noOfInterns: 2,
    about: 'Climate-technology research — how data and reasoning models support climate-science and mitigation work — studied as a research-domain case for our AI reasoning research.',
    responsibilities: [
      'Research climate-technology approaches (climate modelling, emissions tracking, mitigation tools).',
      'Support structuring of open climate datasets for research use.',
      'Assist in summarising climate-science literature relevant to our research.',
      'Document findings for the research team.',
      'Support internal knowledge-sharing on climate-tech trends.',
    ],
    skills: ['Climate-technology landscape research', 'Data structuring', 'Literature review', 'Documentation', 'Basic data analysis'],
    learningOutcomes: ['Climate Technology Landscape Research', 'Climate Dataset Structuring', 'Climate Literature Review', 'Research Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Environmental Science', 'Environmental Engineering', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['Climate Technology', 'Climate Science', 'Climate Data', 'Sustainability'],
  }),
  role({
    slug: 'esg-analytics-intern',
    departmentId: 'climate-sustainability', title: 'ESG Analytics Intern', noOfInterns: 2,
    about: 'ESG (Environmental, Social, Governance) analytics — directly relevant to our own governance and corporate-affairs practice as we formalise ESG reporting.',
    responsibilities: [
      'Support structuring and analysis of ESG data relevant to our own reporting.',
      'Research ESG reporting frameworks and standards.',
      'Assist in benchmarking our practices against ESG standards.',
      'Document ESG data sources and methodology.',
      'Coordinate with the governance & corporate affairs team.',
    ],
    skills: ['ESG frameworks awareness', 'Data analysis', 'Research skills', 'Documentation', 'Excel/Sheets'],
    learningOutcomes: ['ESG Reporting Frameworks', 'ESG Data Structuring', 'Benchmarking Analysis', 'Cross-Team Coordination'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Environmental Science', 'Business Administration', 'Sustainability Studies', 'Any Relevant Discipline'],
    keywords: ['ESG', 'ESG Analytics', 'Sustainability Reporting', 'Corporate Governance'],
  }),
  role({
    slug: 'carbon-accounting-intern',
    departmentId: 'climate-sustainability', title: 'Carbon Accounting Intern', noOfInterns: 2,
    about: 'Carbon accounting — measuring and reporting emissions — supports our own internal sustainability tracking as we grow, and is a genuinely transferable analytical skill.',
    responsibilities: [
      'Support carbon-footprint data collection for internal operations.',
      'Research carbon-accounting standards and methodologies (e.g. GHG Protocol).',
      'Assist in building simple emissions-tracking spreadsheets/dashboards.',
      'Document data sources and calculation methodology.',
      'Present findings to the governance & corporate affairs team.',
    ],
    skills: ['Carbon accounting fundamentals (GHG Protocol awareness)', 'Data collection', 'Excel/Sheets modelling', 'Documentation', 'Attention to detail'],
    learningOutcomes: ['Carbon Accounting Methodology', 'Emissions Data Collection', 'Emissions Dashboard Building', 'Sustainability Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Environmental Science', 'Sustainability Studies', 'Business Administration', 'Any Relevant Discipline'],
    keywords: ['Carbon Accounting', 'GHG Protocol', 'Emissions Tracking', 'Sustainability'],
  }),
  role({
    slug: 'renewable-energy-intern',
    departmentId: 'climate-sustainability', title: 'Renewable Energy Intern', noOfInterns: 2,
    about: 'Renewable-energy research — solar/wind fundamentals, energy-system data — as a research-domain case study, and relevant to our own facility energy-efficiency planning.',
    responsibilities: [
      'Research renewable-energy technologies and adoption trends.',
      'Support analysis of energy-efficiency opportunities for our own facilities.',
      'Assist in documenting renewable-energy research findings.',
      'Support literature review on energy-transition policy.',
      'Present findings to the sustainability-focused team.',
    ],
    skills: ['Renewable energy fundamentals', 'Data analysis basics', 'Research literature review', 'Documentation', 'Presentation skills'],
    learningOutcomes: ['Renewable Energy Technology Research', 'Facility Energy-Efficiency Analysis', 'Energy Transition Policy Research', 'Research Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electrical Engineering', 'Environmental Engineering', 'Energy Studies', 'Any Relevant Discipline'],
    keywords: ['Renewable Energy', 'Solar Energy', 'Wind Energy', 'Energy Transition'],
  }),
  role({
    slug: 'sustainability-research-intern',
    departmentId: 'climate-sustainability', title: 'Sustainability Research Intern', noOfInterns: 2,
    about: 'A broad sustainability-research internship supporting both our external research interests and our own internal sustainability practice as a growing organisation.',
    responsibilities: [
      'Conduct literature reviews on sustainability topics relevant to our research and operations.',
      'Support internal sustainability-practice documentation (waste, energy, procurement).',
      'Assist in benchmarking our practices against sustainability standards.',
      'Prepare research briefs for the governance & corporate affairs team.',
      'Support cross-team sustainability initiatives.',
    ],
    skills: ['Sustainability research', 'Literature review', 'Documentation', 'Benchmarking analysis', 'Communication'],
    learningOutcomes: ['Sustainability Literature Review', 'Internal Practice Documentation', 'Sustainability Benchmarking', 'Cross-Team Initiative Support'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Environmental Science', 'Sustainability Studies', 'Public Policy', 'Any Relevant Discipline'],
    keywords: ['Sustainability', 'Sustainability Research', 'ESG', 'Environmental Studies'],
  }),
];

// =====================================================================================
// 30. PUBLIC SECTOR & SOCIAL IMPACT (directly relevant — education access is our mission)
// =====================================================================================
const PUBLIC_SECTOR_SOCIAL_IMPACT: CatalogRole[] = [
  role({
    slug: 'public-sector-consulting-intern',
    departmentId: 'public-sector-impact', title: 'Public Sector Consulting Intern', noOfInterns: 2,
    about: 'Understanding how public-sector education systems work is core to AquinTutor\'s mission of broadening access. This internship researches public-sector education policy and partnership models.',
    responsibilities: [
      'Research public-sector education policy and program models.',
      'Support analysis of potential public-sector partnership opportunities.',
      'Assist in preparing briefing documents on public-sector engagement.',
      'Document findings for the leadership and governance teams.',
      'Support literature review on education-policy case studies.',
    ],
    skills: ['Public policy research', 'Analytical writing', 'Documentation', 'Literature review', 'Presentation skills'],
    learningOutcomes: ['Public-Sector Education Policy Research', 'Partnership Opportunity Analysis', 'Policy Briefing Documentation', 'Case-Study Research'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Public Policy', 'Public Administration', 'Political Science', 'Any Relevant Discipline'],
    keywords: ['Public Sector', 'Public Policy Consulting', 'Education Policy', 'Government Partnerships'],
  }),
  role({
    slug: 'government-technology-intern',
    departmentId: 'public-sector-impact', title: 'Government Technology Intern', noOfInterns: 2,
    about: 'GovTech — how public services are digitised — is directly relevant to how AquinTutor might integrate with public education infrastructure. Interns research this landscape.',
    responsibilities: [
      'Research GovTech platforms and digital-public-service models relevant to education.',
      'Support analysis of digital public infrastructure (e.g. DPI) relevant to education access.',
      'Assist in documenting GovTech interoperability standards.',
      'Support literature review on digital-government case studies.',
      'Present findings to the product and governance teams.',
    ],
    skills: ['GovTech landscape research', 'Digital public infrastructure awareness', 'Documentation', 'Literature review', 'Analytical thinking'],
    learningOutcomes: ['GovTech Landscape Research', 'Digital Public Infrastructure Analysis', 'Interoperability Standards Research', 'Case-Study Documentation'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Public Policy', 'Computer Science', 'Public Administration', 'Any Relevant Discipline'],
    keywords: ['GovTech', 'Government Technology', 'Digital Public Infrastructure', 'Public Services'],
  }),
  role({
    slug: 'policy-analytics-intern',
    departmentId: 'public-sector-impact', title: 'Policy Analytics Intern', noOfInterns: 2,
    about: 'Applying data analysis to education-policy questions — a distinct, quantitative complement to our qualitative Policy Research internship.',
    responsibilities: [
      'Analyse publicly available education-policy datasets.',
      'Support building visualisations of policy-relevant trends.',
      'Assist in quantitative literature review (meta-analysis basics) on education policy.',
      'Document analytical methodology.',
      'Present findings to the research team.',
    ],
    skills: ['Python/R for analytics', 'Statistics', 'Data visualisation', 'Public dataset research', 'Analytical writing'],
    learningOutcomes: ['Education-Policy Data Analysis', 'Policy Trend Visualisation', 'Quantitative Literature Review', 'Analytical Reporting'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Public Policy', 'Economics', 'Statistics', 'Data Science', 'Any Relevant Discipline'],
    keywords: ['Policy Analytics', 'Education Policy', 'Data Analysis', 'Public Policy Research'],
  }),
  role({
    slug: 'social-innovation-intern',
    departmentId: 'public-sector-impact', title: 'Social Innovation Intern', noOfInterns: 2,
    about: 'Exploring new models for expanding education access — scholarships, waivers, community partnerships — directly building on our existing Talent Accessibility Initiative work.',
    responsibilities: [
      'Research social-innovation models for expanding education access.',
      'Support evaluation of our own accessibility initiatives (fee waivers, free-tier access).',
      'Assist in identifying potential community and NGO partnerships.',
      'Document findings and recommendations.',
      'Support impact-measurement framework design.',
    ],
    skills: ['Social-innovation research', 'Impact measurement basics', 'Stakeholder research', 'Documentation', 'Communication'],
    learningOutcomes: ['Social Innovation Model Research', 'Accessibility Initiative Evaluation', 'Partnership Identification', 'Impact Measurement Design'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Social Work', 'Public Policy', 'Development Studies', 'Any Relevant Discipline'],
    keywords: ['Social Innovation', 'Social Impact', 'Education Access', 'Community Partnerships'],
  }),
  role({
    slug: 'rural-development-technology-intern',
    departmentId: 'public-sector-impact', title: 'Rural Development Technology Intern', noOfInterns: 2,
    about: 'How technology reaches rural and low-connectivity communities is central to AquinTutor\'s offline-first design. This internship researches rural-development technology models directly relevant to that work.',
    responsibilities: [
      'Research rural-development technology models and case studies.',
      'Support analysis of low-connectivity/offline-access patterns relevant to AquinTutor.',
      'Assist in documenting rural-outreach and partnership models.',
      'Support literature review on rural digital-inclusion programs.',
      'Present findings to the product and access-strategy teams.',
    ],
    skills: ['Rural development research', 'Digital inclusion research', 'Documentation', 'Literature review', 'Communication'],
    learningOutcomes: ['Rural Development Technology Research', 'Offline/Low-Connectivity Access Research', 'Rural Outreach Model Documentation', 'Digital Inclusion Research'],
    qualificationType: UGPG, qualifications: STD_QUALIFICATIONS,
    specialisations: ['Development Studies', 'Public Policy', 'Rural Development', 'Any Relevant Discipline'],
    keywords: ['Rural Development', 'Digital Inclusion', 'Offline Access', 'Rural Technology'],
  }),
];

export const INTERN_CATALOG_PHASE2: CatalogRole[] = [
  ...HEALTHCARE_LIFE_SCIENCES,
  ...SPORTS_TECHNOLOGY,
  ...AGRICULTURE_FOOD_TECH,
  ...GIS_GEOSPATIAL,
  ...SMART_CITIES_INFRASTRUCTURE,
  ...QUANTUM_TECHNOLOGIES,
  ...ROBOTICS_AUTONOMOUS,
  ...SEMICONDUCTOR_EMBEDDED,
  ...CLIMATE_SUSTAINABILITY,
  ...PUBLIC_SECTOR_SOCIAL_IMPACT,
];

export const PHASE2_DEPARTMENTS = [
  { id: 'sports-tech', name: 'Sports Technology', icon: 'activity', description: 'Sports analytics, AI, and technology research built on the real Karate.support community platform.' },
  { id: 'agri-food-tech', name: 'Agriculture & Food Technology', icon: 'leaf', description: 'Research-domain applications of our reasoning-model work to agriculture and food systems.' },
  { id: 'geospatial', name: 'GIS & Geospatial Technologies', icon: 'map', description: 'Mapping and spatial analysis of our institutional and partner network, and geospatial-AI research.' },
  { id: 'smart-cities', name: 'Smart Cities & Infrastructure', icon: 'building', description: 'Urban and infrastructure data research supporting the Holistic Education Index.' },
  { id: 'quantum-tech', name: 'Quantum Technologies', icon: 'atom', description: 'Quantum computing, algorithms, and quantum-AI research.' },
  { id: 'robotics-autonomous', name: 'Robotics & Autonomous Systems', icon: 'cpu', description: 'Robotics software, perception, and mechatronics-AI research.' },
  { id: 'semiconductor-embedded', name: 'Semiconductor & Embedded Systems', icon: 'chip', description: 'VLSI, FPGA, PCB design, and semiconductor research supporting our hardware-adjacent work.' },
  { id: 'climate-sustainability', name: 'Climate & Sustainability', icon: 'globe', description: 'Climate-technology research and our own internal ESG, carbon-accounting, and sustainability practice.' },
  { id: 'public-sector-impact', name: 'Public Sector & Social Impact', icon: 'heart-handshake', description: 'Public-sector education policy, GovTech, and social-impact research directly supporting our access mission.' },
];

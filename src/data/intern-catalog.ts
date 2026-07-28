// src/data/intern-catalog.ts — the AICTE-format internship catalog (~170 roles across 20
// functional domains: AI & Data Science, Software Engineering, Cybersecurity, Product & Design,
// Core Engineering Disciplines, Research, Executive Office, HR, Marketing & Growth, Sales & BD,
// Finance & Legal, Operations, Customer & Support, Education & Learning, Media & Communications,
// Emerging Tech, Healthcare & BioTech, Administration, Governance & Corporate Affairs, and
// Entrepreneurship & Innovation).
//
// Every role carries the AICTE-portal field set (learning outcomes, qualification type,
// qualifications, specialisations, keywords, perks, terms of engagement) — see
// CatalogRole in role-catalog.ts and the storage layer in src/lib/role-aicte.ts.
// Imported alongside ROLE_CATALOG via the existing gap-filling "Import role catalog" button
// in /admin/roles: idempotent by slug/title, never overwrites an edited role.
import type { CatalogRole } from './role-catalog';

const REMOTE_IN = 'Remote / Hybrid (India)';

// Shared "Terms of Engagement" — the standard internship structure across the whole catalog,
// matching the founder's specified 6-day week / ~40 hour split (project work + holistic
// well-being time), unless a specific role overrides it.
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

// Shared perks, with small category-flavoured additions layered on top per role where useful.
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
// 5. CORE ENGINEERING DISCIPLINES  (Electronics Engineering Intern is the priority role —
//    an applicant is waiting on this exact link.)
// =====================================================================================
const ENGINEERING_DISCIPLINES: CatalogRole[] = [
  role({
    slug: 'electronics-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Electronics Engineering Intern',
    noOfInterns: 20,
    about: 'Electronics engineering underpins much of our hardware-adjacent and embedded work — from sensor interfacing for physical-board capture to device prototyping for our labs. The Electronics Engineering Internship is designed for students who want hands-on exposure to circuit design, PCB layout, and embedded hardware, working alongside our engineering and research teams on real prototypes rather than textbook exercises.',
    responsibilities: [
      'Design, simulate, and test analog and digital circuits for internal prototypes and lab equipment.',
      'Assist in PCB layout, schematic capture, and component selection using standard EDA tools.',
      'Prototype and debug embedded electronics (sensors, microcontrollers, power circuits).',
      'Support integration of electronic subsystems with software/firmware teams.',
      'Document circuit designs, test procedures, and bill of materials.',
      'Conduct component research and datasheet analysis for design decisions.',
      'Assist with hardware-in-the-loop testing and troubleshooting of live prototypes.',
      'Research emerging trends in electronics, embedded systems, and IoT hardware.',
    ],
    skills: ['Circuit design fundamentals', 'PCB design (KiCad/Eagle/Altium)', 'Microcontrollers (Arduino/STM32/ESP32)', 'Analog & digital electronics', 'Oscilloscope & multimeter use', 'Embedded C/C++ basics', 'Datasheet interpretation', 'SPICE simulation'],
    learningOutcomes: ['Circuit Design & Simulation', 'PCB Layout & Fabrication Basics', 'Embedded Hardware Prototyping', 'Sensor Interfacing', 'Power Electronics Fundamentals', 'Hardware Debugging & Testing', 'Technical Documentation', 'Cross-functional Hardware-Software Integration'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electronics Engineering', 'Electronics & Communication Engineering', 'Electrical Engineering', 'Instrumentation Engineering', 'Computer Engineering', 'Any Relevant Discipline'],
    keywords: ['Electronics Engineering', 'PCB Design', 'Embedded Systems', 'Microcontrollers', 'Circuit Design', 'Arduino', 'STM32', 'Analog Electronics', 'Digital Electronics', 'Hardware Prototyping'],
    eligibilityExtra: ['Coursework or personal projects in circuit design, embedded systems, or microcontroller programming.'],
  }),
  role({
    slug: 'electrical-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Electrical Engineering Intern',
    noOfInterns: 15,
    about: 'Our physical infrastructure and lab equipment depend on sound electrical engineering — power distribution, wiring safety, and system-level electrical design. This internship gives electrical engineering students real exposure to power systems, control panels, and safety-compliant design work.',
    responsibilities: [
      'Assist in electrical system design for lab and office infrastructure.',
      'Support power distribution planning and load calculations.',
      'Help design and test control panels and switchgear layouts.',
      'Ensure compliance with electrical safety standards in prototypes and installations.',
      'Document electrical schematics and single-line diagrams.',
      'Assist senior engineers in troubleshooting electrical systems.',
      'Research energy-efficient and renewable electrical solutions relevant to our facilities.',
    ],
    skills: ['Electrical circuit analysis', 'Power systems fundamentals', 'AutoCAD Electrical', 'Load calculation', 'Electrical safety standards', 'Control panel design', 'Motor & drive basics'],
    learningOutcomes: ['Power System Design', 'Electrical Safety Compliance', 'Control Panel Documentation', 'Load Analysis', 'Renewable Energy Basics', 'Technical Drawing (Electrical)', 'Site Coordination'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electrical Engineering', 'Electrical & Electronics Engineering', 'Power Engineering', 'Any Relevant Discipline'],
    keywords: ['Electrical Engineering', 'Power Systems', 'AutoCAD Electrical', 'Control Panels', 'Load Calculation', 'Electrical Safety'],
  }),
  role({
    slug: 'mechanical-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Mechanical Engineering Intern',
    noOfInterns: 15,
    about: 'From physical-board camera rigs to lab equipment enclosures, mechanical design underlies much of our hardware. This internship offers hands-on CAD, prototyping, and design-for-manufacture experience under mentorship.',
    responsibilities: [
      'Design mechanical parts and assemblies using CAD software.',
      'Support prototyping (3D printing, basic machining coordination) of enclosures and fixtures.',
      'Perform basic stress/thermal analysis on components.',
      'Assist in design-for-manufacture and tolerance reviews.',
      'Document engineering drawings (GD&T) for fabrication.',
      'Support testing and iteration of physical prototypes.',
      'Research materials and manufacturing methods relevant to a design brief.',
    ],
    skills: ['CAD (SolidWorks/Fusion 360/AutoCAD)', 'GD&T basics', '3D printing workflows', 'Material selection', 'Basic FEA', 'Mechanical drawing standards', 'DFM/DFA principles'],
    learningOutcomes: ['CAD Modelling & Assembly', 'Rapid Prototyping', 'Engineering Drawing (GD&T)', 'Design for Manufacture', 'Basic Structural Analysis', 'Materials Selection', 'Prototype Testing & Iteration'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Mechanical Engineering', 'Production Engineering', 'Industrial Engineering', 'Any Relevant Discipline'],
    keywords: ['Mechanical Engineering', 'CAD', 'SolidWorks', '3D Printing', 'Prototyping', 'GD&T', 'DFM'],
  }),
  role({
    slug: 'civil-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Civil Engineering Intern',
    noOfInterns: 10,
    about: 'As our campus and partner-facility footprint grows, civil engineering support is needed for site assessment, structural review coordination, and facility planning. This internship suits students who want real-world site and documentation exposure.',
    responsibilities: [
      'Assist with site assessments and facility layout planning.',
      'Support coordination with structural consultants on renovations/fit-outs.',
      'Prepare basic drawings and BOQs under supervision.',
      'Help track compliance with building codes and safety norms.',
      'Document site visits, measurements, and material requirements.',
      'Research sustainable construction practices relevant to our facilities.',
    ],
    skills: ['AutoCAD Civil', 'Site surveying basics', 'Building codes awareness', 'Quantity estimation', 'Structural drawing reading', 'MS Excel for BOQ'],
    learningOutcomes: ['Site Assessment', 'Facility Planning', 'Quantity & Cost Estimation', 'Building Code Compliance', 'Construction Documentation', 'Sustainable Construction Basics'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Civil Engineering', 'Structural Engineering', 'Architecture', 'Any Relevant Discipline'],
    keywords: ['Civil Engineering', 'AutoCAD', 'Site Planning', 'BOQ', 'Structural Coordination', 'Construction'],
  }),
  role({
    slug: 'aerospace-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Aerospace Engineering Intern',
    noOfInterns: 8,
    about: 'Our aerospace research programme explores autonomous swarm and aerospace-adjacent concepts across scales. As an intern you will do real research work — simulation, parametric analysis, documentation of engineering trades — alongside the team, with your contributions credited.',
    responsibilities: [
      'Run and document simulations (flight profiles, CFD-adjacent analysis).',
      'Build parametric models and engineering trade studies.',
      'Contribute to research documentation and internal papers.',
      'Support aerodynamic and structural literature review.',
      'Present findings in research reviews.',
    ],
    skills: ['Python or MATLAB', 'Aerospace/mechanical fundamentals', 'Simulation literacy', 'Flight mechanics basics', 'Technical writing'],
    learningOutcomes: ['Flight Mechanics Fundamentals', 'Simulation & Parametric Modelling', 'Aerodynamics Literature Review', 'Engineering Trade Studies', 'Research Documentation', 'Technical Presentation'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Aerospace Engineering', 'Aeronautical Engineering', 'Mechanical Engineering', 'Any Relevant Discipline'],
    keywords: ['Aerospace Engineering', 'Flight Mechanics', 'CFD', 'Simulation', 'Aerodynamics', 'Research'],
    duration: '6 Months',
  }),
  role({
    slug: 'robotics-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Robotics Engineering Intern',
    noOfInterns: 10,
    about: 'Robotics sits at the intersection of mechanical design, embedded control, and AI perception — central to our automation and physical-interaction research. This internship gives hands-on exposure to building and programming real robotic systems.',
    responsibilities: [
      'Assist in designing and assembling robotic subsystems (mechanical + electronics).',
      'Write and test control software (ROS or equivalent) for robot behaviours.',
      'Integrate sensors (LiDAR, cameras, IMUs) with robotic platforms.',
      'Support simulation-to-real transfer of robotic control policies.',
      'Debug and iterate on robot performance in test environments.',
      'Document build processes, wiring, and control architecture.',
    ],
    skills: ['ROS/ROS2', 'Python/C++', 'Sensor integration', 'Basic control theory', 'Robot kinematics', 'Simulation (Gazebo/Isaac Sim)'],
    learningOutcomes: ['Robotic System Design', 'ROS-based Control Programming', 'Sensor Fusion Basics', 'Kinematics & Motion Planning', 'Simulation-to-Real Transfer', 'Hardware-Software Integration'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Robotics Engineering', 'Mechatronics', 'Computer Science', 'Electronics Engineering', 'Any Relevant Discipline'],
    keywords: ['Robotics', 'ROS', 'Mechatronics', 'Sensor Fusion', 'Control Systems', 'Automation'],
    duration: '6 Months',
  }),
  role({
    slug: 'mechatronics-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Mechatronics Engineering Intern',
    noOfInterns: 8,
    about: 'Mechatronics blends mechanical, electronic, and software systems into single working machines — exactly the discipline behind our automated lab equipment and prototypes. Interns get exposure across all three layers of a real system.',
    responsibilities: [
      'Assist in integrating mechanical, electrical, and control subsystems.',
      'Support PLC/microcontroller programming for automated systems.',
      'Test and calibrate sensors and actuators in integrated systems.',
      'Document system architecture and integration test results.',
      'Troubleshoot cross-domain issues (mechanical-electrical-software).',
    ],
    skills: ['PLC/microcontroller programming', 'Sensor & actuator integration', 'Basic mechanical design', 'Control systems basics', 'System integration testing'],
    learningOutcomes: ['Systems Integration', 'PLC/Microcontroller Programming', 'Sensor-Actuator Calibration', 'Automation Fundamentals', 'Cross-Domain Troubleshooting'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Mechatronics Engineering', 'Mechanical Engineering', 'Electronics Engineering', 'Any Relevant Discipline'],
    keywords: ['Mechatronics', 'Automation', 'PLC', 'System Integration', 'Sensors', 'Actuators'],
  }),
  role({
    slug: 'chemical-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'Chemical Engineering Intern',
    noOfInterns: 5,
    about: 'For our materials-science-adjacent research and lab safety work, chemical engineering expertise is valuable. Interns support process documentation and lab-safety-compliant experimentation.',
    responsibilities: [
      'Support process documentation for lab experiments.',
      'Assist in material property research and testing.',
      'Help maintain lab safety and chemical handling compliance.',
      'Document experimental procedures and results.',
      'Research process optimisation opportunities.',
    ],
    skills: ['Process fundamentals', 'Lab safety protocols', 'Material properties analysis', 'Basic thermodynamics', 'Technical documentation'],
    learningOutcomes: ['Process Documentation', 'Lab Safety Compliance', 'Material Property Analysis', 'Experimental Design Basics', 'Process Optimisation Thinking'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Chemical Engineering', 'Materials Science', 'Any Relevant Discipline'],
    keywords: ['Chemical Engineering', 'Process Engineering', 'Lab Safety', 'Materials'],
  }),
  role({
    slug: 'iot-engineering-intern',
    departmentId: 'engineering-disciplines',
    title: 'IoT Engineering Intern',
    noOfInterns: 12,
    about: 'Connected sensors and devices power several of our data-collection and lab-monitoring initiatives. This internship covers the full IoT stack — device firmware, connectivity, and cloud ingestion.',
    responsibilities: [
      'Prototype IoT devices using microcontrollers and sensor modules.',
      'Implement connectivity (WiFi/BLE/LoRa/MQTT) between devices and cloud services.',
      'Assist in building simple dashboards for device telemetry.',
      'Test device reliability and battery/power performance.',
      'Document device architecture and communication protocols.',
    ],
    skills: ['Microcontroller programming', 'MQTT/HTTP protocols', 'Sensor interfacing', 'Basic cloud IoT platforms', 'Power management basics'],
    learningOutcomes: ['IoT Device Prototyping', 'Connectivity Protocol Implementation', 'Telemetry Dashboarding', 'Power & Reliability Testing', 'Edge-to-Cloud Architecture'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electronics Engineering', 'Computer Engineering', 'Instrumentation Engineering', 'Any Relevant Discipline'],
    keywords: ['IoT', 'Embedded Systems', 'MQTT', 'Sensors', 'Connectivity', 'Edge Computing'],
  }),
  role({
    slug: 'embedded-systems-intern',
    departmentId: 'engineering-disciplines',
    title: 'Embedded Systems Intern',
    noOfInterns: 12,
    about: 'Embedded firmware is the backbone connecting our hardware prototypes to the software layer. This internship focuses on writing efficient, reliable firmware for real devices.',
    responsibilities: [
      'Write and debug firmware for microcontroller-based devices.',
      'Implement communication protocols (UART/SPI/I2C) between components.',
      'Optimise code for memory and power constraints.',
      'Test firmware against hardware in the loop.',
      'Document firmware architecture and API interfaces.',
    ],
    skills: ['Embedded C/C++', 'RTOS basics', 'UART/SPI/I2C protocols', 'Debugging with JTAG/logic analyzer', 'Memory-constrained programming'],
    learningOutcomes: ['Firmware Development', 'Communication Protocol Implementation', 'RTOS Fundamentals', 'Hardware-in-the-Loop Testing', 'Low-Level Debugging'],
    qualificationType: UGPG,
    qualifications: STD_QUALIFICATIONS,
    specialisations: ['Electronics Engineering', 'Computer Engineering', 'Computer Science', 'Any Relevant Discipline'],
    keywords: ['Embedded Systems', 'Firmware', 'RTOS', 'Microcontrollers', 'C++', 'Hardware Debugging'],
  }),
];

export const INTERN_CATALOG_DEPARTMENTS = [] as const; // department entries live in role-catalog.ts CATALOG_DEPARTMENTS

export const INTERN_CATALOG: CatalogRole[] = [
  ...ENGINEERING_DISCIPLINES,
];

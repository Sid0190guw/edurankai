import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// First, drop and recreate to take the comprehensive seed cleanly
// (Safe: no institutions reference entity_type_id yet)
await sql`DELETE FROM hei_entity_types`;
console.log("Cleared existing entity types for clean re-seed");

// COMPREHENSIVE TAXONOMY - your 15 categories + structural ones + indic + faith
const TYPES = [
  // === FORMAL HIGHER EDUCATION (universities & colleges) ===
  ["university","University","higher_education","Multi-faculty degree-granting institution",10],
  ["deemed_university","Deemed University","higher_education","UGC-granted university status",11],
  ["central_university","Central University","higher_education","Established by Act of Parliament",12],
  ["state_university","State University","higher_education","Established by state legislature",13],
  ["private_university","Private University","higher_education","Established by state-private act",14],
  ["institute_national_importance","Institute of National Importance","higher_education","IIT, AIIMS, NIT, IISER, IIIT, IIM",15],
  ["college_affiliated","Affiliated College","higher_education","Affiliated to a university",20],
  ["college_autonomous","Autonomous College","higher_education","Degree-granting autonomy",21],
  ["college_constituent","Constituent College","higher_education","Part of parent university",22],

  // === K-12 / SCHOOL ===
  ["school_primary","Primary School","school","Grades 1-5",30],
  ["school_secondary","Secondary School","school","Grades 6-10",31],
  ["school_higher_secondary","Higher Secondary School","school","Grades 11-12",32],
  ["school_international","International School","school","IB, IGCSE, Cambridge etc",33],

  // === 1. GOVERNMENT, PUBLIC SECTOR & LEGAL FRAMEWORK ===
  ["civil_services_academy","Civil Services Academy","government_public","Foundational training for civil servants",100],
  ["cadre_specific_academy","Cadre-Specific Academy","government_public","Tax/auditing/postal cadre schools",101],
  ["diplomatic_institute","Diplomatic / Foreign Service Institute","government_public","International statecraft training",102],
  ["state_admin_college","State Administrative College","government_public","Provincial governance training",103],
  ["municipal_panchayat_centre","Municipal & Panchayati Raj Centre","government_public","Urban planning & rural dev training",104],
  ["judicial_academy","Judicial Academy","government_public","Training for judges",105],
  ["prosecution_training_centre","Prosecution Training Centre","government_public","Court litigation training",106],
  ["parliamentary_institute","Parliamentary Studies Institute","government_public","Legislative drafting training",107],

  // === 2. MILITARY, COMBAT & NATIONAL DEFENCE ===
  ["tri_service_academy","Tri-Service Pre-Commissioning Academy","military","Army/Navy/Air Force joint training (NDA)",110],
  ["branch_officer_academy","Branch-Specific Officer Academy","military","Single-service commissioning (IMA, INA, AFA)",111],
  ["higher_command_college","Higher Command & War College","military","Advanced strategic training",112],
  ["regimental_combat_school","Regimental & Combat Arms School","military","Weaponry, artillery, engineering, armor",113],
  ["nco_school","Non-Commissioned Officer School","military","Tactical leadership for enlisted",114],
  ["special_forces_school","Special Forces & Commando School","military","Survival, airborne, asymmetric warfare",115],

  // === 3. LAW ENFORCEMENT, SAFETY & INTELLIGENCE ===
  ["police_leadership_academy","Apex Police Leadership Academy","law_enforcement","Top-tier law enforcement command",120],
  ["state_police_college","State Police College (PTC)","law_enforcement","Mid-rank officer training",121],
  ["police_recruit_centre","Police Recruit Training Centre (RTC)","law_enforcement","Basic constable training",122],
  ["counter_insurgency_school","Counter-Insurgency & Tactical School","law_enforcement","Guerrilla, jungle, urban combat",123],
  ["intelligence_academy","Intelligence & Counter-Intelligence Academy","law_enforcement","Espionage, cyber-surveillance",124],
  ["fire_emergency_academy","Fire & Emergency Services Academy","law_enforcement","Disaster response & firefighting",125],
  ["correctional_admin_school","Prison & Correctional Administration School","law_enforcement","Jail management & rehabilitation",126],

  // === 4. FORENSIC SCIENCE ===
  ["forensic_university","Forensic Science University","forensic","DNA, ballistic, digital evidence training",130],
  ["detective_training_institute","Central Detective Training Institute (CDTI)","forensic","Crime scene processing",131],
  ["cyber_forensics_centre","Cyber Forensics & Crypto-Analysis Centre","forensic","Digital tracing, malware analysis",132],
  ["fingerprint_bureau","Fingerprint & Document Verification Bureau","forensic","Biometric & handwriting analysis",133],

  // === 5. VOCATIONAL & INDUSTRIAL TRADES ===
  ["iti","Industrial Training Institute (ITI)","vocational","Electricians, welders, fitters, turners",140],
  ["itot","Institute of Training of Trainers (IToT)","vocational","Licenses vocational teachers",141],
  ["polytechnic","Polytechnic / Technical Diploma","vocational","Diploma-level technical education",142],
  ["apprenticeship_wing","Apprenticeship Training Wing","vocational","Factory-integrated training",143],
  ["heavy_machinery_centre","Heavy Machinery Training Centre","vocational","Cranes, excavators, mining equipment",144],
  ["skill_development_centre","Skill Development Centre","vocational","NSDC-affiliated or equivalent",145],

  // === 6. INFORMATION TECHNOLOGY ===
  ["software_bootcamp","Software Engineering Bootcamp","information_technology","Coding, web dev, architecture",150],
  ["networking_academy","Networking & Infrastructure Academy","information_technology","Systems, cloud, server management",151],
  ["cybersecurity_institute","Cyber Security Training Institute","information_technology","Pentest, ethical hacking, defense",152],
  ["ai_ml_institute","AI, ML & Data Science Institute","information_technology","Neural networks, big data, modeling",153],
  ["cad_robotics_centre","CAD/CAM & Industrial Robotics Centre","information_technology","Drafting, automation, logic programming",154],

  // === 7. TRANSPORT, AEROSPACE, MARITIME & LOGISTICS ===
  ["flying_training_org","Flying Training Organization (FTO)","transport_aerospace","Pilot license & simulator training",160],
  ["cabin_crew_academy","Cabin Crew & Ground Handling Academy","transport_aerospace","Flight safety, emergency, terminal training",161],
  ["atc_training_centre","Air Traffic Control Training Centre","transport_aerospace","Radar & airspace navigation",162],
  ["maritime_academy","Merchant Navy & Maritime Academy","transport_aerospace","Nautical science, marine engineering",163],
  ["commercial_driving_school","Commercial Driving & Fleet School","transport_aerospace","Heavy vehicle, defensive driving",164],
  ["logistics_institute","Logistics & Supply Chain Institute","transport_aerospace","Warehousing, routing, supply chain",165],

  // === 8. MEDICINE, HEALTHCARE & EMERGENCY CARE ===
  ["medical_college","Medical College & Fellowship Wing","healthcare","Clinical specialization, surgical residency",170],
  ["paramedical_institute","Paramedical Training Institute","healthcare","Lab tech, radiology, dialysis",171],
  ["nursing_college","Nursing College & Training School","healthcare","Patient care, triage, critical care",172],
  ["emt_centre","Emergency Medical Technician (EMT) Centre","healthcare","Field trauma & ambulance care",173],
  ["pharma_training_centre","Pharmaceutical Manufacturing Training Centre","healthcare","Sterile labs, drug formulation",174],

  // === 9. BUSINESS, MANAGEMENT & CORPORATE STRATEGY ===
  ["mdi","Management Development Institute (MDI)","business_management","Executive upskilling, leadership",180],
  ["corporate_university","Corporate University","business_management","In-house enterprise training ecosystems",181],
  ["bfsi_centre","Banking & Financial Services (BFSI) Centre","business_management","Risk, compliance, wealth management",182],
  ["sales_marketing_academy","Sales & Digital Marketing Academy","business_management","Customer acquisition, ad campaigns",183],
  ["soft_skills_centre","Soft Skills & Behavior Modification Centre","business_management","Public speaking, etiquette, leadership",184],

  // === 10. CREATIVE ARTS, MEDIA & ENTERTAINMENT ===
  ["film_tv_academy","Film, Television & Radio Academy","creative_arts","Cinematography, editing, broadcast",190],
  ["acting_drama_school","Acting, Drama & Theatre School","creative_arts","Voice, performance, stagecraft",191],
  ["fashion_design_institute","Fashion, Textile & Apparel Design Institute","creative_arts","Pattern making, garment tailoring",192],
  ["fine_arts_academy","Fine Arts & Sculpture Academy","creative_arts","Painting, drawing, sculpting",193],
  ["animation_vfx_institute","Animation, VFX & Gaming Institute","creative_arts","3D rendering, game physics",194],
  ["music_audio_school","Music, Audio Engineering & Production School","creative_arts","Sound mixing, acoustics, instruments",195],

  // === 11. HOSPITALITY, CULINARY & CONSUMER SERVICES ===
  ["culinary_academy","Culinary Academy & Pastry School","hospitality","Chef training, kitchen hierarchy",200],
  ["hotel_management_academy","Hotel & Resort Management Academy","hospitality","Front office, concierge, housekeeping",201],
  ["tourism_institute","Travel, Tourism & Guiding Institute","hospitality","Ticketing, tour routing, heritage guiding",202],
  ["beauty_cosmetology_academy","Beauty, Cosmetology & Hair Styling Academy","hospitality","Makeup, hair chemistry, salon business",203],

  // === 12. AGRICULTURE, WILDLIFE & ANIMAL SCIENCE ===
  ["agri_extension_centre","Agricultural Extension Centre","agriculture","Crop management, soil testing",210],
  ["veterinary_school","Veterinary & Animal Husbandry School","agriculture","Livestock, dairy, animal nursing",211],
  ["forestry_wildlife_institute","Forestry & Wildlife Conservation Institute","agriculture","Forest ranger, wildlife tracking",212],
  ["aquaculture_centre","Aquaculture & Fisheries Training Centre","agriculture","Hatchery, fish farming",213],

  // === 13. SPORTS, ATHLETICS, MARTIAL ARTS & FITNESS ===
  ["sports_academy","National Sports Academy","sports_fitness","Elite Olympic/professional athlete training",220],
  ["fitness_certification_institute","Fitness & Personal Trainer Certification Institute","sports_fitness","Kinesiology, nutrition, gym coaching",221],
  ["martial_arts_dojo","Traditional Martial Arts Dojo / Akhara","sports_fitness","Combat, weapon, self-defense",222],
  ["adventure_mountaineering_institute","Adventure & Mountaineering Institute","sports_fitness","Climbing, high-altitude rescue",223],

  // === 14. ACADEMIC, LANGUAGE & SPECIAL NEEDS ===
  ["coaching_competitive","Test Prep & Competitive Exam Centre","academic_language","JEE, NEET, UPSC, CAT prep",230],
  ["language_institute","Foreign Language Institute","academic_language","Language acquisition, translation cert",231],
  ["special_education_centre","Rehabilitation & Special Education Centre","academic_language","Neurodivergent, physically disabled learning",232],
  ["tuition_centre","Tuition Centre","academic_language","Small-group local tuition",233],
  ["online_edtech","Online EdTech Platform","academic_language","BYJU's, Unacademy, Vedantu",234],

  // === 15. ESOTERIC, SPIRITUAL & WELLNESS ===
  ["yoga_meditation_school","Yoga & Meditation Teacher Training School","spiritual_wellness","Asana, pranayama, mindfulness cert",240],
  ["theological_seminary","Theological Seminary","spiritual_wellness","Priesthood, scripture interpretation",241],
  ["monastic_training_centre","Monastic Training Centre","spiritual_wellness","Monastic lifestyle training",242],
  ["astrology_occult_institute","Astrology, Occult & Divination Institute","spiritual_wellness","Astronomical charting, vastu, numerology",243],

  // === 16. INDIC TRADITIONAL EDUCATION (added per Siddharth's explicit ask) ===
  ["gurukul","Gurukul","indic_traditional","Traditional Indian residential learning under guru",250],
  ["ashram_teaching","Ashram / Spiritual Teaching Centre","indic_traditional","Aurobindo, Ramakrishna Math, etc",251],
  ["ved_patashala","Ved Patashala","indic_traditional","Traditional Vedic studies",252],
  ["temple_teaching_centre","Temple Teaching Centre","indic_traditional","Run by temple/matha (Sringeri, Udupi)",253],
  ["matha","Matha / Peetham","indic_traditional","Monastic-educational (Dvaita, Advaita)",254],
  ["sanskrit_pathshala","Sanskrit Pathshala","indic_traditional","Sanskrit & shastra study",255],

  // === 17. FAITH-BASED (non-Indic) ===
  ["madrasa","Madrasa","faith_based","Islamic religious education",260],
  ["yeshiva","Yeshiva","faith_based","Jewish religious learning",261],
  ["monastery_school","Monastery School (Gompa)","faith_based","Buddhist/Tibetan monastic education",262],
  ["khanqah","Khanqah","faith_based","Sufi spiritual education",263],

  // === 18. RESEARCH / SPECIALIZED ===
  ["research_institute","Research Institute","research","Pure/applied research focus",270],
  ["national_laboratory","National Laboratory","research","CSIR, DRDO, ISRO labs",271],
  ["think_tank","Think Tank / Policy Institute","research","Public policy research",272],
  ["centre_of_excellence","Centre of Excellence","research","Specialized centre within institution",273],

  // === 19. PROFESSIONAL CERTIFICATION BODIES ===
  ["professional_body","Professional Body","professional","ICAI, ICMAI, ICSI, CFA, CIMA, ACCA",280],
  ["certification_authority","Certification Authority","professional","Issues professional certifications",281],

  // === SUB-UNITS (used with parent_institution_id) ===
  ["department","Academic Department","sub_unit","Department within a parent institution",900],
  ["programme","Academic Programme","sub_unit","Specific degree (B.Tech CSE, M.A. History)",901],
  ["branch","Branch / Campus","sub_unit","Branch of a coaching/training chain",902],
  ["centre","Specialized Centre","sub_unit","Centre within parent (Centre of Excellence etc)",903],

  // === CATCH-ALL ===
  ["other","Other","other","Use sparingly; suggest adding specific type instead",999]
];

let inserted = 0;
for (const [id, label, cat, desc, ord] of TYPES) {
  await sql`
    INSERT INTO hei_entity_types (id, label, category, description, sort_order, is_active)
    VALUES (${id}, ${label}, ${cat}, ${desc}, ${ord}, true)
  `;
  inserted++;
}
console.log("Seeded " + inserted + " entity types");

// Show category breakdown
const byCategory = await sql`SELECT category, COUNT(*)::int as n FROM hei_entity_types GROUP BY category ORDER BY MIN(sort_order)`;
console.log("\nBy category:");
for (const row of byCategory) {
  console.log("  " + row.category.padEnd(28) + ": " + row.n);
}
console.log("\nTotal: " + inserted);

await sql.end();

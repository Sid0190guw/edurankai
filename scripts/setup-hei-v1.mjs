import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== HEI v1.0 Migration ===\n");

// 1. Tag existing v0.4 data
await sql`
  ALTER TABLE hei_dimensions
  ADD COLUMN IF NOT EXISTS methodology_version varchar(10) NOT NULL DEFAULT 'v0.4'
`;
await sql`UPDATE hei_dimensions SET methodology_version = 'v0.4' WHERE methodology_version IS NULL OR methodology_version = ''`;
console.log("Tagged existing dimensions as v0.4");

await sql`
  ALTER TABLE hei_submetrics
  ADD COLUMN IF NOT EXISTS methodology_version varchar(10) NOT NULL DEFAULT 'v0.4'
`;
console.log("Tagged existing submetrics as v0.4");

// 2. v1.0 — 4 top-level metrics
await sql`
  CREATE TABLE IF NOT EXISTS hei_metrics (
    id varchar(50) PRIMARY KEY,
    sort_order integer NOT NULL DEFAULT 0,
    title varchar(200) NOT NULL,
    subtitle varchar(300),
    weight_percent numeric(4,1) NOT NULL DEFAULT 0,
    description text NOT NULL,
    blurb text,
    methodology_version varchar(10) NOT NULL DEFAULT 'v1.0',
    is_published boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("hei_metrics table ready");

// 3. v1.0 — aspects under each metric
await sql`
  CREATE TABLE IF NOT EXISTS hei_aspects (
    id varchar(80) PRIMARY KEY,
    metric_id varchar(50) NOT NULL REFERENCES hei_metrics(id) ON DELETE CASCADE,
    sort_order integer NOT NULL DEFAULT 0,
    title varchar(200) NOT NULL,
    sanskrit_root varchar(200),
    description text NOT NULL,
    sdg_links text,
    measurement_notes text,
    methodology_version varchar(10) NOT NULL DEFAULT 'v1.0',
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS hei_aspects_metric_idx ON hei_aspects(metric_id)`;
console.log("hei_aspects table ready");

// 4. Evidence pipelines
await sql`
  CREATE TABLE IF NOT EXISTS hei_pipelines (
    id varchar(10) PRIMARY KEY,
    sort_order integer NOT NULL DEFAULT 0,
    title varchar(200) NOT NULL,
    use_class varchar(50) NOT NULL,
    sources text NOT NULL,
    description text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("hei_pipelines table ready");

// 5. SDG ↔ Indic principle mapping
await sql`
  CREATE TABLE IF NOT EXISTS hei_sdg_indic_map (
    id serial PRIMARY KEY,
    sdg_number integer NOT NULL,
    sdg_name varchar(200) NOT NULL,
    indic_principle varchar(300) NOT NULL,
    sanskrit_phrase varchar(300),
    explanation text,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("hei_sdg_indic_map table ready");

// 6. Purusharthas (the 4 streams)
await sql`
  CREATE TABLE IF NOT EXISTS hei_purusharthas (
    id varchar(20) PRIMARY KEY,
    sort_order integer NOT NULL DEFAULT 0,
    title varchar(100) NOT NULL,
    transliteration varchar(100),
    description text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("hei_purusharthas table ready");

console.log("\n=== Seeding v1.0 content ===\n");

// === Seed 4 top-level metrics ===
const METRICS = [
  ['hdi', 10, 'Holistic Development Index (HDI)', 'What the institution does, daily', 30,
   'The foundation. Eight aspects of human development that the institution either trains daily or does not. Not a wellness elective added on top of academic study — academic study is itself one component of intellectual and skilful development within HDI.',
   'An institution either trains students to live this way daily, or it does not. The HDI measurement looks for daily living standards, not annual workshops.'],
  ['ri', 20, 'Research & Innovation (R&I)', 'What students do with the training', 20,
   'Active utilisation, application, building, inventing, and questioning that demonstrates the HDI training is real and productive. Not a separate competing dimension — it is what students naturally produce when they have been holistically developed.',
   'Field-normalised citation quality, research originality (NLP-detected novel concepts), student co-authorship rate, interdisciplinary reach, innovation translated to application, retraction rate as negative indicator.'],
  ['excellence', 30, 'Excellence', 'What graduates become, net of starting conditions', 30,
   'The proof that the training and its utilisation produced something real. Six aspects measured against what initial conditions would have predicted — institutions that transform possibility score higher than those that escort continuity.',
   'True educational excellence is svabhāva-fulfilment regardless of starting point. The framework measures it that way.'],
  ['wellbeing', 40, 'Student Wellbeing', 'The dharmic foundation — shared duty of three duty-bearers', 20,
   'Not a single wellness number. A trivarga of shared duty across Society (dāna), Government (right governance), Institution (faithful execution). When any of the three fails, wellbeing fails — and the student lives the consequence regardless of which leg of the table broke.',
   '14,488 student suicides in India in 2024 are not a wellness footnote. They are the failure mode of education that produces credentials without humans.']
];

for (const [id, ord, title, subtitle, weight, desc, blurb] of METRICS) {
  const exists = await sql`SELECT 1 FROM hei_metrics WHERE id = ${id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_metrics (id, sort_order, title, subtitle, weight_percent, description, blurb, methodology_version, is_published)
      VALUES (${id}, ${ord}, ${title}, ${subtitle}, ${weight}, ${desc}, ${blurb}, 'v1.0', true)
    `;
    console.log("  metric: " + title + " (" + weight + "%)");
  }
}

const metricSum = METRICS.reduce((s, m) => s + m[4], 0);
console.log("\nTotal weight: " + metricSum + "% " + (metricSum === 100 ? "OK" : "FAIL"));

// === Seed HDI's 8 aspects ===
const HDI_ASPECTS = [
  ['hdi_physical', 'hdi', 1, 'Physical', 'śaucam · tapas',
   'Daily institutional rhythms for body care: genuine physical education, food quality, sleep policy, sports infrastructure used by the median student. Absence of practices that wear the body down for the sake of ranking.',
   'SDG 3, SDG 6', 'Purity of body, discipline'],
  ['hdi_mental', 'hdi', 2, 'Mental', 'śama · jñānam · vijñānam',
   'Cognitive development: first-principles thinking, focus under pressure, learning agility, stress resilience. Distinguishes between exam-memorisation and genuine understanding.',
   'SDG 4', 'Mastery of mind, theoretical knowledge, realised understanding'],
  ['hdi_emotional', 'hdi', 3, 'Emotional', 'kṣānti · dama',
   'Self-awareness, emotional regulation, capacity to receive hard feedback without collapse and give it without cruelty. Aggregate verified-student survey signal — never named individual data.',
   'SDG 3, SDG 5', 'Patience, forgiveness, sense regulation'],
  ['hdi_social', 'hdi', 4, 'Social', 'ārjavam',
   'Collaboration, communication, trust-building, accountability. Equity of access and absence of discrimination — measured across caste, creed, gender, economic background, region, and ability.',
   'SDG 10, SDG 16, SDG 17', 'Integrity in word and action — the social organ of a healthy society'],
  ['hdi_spiritual', 'hdi', 5, 'Spiritual', 'āstikyam',
   'Whether the institution makes space for students to ask the foundational questions: what is the purpose of life, how does the world actually work, to what do I belong, what is worth doing. Not religious indoctrination — the capacity for serious inquiry.',
   '', 'Faith in higher reality. athāto brahma jijñāsā — the Vedānta-sūtra opening'],
  ['hdi_intellectual', 'hdi', 6, 'Intellectual', 'jñānam · svādhyāya',
   'Depth of conceptual reasoning, curiosity beyond the syllabus, academic and self-directed rigour. Research originality, not citation cartels. Innovation as a disposition expected of every student.',
   'SDG 4, SDG 9', 'Constant study'],
  ['hdi_skilful', 'hdi', 7, 'Skilful', 'vijñānam',
   'Translation of ideas into real, high-quality work. Technical mastery, domain expertise, precision, continuous skill-building. Measured via verified work products, internship outcomes, demonstrated capability — not self-reported confidence.',
   'SDG 8, SDG 9', 'Knowledge is incomplete without application'],
  ['hdi_character', 'hdi', 8, 'Character', 'ārjavam · tapas',
   'Integrity, accountability, courage to disagree, consistency between private and public self. Measured indirectly via ethical breach rates, governance transparency, response to whistle-blowing, alumni cohort behaviour in authority.',
   '', 'Character is what one does when no one is watching']
];

for (const [id, m, ord, title, root, desc, sdg, notes] of HDI_ASPECTS) {
  const exists = await sql`SELECT 1 FROM hei_aspects WHERE id = ${id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_aspects (id, metric_id, sort_order, title, sanskrit_root, description, sdg_links, measurement_notes, methodology_version)
      VALUES (${id}, ${m}, ${ord}, ${title}, ${root}, ${desc}, ${sdg}, ${notes}, 'v1.0')
    `;
    console.log("  HDI aspect: " + title);
  }
}

// === Seed Excellence's 6 aspects ===
const EXCELLENCE_ASPECTS = [
  ['exc_real_world', 'excellence', 9, 'Real-world capability', '',
   'Can graduates do what they were trained to do, under actual conditions? Verified alumni cohort outcomes at 1-year, 3-year, and 7-year horizons — not first-job placement statistics.',
   'SDG 8, SDG 9', 'Not first-job placement statistics (gameable)'],
  ['exc_mental_grounded', 'excellence', 10, 'Mental groundedness', '',
   'Do graduates emerge stable, or broken? Alumni wellbeing signal (aggregate, verified, never named), suicide and self-harm rates, mental-health treatment patterns, life-satisfaction trajectory over time.',
   'SDG 3', 'Aggregate signal only — never named individual data'],
  ['exc_svadharma', 'excellence', 11, 'Svadharma alignment', 'svabhāva-fulfilment',
   'Are graduates living the work that aligns with their natural nature, or trapped in roles chosen by parental anxiety or market signal? Sense of vocation alignment, meaningful work proportion, career correction patterns viewed as recovery rather than failure.',
   '', 'Career corrections are recovery, not failure'],
  ['exc_societal', 'excellence', 12, 'Societal contribution', 'lokasaṅgraha',
   'What do graduates build in the world? Alumni cohort activity mapped against the 17 UN SDG outcome categories. Excellence here means real impact, not prestige proxy.',
   'All 17 SDGs', 'Mapped against UN SDG outcome categories — real impact, not prestige proxy'],
  ['exc_ethical', 'excellence', 13, 'Ethical action under pressure', 'satya · dharma',
   'When there is money to be made by cutting corners, power to be gained by lying, comfort in staying silent — what do graduates do? Public-record cases of integrity (honoured and breached); aggregate cohort governance behaviour.',
   'SDG 16', 'Documented public-record cases only'],
  ['exc_continued_growth', 'excellence', 14, 'Continued growth', 'svādhyāya',
   'Did the institution produce people who keep learning after they leave, or people who never opened a book again? Verified continuing-education patterns, published work post-graduation, civic and intellectual engagement over time.',
   'SDG 4', 'Svādhyāya as a way of life, not a phase']
];

for (const [id, m, ord, title, root, desc, sdg, notes] of EXCELLENCE_ASPECTS) {
  const exists = await sql`SELECT 1 FROM hei_aspects WHERE id = ${id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_aspects (id, metric_id, sort_order, title, sanskrit_root, description, sdg_links, measurement_notes, methodology_version)
      VALUES (${id}, ${m}, ${ord}, ${title}, ${root}, ${desc}, ${sdg}, ${notes}, 'v1.0')
    `;
    console.log("  Excellence aspect: " + title);
  }
}

// === Seed R&I sub-components ===
const RI_ASPECTS = [
  ['ri_citation_quality', 'ri', 15, 'Field-normalised citation quality', '',
   'A breakthrough paper cited 50 times in chemistry is more significant than a derivative paper cited 500 times in computer science. Field-normalised, not raw count.',
   'SDG 9', 'OpenAlex with field normalisation'],
  ['ri_originality', 'ri', 16, 'Research originality', '',
   'NLP analysis of novel concept emergence — penalises derivative work. Detects salami-slicing, citation cartels, self-citation rings.',
   '', 'NLP-detected novel concept emergence'],
  ['ri_student_coauthor', 'ri', 17, 'Student co-authorship rate', '',
   'Does the institution involve students in real research, or is research a faculty-only activity?',
   'SDG 4', 'Student names on published research'],
  ['ri_interdisciplinary', 'ri', 18, 'Interdisciplinary reach', '',
   'Does work cross discipline boundaries, indicating actual creative thinking?',
   '', 'Cross-discipline citation graph analysis'],
  ['ri_innovation_applied', 'ri', 19, 'Innovation translated to application', '',
   'Patents, products, deployed solutions, civic interventions. Not research as performance, but research as building.',
   'SDG 9', 'WIPO + national patent offices + deployed-product evidence'],
  ['ri_retraction_rate', 'ri', 20, 'Retraction rate (negative indicator)', '',
   'Institutions with high retraction rates lose points proportional to retraction frequency. A known problem at rapidly-rising NIRF institutions.',
   '', 'Retraction Watch Database — negative scoring']
];

for (const [id, m, ord, title, root, desc, sdg, notes] of RI_ASPECTS) {
  const exists = await sql`SELECT 1 FROM hei_aspects WHERE id = ${id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_aspects (id, metric_id, sort_order, title, sanskrit_root, description, sdg_links, measurement_notes, methodology_version)
      VALUES (${id}, ${m}, ${ord}, ${title}, ${root}, ${desc}, ${sdg}, ${notes}, 'v1.0')
    `;
    console.log("  R&I aspect: " + title);
  }
}

// === Seed Wellbeing's 3 duty-bearers ===
const WELLBEING_ASPECTS = [
  ['wb_society', 'wellbeing', 21, 'Society duty', 'dāna',
   'What society owes: giving to educational institutions; supporting students from outside the institution\\u2019s walls; cultural climate that honours learning. Measured via aggregate donation patterns to the institution, community engagement with its students, cultural metrics of how learning is regarded in the institution\\u2019s region. Society\\u2019s failure does not exempt the institution, but it does explain part of the score and should be visible to readers.',
   'SDG 1, SDG 17', 'Visible to readers — explains part of the score'],
  ['wb_government', 'wellbeing', 22, 'Government duty', 'rāj-dharma',
   'What government owes: right governance of the flow from tax-collection to institutional execution. Identification and removal of corruption layers. Facilitation of teacher formation where qualified teachers do not yet exist. Per-student public funding actually reaching the institution; transparency of governance; punishment-as-reform of corruption when it appears. Government\\u2019s duty is duty, not ehsān — the citizen already paid through tax.',
   'SDG 16', 'Duty, not favour — citizen already paid through tax'],
  ['wb_institution', 'wellbeing', 23, 'Institution duty', 'sva-dharma',
   'What the institution owes: faithful execution. Right recruitment of teachers, daily training in all eight HDI aspects, honest reporting, accountability to students above all other constituencies. Recruitment quality (do hired teachers embody what they transmit?), execution rigour (does the daily life of the campus match the prospectus?), accountability response (when something goes wrong, what does the institution actually do?).',
   'SDG 4', 'Filters for embodiment over decoration — Upadeśāmṛta 1']
];

for (const [id, m, ord, title, root, desc, sdg, notes] of WELLBEING_ASPECTS) {
  const exists = await sql`SELECT 1 FROM hei_aspects WHERE id = ${id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_aspects (id, metric_id, sort_order, title, sanskrit_root, description, sdg_links, measurement_notes, methodology_version)
      VALUES (${id}, ${m}, ${ord}, ${title}, ${root}, ${desc}, ${sdg}, ${notes}, 'v1.0')
    `;
    console.log("  Wellbeing duty-bearer: " + title);
  }
}

// === Seed 7 evidence pipelines ===
const PIPELINES = [
  ['P1', 1, 'Public government data', 'direct_citation',
   'AISHE, IPEDS, HESA, NCRB ADSI, CAG audit reports, NIRF disclosures, equivalent national statistical sources',
   'Direct citation in published findings. Scheduled crawlers, daily to quarterly cadence.'],
  ['P2', 2, 'RTI & FOI filings', 'direct_citation',
   'Right-to-Information filings (India) + equivalent FOI mechanisms in other jurisdictions',
   'Slowest pipeline (30-90 day response) but highest evidentiary weight. Direct citation in findings.'],
  ['P3', 3, 'Verified student & alumni surveys', 'aggregate_only',
   'Custom forms on our own infrastructure with institutional-email OTP. Embedded WEMWBS, PERMA-23, WHO-5, NSSE-derived items',
   'Aggregate-only — never individual-named claims. Feeds dimension scores, not named institutional claims.'],
  ['P4', 4, 'Public alumni cohort analysis', 'outcome_metrics',
   'LinkedIn Marketing Solutions Insights API where available; structured cohort sampling',
   'Aggregate cohort statistics only. Never publishes individual profile data.'],
  ['P5', 5, 'Research integrity APIs', 'direct_citation',
   'OpenAlex citation graph, Retraction Watch Database, WIPO patent records, national patent office disclosures',
   'All open or properly licensed sources. Direct citation in findings.'],
  ['P6', 6, 'Monitored news (vātāvaraṇ)', 'investigation_lead',
   'Curated watchlist of 500-2000 news sources globally including Indian outlets and investigative journalism',
   'LLM-tagged for institution, dimension, severity. Drives investigation lead queue and right-of-reply windows. Never directly feeds scores.'],
  ['P7', 7, 'Social signal', 'investigation_lead',
   'Structured monitoring of Reddit, Quora and similar public forums for institution-tagged sentiment patterns',
   'Selection-bias corrected. Surfaces investigation priorities only — never quoted as direct evidence about named institutions.']
];

for (const [id, ord, title, useClass, sources, desc] of PIPELINES) {
  const exists = await sql`SELECT 1 FROM hei_pipelines WHERE id = ${id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_pipelines (id, sort_order, title, use_class, sources, description, is_active)
      VALUES (${id}, ${ord}, ${title}, ${useClass}, ${sources}, ${desc}, true)
    `;
    console.log("  pipeline: " + id + " " + title);
  }
}

// === Seed 4 purusharthas ===
const PURUSHARTHAS = [
  ['dharma', 1, 'Dharma', 'what holds the table up',
   'From the etymology dhāryate iti dharmaḥ — that which supports, that which makes standing possible. In student years, the foundation: how to live rightly. Through life, the discipline of every action.'],
  ['artha', 2, 'Artha', 'what is earned',
   'The student phase begins this earning — not only money or material resources but the qualities themselves: principles, discipline, capacity. The quality-earning begins in student life and continues through life.'],
  ['kama', 3, 'Kāma', 'desire, rightly directed',
   'Not denied, but rightly directed. Through life, the right fulfilment of desire — with the understanding that the self is one element among five in any action, never the sole author.'],
  ['moksha', 4, 'Mokṣa', 'the ultimate',
   'Trained alongside the other three, not deferred. Without lifelong mokṣa-training, the later āśramas arrive spiritually unprepared and the entire framework collapses.']
];

for (const [id, ord, title, tr, desc] of PURUSHARTHAS) {
  const exists = await sql`SELECT 1 FROM hei_purusharthas WHERE id = ${id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_purusharthas (id, sort_order, title, transliteration, description)
      VALUES (${id}, ${ord}, ${title}, ${tr}, ${desc})
    `;
    console.log("  puruṣārtha: " + title);
  }
}

// === Seed 17 SDG ↔ Indic principle mapping ===
const SDG_MAP = [
  [1, 'No Poverty', 'Dāna as a way of being', 'sarvabhūta-hite ratāḥ', 'Sharing what one has earned, rightly, with those who lack — built into daily life rather than relegated to fundraising events.'],
  [2, 'Zero Hunger', 'Annadāna — sacred giving of food', 'annaṁ paraṁ aushadham', 'Food as the foremost medicine; feeding others as foundational virtue. Anna-yajña in classical householder duty.'],
  [3, 'Good Health', 'Śaucam, dama, sama', 'śarīramādyaṁ khalu dharmasādhanam', 'Daily cleanliness, sense-regulation, mental calm — body as the foundation of dharma-practice.'],
  [4, 'Quality Education', 'Jñānam, vijñānam, svādhyāya', 'tat tvam asi', 'Knowledge and its realisation; lifelong study; the teacher who embodies what is taught.'],
  [5, 'Gender Equality', 'Ardhanārīśvara as principle', 'sa eṣa puruṣa eva strī', 'Equality as ontological fact — every human as embodied divinity. The divine is both, simultaneously.'],
  [6, 'Clean Water', 'Jala-śuddhi; reverence for rivers as mātṛs', 'āpaḥ pūṣṭiḥ', 'Water as living mother; rivers as ancestors; pollution of water as harm to ancestral lineage.'],
  [7, 'Affordable Clean Energy', 'Sustainable use without exploitation', 'na hi kalyāṇa-kṛt kaścid durgatiṁ tāta gacchati', 'Energy used in alignment with svadharma, not extracted from the earth without limit.'],
  [8, 'Decent Work', 'Dignity of all svadharma; karmaṇi kauśalam', 'yogaḥ karmasu kauśalam', 'The nurse, electrician, farmer, entrepreneur, teacher — each honoured as complete human doing necessary work.'],
  [9, 'Industry & Innovation', 'Vijñānam as right application', 'vijñānam ānando brahma', 'Innovation as fulfilment of knowledge, not novelty for its own sake.'],
  [10, 'Reduced Inequalities', 'Sarve bhavantu sukhinaḥ; dignity of all functional work', 'sarve bhavantu sukhinaḥ', 'May all beings be happy. Functional equality across all work that society needs.'],
  [11, 'Sustainable Cities', 'Vāstu and right urban dharma', 'śilpa-śāstra principles', 'Cities built in alignment with natural patterns; sustainable not as policy but as inherited wisdom.'],
  [12, 'Responsible Consumption', 'Aparigraha; minimal grasping', 'aparigraha', 'Non-grasping. Consumption only what is needed for one\\u2019s svadharma to be fulfilled.'],
  [13, 'Climate Action', 'Bhūmi is Mātā', 'mātā bhūmiḥ putro\\u2019haṁ pṛthivyāḥ', 'Earth as mother (Atharva Veda 12.1.12). Stewardship as filial duty — pollution as harm to one\\u2019s own mother.'],
  [14, 'Life Below Water', 'Reverence for jala-jīva; varuṇa-dharma', 'jalachara-dharma', 'Aquatic life as worthy of protection; oceans as Varuṇa\\u2019s realm requiring reverence.'],
  [15, 'Life on Land', 'Vana-rakṣaṇa; protection of forests, animals, soil', 'sarvabhūta-hita', 'All beings worthy of protection. Vanavāsa-tradition: time in forest as part of human development.'],
  [16, 'Peace, Justice, Strong Institutions', 'Dharma itself — that which holds the social table up', 'dharma eva hato hanti dharmo rakṣati rakṣitaḥ', 'Institutions that support standing, not extract value. Daṇḍa as reform of intent, not retribution.'],
  [17, 'Partnerships', 'Sangha; sanghaṭana; collective dharma-action', 'saha vīryaṁ karavāvahai', 'May we work together with vigour. Cooperative action for common dharma.']
];

for (const [num, name, principle, sanskrit, expl] of SDG_MAP) {
  const exists = await sql`SELECT 1 FROM hei_sdg_indic_map WHERE sdg_number = ${num}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_sdg_indic_map (sdg_number, sdg_name, indic_principle, sanskrit_phrase, explanation)
      VALUES (${num}, ${name}, ${principle}, ${sanskrit}, ${expl})
    `;
  }
}
console.log("Seeded 17 SDG ↔ Indic principle mappings");

console.log("\n=== Summary ===");
const mc = await sql`SELECT COUNT(*)::int as n FROM hei_metrics WHERE methodology_version = 'v1.0'`;
const ac = await sql`SELECT COUNT(*)::int as n FROM hei_aspects WHERE methodology_version = 'v1.0'`;
const pc = await sql`SELECT COUNT(*)::int as n FROM hei_pipelines`;
const sc = await sql`SELECT COUNT(*)::int as n FROM hei_sdg_indic_map`;
const puc = await sql`SELECT COUNT(*)::int as n FROM hei_purusharthas`;
const dc = await sql`SELECT COUNT(*)::int as n FROM hei_dimensions WHERE methodology_version = 'v0.4'`;
console.log("v0.4 dimensions:        " + dc[0].n);
console.log("v1.0 metrics:           " + mc[0].n);
console.log("v1.0 aspects:           " + ac[0].n);
console.log("Pipelines (P1-P7):      " + pc[0].n);
console.log("SDG ↔ Indic mapping:   " + sc[0].n);
console.log("Puruṣārthas:            " + puc[0].n);

await sql.end();

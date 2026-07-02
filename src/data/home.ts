// Single source of truth for the homepage (the stale home.js twin that used
// to shadow this file at import time is deleted — Vite resolves .js before
// .ts, so edits here never rendered while it existed).
export const HERO = {
  eyebrow: 'A frontier AI research lab',
  headline: 'Foundational models for',
  headlineEm: 'how humanity learns.',
  description: 'EduRankAI is a research lab building the next generation of reasoning systems — models that learn from principles, adapt across domains, and reason in ways closer to how humans actually do. Built in Bharat. Open to the world.'
};

export const MISSION = {
  eyebrow: 'The research',
  title: 'Intelligence, rebuilt from <em>first principles.</em>',
  body: [
    'Today\'s frontier models are extraordinary, but they learn in ways no human does. They memorise patterns over trillions of tokens. They reason without understanding. They scale, but they do not think.',
    'EduRankAI is building the next architectural leap — foundational models that reason from principles, learn from experience, and adapt across domains. Not bigger versions of what exists. A different kind of mind entirely.',
    'Our long-term thesis: superintelligence will not emerge from scaling alone. It will emerge from architectures that mirror how the most curious humans have always learned — by asking deeper questions than the answers in front of them.'
  ]
};

export const PILLARS = [
  {
    eyebrow: 'Research',
    title: 'Foundational Models',
    description: 'Reasoning-first architectures designed for the next decade of compute. The work that anchors everything else at EduRankAI.',
    href: '/research',
    cta: 'Read the thesis'
  },
  {
    eyebrow: 'Applied AI',
    title: 'Holistic Education Index',
    description: 'A new way to rank universities. Grounded in education research, not citation cartels. Currently in academic advisory review.',
    href: '/ecosystem/hei',
    cta: 'See the methodology'
  },
  {
    eyebrow: 'Careers',
    title: 'Open roles',
    description: 'We are hiring across every level, from senior leadership to research interns. Remote-first. Every application read personally.',
    href: '/careers',
    cta: 'View open roles'
  }
];

export const PRODUCTS = [
  {
    name: 'AquinTutor',
    status: 'Live',
    statusVariant: 'launch',
    href: '/aquintutor',
    external: false,
    description: 'A virtual institution by EduRankAI - personalised AI tutoring, gamified assessments, verifiable credentials. Six schools across computing, mathematics, the liberal arts, business, design, and a foundational core. Free where possible.'
  },
  {
    name: 'Akasha-Q',
    status: 'Live',
    statusVariant: 'launch',
    href: '/products/akasha-q',
    external: false,
    description: 'Quantum-secure command, control & communications backbone for the Viśvambhara autonomous swarm. Frontier research project. Limited public preview.'
  },
  {
    name: 'Viśvambhara',
    status: 'Live',
    statusVariant: 'launch',
    href: '/products/visvambhara',
    external: false,
    description: 'VESPER autonomous aerospace swarm — Bee micro-UAV, Mother SSTO, Grandmother interplanetary command vessel. Restricted-access programme.'
  },
  {
    name: 'Workspace',
    status: 'Live',
    statusVariant: 'launch',
    href: '/portal/workspace',
    external: false,
    description: '14 in-house tools: mail, chat, CRM, notes, IDE, notebook, canvas, animation studio, resume builder, flashcards, tasks, calendar, network, live class. One sign-on. One inbox.'
  },
  {
    name: 'Animation Studio',
    status: 'Live',
    statusVariant: 'launch',
    href: '/aquintutor/labs/animator',
    external: false,
    description: 'Real-time high-quality animation generator. 16 scenes — fractals, attractors, particle fields, fluid dynamics, Turing patterns, 3D geometry. Record to video, save frames. Pure browser.'
  },
  {
    name: 'Student Feed',
    status: 'Live',
    statusVariant: 'launch',
    href: '/portal/feed',
    external: false,
    description: 'Long-form clips + short-form reels + AR/XR filters. Engagement-shaped recommendations capped at 90 min daily watch time. Educational integrity built in.'
  },
  {
    name: 'ATLAS Proctoring',
    status: 'Live',
    statusVariant: 'launch',
    href: '/products/atlas-proctoring',
    external: false,
    description: 'Honorlock-class proctoring as a service. 28+ event types, 14 KB JS SDK, REST API. Used by EduRankAI\'s own tests; available to any LMS or hiring tool.'
  },
  {
    name: 'Sambandh',
    status: 'Early Build',
    statusVariant: 'planning',
    href: '/ecosystem/sambandh',
    external: false,
    description: 'India’s only dating platform where every profile is verified by government ID and every profession is cross-checked — no fake doctors, no fake engineers, no catfish. Open intent, anonymous-first chat, and a reputation score shaped by real behaviour.'
  },
  {
    name: 'Sancharan',
    status: 'Early Build',
    statusVariant: 'planning',
    href: '/ecosystem/sancharan',
    external: false,
    description: 'Journeys, reimagined. A consumer travel venture being built carefully in India for every kind of journey that matters — weekend trips, family vacations, pilgrimages, heritage circuits, educational tours, corporate offsites. No dark patterns, hidden fees, or fake urgency.'
  },
  {
    name: 'Sampark',
    status: 'Early Build',
    statusVariant: 'planning',
    href: '/ecosystem/sampark',
    external: false,
    description: 'A modern CRM and communication platform — every customer conversation, contact, and transaction in a single encrypted workspace. Lead-capture forms, instant messaging, video calls, pipeline, and integrated payments, without leaving the app.'
  },
  {
    name: 'Foundational Models',
    status: 'Research',
    statusVariant: 'research',
    href: '/ecosystem/foundational-models',
    external: false,
    description: 'Proprietary educational intelligence models being built in-house - ASI-oriented, reasoning-first, designed for the quantum era. Our most ambitious long-term investment, anchoring everything we build.'
  },
  {
    name: 'karate.support',
    status: 'Launching 30 May',
    statusVariant: 'launch',
    href: 'https://www.karate.support',
    external: true,
    description: 'A complete platform for the global karate community - instructor discovery, dojo management, training resources, certification tracking, and tournament infrastructure. Pre-launched now, full release with iOS and Android apps on 30 May 2026.'
  }
];

// src/lib/aquin-brain.ts — the Aquin assistant's DETERMINISTIC brain. It makes the
// assistant genuinely useful with NO LLM: real retrieval over the platform's actual
// tools/routes + rule-based Socratic coaching (method + one hint, never the final
// answer). This is honest intelligence — retrieval + rules, not a language model —
// so the assistant WORKS today instead of showing "coming online". When the LLM is
// switched on it takes over; when it isn't, this answers.

export interface BrainReply { text: string; source: 'kb' | 'coach' | 'fallback'; matched?: string }

// --- platform knowledge base: real tools + real routes ---
interface KBEntry { keys: string[]; answer: string }
const KB: KBEntry[] = [
  { keys: ['virtual lab', 'labs', 'lab', 'simulation', 'experiment', 'practical'],
    answer: 'The Virtual Labs are hands-on, in-browser simulations — you build and run the real thing, not watch a video. Flagships include transformer self-attention, RSA and secp256k1 cryptanalysis, a pipelined RISC CPU, a variational quantum eigensolver, a z-plane filter designer and a PID control lab. Open them at /aquintutor/labs.' },
  { keys: ['stage', 'stages', 'age', 'grade', 'pre-kg', 'phd', 'tots', 'level'],
    answer: 'AquinTutor follows one learner across eight stages: Tots, Primary, Sub-Juniors, Juniors, Scholars, Tutor (undergraduate), Research (postgraduate) and Atelier (vocational) — pre-KG all the way to PhD and into working life. Set your path at /aquintutor/onboarding.' },
  { keys: ['homework', 'helper', 'tutor', 'stuck', 'coach', 'ask aquin', 'ai tutor'],
    answer: 'The Homework Helper coaches you to the answer with questions and hints — it never hands over the solution to something you are meant to solve, because a skill has to be proven, not watched. Open it at /aquintutor/ai-tutor.' },
  { keys: ['knowledge map', 'knowledge graph', 'concept map', 'dependency', 'unlock'],
    answer: 'The Knowledge Graph shows every concept as a dependency map: a topic stays locked until you master what it is built on, and mastering it lights up everything downstream — so you always see why a concept matters. It even builds you a shortest study plan. See it at /aquintutor/knowledge-graph.' },
  { keys: ['recall', 'spaced', 'repetition', 'revise', 'revision', 'forget', 'remember'],
    answer: 'Recall is spaced repetition: it brings a concept back just before you would forget it, so it moves into long-term memory. It schedules reviews from how well you actually recalled each item.' },
  { keys: ['backlog', 'behind', 'catch up', 'gaps', 'recovery'],
    answer: 'Backlog Recovery finds the specific prerequisite gaps that are holding you back and rebuilds them in order, so you are not stuck guessing what to revise.' },
  { keys: ['practice', 'questions', 'quiz', 'problems', 'adaptive test', 'mock'],
    answer: 'Practice is adaptive: each question is chosen from how you are doing, it measures your ability and per-concept mastery, and it tells you the misconception behind a mistake and what to learn next. Start at /aquintutor/practice.' },
  { keys: ['credential', 'certificate', 'verify', 'proof', 'verified'],
    answer: 'The Credential path issues verifiable credentials tied to skills you have actually proven — verified learning, not attendance. Follow it at /aquintutor/credential-path.' },
  { keys: ['research', 'postgraduate', 'phd', 'paper', 'thesis'],
    answer: 'The Research desk supports postgraduate work — literature, hypotheses, reproducible experiments — while keeping you as the author; it assists discovery, it never declares results for you.' },
  { keys: ['apply', 'admission', 'join', 'enroll', 'sign up', 'register'],
    answer: 'You can apply and set up your identity from Admissions — Apply at /aquintutor/apply, or sign in at /aquintutor/login.' },
  { keys: ['what is', 'about', 'how does', 'how it works', 'aquintutor', 'platform', 'overview'],
    answer: 'AquinTutor is a verified-learning institution that follows one learner from pre-KG to PhD and into vocational life. Instead of watching content, you prove skills: adaptive practice measures real mastery, the knowledge graph sequences what to learn, and every credential is earned. Ask me about the Virtual Labs, the Knowledge Graph, Practice, or tell me a concept you are stuck on.' },
];

// concept-level Socratic hints (method + first step, never the answer)
interface Hint { keys: string[]; method: string }
const HINTS: Hint[] = [
  { keys: ['newton', 'force', 'f=ma', 'acceleration', 'mass'], method: 'Newton\'s second law: net force = mass x acceleration. Write down what you are given and what you are solving for, then rearrange F = ma for that unknown. What do you get for the first step?' },
  { keys: ['fraction', 'numerator', 'denominator'], method: 'To add fractions you need a common denominator first. What is the lowest common denominator of the two you have — and what does each fraction become once you rewrite it over that?' },
  { keys: ['quadratic', 'x^2', 'x²', 'roots', 'factor'], method: 'For a quadratic, first get it into the form ax² + bx + c = 0. Can it be factored, or should you use the quadratic formula? Start by identifying a, b and c.' },
  { keys: ['derivative', 'differentiate', 'slope', 'rate of change'], method: 'A derivative is a rate of change. Which rule applies here — power, product, chain? Identify the outer and inner parts first; what is the derivative of just the outer function?' },
  { keys: ['velocity', 'speed', 'distance', 'kinematics', 'projectile'], method: 'Separate what is constant from what changes. Which kinematic equation links the quantities you have with the one you want? Write down u, v, a, t and s first — which is unknown?' },
  { keys: ['energy', 'work', 'joule', 'kinetic', 'potential'], method: 'Work = force x distance moved in the force\'s direction; kinetic energy = ½mv². Which form of energy is changing here, and what stays conserved? Set up the energy balance first.' },
];

const SOLVE_INTENT = /\b(solve|calculate|evaluate|compute|find|how (?:much|many)|what is the (?:answer|value)|prove|derive|simplify|factor)\b/i;

function lastUser(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}
function scoreKeys(text: string, keys: string[]): number {
  let s = 0; for (const k of keys) if (text.includes(k)) s += k.length; // longer keyword match = stronger
  return s;
}

export function aquinReply(messages: Array<{ role: string; content: string }>): BrainReply {
  const raw = lastUser(messages);
  const t = raw.toLowerCase();
  if (!t.trim()) return { text: 'Ask me how anything on AquinTutor works, or tell me a concept you are stuck on and I will coach you to it.', source: 'fallback' };

  // 1) is this a problem the learner wants solved? -> Socratic coaching (never the answer)
  const looksGraded = SOLVE_INTENT.test(t) && (/\d/.test(t) || t.length > 24);
  if (looksGraded) {
    let best: Hint | null = null, bestScore = 0;
    for (const h of HINTS) { const sc = scoreKeys(t, h.keys); if (sc > bestScore) { bestScore = sc; best = h; } }
    if (best) return { text: best.method + ' (I will coach you step by step — I will not just give the final answer.)', source: 'coach', matched: best.keys[0] };
    return { text: 'Let\'s work it through, not around. What is the core principle or formula this problem is testing? Write down what you know and what you are solving for — then tell me your first step and I will check it.', source: 'coach' };
  }

  // 2) platform question -> best knowledge-base answer (real retrieval)
  let bestKB: KBEntry | null = null, bestKBScore = 0;
  for (const e of KB) { const sc = scoreKeys(t, e.keys); if (sc > bestKBScore) { bestKBScore = sc; bestKB = e; } }
  if (bestKB && bestKBScore > 0) return { text: bestKB.answer, source: 'kb', matched: bestKB.keys[0] };

  // 3) graceful fallback
  return { text: 'I can help two ways: explain how AquinTutor works — the Virtual Labs, the Knowledge Graph, adaptive Practice, Recall, the Credential path — or coach you on a concept you are stuck on. Which would you like? You can also just paste a problem and I will guide you through it.', source: 'fallback' };
}

// src/lib/ask-aquin.test.ts — run: npx tsx src/lib/ask-aquin.test.ts
// "Ask Aquin" grounding + scoping (pure): the prompt is grounded in the current KO; exam-secure
// grounding is excluded and refusal is instructed; the student's language is honored. (Streaming,
// per-session logging, and can()-based access-scoping are enforced in the API route.)
import { buildSystemPrompt, filterGrounding, type GroundingUnit } from './ask-aquin';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const current: GroundingUnit = { id: 'ko1', title: 'Limits', body: 'A limit describes the value a function approaches. The squeeze theorem bounds it.', equations: [{ latex: '\\lim_{x\\to 0} \\frac{\\sin x}{x} = 1' }], securityLabels: ['public'] };

console.log('\n== the prompt is grounded in the CURRENT KnowledgeObject ==');
const p = buildSystemPrompt({ current, courseTitle: 'Calculus I', prereqTitles: ['Functions'], language: 'en', studentName: 'Asha' });
ok('includes the KO title', p.includes('# Limits'));
ok('includes the KO body (grounding)', p.includes('squeeze theorem'), p.slice(0, 200));
ok('includes the KO equation', p.includes('\\lim_'));
ok('names the course + prerequisite', p.includes('Calculus I') && p.includes('Functions'));

console.log('\n== a question probing exam-secure material is refused / never grounded ==');
const neighbors: GroundingUnit[] = [
  { id: 'k2', title: 'Practice set', body: 'public practice', securityLabels: ['public'] },
  { id: 'k3', title: 'Final exam key', body: 'SECRET ANSWER KEY: 42', securityLabels: ['exam-secure'] },
];
const safe = filterGrounding(neighbors);
ok('exam-secure unit is dropped from grounding', safe.length === 1 && safe[0].id === 'k2', safe.map((s) => s.id));
ok('the secret answer key text is never in the grounding', !safe.some((s) => (s.body || '').includes('SECRET ANSWER KEY')));
ok('the prompt instructs refusal of exam-secure / answer keys', /never reveal|decline/i.test(p) && /exam-secure|answer key/i.test(p));

console.log('\n== the student\'s language is honored ==');
const hi = buildSystemPrompt({ current, language: 'hi' });
ok('prompt tells the model to answer in the set language', hi.includes("Answer in the student's language: hi"));
const en = buildSystemPrompt({ current });
ok('defaults to en when unset', en.includes("language: en"));

console.log('\n== honesty: no invented facts ==');
ok('prompt forbids inventing facts/citations', /do not.*invent|invent.*facts|invent.*citations/i.test(p));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

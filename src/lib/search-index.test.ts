// src/lib/search-index.test.ts — run: npx tsx src/lib/search-index.test.ts
// Search & Discovery (pure): relevance ranks title matches above body matches and excludes
// non-matching docs; exam-secure content NEVER surfaces; enrolled-only needs enrolment; a doc
// added to the index (post-reindex) becomes findable. (The DB reindex/search wire this up.)
import { rankResults, isDiscoverable, tokenize, type IndexDoc } from './search-index';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const docs: IndexDoc[] = [
  { id: 'a', type: 'CourseObject', title: 'Calculus Foundations', body: 'limits and derivatives', labels: ['public'] },
  { id: 'b', type: 'KnowledgeObject', title: 'Chemistry Basics', body: 'a note about calculus in kinetics', labels: ['public'] },
  { id: 'c', type: 'KnowledgeObject', title: 'History of Art', body: 'renaissance', labels: ['public'] },
];

console.log('\n== relevance ranking ==');
const r = rankResults('calculus', docs);
ok('a title match outranks a body match', r[0].id === 'a' && r[1].id === 'b', r.map((d) => d.id));
ok('non-matching docs are excluded', !r.some((d) => d.id === 'c'), r.map((d) => d.id));
ok('empty query keeps browse order (all docs)', rankResults('', docs).length === 3);
ok('tokenizer drops punctuation + short tokens', JSON.stringify(tokenize('A, calc-101!')) === JSON.stringify(['calc', '101']));

console.log('\n== exam-secure never surfaces; enrolled-only needs access ==');
ok('public is discoverable to anyone', isDiscoverable(['public'], { canEnrolled: false }) === true);
ok('exam-secure is NEVER discoverable, even when enrolled', isDiscoverable(['exam-secure'], { canEnrolled: true }) === false);
ok('enrolled-only hidden from non-enrolled', isDiscoverable(['enrolled-only'], { canEnrolled: false }) === false);
ok('enrolled-only visible to enrolled', isDiscoverable(['enrolled-only'], { canEnrolled: true }) === true);

console.log('\n== a newly published KO becomes findable after (re)indexing ==');
const before = rankResults('thermodynamics', docs);
ok('not findable before it is indexed', before.length === 0);
const after = rankResults('thermodynamics', docs.concat([{ id: 'd', type: 'KnowledgeObject', title: 'Thermodynamics', body: 'entropy', labels: ['public'] }]));
ok('findable once present in the index', after.length === 1 && after[0].id === 'd');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

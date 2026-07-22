// src/lib/knowledge-acquisition/knowledge-acquisition.test.ts
// run: npx tsx src/lib/knowledge-acquisition/knowledge-acquisition.test.ts
// Self-contained (no DB/LLM): the pure source-trust stages + the extraction/provenance schemas.
import {
  scoreSource, recencyScore, filterSources, defaultFilterPolicy, crossVerify, domainFamily,
  ExtractionSchema, ProvenanceSchema, type SourceRecord, type ScoredSource, type Claim,
} from './index';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };
const NOW = new Date('2026-07-20T00:00:00Z');

const src = (over: Partial<SourceRecord>): SourceRecord => ({
  url: 'https://x/y', domain: 'x', sourceType: 'unknown', fetchedAt: NOW.toISOString(),
  hasAuthor: false, https: true, excerpt: 'e', ...over,
});

function main() {
  console.log('\n== scoreSource ==');
  const strong = scoreSource(src({ sourceType: 'peer_reviewed', domainTier: 1, publishedAt: '2026-07-01', hasAuthor: true, citationCount: 100, https: true }), 'physics', NOW);
  ok('fresh peer-reviewed tier-1 with citations -> ~1.0', strong > 0.95, +strong.toFixed(3));
  const weak = scoreSource(src({ sourceType: 'blog', domainTier: 4, publishedAt: '2004-01-01', hasAuthor: false, https: false }), 'default', NOW);
  ok('old plain-HTTP blog -> low (< 0.55)', weak < 0.55, +weak.toFixed(3));
  ok('plain HTTP is discounted vs https', scoreSource(src({ sourceType: 'edu', https: false }), 'default', NOW) < scoreSource(src({ sourceType: 'edu', https: true }), 'default', NOW));

  console.log('\n== recency decay ==');
  ok('unknown date -> neutral 0.5', recencyScore(undefined, 'physics', NOW) === 0.5);
  ok('one half-life old -> ~0.5', Math.abs(recencyScore('2001-07-20', 'physics', NOW) - 0.5) < 0.02, +recencyScore('2001-07-20', 'physics', NOW).toFixed(3));
  ok('fresh -> ~1.0', recencyScore('2026-07-19', 'physics', NOW) > 0.99);
  ok('domainFamily maps unknown -> default', domainFamily('astro-turf') === 'default' && domainFamily('Physics') === 'physics');

  console.log('\n== filterSources ==');
  const scored: ScoredSource[] = [
    { ...src({ domain: 'nist.gov' }), reliability: 0.90 },
    { ...src({ domain: 'wikipedia.org' }), reliability: 0.70 },
    { ...src({ domain: 'blog.com' }), reliability: 0.30 },
    { ...src({ domain: 'bad.com' }), reliability: 0.95 },
  ];
  const kept = filterSources(scored, defaultFilterPolicy({
    allowDomains: new Set(['nist.gov', 'wikipedia.org', 'bad.com']),
    denyDomains: new Set(['bad.com']),
  }));
  ok('deny wins even at high reliability', !kept.some((s) => s.domain === 'bad.com'));
  ok('below-threshold + off-allowlist dropped; best-first', kept.map((s) => s.domain).join(',') === 'nist.gov,wikipedia.org', kept.map((s) => s.domain));

  console.log('\n== crossVerify ==');
  const vSources: ScoredSource[] = [
    { ...src({ domain: 'nist.gov' }), reliability: 0.9 },
    { ...src({ domain: 'wikipedia.org' }), reliability: 0.8 },
    { ...src({ domain: 'nist.gov' }), reliability: 0.7 },
  ];
  const claims: Claim[] = [
    { text: 'two distinct trusted domains', supportIdx: [0, 1] },   // corroborated
    { text: 'same domain twice', supportIdx: [0, 2] },              // NOT corroborated (1 domain)
  ];
  const ver = crossVerify(claims, vSources);
  ok('claim across 2 distinct domains corroborates', ver.claims[0].corroborated === true && ver.claims[0].independentDomains === 2);
  ok('claim within one domain does not corroborate', ver.claims[1].corroborated === false && ver.claims[1].independentDomains === 1);
  ok('consensusScore is the corroborated fraction', ver.consensusScore === 0.5 && ver.passed === true, ver.consensusScore);
  ok('all-uncorroborated -> not passed', crossVerify([{ text: 'x', supportIdx: [0] }], vSources).passed === false);
  ok('out-of-range supportIdx is ignored safely', crossVerify([{ text: 'x', supportIdx: [99] }], vSources).claims[0].independentDomains === 0);

  console.log('\n== extraction + provenance schemas ==');
  const goodEx = { subject: 'physics', domain: 'physics', concept: { name: 'Bernoulli', description: 'd' }, explanation: { body: 'b' }, claims: [{ text: 'c', supportIdx: [0] }] };
  ok('valid extraction parses', ExtractionSchema.safeParse(goodEx).success);
  ok('empty claims rejected', !ExtractionSchema.safeParse({ ...goodEx, claims: [] }).success);
  ok('claim without supportIdx rejected', !ExtractionSchema.safeParse({ ...goodEx, claims: [{ text: 'c', supportIdx: [] }] }).success);
  const prov = { runId: '11111111-1111-4111-8111-111111111111', query: 'q', subject: 's', domain: 'physics', model: 'm', consensusScore: 0.7, sources: [{ url: 'https://nist.gov/a', domain: 'nist.gov', reliability: 0.9 }], extractedAt: NOW.toISOString(), pending: true };
  ok('valid provenance parses', ProvenanceSchema.safeParse(prov).success);
  ok('provenance consensusScore > 1 rejected', !ProvenanceSchema.safeParse({ ...prov, consensusScore: 1.5 }).success);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();

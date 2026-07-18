// src/lib/credential.test.ts — run: npx tsx src/lib/credential.test.ts
// Verifiable credentials (pure): signatures are reproducible; a tampered field fails verification;
// eligibility requires passing ALL required assessments. (Issue/revoke authorization + the public
// no-auth verify route are exercised at the API/page level.)
import { signCredential, verifyCredential, meetsEligibility, newCode, type CredentialFields } from './credential';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

const f: CredentialFields = { code: 'ABCD-EFGH-JKLM', userId: 'u1', courseObjId: 'c1', holderName: 'Asha Rao', courseTitle: 'Calculus I', competencies: ['Limits', 'Derivatives'], issuedAt: '2026-07-18T00:00:00.000Z' };
const secret = 'test-secret';

console.log('\n== signatures are reproducible + tamper-evident ==');
const sig = signCredential(f, secret);
ok('signing is deterministic', signCredential(f, secret) === sig);
ok('correct fields verify', verifyCredential(f, sig, secret) === true);
ok('a tampered holder name FAILS verification', verifyCredential({ ...f, holderName: 'Someone Else' }, sig, secret) === false);
ok('a tampered course FAILS', verifyCredential({ ...f, courseTitle: 'Physics' }, sig, secret) === false);
ok('a tampered competency list FAILS', verifyCredential({ ...f, competencies: ['Limits', 'Integrals'] }, sig, secret) === false);
ok('a wrong secret FAILS (forgery resistant)', verifyCredential(f, sig, 'other-secret') === false);
ok('a garbage signature FAILS, no throw', verifyCredential(f, 'deadbeef', secret) === false);

console.log('\n== eligibility: must pass ALL required assessments ==');
ok('all required passed -> eligible', meetsEligibility(['a1', 'a2'], ['a1', 'a2', 'a3']) === true);
ok('one required missing -> NOT eligible', meetsEligibility(['a1', 'a2'], ['a1']) === false);
ok('no required assessments -> NOT eligible (nothing to certify)', meetsEligibility([], ['a1']) === false);

console.log('\n== public codes are well-formed ==');
ok('code matches XXXX-XXXX-XXXX with unambiguous chars', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(newCode()));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

// src/lib/hr-onboarding.test.ts — run: npx tsx src/lib/hr-onboarding.test.ts
// New-hire credential rules (pure): only Google Drive links in the agreed access format are accepted,
// the 5-document cap is real, rejection reasons are human, and progress reflects HR review.
import { isDriveLink, linkProblem, MAX_DOCS, DOC_TYPES, docTypeLabel, progress, ACCESS_FORMAT, type OnboardingDoc } from './hr-onboarding';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== only Google Drive links are accepted ==');
ok('a Drive file link is accepted', isDriveLink('https://drive.google.com/file/d/1AbCdEf/view?usp=sharing'));
ok('a Google Docs link is accepted', isDriveLink('https://docs.google.com/document/d/1AbCdEf/edit'));
ok('Dropbox / OneDrive are rejected', !isDriveLink('https://dropbox.com/s/abc/file.pdf') && !isDriveLink('https://onedrive.live.com/x'));
ok('a bare filename is rejected', !isDriveLink('degree.pdf'));
ok('http (not https) is rejected', !isDriveLink('http://drive.google.com/file/d/1/view'));

console.log('\n== rejection reasons are human, never a bare "invalid" ==');
ok('empty -> asks for the link', /paste the google drive link/i.test(linkProblem('') || ''));
ok('non-https -> explains', /https/i.test(linkProblem('drive.google.com/file/d/1') || ''));
ok('wrong provider -> names Google Drive', /google drive/i.test(linkProblem('https://dropbox.com/s/a') || ''));
ok('a good link has no problem', linkProblem('https://drive.google.com/file/d/1AbC/view') === null);

console.log('\n== the cap and the document types ==');
ok('cap is 5 documents', MAX_DOCS === 5);
ok('degree, marksheet and certification are offered', ['degree', 'marksheet', 'certification'].every((k) => DOC_TYPES.some((d) => d.key === k)));
ok('a type renders a human label', docTypeLabel('marksheet') === 'Mark sheets' && docTypeLabel('degree') === 'Degree certificate');
ok('the required access format is stated', /anyone with the link/i.test(ACCESS_FORMAT) && /viewer/i.test(ACCESS_FORMAT));

console.log('\n== progress reflects HR review ==');
const d = (id: number, status: any): OnboardingDoc => ({ id, userId: 'u', docType: 'degree', title: 't', driveUrl: 'https://drive.google.com/x', status, reviewNote: null, createdAt: '' });
ok('nothing submitted -> not complete', progress([]).complete === false);
ok('all verified -> complete', progress([d(1, 'verified'), d(2, 'verified')]).complete === true);
ok('one rejected -> NOT complete', progress([d(1, 'verified'), d(2, 'rejected')]).complete === false);
ok('still under review -> not complete', progress([d(1, 'verified'), d(2, 'submitted')]).complete === false);
ok('counts are reported', (() => { const p = progress([d(1, 'verified'), d(2, 'rejected'), d(3, 'submitted')]); return p.submitted === 3 && p.verified === 1 && p.rejected === 1; })());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

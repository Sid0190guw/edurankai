// src/lib/edu-community.test.ts — run: npx tsx src/lib/edu-community.test.ts
// Community (pure): a minor participates only with consent; removed posts vanish for students but
// moderators still see them; only the author can edit their own (un-removed) post.
import { canParticipate, filterVisible, canEditPost } from './edu-community';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { console.log((c ? '  ok  ' : 'FAIL  ') + n); c ? pass++ : fail++; };

console.log('\n== minor safety ==');
ok('adult always participates', canParticipate(false, false) === true);
ok('minor without community consent CANNOT participate', canParticipate(true, false) === false);
ok('minor with guardian consent can participate', canParticipate(true, true) === true);

console.log('\n== removed posts ==');
const posts = [{ id: 'p1', removed: false }, { id: 'p2', removed: true }];
ok('a student does NOT see a removed post', filterVisible(posts, false).length === 1 && filterVisible(posts, false)[0].id === 'p1');
ok('a moderator sees removed posts too', filterVisible(posts, true).length === 2);

console.log('\n== edit-own ==');
ok('author can edit their own post', canEditPost({ user_id: 'u1', removed: false }, 'u1') === true);
ok('a non-author cannot edit', canEditPost({ user_id: 'u1', removed: false }, 'u2') === false);
ok('nobody edits a removed post', canEditPost({ user_id: 'u1', removed: true }, 'u1') === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

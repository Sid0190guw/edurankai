// src/lib/security/security.test.ts — run: npx tsx src/lib/security/security.test.ts
// Self-contained (no DB): the four pure threat detectors over synthetic rows.
import {
  detectLoginBursts, detectPrivilegeEscalation, detectSessionFanout, detectImpossibleTravel,
  type AuditRow, type RbacAuditRow, type SessionRow,
} from './detectors';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };
const NOW = new Date('2026-07-20T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

function main() {
  console.log('\n== login bursts (15-min window, >=5) ==');
  const failed = (n: number, min: number, userId: string | null, ip: string | null): AuditRow[] =>
    Array.from({ length: n }, () => ({ userId, action: 'login.failed', entity: 'auth', ipAddress: ip, createdAt: ago(min) }));
  const burst = detectLoginBursts([...failed(6, 5, 'u1', '1.1.1.1'), ...failed(2, 5, 'u2', '2.2.2.2')], NOW);
  ok('>=5 failures flags one burst; <5 does not', burst.length === 1 && burst[0].subjectUserId === 'u1' && burst[0].score === 6);
  ok('severity scales with count', detectLoginBursts(failed(12, 5, 'u3', null), NOW)[0].severity === 'medium' && detectLoginBursts(failed(25, 5, 'u3', null), NOW)[0].severity === 'high');
  ok('failures outside the 15-min window are ignored', detectLoginBursts(failed(10, 30, 'u4', null), NOW).length === 0);
  ok('non-failure actions are ignored', detectLoginBursts(Array.from({ length: 8 }, () => ({ userId: 'u5', action: 'login.success', entity: 'auth', ipAddress: null, createdAt: ago(2) })), NOW).length === 0);

  console.log('\n== privilege escalation (denied administer/manage/delete, >=3) ==');
  const denied = (n: number, cap: string, userId: string): RbacAuditRow[] =>
    Array.from({ length: n }, () => ({ userId, capability: cap, allow: false, reason: 'no grant', at: ago(10) }));
  ok('>=3 denied administer flags escalation', detectPrivilegeEscalation(denied(4, 'administer', 'u1'), NOW).length === 1);
  ok('allowed decisions never flag', detectPrivilegeEscalation(Array.from({ length: 5 }, () => ({ userId: 'u2', capability: 'manage', allow: true, reason: 'ok', at: ago(5) })), NOW).length === 0);
  ok('non-privileged denied caps ignored', detectPrivilegeEscalation(denied(5, 'read', 'u3'), NOW).length === 0);
  ok('escalation severity high at >=8', detectPrivilegeEscalation(denied(9, 'delete', 'u4'), NOW)[0].severity === 'high');

  console.log('\n== session fanout (>=4 distinct IPs, 60-min) ==');
  const sess = (userId: string, ips: string[], min = 10): SessionRow[] => ips.map((ip) => ({ userId, ipAddress: ip, createdAt: ago(min) }));
  ok('>=4 distinct IPs flags fanout', detectSessionFanout(sess('u1', ['a', 'b', 'c', 'd']), NOW).length === 1);
  ok('3 distinct IPs does not', detectSessionFanout(sess('u2', ['a', 'b', 'c']), NOW).length === 0);
  ok('duplicate IPs count once', detectSessionFanout(sess('u3', ['a', 'a', 'a', 'b']), NOW).length === 0);

  console.log('\n== impossible travel (>=2 distinct IPs, 30-min) ==');
  ok('2 distinct IPs within 30 min flags', detectImpossibleTravel(sess('u1', ['a', 'b'], 10), NOW).length === 1);
  ok('same IP twice does not', detectImpossibleTravel(sess('u2', ['a', 'a'], 10), NOW).length === 0);
  ok('outside the 30-min window ignored', detectImpossibleTravel(sess('u3', ['a', 'b'], 45), NOW).length === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main();

// Who receives a notification, asserted against the call sites rather than against a list.
//
// =================================================================================================
// WHY THIS SCANS THE SOURCE
// =================================================================================================
//
// NOTIFICATION_AUDIENCE is a map maintained by hand, and the cost of forgetting an entry used to be
// invisible: the unmapped type simply went to EVERY active non-applicant account. Eleven live types
// were in that state when this test was written — among them the wallet-debit alert that quotes a
// rupee amount taken from a named user, and the fee-waiver request, which is a person telling us
// they cannot afford to apply. Marketing and editors were receiving both.
//
// The default is now super_admin-only, so a future omission is quiet rather than leaky. That is the
// safe direction but it is still an omission — the people responsible for an event should be told
// about it. So this test walks every sendPushToAdmins/notifyAllAdmins call site in the tree and
// fails if any of them broadcasts a type the map has never heard of.
//
// The same reason src/lib/pg-array.test.ts scans the source: a rule nothing looks for is a rule that
// has already been broken somewhere you have not read yet.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect, report } from './test-shim';
import { NOTIFICATION_AUDIENCE, audienceFor, roleCanReceive, type AppRole } from './notify-audience';

// -------------------------------------------------------------------------------------------------
// The scan
// -------------------------------------------------------------------------------------------------
function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.astro' || name === 'dist') continue;
    const p = dir + '/' + name;
    if (statSync(p).isDirectory()) sources(p, acc);
    else if ((p.endsWith('.ts') || p.endsWith('.astro')) && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

/** notify.ts maps a coarse in-app `type` onto an audience key; read it rather than restating it. */
function typeAliases(): Map<string, string> {
  const body = readFileSync('src/lib/notify.ts', 'utf8');
  const block = body.slice(body.indexOf('TYPE_TO_AUDIENCE'));
  const end = block.indexOf('};');
  const out = new Map<string, string>();
  for (const m of block.slice(0, end).matchAll(/^\s*([a-z_]+)\s*:\s*'([a-z_]+)'/gm)) out.set(m[1], m[2]);
  return out;
}

/** Every audience key actually broadcast to admins anywhere in the tree, with where it came from. */
function broadcastKeys(): Map<string, string[]> {
  const aliases = typeAliases();
  const found = new Map<string, string[]>();
  // The three modules that IMPLEMENT the fan-out are not call sites of it.
  const OWN = ['src/lib/notify.ts', 'src/lib/push.ts', 'src/lib/notify-audience.ts'];
  for (const f of sources('src')) {
    if (OWN.includes(f)) continue;
    const body = readFileSync(f, 'utf8');
    for (const call of body.matchAll(/\b(notifyAllAdmins|sendPushToAdmins)\s*\(/g)) {
      // The options object is written inline at every call site in this repository; 900 characters
      // covers the longest of them and stops well before the next statement.
      const seg = body.slice(call.index || 0, (call.index || 0) + 900);
      const explicit = /audience:\s*['"`]([^'"`]+)/.exec(seg);
      const literal = /type:\s*['"`]([^'"`]+)/.exec(seg);
      // A computed type (`'partner_payout_' + action`) cannot be resolved statically. Those are
      // skipped rather than guessed at — PREFIX handling belongs to notification-catalog.ts.
      if (!explicit && !literal) continue;
      const key = explicit ? explicit[1] : (aliases.get(literal![1]) || literal![1]);
      const at = f + ' (' + (body.slice(0, call.index).split('\n').length) + ')';
      found.set(key, (found.get(key) || []).concat(at));
    }
  }
  return found;
}

const BROADCAST = broadcastKeys();

describe('the map covers what is actually broadcast', () => {
  it('found call sites at all, so this test is not vacuous', () => {
    expect(BROADCAST.size).toBeGreaterThan(10);
  });

  it('every audience key broadcast to admins has an entry', () => {
    // Named, because "one is missing" sends somebody to diff two lists by eye.
    const missing = [...BROADCAST.entries()]
      .filter(([k]) => !Object.prototype.hasOwnProperty.call(NOTIFICATION_AUDIENCE, k))
      .map(([k, where]) => k + ' <- ' + where[0])
      .sort();
    expect(missing.join('; ')).toBe('');
  });

  it('every entry names only roles that exist', () => {
    const ROLES: AppRole[] = [
      'super_admin', 'hr', 'recruiter', 'reviewer', 'department_head',
      'marketing', 'editor', 'technical_moderator', 'teacher', 'partner', 'applicant',
    ];
    const bad: string[] = [];
    for (const [type, roles] of Object.entries(NOTIFICATION_AUDIENCE)) {
      for (const r of roles) if (!ROLES.includes(r)) bad.push(type + ':' + r);
    }
    expect(bad.join(', ')).toBe('');
  });

  it('no entry hands an admin notification to an external role', () => {
    // applicant and partner share the users table with staff. An audience listing either of them
    // would deliver staff traffic to somebody outside the organisation.
    const leaky = Object.entries(NOTIFICATION_AUDIENCE)
      .filter(([, roles]) => roles.includes('applicant') || roles.includes('partner'))
      .map(([t]) => t);
    expect(leaky.join(', ')).toBe('');
  });
});

describe('an unmapped type', () => {
  const UNMAPPED = 'a_type_nobody_has_mapped_yet';

  it('reaches super_admin, so it is never silently dropped', () => {
    expect(roleCanReceive('super_admin', UNMAPPED)).toBe(true);
  });

  it('REACHES NOBODY ELSE — this is the whole point of the change', () => {
    // The old default was `role !== 'applicant'`, which is every account in the building.
    for (const r of ['hr', 'recruiter', 'reviewer', 'department_head', 'marketing', 'editor',
      'technical_moderator', 'teacher', 'partner', 'applicant']) {
      expect(roleCanReceive(r, UNMAPPED)).toBe(false);
    }
  });

  it('is reported as unmapped rather than as an empty audience', () => {
    expect(audienceFor(UNMAPPED)).toBeNull();
    expect(Array.isArray(audienceFor('new_application'))).toBe(true);
  });
});

describe('a mapped type', () => {
  it('reaches the roles it names and no others', () => {
    expect(roleCanReceive('hr', 'leave_request')).toBe(true);
    expect(roleCanReceive('department_head', 'leave_request')).toBe(true);
    expect(roleCanReceive('marketing', 'leave_request')).toBe(false);
    expect(roleCanReceive('editor', 'leave_request')).toBe(false);
    expect(roleCanReceive('teacher', 'leave_request')).toBe(false);
  });

  it('keeps the money and hardship types off every desk that does not handle them', () => {
    // The eleven that were taking the old default. Each is checked against the role that most
    // obviously should not have been receiving it.
    for (const t of ['payment_effect_failed', 'credit_debit_stranded', 'tool_pass_stranded',
      'fee_waiver_request', 'course_fee_waiver_requested', 'paid_application_stuck',
      'offer_verification_request', 'partner_payout_request', 'application_started',
      'activity_alert', 'activity_digest']) {
      expect(roleCanReceive('marketing', t), t + ' -> marketing').toBe(false);
      expect(roleCanReceive('teacher', t), t + ' -> teacher').toBe(false);
      expect(roleCanReceive('partner', t), t + ' -> partner').toBe(false);
      expect(roleCanReceive('super_admin', t), t + ' -> super_admin').toBe(true);
    }
  });

  it('sends the platform oversight feed to the owner only', () => {
    for (const r of ['hr', 'recruiter', 'reviewer', 'department_head', 'technical_moderator']) {
      expect(roleCanReceive(r, 'activity_alert')).toBe(false);
    }
    expect(roleCanReceive('super_admin', 'activity_alert')).toBe(true);
  });

  it('still reaches recruiting for the recruiting funnel', () => {
    expect(roleCanReceive('recruiter', 'fee_waiver_request')).toBe(true);
    expect(roleCanReceive('recruiter', 'paid_application_stuck')).toBe(true);
    expect(roleCanReceive('hr', 'application_started')).toBe(true);
    expect(roleCanReceive('hr', 'payment_effect_failed')).toBe(true);
  });
});

report();

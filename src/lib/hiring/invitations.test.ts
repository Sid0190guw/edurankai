// src/lib/hiring/invitations.test.ts — the pure half: token discipline, status derivation, parsing.
import { describe, it, expect } from 'vitest';
import {
  generateToken, hashToken, tokenPrefixOf, normaliseEmail, isEmail,
  statusOf, isLive, inviteUrl, ttlDays, parseInvite,
  generateCode, normaliseCode, formatCode, hashCode, codePrefixOf,
  hasVisibleNote, cleanNote, looksLikeInviteCode, inviteApplyHref, displayRoleTitle,
  DEFAULT_TTL_DAYS, MAX_TTL_DAYS, NOTE_MAX,
} from '@/lib/hiring/invitations';
import { isGatedApplyPath } from '@/lib/talent/gate-pass';

describe('token', () => {
  it('is long and unguessable, and never the same twice', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes stably, and the hash does not contain the token', () => {
    const t = 'abcDEF-123_xyz';
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toHaveLength(64);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).not.toBe(hashToken(t + 'x'));
  });

  it('shows a prefix short enough to be useless on its own', () => {
    const t = generateToken();
    expect(tokenPrefixOf(t)).toHaveLength(8);
    expect(t.startsWith(tokenPrefixOf(t))).toBe(true);
  });

  it('builds a link on the configured public origin, without doubling the slash', () => {
    const prev = process.env.PUBLIC_SITE_URL;
    try {
      process.env.PUBLIC_SITE_URL = 'https://www.edurankai.in/';
      expect(inviteUrl('tok')).toBe('https://www.edurankai.in/invite/tok');
      process.env.PUBLIC_SITE_URL = 'https://www.edurankai.in';
      expect(inviteUrl('tok')).toBe('https://www.edurankai.in/invite/tok');
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = prev;
    }
  });

  // THIS ONE SHIPPED BROKEN. The route passed `new URL(request.url).origin`, which on a serverless
  // deployment is the address the function was invoked on — production minted
  // https://localhost/invite/<token>. The origin is no longer a parameter, so there is no caller
  // left that can supply a wrong one; this asserts the result is never loopback.
  it('never mints a loopback link', () => {
    const prev = process.env.PUBLIC_SITE_URL;
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      process.env.PUBLIC_SITE_URL = 'http://localhost:4321';
      expect(inviteUrl('tok')).not.toContain('localhost');
      expect(inviteUrl('tok')).toContain('edurankai.in');
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = prev;
      process.env.NODE_ENV = prevEnv;
    }
  });

  // THE REGRESSION THIS PINS ACTUALLY HAPPENED. The landing page first lived at
  // /apply/invite/<token>, and every invitation link 302'd to the application gate without the page
  // ever running: middleware gates the whole /apply prefix and its exemptions are matched EXACTLY,
  // so a path with a token segment can never be exempted there. Asserting against the real gate
  // predicate rather than against the string means moving either one breaks this test.
  it('lands outside the gated apply prefix, or the link never reaches the page', () => {
    const path = new URL(inviteUrl('tok')).pathname;
    expect(isGatedApplyPath(path)).toBe(false);
  });
});

describe('email', () => {
  it('lowercases and trims, because the email is the binding to the application', () => {
    expect(normaliseEmail('  Ananya@Example.ORG ')).toBe('ananya@example.org');
    expect(normaliseEmail(null)).toBe('');
  });

  it('accepts a real address and rejects the near misses', () => {
    expect(isEmail('ananya@example.org')).toBe(true);
    expect(isEmail('ananya@example')).toBe(false);
    expect(isEmail('ananya example.org')).toBe(false);
    expect(isEmail('')).toBe(false);
  });
});

describe('statusOf', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();

  it('reads pending and opened while the link is still live', () => {
    expect(statusOf({ status: 'pending', expiresAt: future })).toBe('pending');
    expect(statusOf({ status: 'opened', expiresAt: future })).toBe('opened');
  });

  it('derives expiry rather than trusting a stored column', () => {
    expect(statusOf({ status: 'pending', expiresAt: past })).toBe('expired');
    expect(statusOf({ status: 'opened', expiresAt: past })).toBe('expired');
  });

  it('keeps revoked ahead of expired — taken back and ran out are different facts', () => {
    expect(statusOf({ status: 'revoked', expiresAt: past })).toBe('revoked');
    expect(statusOf({ status: 'revoked', expiresAt: future })).toBe('revoked');
  });

  it('treats an applied invitation as spent even past its expiry', () => {
    expect(statusOf({ status: 'applied', expiresAt: past })).toBe('applied');
    expect(statusOf({ status: 'opened', expiresAt: past, appliedAt: past })).toBe('applied');
  });

  it('only pending and opened can still be walked through', () => {
    expect(isLive('pending')).toBe(true);
    expect(isLive('opened')).toBe(true);
    expect(isLive('applied')).toBe(false);
    expect(isLive('revoked')).toBe(false);
    expect(isLive('expired')).toBe(false);
  });
});

describe('ttlDays', () => {
  it('defaults when the input is absent or nonsense', () => {
    expect(ttlDays(undefined)).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays('')).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays('abc')).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays(0)).toBe(DEFAULT_TTL_DAYS);
    expect(ttlDays(-5)).toBe(DEFAULT_TTL_DAYS);
  });

  it('caps rather than trusting whatever was posted', () => {
    expect(ttlDays(9999)).toBe(MAX_TTL_DAYS);
    expect(ttlDays(7)).toBe(7);
  });
});

describe('parseInvite', () => {
  it('refuses a missing or malformed address with a sentence a person can act on', () => {
    expect(parseInvite({ email: '' })).toEqual({ error: 'Enter the email address to invite.' });
    expect(parseInvite({ email: 'nope' })).toEqual({ error: 'That email address does not look right.' });
  });

  it('cleans a whole invitation', () => {
    const out = parseInvite({
      email: '  Ananya@Example.ORG ', fullName: '  Ananya Kumar ', roleSlug: ' data-analyst-intern ',
      note: '  We would like you to apply.  ', waiveFee: 'on', days: '14',
    });
    expect(out).toEqual({
      value: {
        email: 'ananya@example.org',
        fullName: 'Ananya Kumar',
        roleSlug: 'data-analyst-intern',
        note: 'We would like you to apply.',
        waiveFee: true,
        days: 14,
      },
    });
  });

  it('leaves the fee alone unless the administrator actually ticked the box', () => {
    const off = parseInvite({ email: 'a@b.co' }) as { value: { waiveFee: boolean } };
    expect(off.value.waiveFee).toBe(false);
    const stringFalse = parseInvite({ email: 'a@b.co', waiveFee: 'false' }) as { value: { waiveFee: boolean } };
    expect(stringFalse.value.waiveFee).toBe(false);
    const checked = parseInvite({ email: 'a@b.co', waiveFee: true }) as { value: { waiveFee: boolean } };
    expect(checked.value.waiveFee).toBe(true);
  });

  it('allows an invitation with no role — the administrator meant the person', () => {
    const out = parseInvite({ email: 'a@b.co' }) as { value: { roleSlug: string } };
    expect(out.value.roleSlug).toBe('');
  });

  it('truncates rather than rejecting an over-long note', () => {
    const out = parseInvite({ email: 'a@b.co', note: 'x'.repeat(20000) }) as { value: { note: string } };
    expect(out.value.note).toHaveLength(NOTE_MAX);
  });
});

describe('the typed code', () => {
  it('uses the project alphabet, so O, 0, I and 1 can never be minted', () => {
    for (let i = 0; i < 40; i++) {
      const body = generateCode();
      expect(body).toHaveLength(15);
      expect(body).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/);
      expect(body).not.toMatch(/[O0I1]/);
    }
  });

  it('never mints the same code twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCode()));
    expect(seen.size).toBe(200);
  });

  it('displays as ERA-INV and not as ERA-SEL, which means a different thing entirely', () => {
    const shown = formatCode('ABCDEFGHJKLMNPQ');
    expect(shown).toBe('ERA-INV-ABCDE-FGHJK-LMNPQ');
    expect(shown.startsWith('ERA-SEL')).toBe(false);
  });

  it('reads back whatever form a person actually types', () => {
    const body = 'ABCDEFGHJKLMNPQ';
    for (const typed of [
      'ERA-INV-ABCDE-FGHJK-LMNPQ',
      'era-inv-abcde-fghjk-lmnpq',
      '  ERA INV ABCDE FGHJK LMNPQ  ',
      'ABCDEFGHJKLMNPQ',
      'abcde fghjk lmnpq',
      'ABCDE-FGHJK-LMNPQ',
    ]) {
      expect(normaliseCode(typed)).toBe(body);
    }
  });

  it('refuses anything that is not a complete code', () => {
    expect(normaliseCode('')).toBeNull();
    expect(normaliseCode('ERA-INV-ABCDE')).toBeNull();
    expect(normaliseCode('ABCDEFGHJKLMNPQR')).toBeNull();
    expect(normaliseCode(null)).toBeNull();
  });

  it('hashes to something that is not the code, and not the token hash of the same string', () => {
    const body = 'ABCDEFGHJKLMNPQ';
    expect(hashCode(body)).toHaveLength(64);
    expect(hashCode(body)).not.toContain(body);
    expect(hashCode(body)).toBe(hashCode(body));
    // Domain-separated: the same string used as a token and as a code must not collide, or one
    // lookup could resolve the other's row.
    expect(hashCode(body)).not.toBe(hashToken(body));
  });

  it('shows only the first group as a prefix', () => {
    expect(codePrefixOf('ABCDEFGHJKLMNPQ')).toBe('ABCDE');
  });
});

// =================================================================================================
// THE EMPTY MESSAGE BOX
// =================================================================================================
//
// A real invitation went out with a bordered quote block containing nothing, sitting between two
// paragraphs of a message that is supposed to read as though a person wrote it. The column was not
// empty — a contenteditable that is focused and then emptied does not come back as ''.
describe('hasVisibleNote', () => {
  it('is false for every shape an emptied composer leaves behind', () => {
    for (const empty of [
      '', '   ', '<br>', '<br/>', '<p><br></p>', '<p></p>', '<div><br></div>',
      '<span></span>', '<p>&nbsp;</p>', '<p> &nbsp; &nbsp; </p>', '<p><span><br></span></p>',
      '<ul><li></li></ul>',
    ]) {
      expect(hasVisibleNote(empty)).toBe(false);
    }
    expect(hasVisibleNote(null)).toBe(false);
    expect(hasVisibleNote(undefined)).toBe(false);
  });

  it('is true as soon as one printable character survives', () => {
    expect(hasVisibleNote('<p>Hello</p>')).toBe(true);
    expect(hasVisibleNote('Hello')).toBe(true);
    expect(hasVisibleNote('<p>&nbsp;x&nbsp;</p>')).toBe(true);
    // An escaped entity is a character somebody typed, not blank space.
    expect(hasVisibleNote('<p>&amp;</p>')).toBe(true);
    expect(hasVisibleNote('<p>&lt;</p>')).toBe(true);
  });

  it('counts a picture as a message, because somebody chose to send it', () => {
    expect(hasVisibleNote('<p><img src="https://example.org/a.png" alt=""></p>')).toBe(true);
    expect(hasVisibleNote('<hr>')).toBe(true);
  });

  it('is not fooled by attribute text, which is never shown as words', () => {
    expect(hasVisibleNote('<p class="a-long-class-name" data-x="hello"><br></p>')).toBe(false);
  });
});

describe('cleanNote', () => {
  it('stores nothing for a note that says nothing', () => {
    expect(cleanNote('<p><br></p>')).toBe('');
    expect(cleanNote('   ')).toBe('');
    expect(cleanNote(undefined)).toBe('');
  });

  it('keeps a real note, trimmed and capped', () => {
    expect(cleanNote('  <p>Hello</p>  ')).toBe('<p>Hello</p>');
    expect(cleanNote('<p>' + 'x'.repeat(NOTE_MAX * 2) + '</p>').length).toBe(NOTE_MAX);
  });

  it('is what parseInvite writes, so an emptied composer never reaches the database', () => {
    const parsed = parseInvite({ email: 'a@b.co', note: '<p><br></p>' });
    expect('value' in parsed && parsed.value.note).toBe('');
  });
});

// =================================================================================================
// THE TWO CODE FAMILIES AT ONE CODE BOX
// =================================================================================================
//
// /apply/gateway has a single code box and answered an ERA-INV code with "enter it at /invite
// instead" — which is where the link in the invitation email had just sent the person. The box now
// reads both families, and which one an entry belongs to is decided from the PREFIX ALONE so that a
// mistyped ERA-SEL code still falls through to the selection path and its uniform refusal.
describe('looksLikeInviteCode', () => {
  it('recognises the displayed form in every spacing a person types', () => {
    for (const typed of [
      'ERA-INV-ABCDE-FGHJK-LMNPQ',
      'era-inv-abcde-fghjk-lmnpq',
      '  ERA INV ABCDE FGHJK LMNPQ  ',
      'ERAINVABCDEFGHJKLMNPQ',
    ]) {
      expect(looksLikeInviteCode(typed)).toBe(true);
    }
  });

  it('leaves the selection family alone, including a mistyped one', () => {
    expect(looksLikeInviteCode('ERA-SEL-ABCDE-FGHJK-LMNPQ')).toBe(false);
    expect(looksLikeInviteCode('ERA-SEL-ABCDE-FGHJK-LMNP')).toBe(false);
    // A bare body with no prefix means the box it was typed into. That box is the selection one.
    expect(looksLikeInviteCode('ABCDEFGHJKLMNPQ')).toBe(false);
    expect(looksLikeInviteCode('')).toBe(false);
    expect(looksLikeInviteCode(null)).toBe(false);
  });

  it('does not claim an incomplete invitation code, which is a malformed entry and not a door', () => {
    expect(looksLikeInviteCode('ERA-INV-ABCDE')).toBe(false);
    expect(looksLikeInviteCode('ERA-INV-ABCDE-FGHJK-LMNPQR')).toBe(false);
  });

  it('agrees with formatCode, so a code we minted is always recognised', () => {
    for (let i = 0; i < 20; i++) {
      expect(looksLikeInviteCode(formatCode(generateCode()))).toBe(true);
    }
  });
});

describe('where an invitation sends somebody', () => {
  it('carries the posting, so the invited person does not land on a blank application', () => {
    expect(inviteApplyHref('executive-assistant-to-ceo')).toBe('/apply?role=executive-assistant-to-ceo');
    expect(inviteApplyHref('')).toBe('/apply');
    expect(inviteApplyHref('   ')).toBe('/apply');
  });

  it('encodes the slug rather than trusting it', () => {
    expect(inviteApplyHref('a b&c')).toBe('/apply?role=a%20b%26c');
  });

  it('never leaves the site, whatever a slug contains', () => {
    expect(inviteApplyHref('//evil.example')).toBe('/apply?role=%2F%2Fevil.example');
  });
});

describe('displayRoleTitle', () => {
  const inv = { roleSlug: 'r', roleTitle: 'What it was called then' };

  it('prefers what the catalogue calls the posting today', () => {
    expect(displayRoleTitle(inv, {
      slug: 'r', title: 'What it is called now', acceptsApplications: true, publicNote: '',
    })).toBe('What it is called now');
  });

  it('falls back to the snapshot when the posting is gone or the read failed', () => {
    expect(displayRoleTitle(inv, null)).toBe('What it was called then');
  });

  // The "synced for the past too" case: rows written before role_title was populated carry only a
  // slug, and every screen still has to name the position.
  it('names a position for a row that only ever stored a slug', () => {
    expect(displayRoleTitle({ roleSlug: 'r', roleTitle: '' }, {
      slug: 'r', title: 'Executive Assistant to CEO', acceptsApplications: true, publicNote: '',
    })).toBe('Executive Assistant to CEO');
  });

  it('is empty when nothing anywhere knows the title, so a caller can say "Any role"', () => {
    expect(displayRoleTitle({ roleSlug: 'r', roleTitle: '' }, null)).toBe('');
  });
});

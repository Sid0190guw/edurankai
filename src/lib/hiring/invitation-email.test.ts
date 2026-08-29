// src/lib/hiring/invitation-email.test.ts — what the invited person actually receives.
//
// THE FAILURE THIS FILE IS ABOUT. A real invitation went out with a bordered quote block containing
// nothing, sitting between two paragraphs of a message that is supposed to read as though a person
// wrote it. The `note` column was not empty: a contenteditable that is focused and then emptied
// stores '<p><br></p>', '<span></span>' or a paragraph holding one non-breaking space, and the
// builder only asked whether the string was truthy.
//
// Imported through the '@' alias, the way src/lib/admin-search-endpoint.test.ts imports its subject:
// a relative import would put a test file next to the route in the server bundle.
import { describe, it, expect } from 'vitest';
import { invitationEmail } from '@/pages/api/admin/applications/invite';
import type { Invitation } from '@/lib/hiring/invitations';

const base: Invitation = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'candidate@example.org',
  fullName: 'Priya Nair',
  roleId: null,
  roleSlug: 'executive-assistant-to-ceo',
  roleTitle: 'Executive Assistant to CEO',
  tokenPrefix: 'abcdefgh',
  codePrefix: 'ABCDE',
  note: '',
  waiveFee: false,
  invitedBy: null,
  invitedByName: 'Ravi Menon',
  status: 'pending',
  emailSent: false,
  emailError: '',
  applicationId: null,
  createdAt: '2026-08-29T00:00:00.000Z',
  expiresAt: '2026-09-28T00:00:00.000Z',
  sentAt: null,
  openedAt: null,
  appliedAt: null,
  revokedAt: null,
};

const build = (note: string) => invitationEmail(
  { ...base, note },
  'https://www.edurankai.in/invite/tok',
  'ERA-INV-ABCDE-FGHJK-LMNPQ',
  'Ravi Menon',
);

/** The quote block is the only thing on the page with this border, so it is what to look for. */
const NOTE_BOX = 'border-left:3px solid #FF4F00';

describe('the invitation email', () => {
  it('has no message block at all when no message was written', () => {
    for (const empty of ['', '   ', '<p><br></p>', '<br>', '<span></span>', '<p>&nbsp;</p>', '<div><br></div>']) {
      const mail = build(empty);
      expect(mail.html).not.toContain(NOTE_BOX);
      // And the two parts of one message agree: no stray empty quotation in text/plain either.
      expect(mail.text).not.toContain('""');
    }
  });

  it('carries the message when there is one, as formatted text and not as tags', () => {
    const mail = build('<p>We would like you to apply.</p>');
    expect(mail.html).toContain(NOTE_BOX);
    expect(mail.html).toContain('We would like you to apply.');
    // Not delivered as literal angle brackets — the note is sanitised, never escaped.
    expect(mail.html).not.toContain('&lt;p&gt;');
    expect(mail.text).toContain('"We would like you to apply."');
  });

  it('drops the block when the sanitiser removed everything the note contained', () => {
    // A note that is nothing but a script is nothing once OUTBOUND has run. The old condition asked
    // whether the column was truthy, so this shipped an empty box too.
    const mail = build('<script>alert(1)</script>');
    expect(mail.html).not.toContain(NOTE_BOX);
    expect(mail.html).not.toContain('alert(1)');
  });

  it('names the position it is inviting somebody to', () => {
    const mail = build('');
    expect(mail.subject).toContain('Executive Assistant to CEO');
    expect(mail.html).toContain('Executive Assistant to CEO');
    expect(mail.text).toContain('Executive Assistant to CEO');
  });

  it('still says plainly that an invitation is not an offer', () => {
    const mail = build('');
    expect(mail.html).toContain('is not an offer');
    expect(mail.text).toContain('is not an offer');
  });
});

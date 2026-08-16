// Inbound MIME parsing. Everything a stranger can put in a message, and what this engine does with
// it — including the parts it refuses to hand on.

import { describe, it, expect } from 'vitest';
import { parseInbound, safeFilename, looksLikeBounce, extractSpamVerdict } from '../src/mime/parse.js';
import { simpleParser } from 'mailparser';

const OPTS = { maxAttachmentBytes: 1024 * 1024, blockedExtensions: ['exe', 'bat', 'js'] };

const MULTIPART = [
  'From: "Priya Raman" <priya@example.com>',
  'To: "Admissions" <admissions@edurankai.in>, second@edurankai.in',
  'Cc: tutor@example.com',
  'Reply-To: priya.personal@example.com',
  'Subject: Re: Application status',
  'Date: Mon, 10 Aug 2026 09:15:00 +0530',
  'Message-ID: <reply-77@example.com>',
  'In-Reply-To: <original-42@mail.edurankai.in>',
  'References: <first-1@mail.edurankai.in> <original-42@mail.edurankai.in>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="ALT"',
  '',
  '--ALT',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Thank you for the update.',
  '',
  '--ALT',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Thank you for the <b>update</b>.</p>',
  '--ALT--',
].join('\r\n');

describe('safeFilename', () => {
  it('removes anything that makes a name dangerous', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
    // The newline is removed and the colon becomes an underscore — a name that is inert whether it
    // reaches a header, a filesystem or a Content-Disposition line.
    expect(safeFilename('report\r\nX-Injected: yes.pdf')).toBe('reportX-Injected_ yes.pdf');
    expect(safeFilename('normal file.pdf')).toBe('normal file.pdf');
    expect(safeFilename('')).toBe('attachment');
    expect(safeFilename(undefined)).toBe('attachment');
  });
});

describe('parseInbound — headers and bodies', () => {
  it('reads every address field and keeps the threading headers whole', async () => {
    const m = await parseInbound(MULTIPART, OPTS);
    expect(m.from).toEqual({ address: 'priya@example.com', name: 'Priya Raman' });
    expect(m.to.map((t) => t.address)).toEqual(['admissions@edurankai.in', 'second@edurankai.in']);
    expect(m.cc.map((c) => c.address)).toEqual(['tutor@example.com']);
    expect(m.replyTo).toBe('priya.personal@example.com');
    expect(m.subject).toBe('Re: Application status');
    expect(m.rfcMessageId).toBe('<reply-77@example.com>');
    expect(m.inReplyTo).toBe('<original-42@mail.edurankai.in>');
    expect(m.references).toEqual(['<first-1@mail.edurankai.in>', '<original-42@mail.edurankai.in>']);
  });

  it('keeps both halves of a multipart/alternative', async () => {
    const m = await parseInbound(MULTIPART, OPTS);
    expect(m.text).toContain('Thank you for the update.');
    expect(m.html).toContain('<b>update</b>');
  });

  it('prefers the ENVELOPE over the headers for who the message is for', async () => {
    // A Bcc'd recipient appears in no header at all, and an alias delivers to a mailbox whose
    // address is nowhere in To. Using the headers here is how Bcc'd mail goes missing.
    const m = await parseInbound(MULTIPART, { ...OPTS, envelope: { from: 'bounce@example.com', to: ['hidden@edurankai.in'] } });
    expect(m.envelopeTo).toEqual(['hidden@edurankai.in']);
    expect(m.envelopeFrom).toBe('bounce@example.com');
  });

  it('falls back to the To header when no envelope was supplied', async () => {
    const m = await parseInbound(MULTIPART, OPTS);
    expect(m.envelopeTo).toEqual(['admissions@edurankai.in', 'second@edurankai.in']);
  });

  it('handles a plain-text message with no MIME structure at all', async () => {
    const plain = 'From: a@example.com\r\nSubject: hi\r\n\r\njust text';
    const m = await parseInbound(plain, OPTS);
    expect(m.text.trim()).toBe('just text');
    expect(m.attachments).toHaveLength(0);
  });
});

describe('parseInbound — attachments', () => {
  const withAttachment = (filename: string, body = 'SGVsbG8gd29ybGQ=') => [
    'From: a@example.com',
    'To: b@edurankai.in',
    'Subject: with attachment',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: text/plain',
    '',
    'see attached',
    '',
    '--MIX',
    'Content-Type: application/octet-stream',
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '--MIX--',
  ].join('\r\n');

  it('extracts an ordinary attachment with its bytes', async () => {
    const m = await parseInbound(withAttachment('notes.pdf'), OPTS);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].filename).toBe('notes.pdf');
    expect(Buffer.from(m.attachments[0].content!, 'base64').toString()).toBe('Hello world');
    expect(m.attachments[0].rejectedReason).toBeNull();
  });

  it('REFUSES an executable attachment but still records that it was there', async () => {
    // Dropping the part silently means the recipient reads a message that mentions an attachment
    // they cannot see and never learns why.
    const m = await parseInbound(withAttachment('invoice.exe'), OPTS);
    expect(m.attachments[0].content).toBeNull();
    expect(m.attachments[0].rejectedReason).toContain('.exe attachments are not accepted');
  });

  it('drops the bytes of an oversized attachment rather than carrying them around', async () => {
    const big = Buffer.alloc(4096, 'A').toString('base64');
    const m = await parseInbound(withAttachment('big.bin', big), { ...OPTS, maxAttachmentBytes: 1000 });
    expect(m.attachments[0].content).toBeNull();
    expect(m.attachments[0].rejectedReason).toContain('over the');
    expect(m.attachments[0].sizeBytes).toBeGreaterThan(1000);
  });

  it('sanitises a traversal filename before anything can use it', async () => {
    const m = await parseInbound(withAttachment('../../evil.txt'), OPTS);
    expect(m.attachments[0].filename).toBe('evil.txt');
  });
});

describe('extractSpamVerdict', () => {
  it('reads an Rspamd score', async () => {
    const parsed = await simpleParser('X-Spamd-Result: default: False [3.20 / 15.00]\r\nX-Spamd-Action: no action\r\n\r\nbody');
    expect(extractSpamVerdict(parsed).score).toBe(3.2);
  });

  it('reads a SpamAssassin score and star level', async () => {
    const withScore = await simpleParser('X-Spam-Score: 8.4\r\n\r\nbody');
    expect(extractSpamVerdict(withScore).score).toBe(8.4);
    const withStars = await simpleParser('X-Spam-Level: *****\r\n\r\nbody');
    expect(extractSpamVerdict(withStars).score).toBe(5);
  });

  it('reports null when no filter has been anywhere near the message', async () => {
    // The engine has to behave sensibly with no spam filter installed, which is a fresh laptop.
    const parsed = await simpleParser('From: a@b.com\r\n\r\nbody');
    expect(extractSpamVerdict(parsed).score).toBeNull();
  });
});

describe('looksLikeBounce', () => {
  it('recognises the null return path, which is the definitive marker', () => {
    expect(looksLikeBounce({ envelopeFrom: '', from: { address: 'x@y.com', name: '' }, subject: 'hi' })).toBe(true);
    expect(looksLikeBounce({ envelopeFrom: '<>', from: { address: 'x@y.com', name: '' }, subject: 'hi' })).toBe(true);
  });

  it('recognises the usual senders and subjects', () => {
    expect(looksLikeBounce({ envelopeFrom: 'a@b.com', from: { address: 'MAILER-DAEMON@b.com', name: '' }, subject: 'x' })).toBe(true);
    expect(looksLikeBounce({ envelopeFrom: 'a@b.com', from: { address: 'x@y.com', name: '' }, subject: 'Undelivered Mail Returned to Sender' })).toBe(true);
  });

  it('does not mistake ordinary mail for a bounce', () => {
    expect(looksLikeBounce({ envelopeFrom: 'priya@example.com', from: { address: 'priya@example.com', name: '' }, subject: 'Re: Application status' })).toBe(false);
  });
});

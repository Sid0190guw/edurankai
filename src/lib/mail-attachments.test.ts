// src/lib/mail-attachments.test.ts — what an attachment is allowed to do on screen.
//
// Wholly pure: this module imports no database and no framework. Each case below is a technique
// somebody actually uses, not a category — the right-to-left override, the type that disagrees with
// the extension, the SVG that is a document rather than a picture.
import { describe, it, expect } from 'vitest';
import {
  safeFilename, extensionOf, classifyAttachment, contentDisposition, validateOutgoingAttachment,
  isLocalUrl, isSafeLink, formatBytes, mimeForExtension,
  MAX_ATTACHMENT_BYTES, MAX_FILENAME_LENGTH, EXECUTABLE_EXTENSIONS, ACTIVE_CONTENT_TYPES,
} from './mail-attachments';

const HOST = 'www.edurankai.in';

describe('safe filenames', () => {
  it('keeps an ordinary name intact', () => {
    expect(safeFilename('July invoice.pdf')).toBe('July invoice.pdf');
  });

  it('strips the right-to-left override that makes an extension read backwards', () => {
    // "report<U+202E>fdp.exe" renders as "reportexe.pdf" in most UIs. The bytes are honest and the
    // display is a lie, so the character comes out and the real extension is visible again.
    const spoofed = 'report\u202Efdp.exe';
    const safe = safeFilename(spoofed);
    expect(safe).not.toContain('\u202E');
    expect(extensionOf(safe)).toBe('exe');
  });

  it('strips the isolate characters that do the same trick differently', () => {
    expect(safeFilename('a\u2066b\u2069c.pdf')).toBe('abc.pdf');
  });

  it('removes control characters that would forge a header', () => {
    expect(safeFilename('inv\r\noice\u0000.pdf')).toBe('invoice.pdf');
  });

  it('takes only the name, never a path', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
  });

  it('collapses dot runs so nothing can traverse, and drops a leading dot', () => {
    expect(safeFilename('a..b.pdf')).toBe('a.b.pdf');
    expect(safeFilename('.hidden')).toBe('hidden');
  });

  it('removes the characters that break a header or a shell word', () => {
    expect(safeFilename('re"port;rm -rf.pdf')).not.toMatch(/["';]/);
  });

  it('truncates the STEM and keeps the extension, so the file is still recognisable', () => {
    const long = 'a'.repeat(400) + '.pdf';
    const out = safeFilename(long);
    expect(out.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('falls back rather than returning an empty name', () => {
    expect(safeFilename('')).toBe('attachment');
    expect(safeFilename('...')).toBe('attachment');
    expect(safeFilename(null)).toBe('attachment');
  });
});

describe('extensions', () => {
  it('reads the last one, lower case', () => {
    expect(extensionOf('Report.FINAL.PDF')).toBe('pdf');
  });
  it('is empty when there is not one', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });
  it('maps an extension to the type it implies', () => {
    expect(mimeForExtension('pdf')).toBe('application/pdf');
    expect(mimeForExtension('svg')).toBe('image/svg+xml');
    expect(mimeForExtension('zzz')).toBe('');
  });
});

describe('links', () => {
  it('accepts http, https and mailto, and refuses the rest', () => {
    expect(isSafeLink('https://x.example/a.pdf')).toBe(true);
    expect(isSafeLink('/era/a.pdf')).toBe(true);
    expect(isSafeLink('javascript:alert(1)')).toBe(false);
    expect(isSafeLink('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeLink('file:///etc/passwd')).toBe(false);
    expect(isSafeLink('')).toBe(false);
  });
  it('knows what this deployment serves itself', () => {
    expect(isLocalUrl('/uploads/a.png', HOST)).toBe(true);
    expect(isLocalUrl('https://' + HOST + '/a.png', HOST)).toBe(true);
    expect(isLocalUrl('https://elsewhere.example/a.png', HOST)).toBe(false);
    // A protocol-relative URL is somebody else's host, not ours.
    expect(isLocalUrl('//elsewhere.example/a.png', HOST)).toBe(false);
    // With no host given, nothing is ours — the safe direction.
    expect(isLocalUrl('https://' + HOST + '/a.png')).toBe(false);
  });
});

describe('what may be rendered', () => {
  it('a local raster image is shown in place', () => {
    const v = classifyAttachment({ filename: 'photo.png', url: '/uploads/photo.png', mime: 'image/png' }, HOST);
    expect(v.preview).toBe('inline');
    expect(v.kind).toBe('image');
  });

  it('a REMOTE image is a link, because loading it reports the open to that host', () => {
    const v = classifyAttachment({ filename: 'photo.png', url: 'https://tracker.example/p.png', mime: 'image/png' }, HOST);
    expect(v.preview).toBe('link');
    expect(v.reason).toContain('opened');
  });

  it('an SVG is a document, not a picture, and is never rendered', () => {
    const v = classifyAttachment({ filename: 'logo.svg', url: '/uploads/logo.svg', mime: 'image/svg+xml' }, HOST);
    expect(v.kind).toBe('active');
    expect(v.preview).toBe('blocked');
  });

  it('every active content type is blocked, not merely most of them', () => {
    for (const mime of ACTIVE_CONTENT_TYPES) {
      const v = classifyAttachment({ filename: 'x.bin', url: '/uploads/x', mime }, HOST);
      expect(v.preview).toBe('blocked');
    }
  });

  it('a PDF opens in a new tab rather than being framed inside a signed-in page', () => {
    const v = classifyAttachment({ filename: 'invoice.pdf', url: 'https://drive.example/f', mime: 'application/pdf' }, HOST);
    expect(v.kind).toBe('pdf');
    expect(v.preview).toBe('link');
  });

  it('every executable extension is listed but not clickable', () => {
    for (const ext of EXECUTABLE_EXTENSIONS) {
      const v = classifyAttachment({ filename: 'setup.' + ext, url: 'https://x.example/s' }, HOST);
      expect(v.preview).toBe('blocked');
      expect(v.kind).toBe('executable');
      // Still shown: hiding what somebody was sent is its own kind of failure.
      expect(v.safeName).toContain(ext);
    }
  });

  it('a missing or unusable link is blocked with a reason, not silently dropped', () => {
    const v = classifyAttachment({ filename: 'a.pdf', url: 'javascript:alert(1)' }, HOST);
    expect(v.preview).toBe('blocked');
    expect(v.warning).toBeTruthy();
  });

  it('a declared type that disagrees with the name is FLAGGED, and the safer reading wins', () => {
    const v = classifyAttachment({ filename: 'invoice.pdf', url: 'https://x.example/f', mime: 'text/html' }, HOST);
    expect(v.typeMismatch).toBe(true);
    expect(v.preview).toBe('blocked');
    expect(v.warning).toContain('disagree');
  });

  it('a file over the size ceiling is linked, with the size said out loud', () => {
    const v = classifyAttachment({ filename: 'big.zip', url: 'https://x.example/f', mime: 'application/zip', sizeBytes: MAX_ATTACHMENT_BYTES + 1 }, HOST);
    expect(v.preview).toBe('link');
    expect(v.warning).toContain('larger than');
  });

  it('names the kind for the icon, from the type rather than from a guess', () => {
    const kind = (f: string, m: string) => classifyAttachment({ filename: f, url: 'https://x.example/f', mime: m }, HOST).kind;
    expect(kind('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document');
    expect(kind('a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(kind('a.zip', 'application/zip')).toBe('archive');
    expect(kind('a.mp3', 'audio/mpeg')).toBe('audio');
    expect(kind('a.mp4', 'video/mp4')).toBe('video');
    expect(kind('a.ics', 'text/calendar')).toBe('calendar');
  });

  it('falls back to the name when no type was declared', () => {
    const v = classifyAttachment({ filename: 'notes.txt', url: '/uploads/notes.txt' }, HOST);
    expect(v.effectiveMime).toBe('text/plain');
    expect(v.typeMismatch).toBe(false);
  });

  it('takes a name from the URL when the sender gave none', () => {
    const v = classifyAttachment({ url: 'https://x.example/files/July%20report.pdf', mime: 'application/pdf' }, HOST);
    expect(v.safeName).toBe('July report.pdf');
  });
});

describe('download headers', () => {
  it('carries the name in both forms, for old clients and for the rest', () => {
    const h = contentDisposition('जुलाई.pdf');
    expect(h).toContain('attachment; filename="');
    expect(h).toContain("filename*=UTF-8''");
    expect(h).toContain(encodeURIComponent('जुलाई.pdf'));
  });
  it('the ASCII fallback carries no quote to break out with', () => {
    expect(contentDisposition('a"b.pdf')).not.toMatch(/filename="[^"]*"[^;]/);
  });
});

describe('refusing an attachment at the composer', () => {
  it('refuses a program before it is ever stored', () => {
    const r = validateOutgoingAttachment({ filename: 'setup.exe', url: 'https://x.example/s' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('.exe');
  });
  it('refuses something that is not a web address', () => {
    expect(validateOutgoingAttachment({ filename: 'a.pdf', url: 'javascript:1' }).ok).toBe(false);
  });
  it('refuses something over the ceiling', () => {
    expect(validateOutgoingAttachment({ filename: 'a.zip', url: 'https://x.example/f', sizeBytes: MAX_ATTACHMENT_BYTES + 1 }).ok).toBe(false);
  });
  it('accepts an ordinary document link', () => {
    expect(validateOutgoingAttachment({ filename: 'report.pdf', url: 'https://drive.example/d/abc' }).ok).toBe(true);
  });
});

describe('sizes', () => {
  it('reads as a person would', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });
});

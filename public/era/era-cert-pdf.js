/* era-cert-pdf.js - self-contained PDF generator for event artifacts.
   No external library. Certificates (participation / completion / award /
   certificate) render landscape; letters (selection / lor) render portrait.
   Usage: EraCertPdf.download(data, filename)
   data = { artifactType, title, participantName, eventTitle, levelName, body,
            serial, integrityHash, issuedAt, organiser, signatoryName,
            signatoryTitle, verifyUrl }
*/
(function (global) {
  'use strict';

  var MARGIN = 54;
  var AVGW = { helv: 0.50, bold: 0.53, ital: 0.46, cour: 0.60, serif: 0.50, serifb: 0.54, serifi: 0.49 };

  function esc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
  function clean(s) { return String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, ''); }
  function fontKey(f) { return AVGW[f] ? f : 'helv'; }
  function textWidth(s, size, f) { return clean(s).length * AVGW[fontKey(f)] * size; }

  function fontRefOf(f) {
    switch (f) {
      case 'bold': return '/F2';
      case 'ital': return '/F3';
      case 'cour': return '/F4';
      case 'serif': return '/F5';
      case 'serifb': return '/F6';
      case 'serifi': return '/F7';
      default: return '/F1';
    }
  }

  function wrap(s, size, f, maxW) {
    s = clean(s);
    var words = s.split(/\s+/);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (textWidth(test, size, f) > maxW && cur) { lines.push(cur); cur = words[i]; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function Doc(w, h) {
    this.W = w; this.H = h;
    this.pages = [];
    this.newPage();
  }
  Doc.prototype.newPage = function () {
    this.page = { ops: [] };
    this.pages.push(this.page);
    this.y = this.H - MARGIN;
    return this.page;
  };
  Doc.prototype.ensure = function (hh) { if (this.y - hh < MARGIN) this.newPage(); };
  Doc.prototype.op = function (s) { this.page.ops.push(s); };
  Doc.prototype.rect = function (x, y, w, h, rgb) {
    this.op(rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' rg');
    this.op(x.toFixed(2) + ' ' + y.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re f');
  };
  Doc.prototype.stroke = function (x, y, w, h, rgb, lw) {
    this.op((lw || 1) + ' w ' + rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' RG');
    this.op(x.toFixed(2) + ' ' + y.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re S');
  };
  Doc.prototype.line = function (x1, y1, x2, y2, rgb, lw) {
    this.op((lw || 0.5) + ' w ' + rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' RG');
    this.op(x1.toFixed(2) + ' ' + y1.toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' l S');
  };
  Doc.prototype.textAt = function (str, x, y, size, f, rgb, align, boxW) {
    str = clean(str);
    var tx = x;
    if (align === 'right') tx = x + boxW - textWidth(str, size, f);
    else if (align === 'center') tx = x + (boxW - textWidth(str, size, f)) / 2;
    var c = rgb || [0.04, 0.04, 0.05];
    this.op('BT ' + fontRefOf(f) + ' ' + size + ' Tf ' + c[0] + ' ' + c[1] + ' ' + c[2] + ' rg ' + tx.toFixed(2) + ' ' + y.toFixed(2) + ' Td (' + esc(str) + ') Tj ET');
  };
  Doc.prototype.centerLines = function (str, size, f, rgb, lh, maxW) {
    var lines = wrap(str, size, f, maxW);
    for (var i = 0; i < lines.length; i++) {
      this.ensure(lh); this.y -= lh;
      this.textAt(lines[i], MARGIN, this.y, size, f, rgb, 'center', this.W - MARGIN * 2);
    }
  };
  Doc.prototype.para = function (str, opts) {
    opts = opts || {};
    var size = opts.size || 10.5, f = opts.font || 'helv';
    var rgb = opts.color || [0.23, 0.23, 0.25];
    var lh = opts.lh || size * 1.5;
    var x = opts.x != null ? opts.x : MARGIN;
    var maxW = opts.maxW != null ? opts.maxW : (this.W - MARGIN * 2);
    var lines = wrap(str, size, f, maxW);
    for (var i = 0; i < lines.length; i++) {
      this.ensure(lh); this.y -= lh;
      this.textAt(lines[i], x, this.y, size, f, rgb, opts.align, maxW);
    }
    return lines.length;
  };
  Doc.prototype.gap = function (h) { this.y -= (h || 8); };

  Doc.prototype.build = function () {
    var objs = [];
    function add(body) { objs.push(body); return objs.length; }
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>');
    var resources = '<< /Font << /F1 1 0 R /F2 2 0 R /F3 3 0 R /F4 4 0 R /F5 5 0 R /F6 6 0 R /F7 7 0 R >> >>';
    var pagesId = objs.length + 1;
    var pageIds = [];
    for (var p = 0; p < this.pages.length; p++) {
      var stream = this.pages[p].ops.join('\n');
      var contentId = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
      var pageId = add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + this.W.toFixed(2) + ' ' + this.H.toFixed(2) + '] /Resources ' + resources + ' /Contents ' + contentId + ' 0 R >>');
      pageIds.push(pageId);
    }
    var kids = pageIds.map(function (id) { return id + ' 0 R'; }).join(' ');
    var realPagesId = add('<< /Type /Pages /Kids [' + kids + '] /Count ' + pageIds.length + ' >>');
    var catalogId = add('<< /Type /Catalog /Pages ' + realPagesId + ' 0 R >>');
    var header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    var body = '', offsets = [], pos = header.length;
    for (var i = 0; i < objs.length; i++) {
      var s = (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n';
      offsets.push(pos); body += s; pos += s.length;
    }
    var xrefPos = pos;
    var xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    for (var j = 0; j < offsets.length; j++) xref += ('0000000000' + offsets[j]).slice(-10) + ' 00000 n \n';
    var trailer = 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';
    return header + body + xref + trailer;
  };

  var INK = [0.05, 0.05, 0.06], GREY = [0.42, 0.42, 0.46], SOFT = [0.55, 0.55, 0.58];
  var RUST = [0.85, 0.32, 0.07], GOLD = [0.62, 0.49, 0.16], DARK = [0.043, 0.051, 0.063];

  function isLetter(t) { return t === 'selection' || t === 'lor'; }

  function renderCertificate(d) {
    var doc = new Doc(841.89, 595.28); // A4 landscape
    var W = doc.W, H = doc.H;
    // Outer + inner border
    doc.stroke(24, 24, W - 48, H - 48, GOLD, 2);
    doc.stroke(32, 32, W - 64, H - 64, [0.8, 0.8, 0.82], 0.7);
    // Top band wordmark
    doc.y = H - 70;
    doc.textAt('EduRankAI', MARGIN, doc.y, 16, 'bold', INK, 'center', W - MARGIN * 2);
    doc.gap(8);
    doc.textAt((d.organiser || 'AI Research and Technology'), MARGIN, doc.y, 9, 'helv', SOFT, 'center', W - MARGIN * 2);
    doc.gap(26);
    // Title
    doc.centerLines((d.title || 'Certificate'), 30, 'serifb', INK, 36, W - 200);
    doc.gap(6);
    doc.line(W / 2 - 60, doc.y, W / 2 + 60, doc.y, RUST, 1.4);
    doc.gap(22);
    doc.textAt('This is proudly presented to', MARGIN, doc.y, 11, 'serifi', GREY, 'center', W - MARGIN * 2);
    doc.gap(34);
    doc.centerLines((d.participantName || 'Recipient'), 26, 'serifb', RUST, 30, W - 160);
    doc.gap(16);
    var bodyTxt = d.body || '';
    doc.centerLines(bodyTxt, 11.5, 'serif', [0.2, 0.2, 0.23], 17, W - 220);
    // Footer: signatory left, serial/verify right, date center
    var footY = 96;
    doc.line(MARGIN + 30, footY + 14, MARGIN + 210, footY + 14, [0.7, 0.7, 0.72], 0.6);
    doc.textAt((d.signatoryName || 'Siddharth Prasad'), MARGIN + 30, footY, 11, 'serifb', INK);
    doc.textAt((d.signatoryTitle || 'Founder & CEO') + ', EduRankAI', MARGIN + 30, footY - 13, 8.5, 'helv', SOFT);
    var rX = W - MARGIN - 230;
    doc.textAt('Serial: ' + (d.serial || ''), rX, footY, 8.5, 'cour', INK, 'right', 230);
    doc.textAt('Integrity: ' + (d.integrityHash || ''), rX, footY - 12, 8, 'cour', SOFT, 'right', 230);
    if (d.issuedAt) doc.textAt('Issued: ' + d.issuedAt, rX, footY - 24, 8, 'helv', SOFT, 'right', 230);
    if (d.verifyUrl) doc.textAt('Verify: ' + d.verifyUrl, MARGIN, 50, 7.5, 'cour', SOFT, 'center', W - MARGIN * 2);
    return doc.build();
  }

  function renderLetter(d) {
    var doc = new Doc(595.28, 841.89); // A4 portrait
    var W = doc.W;
    // Header band
    var bandH = 92;
    doc.rect(0, doc.H - bandH, W, bandH, DARK);
    doc.textAt('EduRankAI', MARGIN, doc.H - 38, 20, 'bold', [1, 1, 1]);
    doc.textAt((d.organiser || 'AI Research and Technology  |  Guwahati, Assam, India'), MARGIN, doc.H - 56, 8.5, 'helv', [0.7, 0.7, 0.72]);
    doc.textAt('hr@edurankai.in  |  www.edurankai.in', MARGIN, doc.H - 69, 8.5, 'helv', [0.6, 0.6, 0.62]);
    var rcW = 200, rcX = W - MARGIN - rcW;
    doc.textAt('SERIAL', rcX, doc.H - 38, 7, 'bold', [0.55, 0.55, 0.6], 'right', rcW);
    doc.textAt(d.serial || '', rcX, doc.H - 52, 10, 'cour', [1, 1, 1], 'right', rcW);
    doc.y = doc.H - bandH - 34;
    if (d.issuedAt) { doc.para(d.issuedAt, { size: 9.5, color: SOFT, lh: 13 }); doc.gap(8); }
    // Title
    doc.para((d.title || 'Letter'), { font: 'serifb', size: 17, color: INK, lh: 22 });
    doc.gap(4);
    doc.line(MARGIN, doc.y, MARGIN + 80, doc.y, RUST, 1.4);
    doc.gap(16);
    doc.para('To Whom It May Concern,', { font: 'serif', size: 11, color: INK, lh: 16 });
    doc.gap(8);
    doc.para(d.body || '', { font: 'serif', size: 11, color: [0.2, 0.2, 0.23], lh: 17 });
    if (d.eventTitle) { doc.gap(6); doc.para('Event: ' + d.eventTitle + (d.levelName ? '  |  Level: ' + d.levelName : ''), { size: 9.5, color: SOFT, lh: 13 }); }
    doc.gap(26);
    doc.para('Sincerely,', { font: 'serif', size: 11, color: INK, lh: 16 });
    doc.gap(10);
    doc.para((d.signatoryName || 'Siddharth Prasad'), { font: 'serifb', size: 13, color: INK, lh: 17 });
    doc.para((d.signatoryTitle || 'Founder & CEO') + ', EduRankAI', { size: 9.5, color: GREY, lh: 13 });
    // Footer verify
    doc.gap(22);
    doc.line(MARGIN, doc.y, W - MARGIN, doc.y, [0.85, 0.85, 0.87], 0.6);
    doc.gap(8);
    doc.para('Integrity hash: ' + (d.integrityHash || ''), { font: 'cour', size: 8.5, color: SOFT, lh: 12 });
    if (d.verifyUrl) doc.para('Verify authenticity at: ' + d.verifyUrl, { font: 'cour', size: 8.5, color: RUST, lh: 12 });
    return doc.build();
  }

  function render(d) {
    return isLetter(d.artifactType) ? renderLetter(d) : renderCertificate(d);
  }

  function download(data, filename) {
    try {
      var pdfStr = render(data);
      var bytes = new Uint8Array(pdfStr.length);
      for (var i = 0; i < pdfStr.length; i++) bytes[i] = pdfStr.charCodeAt(i) & 0xff;
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename || 'EduRankAI-Certificate.pdf';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (e) { console.error('era-cert-pdf', e); return false; }
  }

  global.EraCertPdf = { download: download, render: render };
})(window);

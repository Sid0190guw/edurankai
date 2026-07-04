/* era-offer-pdf.js - self-contained PDF generator for offer letters.
   No external library. Builds a real PDF (base-14 fonts, filled rects, lines,
   word-wrapped text, auto pagination) and downloads it in one click.
   Usage: EraOfferPdf.download(data, filename)
*/
(function (global) {
  'use strict';

  var PAGE_W = 595.28, PAGE_H = 841.89;       // A4 in points
  var MARGIN = 50;
  var CONTENT_W = PAGE_W - MARGIN * 2;

  // Approx average glyph width as a fraction of font size (good enough for wrap).
  var AVGW = { helv: 0.50, bold: 0.53, ital: 0.46, cour: 0.60 };

  function esc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
  function clean(s) { return String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, ''); }
  function fontKey(f) { return f === 'bold' ? 'bold' : f === 'ital' ? 'ital' : f === 'cour' ? 'cour' : 'helv'; }
  function textWidth(s, size, f) { return clean(s).length * AVGW[fontKey(f)] * size; }

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

  function Doc() {
    this.pages = [];     // each: { ops: [] }
    this.newPage();
  }
  Doc.prototype.newPage = function () {
    this.page = { ops: [] };
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
    return this.page;
  };
  Doc.prototype.ensure = function (h) { if (this.y - h < MARGIN) this.newPage(); };
  Doc.prototype.op = function (s) { this.page.ops.push(s); };

  // Filled rectangle (x,y are bottom-left; y from page bottom).
  Doc.prototype.rect = function (x, y, w, h, rgb) {
    this.op(rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' rg');
    this.op(x.toFixed(2) + ' ' + y.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re f');
  };
  Doc.prototype.line = function (x1, y1, x2, y2, rgb, lw) {
    this.op((lw || 0.5) + ' w');
    this.op(rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' RG');
    this.op(x1.toFixed(2) + ' ' + y1.toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' l S');
  };
  // Absolute text at (x, yFromTopCursor=false). y is measured from page bottom.
  Doc.prototype.textAt = function (str, x, y, size, f, rgb, align, boxW) {
    str = clean(str);
    var fontRef = f === 'bold' ? '/F2' : f === 'ital' ? '/F3' : f === 'cour' ? '/F4' : '/F1';
    var tx = x;
    if (align === 'right') tx = x + boxW - textWidth(str, size, f);
    else if (align === 'center') tx = x + (boxW - textWidth(str, size, f)) / 2;
    var c = rgb || [0.04, 0.04, 0.05];
    this.op('BT ' + fontRef + ' ' + size + ' Tf ' + c[0] + ' ' + c[1] + ' ' + c[2] + ' rg ' + tx.toFixed(2) + ' ' + y.toFixed(2) + ' Td (' + esc(str) + ') Tj ET');
  };
  // Flowing paragraph from the cursor; advances y. Returns lines used.
  Doc.prototype.para = function (str, opts) {
    opts = opts || {};
    var size = opts.size || 10.5;
    var f = opts.font || 'helv';
    var rgb = opts.color || [0.23, 0.23, 0.25];
    var lh = opts.lh || size * 1.45;
    var x = opts.x != null ? opts.x : MARGIN;
    var maxW = opts.maxW != null ? opts.maxW : CONTENT_W;
    var lines = wrap(str, size, f, maxW);
    for (var i = 0; i < lines.length; i++) {
      this.ensure(lh);
      this.y -= lh;
      this.textAt(lines[i], x, this.y, size, f, rgb, opts.align, maxW);
    }
    return lines.length;
  };
  Doc.prototype.gap = function (h) { this.y -= (h || 8); };

  // Serialize to a PDF byte string.
  Doc.prototype.build = function () {
    var objs = [];                 // object body strings (without "N 0 obj")
    function add(body) { objs.push(body); return objs.length; } // returns 1-based id

    var fontHelv = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    var fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    var fontItal = add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>');
    var fontCour = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
    var resources = '<< /Font << /F1 ' + fontHelv + ' 0 R /F2 ' + fontBold + ' 0 R /F3 ' + fontItal + ' 0 R /F4 ' + fontCour + ' 0 R >> >>';

    var pagesId = objs.length + 1; // placeholder; we add Pages after pages/contents
    // Build content + page objects
    var pageIds = [];
    for (var p = 0; p < this.pages.length; p++) {
      var stream = this.pages[p].ops.join('\n');
      var contentId = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
      var pageId = add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W.toFixed(2) + ' ' + PAGE_H.toFixed(2) + '] /Resources ' + resources + ' /Contents ' + contentId + ' 0 R >>');
      pageIds.push(pageId);
    }
    // Pages tree (id == pagesId by construction order)
    var kids = pageIds.map(function (id) { return id + ' 0 R'; }).join(' ');
    var realPagesId = add('<< /Type /Pages /Kids [' + kids + '] /Count ' + pageIds.length + ' >>');
    // realPagesId must equal pagesId we referenced
    var catalogId = add('<< /Type /Catalog /Pages ' + realPagesId + ' 0 R >>');

    // Assemble with xref
    var header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    var body = '';
    var offsets = [];
    var pos = header.length;
    for (var i = 0; i < objs.length; i++) {
      var s = (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n';
      offsets.push(pos);
      body += s;
      pos += s.length;
    }
    var xrefPos = pos;
    var xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    for (var j = 0; j < offsets.length; j++) {
      xref += ('0000000000' + offsets[j]).slice(-10) + ' 00000 n \n';
    }
    var trailer = 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';
    return header + body + xref + trailer;
  };

  // ── High-level offer-letter layout ──────────────────────────────────────
  var INK = [0.04, 0.04, 0.05];
  var GREY = [0.42, 0.42, 0.46];
  var SOFT = [0.55, 0.55, 0.58];
  var RUST = [1, 0.31, 0];
  var DARK = [0.04, 0.04, 0.047];

  function renderOffer(d) {
    var doc = new Doc();

    // Header band
    var bandH = 118;
    doc.rect(0, PAGE_H - bandH, PAGE_W, bandH, DARK);
    var hx = MARGIN, topY = PAGE_H - 34;
    doc.textAt('EduRankAI', hx, topY, 22, 'bold', [1, 1, 1]);
    doc.textAt('AI Research and Technology  |  Guwahati, Assam, India', hx, topY - 18, 8.5, 'helv', [0.7, 0.7, 0.72]);
    doc.textAt('hr@edurankai.in  |  edurankai.in', hx, topY - 31, 8.5, 'helv', [0.6, 0.6, 0.62]);
    // right column
    var rcW = 200, rcX = PAGE_W - MARGIN - rcW;
    doc.textAt('REFERENCE', rcX, topY, 7, 'bold', [0.55, 0.55, 0.6], 'right', rcW);
    doc.textAt(d.refNumber || '', rcX, topY - 15, 11, 'cour', [1, 1, 1], 'right', rcW);
    if (d.offerDate) doc.textAt(d.offerDate, rcX, topY - 30, 9, 'helv', [0.7, 0.7, 0.72], 'right', rcW);
    doc.textAt('PRIVATE AND CONFIDENTIAL', rcX, topY - 50, 7, 'bold', RUST, 'right', rcW);

    doc.y = PAGE_H - bandH - 28;

    // Candidate
    if (d.candidateName) { doc.para(d.candidateName, { font: 'bold', size: 15, color: INK, lh: 19 }); }
    var contact = [];
    if (d.candidateEmail) contact.push(d.candidateEmail);
    if (d.candidatePhone) contact.push(d.candidatePhone);
    if (contact.length) doc.para(contact.join('   |   '), { size: 9.5, color: SOFT, lh: 13 });
    if (d.candidateCity) doc.para(d.candidateCity, { size: 9.5, color: SOFT, lh: 13 });

    doc.gap(10);
    // Re line (left rust bar)
    var reTxt = 'Re: Offer of ' + (d.employmentType || '') + '  |  ' + (d.roleTitle || '') + (d.department ? ', ' + d.department : '');
    doc.ensure(22);
    doc.rect(MARGIN, doc.y - 16, 3, 18, RUST);
    doc.para(reTxt, { x: MARGIN + 12, maxW: CONTENT_W - 12, font: 'bold', size: 11, color: INK, lh: 16 });

    doc.gap(14);
    // Body paragraphs
    var name = (d.candidateName || '').split(' ')[0] || 'there';
    doc.para('Dear ' + name + ',', { size: 10.5, color: INK, lh: 15 });
    doc.gap(6);
    var paras = (d.bodyParas && d.bodyParas.length) ? d.bodyParas : [
      'We are pleased to extend this formal offer for the position of ' + (d.roleTitle || '') + ' within ' + (d.department || 'the team') + ' at EduRankAI.',
      'This engagement is offered as ' + (d.employmentType || '') + ', work mode ' + (d.workMode || '') + ', for ' + (d.duration || 'the agreed term') + '. Compensation: ' + (d.compensation || 'as discussed') + '.',
      'By accepting, you confirm you have read and agree to EduRankAI\'s Recruitment and Work Policy and Code of Conduct.'
    ];
    for (var i = 0; i < paras.length; i++) { doc.para(paras[i], { size: 10.5, color: [0.2, 0.2, 0.23], lh: 15 }); doc.gap(8); }

    // Founder's remark (fixed, on every offer)
    doc.gap(4);
    doc.ensure(40);
    doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, [0.85, 0.85, 0.87], 0.6);
    doc.gap(8);
    doc.para('A REMARK FROM THE FOUNDER', { font: 'bold', size: 8, color: RUST, lh: 13 });
    doc.gap(3);
    doc.para('Your active contribution hours are fixed in accordance with our policies. Beyond them, we warmly encourage you to devote a further 2.5 hours each day to staying holistically fit. A sound body and a steady mind are the quiet foundation of exceptional work, and so this practice is regarded as part of your eligibility criteria and is assessed accordingly.', { size: 9.5, color: [0.2, 0.2, 0.23], lh: 13.5 });
    doc.gap(5);
    doc.para('A gentle rhythm you might follow for that time:', { size: 9.5, color: [0.2, 0.2, 0.23], lh: 13.5 });
    doc.gap(2);
    var remarkBullets = [
      '15 to 30 minutes of meditation: the chanting of Aum, the Hare Krishna Mahamantra, or any practice true to your own faith.',
      '45 minutes of intensive physical exercise.',
      '15 minutes of focused rest.',
      '30 minutes with the Srimad Bhagavad Gita, or any scripture that speaks to you.'
    ];
    for (var rb = 0; rb < remarkBullets.length; rb++) {
      doc.textAt('-', MARGIN + 6, doc.y - 12, 9.5, 'bold', RUST);
      doc.para(remarkBullets[rb], { x: MARGIN + 16, maxW: CONTENT_W - 16, size: 9.5, color: [0.2, 0.2, 0.23], lh: 13 });
      doc.gap(2);
    }
    doc.gap(4);
    doc.para('Why ask for something so personal in a professional letter? Because good health shapes character, and character is what upholds true professional excellence. Consider this an invitation, offered with care. Thank you for your precious time and your kind efforts.', { size: 9.5, color: [0.2, 0.2, 0.23], lh: 13.5 });
    doc.gap(6);

    // Offer summary table
    doc.gap(6);
    doc.ensure(20);
    doc.y -= 4;
    doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, [0.85, 0.85, 0.87], 0.6);
    doc.gap(6);
    doc.para('OFFER SUMMARY', { font: 'bold', size: 8, color: SOFT, lh: 14 });
    doc.gap(2);
    var rows = [
      ['Position', d.roleTitle], ['Department', d.department], ['Employment Type', d.employmentType],
      ['Work Mode', d.workMode], ['Duration', d.duration], ['Working Hours', d.hoursCommitment],
      ['Compensation', d.compensation], ['Integrity Hash', d.integrityHash]
    ];
    for (var r = 0; r < rows.length; r++) {
      if (!rows[r][1]) continue;
      doc.ensure(20);
      var ry = doc.y - 14;
      doc.textAt(rows[r][0], MARGIN, ry, 9.5, 'helv', GREY);
      var isHash = rows[r][0] === 'Integrity Hash';
      doc.textAt(rows[r][1], MARGIN + 170, ry, isHash ? 9.5 : 10, isHash ? 'cour' : 'bold', isHash ? RUST : INK);
      doc.y -= 20;
      doc.line(MARGIN, doc.y + 4, PAGE_W - MARGIN, doc.y + 4, [0.92, 0.92, 0.93], 0.5);
    }

    // Signatory
    doc.gap(12);
    doc.para('Issued by EduRankAI  |  ' + (d.offerDate || ''), { size: 8, color: SOFT, lh: 12 });
    doc.gap(2);
    doc.para(d.signatoryName || 'EduRankAI', { font: 'ital', size: 14, color: INK, lh: 18 });
    if (d.signatoryTitle) doc.para(d.signatoryTitle, { size: 9.5, color: GREY, lh: 13 });
    doc.para('EduRankAI', { font: 'bold', size: 9.5, color: RUST, lh: 13 });

    // Accepted block
    if (d.signed) {
      doc.gap(14);
      doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, [0.85, 0.85, 0.87], 0.6);
      doc.gap(8);
      doc.para('ACCEPTED BY APPLICANT', { font: 'bold', size: 8, color: SOFT, lh: 13 });
      doc.gap(2);
      doc.para(d.candidateName || '', { font: 'ital', size: 20, color: INK, lh: 26 });
      if (d.signedAt) doc.para('Signed: ' + d.signedAt, { font: 'ital', size: 8.5, color: SOFT, lh: 12 });
    }

    // Access credentials
    doc.gap(14);
    doc.ensure(40);
    doc.para('ACCESS CREDENTIALS', { font: 'bold', size: 8, color: RUST, lh: 14 });
    doc.gap(2);
    doc.para('Sign in at edurankai.in/admin/login using your personal email OR your internal handle - both work.', { size: 9.5, color: [0.2, 0.2, 0.23], lh: 13 });
    doc.gap(4);
    if (d.candidateEmail) { doc.para('Personal email:  ' + d.candidateEmail, { font: 'cour', size: 9.5, color: INK, lh: 13 }); }
    if (d.internalHandle) { doc.para('Internal handle:  ' + d.internalHandle, { font: 'cour', size: 9.5, color: INK, lh: 13 }); }
    doc.para('Password:  set or reset any time via the Set / reset password link. We never display a stored password.', { size: 9, color: SOFT, lh: 12 });

    // Verification
    doc.gap(14);
    doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, [0.85, 0.85, 0.87], 0.6);
    doc.gap(8);
    doc.para('VERIFICATION', { font: 'bold', size: 8, color: SOFT, lh: 13 });
    doc.para('Verify this offer letter at:', { size: 9.5, color: [0.2, 0.2, 0.23], lh: 13 });
    if (d.verifyUrl) doc.para(d.verifyUrl, { font: 'cour', size: 9, color: RUST, lh: 12 });
    doc.gap(4);
    doc.para('Institutions or firms needing a formal certified verification can write to hr@edurankai.in (1 CHF processing fee).', { size: 8.5, color: SOFT, lh: 12 });

    return doc.build();
  }

  function download(data, filename) {
    try {
      var pdfStr = renderOffer(data);
      var bytes = new Uint8Array(pdfStr.length);
      for (var i = 0; i < pdfStr.length; i++) bytes[i] = pdfStr.charCodeAt(i) & 0xff;
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || 'EduRankAI-Offer-Letter.pdf';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (e) {
      console.error('era-offer-pdf', e);
      return false;
    }
  }

  global.EraOfferPdf = { download: download, render: renderOffer };
})(window);

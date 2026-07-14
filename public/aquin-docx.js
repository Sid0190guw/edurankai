/*
 * aquin-docx.js — a REAL .docx writer. Zero dependencies.
 *
 * The old resume "Word" export shipped an HTML string with a .doc extension and an
 * application/msword MIME type. Modern Word refuses that as "the file is corrupt".
 * This builds a genuine Office Open XML package instead: a real ZIP (local file
 * headers + central directory + EOCD, STORED method, real CRC-32) containing
 * [Content_Types].xml, _rels/.rels, word/_rels/document.xml.rels and word/document.xml.
 * Word, LibreOffice and Google Docs open it natively and it stays editable.
 *
 * API:
 *   var d = AquinDocx.create({ marginTwips: 720 });
 *   d.p([{ t:'Name', b:true, sz:32 }], { align:'center', after:60 });
 *   d.p([{ t:'site', link:'https://x.com' }]);
 *   d.bullet([{ t:'a point' }]);
 *   d.rule();                       // horizontal divider
 *   var bytes = d.build();          // Uint8Array -> Blob(type: DOCX_MIME)
 *
 * Run sizes (sz) are HALF-points, per the OOXML spec: sz:22 == 11pt.
 */
(function () {
  var MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = []; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else { out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); } }
    return new Uint8Array(out);
  }

  // minimal ZIP (STORED / no compression) — valid per the PKZIP spec
  function zipStore(files) {
    var u16 = function (v) { return [v & 0xFF, (v >>> 8) & 0xFF]; };
    var u32 = function (v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; };
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data), size = data.length;
      var lh = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(name.length), u16(0));
      parts.push(new Uint8Array(lh), name, data);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))));
      central.push(name);
      offset += lh.length + name.length + size;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var eocd = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(cdStart), u16(0)));
    var all = parts.concat(central, [eocd]);
    var total = 0; all.forEach(function (b) { total += b.length; });
    var out = new Uint8Array(total), p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

  function create(opts) {
    opts = opts || {};
    var margin = opts.marginTwips != null ? opts.marginTwips : 720;   // 720 twips = 0.5"
    var body = [], rels = [], relSeq = 0;

    function runXml(r) {
      var rpr = '';
      if (r.b) rpr += '<w:b/>';
      if (r.i) rpr += '<w:i/>';
      if (r.u || r.link) rpr += '<w:u w:val="single"/>';
      if (r.sz) rpr += '<w:sz w:val="' + r.sz + '"/><w:szCs w:val="' + r.sz + '"/>';
      var color = r.color || (r.link ? '0563C1' : null);
      if (color) rpr += '<w:color w:val="' + color + '"/>';
      if (r.caps) rpr += '<w:caps/>';
      rpr += '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>';
      var run = '<w:r><w:rPr>' + rpr + '</w:rPr><w:t xml:space="preserve">' + esc(r.t) + '</w:t></w:r>';
      if (r.link) {
        var id = 'rIdL' + (++relSeq);
        rels.push('<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + esc(r.link) + '" TargetMode="External"/>');
        return '<w:hyperlink r:id="' + id + '">' + run + '</w:hyperlink>';
      }
      return run;
    }

    var D = {
      // a paragraph of runs. opts: { align, before, after, indent, bullet }
      p: function (runs, o) {
        o = o || {};
        var ppr = '';
        if (o.align) ppr += '<w:jc w:val="' + o.align + '"/>';
        var sp = '';
        if (o.before != null) sp += ' w:before="' + o.before + '"';
        if (o.after != null) sp += ' w:after="' + o.after + '"';
        ppr += '<w:spacing' + (sp || ' w:after="60"') + ' w:line="240" w:lineRule="auto"/>';
        if (o.indent) ppr += '<w:ind w:left="' + o.indent + '"' + (o.hanging ? ' w:hanging="' + o.hanging + '"' : '') + '/>';
        if (o.border) ppr += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>';
        body.push('<w:p><w:pPr>' + ppr + '</w:pPr>' + (runs || []).map(runXml).join('') + '</w:p>');
        return D;
      },
      bullet: function (runs, o) {
        o = o || {};
        var all = [{ t: '•  ' }].concat(runs || []);
        return D.p(all, { indent: o.indent || 284, hanging: 170, after: o.after != null ? o.after : 30 });
      },
      rule: function () { return D.p([{ t: '' }], { border: true, after: 80 }); },
      spacer: function (h) { return D.p([{ t: '' }], { after: h || 120 }); },

      build: function () {
        var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          + '<w:body>' + body.join('')
          + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="' + margin + '" w:right="' + margin + '" w:bottom="' + margin + '" w:left="' + margin + '" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>'
          + '</w:body></w:document>';

        var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          + '<Default Extension="xml" ContentType="application/xml"/>'
          + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          + '</Types>';

        var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
          + '</Relationships>';

        var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>';

        return zipStore([
          { name: '[Content_Types].xml', data: utf8(contentTypes) },
          { name: '_rels/.rels', data: utf8(rootRels) },
          { name: 'word/_rels/document.xml.rels', data: utf8(docRels) },
          { name: 'word/document.xml', data: utf8(doc) }
        ]);
      }
    };
    return D;
  }

  window.AquinDocx = { create: create, MIME: MIME, crc32: crc32, zipStore: zipStore };
})();

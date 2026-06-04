// Replace CDN dependencies with self-hosted ERA library
const fs = require('fs');
const path = require('path');

const FILES_TO_MIGRATE = [
  'src/pages/admin/offer/blank.astro',
  'src/pages/admin/hr/offboarding.astro',
  'src/pages/admin/hr/recommendation.astro',
  'src/pages/portal/offer/[token].astro',
];

let migrated = 0;
let skipped = 0;

for (const filePath of FILES_TO_MIGRATE) {
  const fullPath = path.join(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    console.log('SKIP (not found):', filePath);
    skipped++;
    continue;
  }
  let content = fs.readFileSync(fullPath, 'utf8');
  const original = content;

  // Replace CDN script tags with ERA library
  // qrcode CDN -> era-qr.js
  content = content.replace(
    /<script is:inline src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcode@[^"]+"><\/script>/g,
    '<script is:inline src="/era/era-qr.js"></script>'
  );
  // html2canvas + jspdf CDNs -> era-pdf.js (combined into one)
  content = content.replace(
    /<script is:inline src="https:\/\/cdn\.jsdelivr\.net\/npm\/html2canvas@[^"]+"><\/script>\s*<script is:inline src="https:\/\/cdn\.jsdelivr\.net\/npm\/jspdf@[^"]+"><\/script>/g,
    '<script is:inline src="/era/era-pdf.js"></script>'
  );
  // Individual replacements if not combined
  content = content.replace(
    /<script is:inline src="https:\/\/cdn\.jsdelivr\.net\/npm\/html2canvas@[^"]+"><\/script>/g,
    '<script is:inline src="/era/era-pdf.js"></script>'
  );
  content = content.replace(
    /<script is:inline src="https:\/\/cdn\.jsdelivr\.net\/npm\/jspdf@[^"]+"><\/script>/g,
    ''
  );

  // Replace API calls: html2canvas(target, opts).then(...) -> ERA.PDF.toCanvas(target, opts).then(...)
  // For PDF generation: instead of canvas->PDF, use ERA.PDF.print() which uses browser save-as-PDF
  // Replace the pattern: if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {...}
  content = content.replace(
    /if \(typeof html2canvas === 'undefined' \|\| typeof window\.jspdf === 'undefined'\) \{[^}]+\}/g,
    "if (typeof ERA === 'undefined' || !ERA.PDF) { alert('PDF library not loaded yet. Please refresh and try again.'); return; }"
  );

  // Replace the html2canvas + jspdf rendering block with ERA.PDF.print()
  // The patterns vary slightly across files; do a smart replace
  // Pattern: html2canvas(target, {...}).then(function(canvas) { ... pdf.save(...) ... });
  content = content.replace(
    /html2canvas\(([^,]+),\s*\{[^}]+\}\)\.then\(function\(canvas[A-Za-z]*\)\s*\{[\s\S]*?pdf\.save\(([^)]+)\);?\s*\}\);?/g,
    'ERA.PDF.print($1, { title: $2 });'
  );

  // QR replacement: QRCode.toCanvas(canvas, text, opts, cb) -> ERA.QR.toCanvas(canvas, text, opts)
  content = content.replace(
    /QRCode\.toCanvas\(([^,]+),\s*([^,]+),\s*\{[^}]*\},?\s*function[^}]*\}\);?/g,
    'ERA.QR.toCanvas($1, $2, { scale: 4 });'
  );
  content = content.replace(
    /QRCode\.toCanvas\(([^,]+),\s*([^,]+),\s*\{[^}]*\}\);?/g,
    'ERA.QR.toCanvas($1, $2, { scale: 4 });'
  );

  if (content !== original) {
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log('OK:', filePath);
    migrated++;
  } else {
    console.log('UNCHANGED:', filePath);
    skipped++;
  }
}

console.log('');
console.log('Migrated: ' + migrated);
console.log('Skipped:  ' + skipped);

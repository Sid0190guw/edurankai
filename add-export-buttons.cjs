// Add Export CSV buttons to admin list pages
const fs = require('fs');
const path = require('path');

var EXPORTS = [
  {
    file: 'src/pages/admin/applications/index.astro',
    api: '/api/export/applications',
    label: 'Export CSV',
    // Find a good insertion point - usually right before the search/filter area
    // Pattern: insert after the first <h1 ...> in the body
  },
  {
    file: 'src/pages/admin/users.astro',
    api: '/api/export/users',
    label: 'Export CSV',
  },
  {
    file: 'src/pages/admin/hr/employees/index.astro',
    api: '/api/export/employees',
    label: 'Export CSV',
  },
];

var BUTTON_HTML = function(api, label) {
  return '<a href="' + api + '" class="era-btn era-btn-secondary era-btn-sm" download style="display:inline-flex;align-items:center;gap:5px;text-decoration:none;">' +
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
    label + '</a>';
};

var modified = 0, skipped = 0;
EXPORTS.forEach(function(ex) {
  var full = path.join(process.cwd(), ex.file);
  if (!fs.existsSync(full)) {
    console.log('SKIP (not found): ' + ex.file);
    skipped++;
    return;
  }
  var c = fs.readFileSync(full, 'utf8');
  if (c.indexOf(ex.api) !== -1) {
    console.log('SKIP (already has export): ' + ex.file);
    skipped++;
    return;
  }
  var btn = BUTTON_HTML(ex.api, ex.label);
  // Try to inject the button. Look for the first <h1> in JSX after frontmatter
  // We use a pattern: find the first ---/n then look for h1 or similar header
  var origC = c;
  // Strategy: find first  </h1> closing tag and inject button right after
  // But it must be inside the visible JSX (after the second --- delimiter)
  var fmEndIdx = c.indexOf('---', 3);
  if (fmEndIdx === -1) {
    console.log('SKIP (no frontmatter end): ' + ex.file);
    skipped++;
    return;
  }
  var jsx = c.substring(fmEndIdx + 3);
  // Find first </h1>
  var h1End = jsx.indexOf('</h1>');
  if (h1End === -1) {
    console.log('SKIP (no h1): ' + ex.file);
    skipped++;
    return;
  }
  // Insert after the </h1>; but better to insert a wrapper div with the button
  // Actually easier: find the parent <div ...> that contains <h1...> and append after the h1
  // Just inject right after </h1>
  var beforeJsx = c.substring(0, fmEndIdx + 3);
  var afterJsx = jsx.substring(0, h1End + 5) + '\n  <div style="margin-top:8px;display:flex;gap:6px;">' + btn + '</div>\n' + jsx.substring(h1End + 5);
  c = beforeJsx + afterJsx;
  fs.writeFileSync(full, c, 'utf8');
  console.log('OK: ' + ex.file);
  modified++;
});

console.log('');
console.log('Modified: ' + modified);
console.log('Skipped:  ' + skipped);

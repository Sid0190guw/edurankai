// Wire side-panel preview to application list cards
const fs = require('fs');
const path = require('path');

var filePath = path.join(process.cwd(), 'src', 'pages', 'admin', 'applications', 'index.astro');
if (!fs.existsSync(filePath)) {
  console.log('Applications page not found');
  process.exit(0);
}

var c = fs.readFileSync(filePath, 'utf8');
var orig = c;

// Add data-preview to any link going to /admin/applications/[id]
// Match patterns like: href={`/admin/applications/${a.id}`}
c = c.replace(
  /href=\{`\/admin\/applications\/\$\{([a-zA-Z0-9_.]+)\}`\}/g,
  'href={`/admin/applications/${$1}`} data-preview={`/admin/applications/${$1}`} data-preview-title={`Application: ${$1}`}'
);

// Also any plain href that's literal admin/applications/something - skip those for now

if (c !== orig) {
  fs.writeFileSync(filePath, c, 'utf8');
  console.log('Wired side-panel preview on application links');
} else {
  console.log('No matching links to wire (might already be wired)');
}

// Fix test runner: hide FAB during test, ensure options render as proper buttons
const fs = require('fs');
const path = require('path');

var files = [
  'src/pages/aquintutor/test/[slug]/run.astro',
  'src/pages/aquintutor/test/[slug]/result.astro',
];

files.forEach(function(rel) {
  var full = path.join(process.cwd(), rel);
  if (!fs.existsSync(full)) {
    console.log('SKIP (not found): ' + rel);
    return;
  }
  var c = fs.readFileSync(full, 'utf8');
  var orig = c;

  // 1. Add era-no-fab class to body so the FAB hides during test
  // Find <body and ensure it has era-no-fab class
  if (c.indexOf('era-no-fab') === -1) {
    // Match <body ...> tag
    c = c.replace(/<body([^>]*)>/, function(match, attrs) {
      if (attrs.indexOf('class=') !== -1) {
        // Append to existing class
        return '<body' + attrs.replace(/class="([^"]*)"/, 'class="$1 era-no-fab"') + '>';
      } else {
        return '<body class="era-no-fab"' + attrs + '>';
      }
    });
  }

  // 2. Override era-mobile body padding for test runner
  // Add a <style> block that resets body padding-bottom to 0 for full-screen runner
  if (c.indexOf('/* test-runner-reset */') === -1) {
    var resetCSS = '\n  <style>/* test-runner-reset */\n    body.era-no-fab { padding-bottom: 0 !important; }\n  </style>\n';
    // Insert before </head>
    c = c.replace('</head>', resetCSS + '</head>');
  }

  if (c !== orig) {
    fs.writeFileSync(full, c, 'utf8');
    console.log('OK: ' + rel);
  } else {
    console.log('UNCHANGED: ' + rel);
  }
});

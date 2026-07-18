// src/lib/content-render.test.ts — run: npx tsx src/lib/content-render.test.ts
// Verifies the server-side markdown + LaTeX renderers are real (not passthrough) and safe.
import { mdLite, latexToHtml, escapeHtml } from './content-render';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

// --- markdown ---
const h = mdLite('# Title\n\nHello **world** and `code` and [link](https://x.io).\n\n- a\n- b');
ok('heading rendered', h.includes('<h2>Title</h2>'), h);
ok('bold rendered', h.includes('<strong>world</strong>'));
ok('inline code rendered', h.includes('<code>code</code>'));
ok('safe link rendered', h.includes('<a href="https://x.io"'));
ok('list rendered', h.includes('<ul><li>a</li><li>b</li></ul>'));
ok('paragraph rendered', h.includes('<p>Hello'));

// --- markdown safety (XSS) ---
const x = mdLite('<script>alert(1)</script> and [x](javascript:alert(1))');
ok('script tag escaped, not emitted', !x.includes('<script>') && x.includes('&lt;script&gt;'), x);
ok('javascript: link NOT turned into an anchor', !/<a [^>]*javascript:/i.test(x));

// --- LaTeX subset ---
const e1 = latexToHtml('E = mc^2');
ok('superscript rendered', e1.includes('<sup>2</sup>') && e1.includes('class="eq"'), e1);
const e2 = latexToHtml('\\frac{a}{b}');
ok('fraction rendered', e2.includes('class="frac"') && e2.includes('a') && e2.includes('b'), e2);
const e3 = latexToHtml('\\alpha + \\beta \\leq \\gamma');
ok('greek + operator rendered', e3.includes('α') && e3.includes('β') && e3.includes('≤') && e3.includes('γ'), e3);
const e4 = latexToHtml('x_{i}^{2} \\times 3');
ok('sub+sup+times rendered', e4.includes('<sub>i</sub>') && e4.includes('<sup>2</sup>') && e4.includes('×'), e4);

// --- LaTeX fallback (unknown macro) is honest, not wrong ---
const e5 = latexToHtml('\\underbrace{x}_{y} \\weirdmacro');
ok('unsupported LaTeX falls back to raw source box', e5.includes('eq-raw') && e5.includes(escapeHtml('\\weirdmacro')), e5);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

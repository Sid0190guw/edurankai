// src/lib/content-render.ts — tiny, dependency-free, SERVER-SIDE renderers for KnowledgeObject
// content. Ships ZERO client JS (the pages call these at render time and emit plain HTML).
// - mdLite: a safe markdown subset (escape-first, then a small set of inline/block rules).
// - latexToHtml: a common LaTeX math subset -> HTML (sup/sub/fractions/Greek/operators); any
//   construct it does not know falls back to the raw LaTeX in a <code> box (honest, never wrong).
// Both are pure functions so they are unit-tested without a browser (content-render.test.ts).

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- markdown (safe subset) ----------------------------------------------------------------
function inlineMd(s: string): string {
  // s is already HTML-escaped. Apply inline rules on the escaped text.
  let t = s;
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // links [text](http|https|/path) — restrict scheme to prevent javascript: etc.
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_m, txt, href) => `<a href="${href}" rel="noopener">${txt}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
  return t;
}

/** Render a safe markdown subset to HTML. Headings, bold/italic/code/links, ul/ol, blockquote, paragraphs. */
export function mdLite(src: string): string {
  if (!src) return '';
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let i = 0;
  const flushList = (tag: string, items: string[]) => { if (items.length) { out.push(`<${tag}>` + items.map((x) => `<li>${inlineMd(x)}</li>`).join('') + `</${tag}>`); } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const lvl = h[1].length + 1; out.push(`<h${lvl}>${inlineMd(h[2].trim())}</h${lvl}>`); i++; continue; }
    if (/^\s*>\s?/.test(line)) { const parts: string[] = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { parts.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push(`<blockquote>${inlineMd(parts.join(' '))}</blockquote>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) { const items: string[] = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; } flushList('ul', items); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const items: string[] = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; } flushList('ol', items); continue; }
    // paragraph: gather until blank line
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|\s*>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<p>${inlineMd(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---- LaTeX math (common subset) ------------------------------------------------------------
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const OPS: Record<string, string> = {
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  approx: '≈', equiv: '≡', propto: '∝', infty: '∞', sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇',
  forall: '∀', exists: '∃', in: '∈', notin: '∉', subset: '⊂', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅',
  rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', Leftrightarrow: '⇔', langle: '⟨', rangle: '⟩',
  ldots: '…', cdots: '⋯', angle: '∠', perp: '⊥', deg: '°', ast: '∗', star: '⋆',
};

// Extract a {...} group or a single char starting at index i (after a marker like ^ _ or macro arg).
function grabGroup(s: string, i: number): { body: string; next: number } {
  if (s[i] === '{') { let depth = 1, j = i + 1; while (j < s.length && depth > 0) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; if (depth === 0) break; j++; } return { body: s.slice(i + 1, j), next: j + 1 }; }
  return { body: s[i] ?? '', next: i + 1 };
}

/** Returns { html, ok } — ok=false means we hit something unsupported and the caller should fall back. */
function renderMath(src: string): { html: string; ok: boolean } {
  let out = '', ok = true, i = 0;
  const s = src.replace(/\\left|\\right/g, '').replace(/\\,|\\;|\\!|\\quad|\\qquad/g, ' ');
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const m = s.slice(i + 1).match(/^[a-zA-Z]+/);
      if (m) {
        const name = m[0]; i += 1 + name.length;
        if (name === 'frac') { const a = grabGroup(s, i); const b = grabGroup(s, a.next); i = b.next; const ra = renderMath(a.body), rb = renderMath(b.body); ok = ok && ra.ok && rb.ok; out += `<span class="frac"><span class="fnum">${ra.html}</span><span class="fden">${rb.html}</span></span>`; continue; }
        if (name === 'sqrt') { const a = grabGroup(s, i); i = a.next; const ra = renderMath(a.body); ok = ok && ra.ok; out += `<span class="sqrt">√<span class="srad">${ra.html}</span></span>`; continue; }
        if (name === 'text' || name === 'mathrm' || name === 'mathbf') { const a = grabGroup(s, i); i = a.next; out += escapeHtml(a.body); continue; }
        if (GREEK[name]) { out += GREEK[name]; continue; }
        if (OPS[name]) { out += OPS[name]; continue; }
        ok = false; out += escapeHtml('\\' + name); continue;   // unknown macro -> not ok
      }
      out += escapeHtml(ch); i++; continue;
    }
    if (ch === '^' || ch === '_') { const g = grabGroup(s, i + 1); i = g.next; const r = renderMath(g.body); ok = ok && r.ok; out += ch === '^' ? `<sup>${r.html}</sup>` : `<sub>${r.html}</sub>`; continue; }
    if (ch === '{' || ch === '}') { i++; continue; }
    out += escapeHtml(ch); i++;
  }
  return { html: out, ok };
}

/** Render a LaTeX math string to HTML. Falls back to the raw source in a <code> box if unsupported. */
export function latexToHtml(latex: string): string {
  if (!latex) return '';
  const r = renderMath(latex.trim());
  if (!r.ok) return `<code class="eq-raw">${escapeHtml(latex.trim())}</code>`;
  return `<span class="eq">${r.html}</span>`;
}

// Minimal CSS the pages inline once so fractions/roots read correctly (no external stylesheet).
export const EQUATION_CSS = `.eq{font-family:'Cambria Math','Times New Roman',serif;font-size:1.05em}
.eq .frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;margin:0 .15em}
.eq .frac .fnum{border-bottom:1px solid currentColor;padding:0 .3em}
.eq .frac .fden{padding:0 .3em}
.eq .sqrt .srad{border-top:1px solid currentColor;padding:0 .2em}
.eq sup,.eq sub{font-size:.72em}
.eq-raw{font-family:'Geist Mono',monospace;font-size:.9em;background:rgba(0,0,0,0.05);padding:2px 6px;border-radius:4px}`;

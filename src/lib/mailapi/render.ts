// src/lib/mailapi/render.ts — the template renderer. Pure: no database, no network, no clock.
//
// THIS IS THE MECHANISM /admin/mail/templates SAID DID NOT EXIST. That screen's own header records
// the problem honestly: "nothing anywhere in the mail path substitutes a placeholder", so a template
// full of {{first_name}} went out with the braces intact. It stayed true because the composer sends
// ONE message row to many recipients — a per-person merge is a different send model, not a wording
// change. The transactional API is that different model: one API call, one message, one recipient
// set that shares the same variables. So substitution is finally safe to do, and it is done here.
//
// A MISSING VARIABLE IS AN ERROR, NOT AN EMPTY STRING. Rendering `Dear ,` and delivering it is worse
// than refusing: the mail is already in the candidate's inbox by the time anybody notices. Every
// render reports exactly which paths were unresolved, and the send path turns that into a 422 with
// the names in it. A caller who genuinely wants a blank passes an empty string, which is present.
//
// NO eval, NO Function, NO template library. The syntax below is small enough to parse directly, and
// a mail body is attacker-adjacent input — template engines that compile to JavaScript have a long
// history of turning a content edit into remote code execution.

export interface RenderOptions {
  /** HTML-escape substituted values. True for an HTML body, false for a subject line or a text part. */
  escape?: boolean;
  /** Cap on output size, so a runaway {{#each}} cannot exhaust memory. */
  maxOutputBytes?: number;
}

export interface RenderResult {
  output: string;
  /** Variable paths referenced by the template that the caller did not supply. */
  missing: string[];
  /** True when the output hit maxOutputBytes and was cut. */
  truncated: boolean;
}

const DEFAULT_MAX_OUTPUT = 512 * 1024;

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; path: string; raw: boolean }
  | { t: 'section'; kind: 'if' | 'unless' | 'each'; path: string; body: Node[]; alt: Node[] };

const TAG = /\{\{\{?\s*([#\/]?)\s*([^{}]*?)\s*\}?\}\}/g;

/**
 * Parse a template into nodes. Unknown or malformed tags are left as literal text rather than
 * throwing: a stray brace in a body is a typo, and a typo must not stop a password reset going out.
 * Unclosed sections ARE reported, because they change the meaning of everything after them.
 */
export function parse(source: string): { nodes: Node[]; errors: string[] } {
  const src = String(source || '');
  const errors: string[] = [];
  const rootBody: Node[] = [];
  // Each stack frame is an open section; `into` is the list currently being filled (body or alt).
  const stack: { kind: 'if' | 'unless' | 'each'; path: string; body: Node[]; alt: Node[]; inAlt: boolean }[] = [];
  const current = () => {
    const top = stack[stack.length - 1];
    if (!top) return rootBody;
    return top.inAlt ? top.alt : top.body;
  };

  let last = 0;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(src)) !== null) {
    const [full, marker, inner] = m;
    if (m.index > last) current().push({ t: 'text', v: src.slice(last, m.index) });
    last = m.index + full.length;
    const raw = full.startsWith('{{{');
    const body = inner.trim();

    if (marker === '#') {
      const [kw, ...rest] = body.split(/\s+/);
      const path = rest.join(' ').trim();
      if ((kw === 'if' || kw === 'unless' || kw === 'each') && path) {
        stack.push({ kind: kw, path, body: [], alt: [], inAlt: false });
      } else {
        errors.push('Unknown block `' + body + '`. Supported blocks are #if, #unless and #each.');
        current().push({ t: 'text', v: full });
      }
      continue;
    }
    if (marker === '/') {
      const top = stack.pop();
      if (!top) {
        errors.push('Closing tag `' + body + '` has no matching opening block.');
        continue;
      }
      if (body && body !== top.kind) {
        errors.push('Block `' + top.kind + ' ' + top.path + '` was closed with `/' + body + '`.');
      }
      current().push({ t: 'section', kind: top.kind, path: top.path, body: top.body, alt: top.alt });
      continue;
    }
    if (body === 'else') {
      const top = stack[stack.length - 1];
      if (!top) { errors.push('`else` outside a block.'); continue; }
      top.inAlt = true;
      continue;
    }
    if (!body) { current().push({ t: 'text', v: full }); continue; }
    current().push({ t: 'var', path: body, raw });
  }
  if (last < src.length) current().push({ t: 'text', v: src.slice(last) });

  while (stack.length) {
    const top = stack.pop()!;
    errors.push('Block `' + top.kind + ' ' + top.path + '` was never closed.');
    rootBody.push({ t: 'section', kind: top.kind, path: top.path, body: top.body, alt: top.alt });
  }
  return { nodes: rootBody, errors };
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

const MISSING = Symbol('missing');

function resolve(path: string, scopes: any[]): any {
  if (path === 'this' || path === '.') {
    const v = scopes[scopes.length - 1];
    return v === undefined || v === null ? MISSING : v;
  }
  const parts = path.split('.').filter(Boolean);
  // Innermost scope wins, so {{name}} inside {{#each people}} reads the person, then falls back to
  // the top-level variables — which is what anybody writing the template expects.
  for (let i = scopes.length - 1; i >= 0; i--) {
    let cur: any = scopes[i];
    let ok = true;
    for (const p of parts) {
      if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, p)) {
        cur = cur[p];
      } else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null) return cur;
    if (ok && (cur === undefined || cur === null)) return MISSING;
  }
  return MISSING;
}

function stringify(v: any): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  try { return JSON.stringify(v); } catch { return String(v); }
}

function truthy(v: any): boolean {
  if (v === MISSING || v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function render(source: string, variables: Record<string, any>, opts: RenderOptions = {}): RenderResult {
  const escape = opts.escape !== false;
  const max = opts.maxOutputBytes || DEFAULT_MAX_OUTPUT;
  const { nodes } = parse(source);
  const missing = new Set<string>();
  let out = '';
  let truncated = false;

  const push = (s: string) => {
    if (truncated) return;
    if (out.length + s.length > max) { out += s.slice(0, Math.max(0, max - out.length)); truncated = true; return; }
    out += s;
  };

  const walk = (list: Node[], scopes: any[], depth: number) => {
    if (depth > 12) return; // a template nesting twelve deep is a mistake, not a design
    for (const n of list) {
      if (truncated) return;
      if (n.t === 'text') { push(n.v); continue; }
      if (n.t === 'var') {
        const v = resolve(n.path, scopes);
        if (v === MISSING) { missing.add(n.path); continue; }
        const s = stringify(v);
        push(n.raw || !escape ? s : escapeHtml(s));
        continue;
      }
      const v = resolve(n.path, scopes);
      if (n.kind === 'each') {
        const list2 = v === MISSING ? [] : (Array.isArray(v) ? v : [v]);
        if (list2.length === 0) { walk(n.alt, scopes, depth + 1); continue; }
        list2.forEach((item, i) => {
          walk(n.body, scopes.concat([{ ...(typeof item === 'object' && item ? item : {}), '@index': i, '@number': i + 1 }, item]), depth + 1);
        });
        continue;
      }
      const test = n.kind === 'if' ? truthy(v) : !truthy(v);
      walk(test ? n.body : n.alt, scopes, depth + 1);
    }
  };

  walk(nodes, [variables || {}], 0);
  return { output: out, missing: Array.from(missing).sort(), truncated };
}

/**
 * Every variable path a template references, ignoring block keywords and loop-local names.
 *
 * This is what the template API returns as `variables` and what the console shows next to the editor
 * so somebody writing a template can see what a caller will have to supply.
 */
export function extractVariables(...sources: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    const { nodes } = parse(s);
    // `prefix` is the loop path a node sits inside, if any. A reference inside {{#each steps}} is
    // reported as `steps[].title` rather than as a top-level `title`, because a caller CANNOT supply
    // `title` at the top level — it comes from each item. Reporting it plainly would send somebody
    // looking for a variable that does not exist; omitting it entirely would hide what the loop body
    // reads. The qualified name says both things.
    const walk = (list: Node[], prefix: string) => {
      for (const n of list) {
        if (n.t === 'var') {
          if (n.path === 'this' || n.path === '.' || n.path.startsWith('@')) continue;
          found.add(prefix ? prefix + '[].' + n.path : n.path);
        } else if (n.t === 'section') {
          if (!n.path.startsWith('@') && n.path !== 'this' && n.path !== '.') {
            found.add(prefix ? prefix + '[].' + n.path : n.path);
          }
          const inner = n.kind === 'each' ? (prefix ? prefix + '[].' + n.path : n.path) : prefix;
          walk(n.body, inner);
          walk(n.alt, prefix);
        }
      }
    };
    walk(nodes, '');
  }
  return Array.from(found).sort();
}

/** Syntax problems in a template, for the editor and for POST /v1/templates. */
export function validateTemplateSyntax(...sources: (string | null | undefined)[]): string[] {
  const errors: string[] = [];
  for (const s of sources) {
    if (!s) continue;
    errors.push(...parse(s).errors);
  }
  return Array.from(new Set(errors));
}

// ---------------------------------------------------------------------------
// Plain-text fallback
// ---------------------------------------------------------------------------

/**
 * Derive a readable text/plain part from an HTML body.
 *
 * Not a general HTML-to-Markdown converter — it exists so a message never goes out HTML-only, which
 * is both an accessibility failure and a strong spam signal. Links keep their target in parentheses
 * because a text-only reader who cannot see the anchor still needs the URL.
 */
export function htmlToText(html: string): string {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const text = String(label).replace(/<[^>]+>/g, '').trim();
    return text && text !== href ? text + ' (' + href + ')' : href;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|tr|li|table|section|header|footer)>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

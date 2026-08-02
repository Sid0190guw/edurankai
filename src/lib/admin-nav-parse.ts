// src/lib/admin-nav-parse.ts — read the sidebar's own source and report what is in it.
//
// WHY THIS IS NOT A COPY OF THE NAV. The nav array and the NAV_SECTION map live in the frontmatter of
// src/layouts/AdminLayout.astro, which nothing can import — an .astro component exports a component,
// not its consts. Any page that wants to show "what would this role see in the sidebar" therefore has
// two options: keep a second, hand-maintained copy of the nav (which is one edit away from lying —
// exactly the failure this console exists to prevent), or read the layout's own text.
//
// This reads the text. `?raw` is resolved by Vite at BUILD time (Astro's own plugin skips ids with a
// ?raw query — see hasSpecialQueries in astro/dist/vite-plugin-utils), so the caller gets the real
// file contents inlined into the bundle. No filesystem access at runtime, nothing to ship to the
// serverless function, and no way for the answer to drift: add a nav entry to the layout and it
// appears here on the next deploy.
//
// IT REPORTS ITS OWN FAILURE. Parsing source with regular expressions is only as stable as the
// formatting it was written against. If the layout is reformatted past what this understands, the
// result carries `ok: false` and a `problem` string so the page can say so loudly, rather than
// rendering an empty table that reads like "this role sees nothing" — a wrong answer here is worse
// than no answer, because the whole point is to be believed.

export interface ParsedNavItem {
  id: string;
  label: string;
  href: string;
  /** The collapsible group this entry sits under in the sidebar, or null for a top-level entry. */
  group: string | null;
}

export interface ParsedAdminNav {
  ok: boolean;
  problem: string | null;
  items: ParsedNavItem[];
  /** nav id -> admin section key. A Map, not a Record, so duplicate keys resolve the way the object literal does (last wins) and JSX never sees a typed index signature. */
  navSection: Map<string, string>;
  /** Nav ids every signed-in admin keeps regardless of section grants. */
  universal: Set<string>;
}

/** Drop whole-line `//` comments. Every comment inside the two blocks we read is on its own line, and this keeps prose out of the entry regexes. */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/**
 * Return the text between `open` and its matching `close`, starting at or after `fromIndex`.
 * Quote-aware, so a bracket inside a string literal cannot unbalance the count.
 */
function matchedBlock(source: string, fromIndex: number, open: string, close: string): { body: string; end: number } | null {
  const start = source.indexOf(open, fromIndex);
  if (start === -1) return null;
  let depth = 0;
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { body: source.slice(start + 1, i), end: i };
    }
  }
  return null;
}

/**
 * Same as matchedBlock, but starts looking only after the `=` of the declaration.
 *
 * Without this, `const navStructure: (NavItem | NavGroup)[] = [` hands back the empty `[]` of the
 * TYPE annotation and the nav reads as zero entries — which is precisely the silent-wrong-answer this
 * module must not produce.
 */
function assignedBlock(source: string, declIndex: number, open: string, close: string): { body: string; end: number } | null {
  const eq = source.indexOf('=', declIndex);
  if (eq === -1) return null;
  return matchedBlock(source, eq, open, close);
}

export function parseAdminNav(source: string): ParsedAdminNav {
  const empty: ParsedAdminNav = { ok: false, problem: null, items: [], navSection: new Map(), universal: new Set() };

  const navStart = source.indexOf('const navStructure');
  if (navStart === -1) return { ...empty, problem: 'The layout no longer declares `const navStructure`.' };
  const navBlock = assignedBlock(source, navStart, '[', ']');
  if (!navBlock) return { ...empty, problem: 'Could not find the end of the `navStructure` array.' };

  const mapStart = source.indexOf('const NAV_SECTION');
  if (mapStart === -1) return { ...empty, problem: 'The layout no longer declares `const NAV_SECTION`.' };
  const mapBlock = assignedBlock(source, mapStart, '{', '}');
  if (!mapBlock) return { ...empty, problem: 'Could not find the end of the `NAV_SECTION` map.' };

  // ---- NAV_SECTION: `key: 'section'` or `'key': 'section'`, later entries winning, as the object literal does.
  const navSection = new Map<string, string>();
  const mapBody = stripLineComments(mapBlock.body);
  const entryRe = /(?:'([^']+)'|([A-Za-z_][\w-]*))\s*:\s*'([^']+)'/g;
  for (let m = entryRe.exec(mapBody); m !== null; m = entryRe.exec(mapBody)) {
    navSection.set(m[1] || m[2], m[3]);
  }

  // ---- UNIVERSAL_NAV: the ids that bypass the section filter entirely.
  const universal = new Set<string>();
  const uniStart = source.indexOf('const UNIVERSAL_NAV');
  if (uniStart !== -1) {
    const uniBlock = assignedBlock(source, uniStart, '[', ']');
    if (uniBlock) {
      const idRe = /'([^']+)'/g;
      for (let m = idRe.exec(uniBlock.body); m !== null; m = idRe.exec(uniBlock.body)) universal.add(m[1]);
    }
  }

  // ---- Groups, so a child entry can be shown under the heading it actually appears beneath.
  const body = stripLineComments(navBlock.body);
  const groups: { label: string; start: number; end: number }[] = [];
  const groupRe = /groupId:\s*'([^']+)'/g;
  for (let m = groupRe.exec(body); m !== null; m = groupRe.exec(body)) {
    const after = body.slice(m.index, m.index + 400);
    const labelMatch = /label:\s*'([^']+)'/.exec(after);
    const childrenAt = body.indexOf('children:', m.index);
    if (childrenAt === -1) continue;
    const childBlock = matchedBlock(body, childrenAt, '[', ']');
    if (!childBlock) continue;
    groups.push({ label: labelMatch ? labelMatch[1] : m[1], start: childrenAt, end: childBlock.end });
  }

  // ---- The entries themselves. A group header carries `groupId` and no `href`, so it never matches.
  const items: ParsedNavItem[] = [];
  const itemRe = /[{,]\s*id:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*href:\s*'([^']+)'/g;
  for (let m = itemRe.exec(body); m !== null; m = itemRe.exec(body)) {
    const owner = groups.find((g) => m!.index > g.start && m!.index < g.end);
    items.push({ id: m[1], label: m[2], href: m[3], group: owner ? owner.label : null });
  }

  if (items.length === 0) return { ...empty, navSection, universal, problem: 'Found the nav array but could not read any entries out of it.' };
  if (navSection.size === 0) return { ...empty, items, universal, problem: 'Found the NAV_SECTION map but could not read any mappings out of it.' };

  return { ok: true, problem: null, items, navSection, universal };
}

/**
 * The sidebar's own visibility test, applied to a set of granted section keys.
 *
 * Mirrors `canSee()` in AdminLayout.astro, including the part that matters most: an unmapped nav id
 * FAILS CLOSED for a restricted user. That behaviour is invisible to whoever adds a nav entry, which
 * is why the console lists the unmapped ids separately.
 *
 * @param allowedKeys null means "no section filtering at all" — a super_admin, or a role with no
 *                    entry in ROLE_SECTIONS, which is not the same thing and is worth showing.
 */
export function navIdVisible(nav: ParsedAdminNav, id: string, allowedKeys: Set<string> | null): boolean {
  if (allowedKeys === null) return true;
  if (nav.universal.has(id)) return true;
  const key = nav.navSection.get(id);
  if (!key) return false;
  return allowedKeys.has(key);
}

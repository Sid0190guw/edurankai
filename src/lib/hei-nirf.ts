// src/lib/hei-nirf.ts — a REAL ingester for India's national ranking framework (NIRF).
//
// This is a bespoke parser for one real source, not a generic "crawl the internet" claim.
// The publisher serves plain server-rendered HTML (no JS rendering) and publishes no
// robots.txt (verified: 404 -> no crawl restrictions), so a polite, low-volume, cached
// read of a public ranking table is legitimate.
//
// Shape of the source (verified against the live page):
//   <table id="tbl_overall">
//     <thead><tr><th>Institute ID</th><th>Name</th><th>City</th><th>State</th>
//                <th>Score</th><th>Rank</th></tr></thead>
//     <tbody><tr><td>IR-E-U-0456</td><td>Indian Institute of Technology Madras<div…>…</div></td>
//                <td>Chennai</td><td>Tamil Nadu</td><td>89.46</td><td>1</td></tr>
//
// The name cell carries nested markup (More Details / PDF links / a hidden panel), so the
// name is taken as the text BEFORE the first nested <div> and then tag-stripped.
//
// HONEST SCOPE: parsing + normalisation are real and tested against the live page. If the
// publisher changes its markup this parser must be updated — that is the true cost of a
// bespoke ingester, and why "crawl everything" is not a 100-line claim.

const UA = 'EduRankAI-HEI/1.0 (+https://www.edurankai.in; hei@edurankai.in)';
const BASE = 'https://www.nirfindia.org/Rankings';

// category -> URL segment. Rank bands extend a category beyond its top list.
export const NIRF_CATEGORIES: Record<string, string> = {
  Overall: 'OverallRanking', Engineering: 'EngineeringRanking', University: 'UniversityRanking',
  Management: 'ManagementRanking', College: 'CollegeRanking', Medical: 'MedicalRanking',
  Pharmacy: 'PharmacyRanking', Law: 'LawRanking', Architecture: 'ArchitectureRanking',
  Dental: 'DentalRanking', Research: 'ResearchRanking', Agriculture: 'AgricultureRanking',
  Innovation: 'InnovationRanking'
};
// bands available for the big categories ('' = the default top list)
export const NIRF_BANDS = ['', '150', '200', '300'];

export interface NirfRow {
  instituteId: string; name: string; city: string | null; state: string | null;
  score: number | null; rank: number | null; rankBand: string | null; category: string; year: number;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

// Each row's "More Details" panel contains its own NESTED <table>. So a non-greedy
// /<table>[\s\S]*?<\/table>/ closes on the FIRST nested </table> and a /<tr>...<\/tr>/
// closes on a nested </tr> — which silently truncated the page to one broken row.
// Regex cannot balance nested tags, so these two scanners track <table> depth and only
// take rows/cells belonging to OUR table.

/** Top-level <tr> blocks of the table that starts at `from` in `html`. */
function topLevelRows(html: string, from: number): string[] {
  const re = /<\/?(?:table|tr)\b[^>]*>/gi;
  re.lastIndex = from;
  const rows: string[] = [];
  let depth = 0, rowStart = -1, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0].toLowerCase();
    const isClose = tag.startsWith('</');
    if (/^<\/?table\b/.test(tag)) {
      depth += isClose ? -1 : 1;
      if (depth === 0) break;                 // our table closed
      continue;
    }
    if (depth !== 1) continue;                // a <tr> inside a nested table
    if (!isClose && rowStart < 0) rowStart = m.index;
    else if (isClose && rowStart >= 0) { rows.push(html.slice(rowStart, m.index + m[0].length)); rowStart = -1; }
  }
  return rows;
}

/** Contents of the row's own <td> cells (skipping cells of nested tables). */
function topLevelCells(rowHtml: string): string[] {
  const re = /<\/?(?:table|td)\b[^>]*>/gi;
  const cells: string[] = [];
  let depth = 0, start = -1, m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml))) {
    const tag = m[0].toLowerCase();
    const isClose = tag.startsWith('</');
    if (/^<\/?table\b/.test(tag)) { depth += isClose ? -1 : 1; continue; }
    if (depth !== 0) continue;
    if (!isClose && start < 0) start = m.index + m[0].length;
    else if (isClose && start >= 0) { cells.push(rowHtml.slice(start, m.index)); start = -1; }
  }
  return cells;
}

/** Parse a NIRF ranking page's table into rows. Pure — no network. */
export function parseNirf(html: string, category: string, year: number, band = ''): NirfRow[] {
  const at = html.search(/<table[^>]*id=["']tbl_overall["']/i);
  if (at < 0) return [];

  const rows: NirfRow[] = [];
  for (const tr of topLevelRows(html, at)) {
    const tds = topLevelCells(tr);
    if (tds.length < 6) continue;

    const instituteId = stripTags(tds[0]);
    if (!/^IR-/i.test(instituteId)) continue;               // header/spacer rows

    // name cell: take text before the first nested <div>, then strip any remaining tags
    const name = stripTags(tds[1].split(/<div/i)[0]);
    if (!name) continue;

    const city = stripTags(tds[2]) || null;
    const state = stripTags(tds[3]) || null;
    const scoreN = parseFloat(stripTags(tds[4]));
    const rankTxt = stripTags(tds[5]);
    const rankN = parseInt(rankTxt, 10);

    rows.push({
      instituteId, name, city, state,
      score: Number.isFinite(scoreN) ? scoreN : null,
      rank: Number.isFinite(rankN) ? rankN : null,        // banded pages show e.g. "101-150"
      rankBand: Number.isFinite(rankN) ? null : (rankTxt || null),
      category, year
    });
  }
  return rows;
}

export function nirfUrl(category: string, year: number, band = ''): string {
  const seg = NIRF_CATEGORIES[category];
  if (!seg) throw new Error('unknown NIRF category "' + category + '"');
  return `${BASE}/${year}/${seg}${band}.html`;
}

/** Fetch + parse one NIRF ranking page. */
export async function fetchNirf(category: string, year: number, band = '', timeoutMs = 30000): Promise<NirfRow[]> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(nirfUrl(category, year, band), { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error('source responded ' + res.status + ' for ' + category + ' ' + year + (band ? ' band ' + band : ''));
    return parseNirf(await res.text(), category, year, band);
  } finally { clearTimeout(to); }
}

// src/lib/hei-miner.ts — the HEI data miner. Pulls REAL, live university data from the
// open public knowledge graph (Wikidata's SPARQL endpoint) and normalises it into the
// shape of hei_institutions.
//
// WHY THIS SOURCE, HONESTLY:
//  - "Mine the whole internet" is not a thing code can do — that is Google-scale
//    infrastructure (billions of pages, distributed crawlers, petabytes of storage).
//  - What IS real: a free, structured, openly-licensed knowledge graph that already
//    holds tens of thousands of universities worldwide (name, country, city, website,
//    founding year, student count), is edited continuously (so a change made a second
//    ago is queryable), and is *designed* to be queried. No scraping, no robots.txt
//    violation, no rate-limit abuse, no legal grey area.
//  - For a single institution we can additionally read its own site's schema.org
//    JSON-LD, which universities publish as a standard.
//
// Mined rows are NEVER auto-published: they land with isPublished=false so a human
// reviews before anything appears in a public ranking. Unverified data must not shape
// an institution's public score.

const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'EduRankAI-HEI/1.0 (https://www.edurankai.in; hei@edurankai.in)';

// Wikidata QIDs for country filtering. 'all' = no filter (worldwide).
export const COUNTRIES: Record<string, string> = {
  India: 'Q668', 'United States': 'Q30', 'United Kingdom': 'Q145', Canada: 'Q16',
  Australia: 'Q408', Germany: 'Q183', France: 'Q142', Japan: 'Q17', China: 'Q148',
  Singapore: 'Q334', 'United Arab Emirates': 'Q878', Nepal: 'Q837', 'Sri Lanka': 'Q854'
};

export interface MinedInstitution {
  qid: string; name: string; country: string | null; city: string | null;
  websiteUrl: string | null; establishedYear: number | null; studentCount: number | null;
}

export function slugify(s: string): string {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 140) || 'institution';
}

function buildQuery(countryQid: string | null, limit: number, offset: number): string {
  // P31/P279* Q3918 = instance of (a subclass of) university.
  // Page over DISTINCT ?item in a subselect: the OPTIONAL fields below multiply rows,
  // so a plain LIMIT would page by ROW and silently return fewer institutions than asked
  // (and skip records when paging through the full set). The subselect makes limit/offset
  // mean "institutions", which is what callers expect and what paging all of them needs.
  const countryLine = countryQid ? `?item wdt:P17 wd:${countryQid} .` : '';
  return `SELECT ?item ?itemLabel ?countryLabel ?cityLabel ?website ?inception ?students WHERE {
  { SELECT DISTINCT ?item WHERE {
      ?item wdt:P31/wdt:P279* wd:Q3918 .
      ${countryLine}
    } ORDER BY ?item LIMIT ${limit} OFFSET ${offset} }
  OPTIONAL { ?item wdt:P17 ?country. }
  OPTIONAL { ?item wdt:P131 ?city. }
  OPTIONAL { ?item wdt:P856 ?website. }
  OPTIONAL { ?item wdt:P571 ?inception. }
  OPTIONAL { ?item wdt:P2196 ?students. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

async function runSparql(query: string, timeoutMs = 55000): Promise<any[]> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = SPARQL + '?query=' + encodeURIComponent(query) + '&format=json';
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('knowledge graph responded ' + res.status);
    const j: any = await res.json();
    return j?.results?.bindings || [];
  } finally { clearTimeout(to); }
}

// A row repeats per OPTIONAL combination, so fold by QID and keep the first non-empty value.
function fold(bindings: any[]): MinedInstitution[] {
  const byQid = new Map<string, MinedInstitution>();
  for (const b of bindings) {
    const uri = b.item?.value || '';
    const qid = uri.split('/').pop() || '';
    if (!qid) continue;
    const name = b.itemLabel?.value || '';
    if (!name || /^Q\d+$/.test(name)) continue;              // unlabelled entity -> skip
    const cur = byQid.get(qid) || { qid, name, country: null, city: null, websiteUrl: null, establishedYear: null, studentCount: null };
    if (!cur.country && b.countryLabel?.value) cur.country = b.countryLabel.value;
    if (!cur.city && b.cityLabel?.value) cur.city = b.cityLabel.value;
    if (!cur.websiteUrl && b.website?.value) cur.websiteUrl = b.website.value;
    if (!cur.establishedYear && b.inception?.value) {
      const y = parseInt(String(b.inception.value).slice(0, 4), 10);
      if (y > 800 && y <= new Date().getFullYear()) cur.establishedYear = y;
    }
    if (!cur.studentCount && b.students?.value) {
      const n = parseInt(String(b.students.value), 10);
      if (Number.isFinite(n) && n > 0 && n < 5000000) cur.studentCount = n;
    }
    byQid.set(qid, cur);
  }
  return [...byQid.values()];
}

/** Mine universities. country = a key of COUNTRIES, or 'all' for worldwide. */
export async function mineUniversities(opts: { country?: string; limit?: number; offset?: number } = {}): Promise<MinedInstitution[]> {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
  const offset = Math.max(opts.offset || 0, 0);
  const qid = !opts.country || opts.country === 'all' ? null : (COUNTRIES[opts.country] || null);
  if (opts.country && opts.country !== 'all' && !qid) throw new Error('unsupported country "' + opts.country + '"');
  return fold(await runSparql(buildQuery(qid, limit, offset)));
}

/** How many universities exist for this filter (so "all" can be paged honestly). */
export async function countUniversities(country?: string): Promise<number> {
  const qid = !country || country === 'all' ? null : (COUNTRIES[country] || null);
  const line = qid ? `?item wdt:P17 wd:${qid} .` : '';
  const rows = await runSparql(`SELECT (COUNT(DISTINCT ?item) AS ?n) WHERE { ?item wdt:P31/wdt:P279* wd:Q3918 . ${line} }`);
  return parseInt(rows[0]?.n?.value || '0', 10) || 0;
}

/** Read one institution's own site for schema.org JSON-LD (a standard universities publish). */
export async function mineSiteJsonLd(url: string): Promise<Partial<MinedInstitution> & { raw?: any }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error('site responded ' + res.status);
    const html = await res.text();
    const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const b of blocks) {
      let data: any; try { data = JSON.parse(b[1].trim()); } catch { continue; }
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of nodes) {
        const t = String(n['@type'] || '');
        if (!/Organization|University|College|School/i.test(t)) continue;
        return {
          name: n.name || undefined,
          websiteUrl: n.url || url,
          city: n.address?.addressLocality || null,
          country: n.address?.addressCountry?.name || n.address?.addressCountry || null,
          establishedYear: n.foundingDate ? parseInt(String(n.foundingDate).slice(0, 4), 10) || null : null,
          raw: n
        };
      }
    }
    return {};
  } finally { clearTimeout(to); }
}

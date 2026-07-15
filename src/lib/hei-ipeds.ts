// src/lib/hei-ipeds.ts — REAL ingester for the official US institution directory (IPEDS
// HD file, published by the national education statistics centre).
//
// DUE DILIGENCE (verified before building):
//  - the publisher's robots.txt returns 200 and disallows only four unrelated paths;
//    /ipeds/datacenter/data/ is NOT disallowed, so this download is permitted;
//  - HD2023.zip -> 200, application/x-zip-compressed, 1,110,720 bytes;
//  - it is a single DEFLATE entry (HD2023.csv, 1.1MB -> 4.5MB) holding ~6,164 institutions.
//
// NOTE ON OTHER SOURCES (checked honestly, not assumed):
//  - the popular third-party IPEDS REST API sits behind a bot challenge — getting past it
//    would mean defeating bot protection, so it is not used;
//  - HESA returns 403 to automated requests — it is not ingested here.
//  This file therefore covers the OFFICIAL, openly-published US directory only.
//
// HONEST SCOPE: unzip + CSV parse + field mapping are real and tested against the live
// file. The directory carries identity/location, not quality metrics — it populates who
// exists, not how good they are.
import zlib from 'node:zlib';

const UA = 'EduRankAI-HEI/1.0 (+https://www.edurankai.in; hei@edurankai.in)';
const BASE = 'https://nces.ed.gov/ipeds/datacenter/data';

export interface IpedsRow {
  unitId: string; name: string; city: string | null; state: string | null;
  websiteUrl: string | null; control: string | null;
}

// CONTROL codes in the HD file
const CONTROL: Record<string, string> = { '1': 'Public', '2': 'Private non-profit', '3': 'Private for-profit' };

/** Proper CSV line splitter: fields may be quoted and contain commas / doubled quotes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Extract the first entry of a zip buffer (STORED or DEFLATE) without any dependency. */
export function unzipFirst(buf: Buffer): { name: string; data: Buffer } | null {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(8);
  const csize = buf.readUInt32LE(18);
  const nlen = buf.readUInt16LE(26), elen = buf.readUInt16LE(28);
  const name = buf.subarray(30, 30 + nlen).toString('utf8');
  const start = 30 + nlen + elen;
  const raw = buf.subarray(start, start + csize);
  const data = method === 8 ? zlib.inflateRawSync(raw) : raw;   // 8 = DEFLATE, 0 = STORED
  return { name, data };
}

/** Parse an HD csv into institution rows. Pure — no network. */
export function parseIpedsHd(csv: string): IpedsRow[] {
  const lines = csv.split(/\r?\n/);
  if (!lines.length) return [];
  // The file carries a UTF-8 BOM but is decoded as latin1 (its real encoding), so the BOM
  // arrives as the three chars "ï»¿" — not U+FEFF. Stripping only U+FEFF left the first
  // header as "ï»¿UNITID", so UNITID never matched and every unit id came out empty.
  const hdr = parseCsvLine(lines[0]).map((h) => h.replace(/^(?:﻿|ï»¿)/, '').trim().toUpperCase());
  const idx = (n: string) => hdr.indexOf(n);
  const iId = idx('UNITID'), iName = idx('INSTNM'), iCity = idx('CITY'),
        iState = idx('STABBR'), iWeb = idx('WEBADDR'), iCtl = idx('CONTROL');
  if (iName < 0) return [];

  const rows: IpedsRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const f = parseCsvLine(l);
    const name = (f[iName] || '').trim();
    if (!name) continue;
    let web = iWeb >= 0 ? (f[iWeb] || '').trim() : '';
    if (web && !/^https?:\/\//i.test(web)) web = 'https://' + web.replace(/^\/+/, '');
    rows.push({
      unitId: (f[iId] || '').trim(),
      name,
      city: iCity >= 0 ? (f[iCity] || '').trim() || null : null,
      state: iState >= 0 ? (f[iState] || '').trim() || null : null,
      websiteUrl: web || null,
      control: iCtl >= 0 ? (CONTROL[(f[iCtl] || '').trim()] || null) : null
    });
  }
  return rows;
}

/** Fetch + unzip any IPEDS data file (e.g. HD2023, DRVEF2023) as raw CSV text. */
export async function fetchIpedsCsv(fileName: string, timeoutMs = 45000): Promise<string> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${fileName}.zip`, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error('source responded ' + res.status + ' for ' + fileName);
    const entry = unzipFirst(Buffer.from(await res.arrayBuffer()));
    if (!entry) throw new Error(fileName + ' is not a readable zip');
    return entry.data.toString('latin1');
  } finally { clearTimeout(to); }
}

// IPEDS writes '.' (and variants) for "not applicable / not reported". Turning that into 0
// would silently invent a 0% graduation rate, so it must become null.
function num(v: string | undefined): number | null {
  const s = (v ?? '').trim();
  if (!s || /^\.+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Generic: map a derived file into { unitId -> picked columns }. Pure. */
export function parseByUnitId(csv: string, cols: string[]): Map<string, Record<string, number | null>> {
  const out = new Map<string, Record<string, number | null>>();
  const lines = csv.split(/\r?\n/);
  if (!lines.length) return out;
  const hdr = parseCsvLine(lines[0]).map((h) => h.replace(/^(?:﻿|ï»¿)/, '').trim().toUpperCase());
  const iId = hdr.indexOf('UNITID');
  if (iId < 0) return out;
  const want = cols.map((c) => ({ c, i: hdr.indexOf(c.toUpperCase()) })).filter((x) => x.i >= 0);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = parseCsvLine(lines[i]);
    const id = (f[iId] || '').trim();
    if (!id) continue;
    const rec: Record<string, number | null> = {};
    for (const w of want) rec[w.c] = num(f[w.i]);
    out.set(id, rec);
  }
  return out;
}

export interface IpedsMetric { unitId: string; enrollment: number | null; gradRate: number | null; }

/** Enrollment (DRVEF) + graduation rate (DRVGR) merged by unit id. */
export async function fetchIpedsMetrics(year = 2023): Promise<IpedsMetric[]> {
  const [efCsv, grCsv] = await Promise.all([fetchIpedsCsv('DRVEF' + year), fetchIpedsCsv('DRVGR' + year)]);
  const ef = parseByUnitId(efCsv, ['ENRTOT']);
  const gr = parseByUnitId(grCsv, ['GRRTTOT']);
  const ids = new Set<string>([...ef.keys(), ...gr.keys()]);
  const out: IpedsMetric[] = [];
  for (const id of ids) {
    const enrollment = ef.get(id)?.ENRTOT ?? null;
    const gradRate = gr.get(id)?.GRRTTOT ?? null;
    if (enrollment == null && gradRate == null) continue;
    out.push({ unitId: id, enrollment, gradRate });
  }
  return out;
}

/** Fetch + unzip + parse the HD directory for a year. */
export async function fetchIpeds(year = 2023, timeoutMs = 45000): Promise<IpedsRow[]> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/HD${year}.zip`, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error('source responded ' + res.status + ' for HD' + year);
    const buf = Buffer.from(await res.arrayBuffer());
    const entry = unzipFirst(buf);
    if (!entry) throw new Error('not a readable zip');
    // IPEDS ships these files in latin1, not utf8 — decoding as utf8 mangles names.
    return parseIpedsHd(entry.data.toString('latin1'));
  } finally { clearTimeout(to); }
}

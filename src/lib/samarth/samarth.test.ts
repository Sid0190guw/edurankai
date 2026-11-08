// SAMARTH pure rules. Each block says what breaks in production if it fails.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACKAGES, PUBLISHED_CODES, packageByCode, priceLabel, assessEligibility, validatePackageChoice, validateConfirmedAmount,
  rupeesToPaise, formatInrPaise, groupInr, STANDARD_EXCLUSIONS,
} from '@/lib/samarth/pricing';
import { feeBreakdown, formatMoney, parseMajorToMinor, toSettlementPaise, suggestCurrency, currencyDef, CURRENCIES, minorToMajorString } from '@/lib/samarth/currency';
import {
  canTransition, availableTransitions, applicationStepState, dueDiligenceComplete, DUE_DILIGENCE_ITEMS, isContracted, MACHINES, INCUBATION_PLACES,
} from '@/lib/samarth/workflow';
import { parseAnswers, PATHWAYS, COMMON_QUESTIONS, fieldName, describeAnswers, defaultPathwayFor } from '@/lib/samarth/pathways';
import { APPLICANT_CATEGORIES, isOfficialCategory, GOVERNMENT_LEVELS } from '@/lib/samarth/categories';
import * as catalog from '@/lib/samarth/catalog';
import { newRef, isRef, newToken, hashToken, tokenMatches, zonedLocalToUtc, cleanUrl, cleanEmail, parseDocLinks, isCountryCode } from '@/lib/samarth/validate';
import { parseScores, reviewTotal, aggregate, rankForIncubation, MAX_TOTAL } from '@/lib/samarth/x-scoring';
import { MODULES } from '@/lib/samarth/registry';

describe('consultancy packages (spec Part 6)', () => {
  // A wrong list price here is a wrong price on the public page and on every quotation check.
  it('publishes the specified prices', () => {
    const p = (c: string) => packageByCode(c)!;
    expect(p('general').basePaise).toBe(30000_00);
    expect(p('micro').basePaise).toBe(50000_00);
    expect(p('medium').basePaise).toBe(250000_00);
    expect(p('large').basePaise).toBe(499999_00);
    expect(p('startup_general').basePaise).toBe(40000_00);
    expect(p('startup_venture').basePaise).toBe(40000_00);
    for (const c of ['government', 'engineering', 'infrastructure', 'custom']) expect(p(c).priceKind).toBe('quotation');
    expect(PUBLISHED_CODES.length).toBe(9);
  });
  it('prints prices with Indian grouping and the right qualifier', () => {
    expect(groupInr(250000)).toBe('2,50,000');
    expect(groupInr(499999)).toBe('4,99,999');
    expect(priceLabel(packageByCode('medium')!)).toBe('₹2,50,000 per project');
    expect(priceLabel(packageByCode('general')!)).toBe('₹30,000 starting');
    expect(priceLabel(packageByCode('startup_venture')!)).toBe('₹40,000 onwards');
    expect(priceLabel(packageByCode('government')!)).toBe('Custom quotation');
    expect(formatInrPaise(123456)).toBe('₹1,234.56');
  });
  // Part 6.6: a standard fee that silently included engineering or IP transfer is a contract dispute.
  it('excludes engineering, licences, IP transfer and implementation from every fee', () => {
    expect(STANDARD_EXCLUSIONS.join(' ')).toMatch(/engineering/i);
    expect(STANDARD_EXCLUSIONS.join(' ')).toMatch(/intellectual property/i);
    expect(STANDARD_EXCLUSIONS.join(' ')).toMatch(/implementation/i);
  });
  it('never stacks packages', () => {
    expect(validatePackageChoice(['micro', 'medium']).ok).toBe(false);
    expect(validatePackageChoice('micro,medium').ok).toBe(false);
    expect(validatePackageChoice('micro+large').ok).toBe(false);
    expect(validatePackageChoice('micro')).toEqual({ ok: true, code: 'micro' });
    expect(validatePackageChoice('').ok).toBe(false);
  });
  it('holds confirmed amounts to the package rule', () => {
    expect(validateConfirmedAmount('large', 499999_00).ok).toBe(true);
    expect(validateConfirmedAmount('large', 450000_00).ok).toBe(false);
    expect(validateConfirmedAmount('general', 29000_00).ok).toBe(false);
    expect(validateConfirmedAmount('general', 45000_00).ok).toBe(true);
    expect(validateConfirmedAmount('engineering', 99).ok).toBe(false);
    expect(validateConfirmedAmount('engineering', 1234567_00).ok).toBe(true);
    expect(rupeesToPaise('2,50,000')).toBe(250000_00);
    expect(rupeesToPaise('12.5')).toBe(1250);
    expect(rupeesToPaise('abc')).toBeNull();
  });
});

describe('eligibility assessment', () => {
  const r = (category: string, turnover: string, need: string) => assessEligibility({ category, turnover, need }).recommended;
  // A wrong recommendation steers an applicant to the wrong price.
  it('routes every official body to a quotation, in any country', () => {
    expect(r('government', 'not_disclosed', 'assessment')).toBe('government');
    expect(r('intergovernmental', 'not_disclosed', 'project')).toBe('government');
    expect(r('public_sector', 'upto_usd1b', 'enterprise_wide')).toBe('government');
  });
  it('quotes engineering and infrastructure, never a fixed fee', () => {
    expect(r('business', 'upto_2cr', 'engineering')).toBe('engineering');
    expect(r('enterprise', 'upto_usd1b', 'infrastructure')).toBe('infrastructure');
  });
  it('maps turnover bands as the specification defines them', () => {
    expect(r('business', 'upto_2cr', 'assessment')).toBe('micro');
    expect(r('business', 'above_2cr', 'project')).toBe('medium');
    expect(r('enterprise', 'upto_usd1b', 'enterprise_wide')).toBe('large');
    expect(r('enterprise', 'above_usd1b', 'enterprise_wide')).toBe('custom');
    expect(r('startup', 'pre_revenue', 'assessment')).toBe('startup_general');
    expect(r('startup', 'pre_revenue', 'venture')).toBe('startup_venture');
  });
  it('treats the general engagement as general, not a cheaper substitute', () => {
    const res = assessEligibility({ category: 'business', turnover: 'upto_2cr', need: 'general' });
    expect(res.recommended).toBe('general');
    expect(res.requiresHumanReview).toBe(true);
  });
  it('returns one recommendation and alternatives that never include it', () => {
    for (const c of APPLICANT_CATEGORIES) {
      const res = assessEligibility({ category: c.value, turnover: 'above_2cr', need: 'project' });
      expect(packageByCode(res.recommended)).not.toBeNull();
      expect(res.alternatives).not.toContain(res.recommended);
    }
  });
});

describe('currency and the booking-fee breakdown', () => {
  // A wrong breakdown is a wrong charge.
  it('adds exclusive tax and a processing charge, and backs out inclusive tax', () => {
    const ex = feeBreakdown({ amountMinor: 10000_00, currency: 'INR', taxMode: 'exclusive', taxLabel: 'GST', taxRateBp: 1800, processingBp: 200 });
    expect(ex.tax).toBe(1800_00);
    expect(ex.processing).toBe(236_00);
    expect(ex.total).toBe(12036_00);
    const inc = feeBreakdown({ amountMinor: 11800, currency: 'EUR', taxMode: 'inclusive', taxLabel: 'VAT', taxRateBp: 1800, processingBp: 0 });
    expect(inc.base + inc.tax).toBe(11800);
    expect(inc.base).toBe(10000);
    expect(inc.total).toBe(11800);
    const none = feeBreakdown({ amountMinor: 5000, currency: 'USD', taxMode: 'none' });
    expect(none.total).toBe(5000);
    expect(none.lines.length).toBe(1);
  });
  it('respects zero-decimal currencies', () => {
    expect(currencyDef('JPY')!.exponent).toBe(0);
    expect(parseMajorToMinor('1500', 'JPY')).toBe(1500);
    expect(parseMajorToMinor('15.50', 'JPY')).toBeNull();
    expect(formatMoney(1500, 'JPY')).toBe('JPY 1,500');
    expect(parseMajorToMinor('1,250.5', 'USD')).toBe(125050);
    expect(minorToMajorString(125050, 'USD')).toBe('1250.50');
    expect(formatMoney(25000000, 'INR')).toBe('₹2,50,000');
  });
  it('converts to INR paise only with a real rate', () => {
    expect(toSettlementPaise(10000, 'USD', 83.5)).toBe(835000);
    expect(toSettlementPaise(1000, 'JPY', 0.56)).toBe(56000);
    expect(toSettlementPaise(500000, 'INR', 1)).toBe(500000);
    expect(toSettlementPaise(10000, 'USD', 0)).toBeNull();
    expect(toSettlementPaise(10000, 'XXX', 1)).toBeNull();
  });
  it('suggests a currency for any country and supports only rate-published currencies', () => {
    expect(suggestCurrency('IN')).toBe('INR');
    expect(suggestCurrency('DE')).toBe('EUR');
    expect(suggestCurrency('KE')).toBe('USD');
    expect(CURRENCIES.find((c) => c.code === 'AED')).toBeUndefined();
  });
});

describe('workflow guards', () => {
  // A transition a person can click that skips payment is free consultations; one that skips approval is an unapproved price.
  it('never lets a person mark the booking fee paid without a confirmed payment', () => {
    expect(canTransition('application', 'FEE_PENDING', 'FEE_PAID', 'applicant', { paymentConfirmed: true }).ok).toBe(false);
    expect(canTransition('application', 'FEE_PENDING', 'FEE_PAID', 'staff', {}).ok).toBe(false);
    expect(canTransition('application', 'FEE_PENDING', 'FEE_PAID', 'system', { paymentConfirmed: true }).ok).toBe(true);
  });
  it('follows Registration, Details, Requirements, Fee, Booking, Consultant in order', () => {
    expect(canTransition('application', 'DRAFT', 'REQUIREMENTS_COMPLETE', 'applicant', { detailsComplete: true, requirementsComplete: true }).ok).toBe(false);
    expect(canTransition('application', 'REQUIREMENTS_COMPLETE', 'FEE_PENDING', 'applicant', { detailsComplete: true, requirementsComplete: true, feeQuoted: false, termsAccepted: true }).ok).toBe(false);
    expect(canTransition('application', 'FEE_PAID', 'BOOKING_REQUESTED', 'applicant', { slotsGiven: true }).ok).toBe(true);
    expect(canTransition('application', 'FEE_PAID', 'CONSULTANT_ASSIGNED', 'staff', { consultantSet: true }).ok).toBe(false);
    expect(canTransition('application', 'BOOKING_REQUESTED', 'CONSULTANT_ASSIGNED', 'staff', { consultantSet: true }).ok).toBe(true);
    const steps = applicationStepState('FEE_PAID');
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'current', 'todo']);
  });
  it('requires a reason to decline or cancel', () => {
    expect(canTransition('application', 'DRAFT', 'DECLINED', 'staff', {}, '').ok).toBe(false);
    expect(canTransition('application', 'DRAFT', 'DECLINED', 'staff', {}, 'Outside scope').ok).toBe(true);
  });
  it('requires an approval note, validity and payment or contract before delivery', () => {
    expect(canTransition('engagement', 'PENDING_APPROVAL', 'APPROVED', 'staff', { quotationValid: true, approvalNoteGiven: false }, '').ok).toBe(false);
    expect(canTransition('engagement', 'PENDING_APPROVAL', 'APPROVED', 'staff', { quotationValid: true, approvalNoteGiven: true }, 'Approved by director').ok).toBe(true);
    expect(canTransition('engagement', 'SENT', 'ACCEPTED', 'applicant', { notExpired: false }).ok).toBe(false);
    expect(canTransition('engagement', 'ACCEPTED', 'IN_DELIVERY', 'staff', { paidOrContracted: false }).ok).toBe(false);
    expect(canTransition('engagement', 'DRAFT', 'SENT', 'staff', { quotationValid: true, notExpired: true }).ok).toBe(false);
    expect(availableTransitions('engagement', 'DRAFT', 'applicant')).toEqual([]);
  });
  // Part 5.4: a proposal is never an award.
  it('only calls an engagement contracted once delivery runs on a reference or a payment', () => {
    expect(isContracted('SENT', 'PO-1', true)).toBe(false);
    expect(isContracted('ACCEPTED', 'PO-1', true)).toBe(false);
    expect(isContracted('IN_DELIVERY', '', false)).toBe(false);
    expect(isContracted('IN_DELIVERY', 'PO-1', false)).toBe(true);
  });
  it('approves a partner only after complete due diligence', () => {
    const all: Record<string, string> = Object.fromEntries(DUE_DILIGENCE_ITEMS.map((i) => [i.key, 'pass']));
    expect(dueDiligenceComplete(all)).toBe(true);
    expect(dueDiligenceComplete({ ...all, references: 'pending' })).toBe(false);
    expect(dueDiligenceComplete({ ...all, insurance: 'fail' })).toBe(false);
    expect(dueDiligenceComplete({ ...all, insurance: 'pending' })).toBe(true);
    expect(canTransition('partner', 'DUE_DILIGENCE', 'APPROVED', 'staff', { dueDiligenceComplete: false }, 'ok then').ok).toBe(false);
  });
  it('caps formal incubation at six and requires an agreement', () => {
    expect(INCUBATION_PLACES).toBe(6);
    expect(canTransition('x', 'SELECTED', 'INCUBATING', 'staff', { cohortSet: true, agreementRecorded: true, incubationSlotFree: false }).ok).toBe(false);
    expect(canTransition('x', 'SELECTED', 'INCUBATING', 'staff', { cohortSet: true, agreementRecorded: false, incubationSlotFree: true }).ok).toBe(false);
    expect(canTransition('x', 'SELECTED', 'INCUBATING', 'staff', { cohortSet: true, agreementRecorded: true, incubationSlotFree: true }).ok).toBe(true);
  });
  it('has no transition to an unknown status, and every status is reachable or initial', () => {
    for (const [machine, defs] of Object.entries(MACHINES)) {
      const values = new Set(defs.map((d) => d.value));
      const targets = new Set(defs.flatMap((d) => d.next.map((n) => n.to)));
      for (const t of targets) expect(values.has(t), machine + ' -> ' + t).toBe(true);
      for (const d of defs.slice(1)) expect(targets.has(d.value), machine + ' ' + d.value + ' unreachable').toBe(true);
    }
  });
});

describe('discovery pathways', () => {
  it('covers the ten pathways of Part 12.4 with unique field names', () => {
    expect(PATHWAYS.map((p) => p.id).sort()).toEqual(['business', 'enterprise', 'government', 'healthcare', 'industrial', 'infrastructure', 'manufacturing', 'research', 'startup', 'university']);
    const keys = [...COMMON_QUESTIONS, ...PATHWAYS.flatMap((p) => p.questions)].map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('validates required answers and option values', () => {
    const answers: Record<string, string> = {
      [fieldName('industry')]: 'Healthcare', [fieldName('objectives')]: 'Integrate records across hospitals', [fieldName('budget')]: 'not_decided_yet',
      [fieldName('funding')]: 'seeking_funding', [fieldName('timeline')]: 'flexible', [fieldName('facility_type')]: 'hospital',
      [fieldName('clinical_constraints')]: 'Data stays in the country', [fieldName('scale')]: '400 beds',
    };
    const ok = parseAnswers('healthcare', (n) => answers[n] || '');
    expect(ok.missing).toEqual([]);
    expect(ok.invalid).toEqual([]);
    const bad = parseAnswers('healthcare', (n) => (n === fieldName('budget') ? 'a million' : answers[n] || ''));
    expect(bad.invalid.length).toBe(1);
    expect(describeAnswers('healthcare', ok.answers).find((x) => x.label === 'Budget expectation')!.value).toBe('Not decided yet');
    expect(defaultPathwayFor('intergovernmental')).toBe('government');
  });
});

describe('references, tokens and time zones', () => {
  // A guessable reference or a token stored in clear is somebody else reading a request.
  it('issues readable references and checks tokens by hash', () => {
    const ref = newRef('A');
    expect(isRef(ref, 'A')).toBe(true);
    expect(isRef(ref, 'X')).toBe(false);
    expect(isRef('SAM-A-ILOU0000')).toBe(false);
    const t = newToken();
    const h = hashToken(t);
    expect(h).toHaveLength(64);
    expect(tokenMatches(t, h)).toBe(true);
    expect(tokenMatches(t + 'x', h)).toBe(false);
    expect(tokenMatches('', h)).toBe(false);
  });
  it('converts a wall-clock time in any zone to the right instant', () => {
    expect(zonedLocalToUtc('2026-12-01T15:30', 'Asia/Kolkata')!.toISOString()).toBe('2026-12-01T10:00:00.000Z');
    expect(zonedLocalToUtc('2026-07-01T09:00', 'America/New_York')!.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedLocalToUtc('2026-01-15T09:00', 'Europe/Berlin')!.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(zonedLocalToUtc('nonsense', 'UTC')).toBeNull();
    expect(zonedLocalToUtc('2026-01-15T09:00', 'Not/AZone')).toBeNull();
  });
  it('accepts links only as http(s) and documents only as links', () => {
    expect(cleanUrl('javascript:alert(1)')).toBeNull();
    expect(cleanUrl('https://example.org/x')).toBe('https://example.org/x');
    expect(cleanEmail('A@B.co')).toBe('a@b.co');
    expect(cleanEmail('not an email')).toBeNull();
    const d = parseDocLinks((n) => ({ doc_url_0: 'https://drive.example.org/a', doc_label_0: 'RFP', doc_url_1: 'ftp://x' } as Record<string, string>)[n] || '');
    expect(d.links).toEqual([{ label: 'RFP', url: 'https://drive.example.org/a' }]);
    expect(d.invalid).toBe(1);
    expect(isCountryCode('KE')).toBe(true);
    expect(isCountryCode('ZZ')).toBe(false);
  });
});

describe('SAMARTH X scoring (advisory)', () => {
  it('scores every criterion 0 to 5 and ranks without deciding', () => {
    const s = parseScores((k) => (k === 'technical' ? '9' : '4'));
    expect(s.ok).toBe(true);
    if (s.ok) expect(reviewTotal(s.scores)).toBe(25);
    expect(parseScores(() => '').ok).toBe(false);
    expect(MAX_TOTAL).toBe(30);
    const agg = aggregate([{ problem: 5, technical: 5, evidence: 5, team: 5, viability: 5, drive: 5 }, { problem: 1, technical: 1, evidence: 1, team: 1, viability: 1, drive: 1 }]);
    expect(agg.mean).toBe(18);
    expect(agg.spread).toBe(24);
    const ranked = rankForIncubation([
      { id: 'a', mean: null, reviews: 0, createdAt: '2026-01-01' },
      { id: 'b', mean: 20, reviews: 2, createdAt: '2026-01-02' },
      { id: 'c', mean: 20, reviews: 3, createdAt: '2026-01-03' },
    ], 2);
    expect(ranked.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(ranked[2].inTopPlaces).toBe(false);
  });
});

describe('copy and governance rules', () => {
  const textOf = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(textOf).join(' ') : v && typeof v === 'object' ? Object.values(v).map(textOf).join(' ') : '');
  const allCopy = textOf(Object.values(catalog)) + ' ' + textOf(APPLICANT_CATEGORIES) + ' ' + textOf(GOVERNMENT_LEVELS) + ' ' + textOf(PATHWAYS) + ' ' + textOf(PACKAGES);
  // Project rules: no emoji, no arrows, no named competitor or company, no unverified claims.
  it('has no emoji or arrow characters', () => {
    expect(allCopy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(allCopy).not.toMatch(/[←-⇿]/);
  });
  it('names no company, accelerator or competitor', () => {
    for (const name of ['Combinator', 'Coursera', 'Google', 'Microsoft', 'Amazon', 'Anthropic', 'OpenAI', 'Claude', 'Razorpay', 'Vercel', 'Nvidia', 'NVIDIA', 'Accenture', 'Deloitte', 'Infosys', 'TCS', 'McKinsey', 'GeM']) {
      expect(allCopy.includes(name), name).toBe(false);
    }
  });
  it('claims no certification, licence or past client', () => {
    expect(allCopy).not.toMatch(/\b(we are|SAMARTH is) (certified|accredited|licensed)\b/i);
    expect(allCopy).not.toMatch(/\bour clients include\b/i);
    expect(catalog.REGULATED_WORK_NOTICE).toMatch(/does not hold regulatory authority or nuclear operating licences/);
  });
  it('keeps SAMARTH X free', () => {
    expect(catalog.SAMARTH_X.noFee).toMatch(/no participation fee and no incubation fee/i);
    const xSource = readFileSync('src/lib/samarth/x.ts', 'utf8');
    expect(xSource).not.toMatch(/createOrder|payments \(/);
  });
  it('serves every country, not only India', () => {
    expect(catalog.SAMARTH.reach).toMatch(/every country/);
    expect(isOfficialCategory('intergovernmental')).toBe(true);
    expect(GOVERNMENT_LEVELS.map((l) => l.value)).toContain('international');
  });
  it('gives every capability page substance and unique slugs', () => {
    expect(catalog.TOPICS.length).toBe(14);
    expect(new Set(catalog.TOPICS.map((t) => t.slug)).size).toBe(14);
    for (const t of catalog.TOPICS) {
      expect(t.description.length, t.slug).toBeLessThanOrEqual(160);
      expect(t.scope.length).toBeGreaterThanOrEqual(5);
      expect(t.faq.length).toBeGreaterThanOrEqual(2);
      for (const r of t.related) expect(catalog.topicBySlug(r), t.slug + ' related ' + r).not.toBeNull();
    }
  });
  // The public pages must obey the same rules as the data they render.
  it('public SAMARTH pages carry no emoji or arrow characters', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : f.endsWith('.astro') ? [f] : []; });
    for (const f of [...walk('src/pages/samarth'), ...walk('src/components/samarth')]) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      expect(s, f).not.toMatch(/[←-⇿]/);
    }
  });
});

describe('schema and register', () => {
  // A drifted hand-run file creates a different database from the bootstrap.
  it('keeps db/samarth-schema.sql identical to SAMARTH_DDL', () => {
    const src = readFileSync('src/lib/samarth/schema.ts', 'utf8');
    const ddl = src.match(/export const SAMARTH_DDL = `([\s\S]*?)`;/)![1].trim();
    const file = readFileSync('db/samarth-schema.sql', 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
    expect(file).toBe(ddl);
    expect(ddl).not.toMatch(/ALTER TABLE|REFERENCES|DROP /i);
  });
  it('registers all fourteen modules and the reserved component, honestly', () => {
    expect(MODULES.map((m) => m.id)).toEqual(['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', 'C03']);
    for (const m of MODULES) {
      if (m.status === 'built') expect(m.pending, m.id).toEqual([]);
      else expect(m.pending.length, m.id).toBeGreaterThan(0);
    }
  });
});

// Tests for the fee engine. Every amount here is an integer count of minor units (paise), because
// that is the only representation of money this engine has — see the header of fee-engine.ts.
//
// The properties these tests defend, in order of how much they would cost somebody if they broke:
//   1. THE ARITHMETIC IS EXACT. 75% off 10,000 leaves 2,500, and the engine proves it rather than
//      being trusted about it.
//   2. THE PARTS ADD UP TO THE TOTAL. An adjustment split across lines sums to exactly the amount
//      that was applied, so a document never has to explain a stray paisa.
//   3. NOTHING GOES NEGATIVE. Every reduction is capped at what is still payable.
//   4. THE ORDER IS THE ENGINE'S, NOT THE CALLER'S. Handing the adjustments over in another sequence
//      cannot change the answer.
import { describe, it, expect, report } from './test-shim';
import {
  computeFee, pctOfMinor, allocate, minorUnits, formatMinor,
  adjustmentFromCoupon, adjustmentFromWaiverRecord,
  ADJUSTMENT_ORDER, CHARGE_TYPES,
  type ChargeLine, type FeeAdjustment,
} from './fee-engine';

/** Rs 10,000.00, as this engine counts money. */
const TEN_THOUSAND = 1000000;

const baseLine = (amountMinor = TEN_THOUSAND): ChargeLine => ({
  code: 'base', type: 'base', label: 'Course fee', amountMinor,
});

const adj = (over: Partial<FeeAdjustment> & Pick<FeeAdjustment, 'kind'>): FeeAdjustment => ({
  code: over.kind, label: over.kind, basis: 'percent', value: 0, ...over,
});

describe('money is whole minor units', () => {
  it('coerces anything unusable to zero rather than to NaN', () => {
    // NaN propagates through every sum after it and comes out as a total nobody can explain.
    expect(minorUnits(undefined)).toBe(0);
    expect(minorUnits('not a number')).toBe(0);
    expect(minorUnits(Infinity)).toBe(0);
    expect(minorUnits('250000')).toBe(250000);
  });

  it('rounds a percentage half AWAY FROM ZERO, at the one point a fraction can exist', () => {
    expect(pctOfMinor(1000, 50)).toBe(500);
    expect(pctOfMinor(1001, 50)).toBe(501);     // 500.5 -> 501, not 500
    expect(pctOfMinor(201, 50)).toBe(101);      // 100.5 -> 101
  });

  it('does not lose a half unit to the way doubles are stored', () => {
    // The defect src/lib/money.ts documents: (1.005 * 100) is 100.49999999999999 in IEEE754, and the
    // bias is always downward and always against the person paying.
    expect(pctOfMinor(100500, 1)).toBe(1005);
    expect(pctOfMinor(20100, 5)).toBe(1005);
  });

  it('answers nothing for a percentage of nothing', () => {
    expect(pctOfMinor(0, 50)).toBe(0);
    expect(pctOfMinor(TEN_THOUSAND, 0)).toBe(0);
    expect(pctOfMinor(TEN_THOUSAND, -10)).toBe(0);
  });
});

describe('splitting one reduction across several lines', () => {
  it('the parts sum EXACTLY to the whole', () => {
    // 1000 across three lines that do not divide evenly. Largest remainder, so nothing is lost and
    // nothing is invented.
    const parts = allocate(1000, [333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('never gives a line more than that line is worth', () => {
    const parts = allocate(900, [100, 800, 50]);
    expect(parts[0]).toBeLessThanOrEqual(100);
    expect(parts[1]).toBeLessThanOrEqual(800);
    expect(parts[2]).toBeLessThanOrEqual(50);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(900);
  });

  it('a total at or above the weights takes all of them and no more', () => {
    expect(allocate(1000, [400, 600])).toEqual([400, 600]);
    expect(allocate(5000, [400, 600])).toEqual([400, 600]);
  });

  it('splits nothing when there is nothing to split', () => {
    expect(allocate(0, [100, 200])).toEqual([0, 0]);
    expect(allocate(100, [0, 0])).toEqual([0, 0]);
  });
});

describe('the arithmetic the founder asked for', () => {
  it('a 75 percent waiver on 10,000 leaves 2,500', () => {
    const r = computeFee({ lines: [baseLine()], adjustments: [adj({ kind: 'waiver', value: 75, label: 'Hardship' })] });
    expect(r.grossMinor).toBe(1000000);
    expect(r.adjustmentTotalMinor).toBe(750000);
    expect(r.payableMinor).toBe(250000);
    expect(formatMinor(r.payableMinor, 'INR')).toBe('INR 2,500.00');
  });

  it('the lines always add up to the total', () => {
    const r = computeFee({
      lines: [
        baseLine(),
        { code: 'exam', type: 'examination', label: 'Examination', amountMinor: 333333 },
        { code: 'lab', type: 'laboratory', label: 'Laboratory', amountMinor: 66667 },
      ],
      adjustments: [adj({ kind: 'discount', value: 33.333, label: 'Early' })],
    });
    const summed = r.lines.reduce((a, l) => a + l.netMinor, 0);
    expect(summed).toBe(r.netMinor);
    expect(r.lines.reduce((a, l) => a + l.reducedMinor, 0)).toBe(r.adjustmentTotalMinor);
    expect(r.netMinor + r.taxTotalMinor).toBe(r.payableMinor);
  });
});

describe('the order of operations', () => {
  it('is the engine\'s, not the order the caller happened to pass', () => {
    const lines = [baseLine()];
    const discount = adj({ kind: 'discount', basis: 'fixed', value: 100000, label: 'Bundle' });
    const waiver = adj({ kind: 'waiver', value: 50, label: 'Hardship' });
    const a = computeFee({ lines, adjustments: [discount, waiver] });
    const b = computeFee({ lines, adjustments: [waiver, discount] });
    expect(a.payableMinor).toBe(b.payableMinor);
    expect(a.adjustments.map((x) => x.kind)).toEqual(b.adjustments.map((x) => x.kind));
  });

  it('applies them in the declared sequence', () => {
    const r = computeFee({
      lines: [baseLine()],
      adjustments: [
        adj({ kind: 'sponsorship', basis: 'fixed', value: 1 }),
        adj({ kind: 'coupon', basis: 'fixed', value: 1 }),
        adj({ kind: 'discount', basis: 'fixed', value: 1 }),
      ],
    });
    expect(r.adjustments.map((x) => x.kind)).toEqual(['discount', 'coupon', 'sponsorship']);
    expect(r.order).toEqual(ADJUSTMENT_ORDER);
  });

  it('a fixed amount and a percentage do NOT commute — which is why the order is declared', () => {
    // 1,000 off 10,000 and then half of what is left: 9,000 -> 4,500.
    const fixedFirst = computeFee({
      lines: [baseLine()],
      adjustments: [
        adj({ kind: 'discount', basis: 'fixed', value: 100000 }),
        adj({ kind: 'waiver', basis: 'percent', value: 50 }),
      ],
    });
    // Half of 10,000 and then 1,000 off what is left: 5,000 -> 4,000.
    const percentFirst = computeFee({
      lines: [baseLine()],
      adjustments: [
        adj({ kind: 'discount', basis: 'percent', value: 50 }),
        adj({ kind: 'waiver', basis: 'fixed', value: 100000 }),
      ],
    });
    expect(fixedFirst.payableMinor).toBe(450000);
    expect(percentFirst.payableMinor).toBe(400000);
    expect(fixedFirst.payableMinor).not.toBe(percentFirst.payableMinor);
  });

  it('two percentages DO commute, and the engine says so honestly', () => {
    // Multiplication commutes, so 10% then 50% and 50% then 10% both leave 45%. The order still
    // decides which instrument is recorded as covering which rupee, which is what a budget counts.
    const a = computeFee({
      lines: [baseLine()],
      adjustments: [adj({ kind: 'discount', value: 10 }), adj({ kind: 'waiver', value: 50 })],
    });
    const b = computeFee({
      lines: [baseLine()],
      adjustments: [adj({ kind: 'discount', value: 50 }), adj({ kind: 'waiver', value: 10 })],
    });
    expect(a.payableMinor).toBe(450000);
    expect(b.payableMinor).toBe(450000);
    expect(a.coverage.discount).not.toBe(b.coverage.discount);
  });

  it('each stage applies to what is still payable, not to the original gross', () => {
    const r = computeFee({
      lines: [baseLine()],
      adjustments: [adj({ kind: 'scholarship', value: 25 }), adj({ kind: 'waiver', value: 50 })],
    });
    expect(r.coverage.scholarship).toBe(250000);   // 25% of 10,000
    expect(r.coverage.waiver).toBe(375000);        // 50% of the 7,500 that was left
    expect(r.payableMinor).toBe(375000);
  });
});

describe('nothing ever goes negative', () => {
  it('caps a reduction at the balance still payable and says it was capped', () => {
    const r = computeFee({
      lines: [baseLine()],
      adjustments: [
        adj({ kind: 'scholarship', value: 100, label: 'Full award' }),
        adj({ kind: 'waiver', value: 100, label: 'Full waiver' }),
      ],
    });
    expect(r.payableMinor).toBe(0);
    expect(r.requiresPayment).toBe(false);
    const waiver = r.adjustments.find((a) => a.kind === 'waiver');
    expect(waiver?.appliedMinor).toBe(0);
    expect(waiver?.capped).toBe(true);
    expect(waiver?.note).toContain('Nothing was left');
  });

  it('a fixed reduction larger than the charge covers the charge and no more', () => {
    const r = computeFee({ lines: [baseLine(50000)], adjustments: [adj({ kind: 'sponsorship', basis: 'fixed', value: 900000 })] });
    expect(r.payableMinor).toBe(0);
    expect(r.adjustments[0].requestedMinor).toBe(900000);
    expect(r.adjustments[0].appliedMinor).toBe(50000);
    expect(r.adjustments[0].capped).toBe(true);
  });

  it('refuses a negative charge line and says so instead of quietly crediting somebody', () => {
    const r = computeFee({ lines: [{ code: 'x', type: 'material', label: 'Kit', amountMinor: -5000 }] });
    expect(r.grossMinor).toBe(0);
    expect(r.warnings.join(' ')).toContain('refund or credit');
  });

  it('refuses a negative percentage, because a surcharge is a charge line', () => {
    const r = computeFee({ lines: [baseLine()], adjustments: [adj({ kind: 'discount', value: -20 })] });
    expect(r.payableMinor).toBe(1000000);
    expect(r.adjustments[0].appliedMinor).toBe(0);
    expect(r.adjustments[0].note).toContain('surcharge');
  });
});

describe('a charge is line items, never one price', () => {
  it('carries all eight kinds of charge', () => {
    expect(CHARGE_TYPES).toEqual([
      'base', 'registration', 'application', 'examination',
      'certification', 'laboratory', 'material', 'service',
    ]);
  });

  it('an adjustment scoped to one kind leaves the others alone', () => {
    const r = computeFee({
      lines: [
        baseLine(500000),
        { code: 'exam', type: 'examination', label: 'Examination', amountMinor: 200000 },
      ],
      adjustments: [adj({ kind: 'waiver', value: 100, appliesTo: ['examination'], label: 'Exam fee waived' })],
    });
    expect(r.lines[0].netMinor).toBe(500000);
    expect(r.lines[1].netMinor).toBe(0);
    expect(r.payableMinor).toBe(500000);
  });

  it('multiplies a quantity, and splits a reduction across the lines proportionally', () => {
    const r = computeFee({
      lines: [
        { code: 'mat', type: 'material', label: 'Workbook', amountMinor: 30000, quantity: 3 },
        baseLine(100000),
      ],
      adjustments: [adj({ kind: 'discount', value: 50 })],
    });
    expect(r.lines[0].grossMinor).toBe(90000);
    expect(r.grossMinor).toBe(190000);
    expect(r.adjustmentTotalMinor).toBe(95000);
    expect(r.lines.reduce((a, l) => a + l.reducedMinor, 0)).toBe(95000);
  });
});

describe('tax', () => {
  it('is charged on what is payable, not on a gross nobody is charged', () => {
    const r = computeFee({
      lines: [baseLine()],
      adjustments: [adj({ kind: 'waiver', value: 50 })],
      taxes: [{ code: 'gst', label: 'GST', basis: 'percent_of_taxable_net', value: 18 }],
    });
    expect(r.taxableNetMinor).toBe(500000);
    expect(r.taxTotalMinor).toBe(90000);
    expect(r.payableMinor).toBe(590000);
  });

  it('leaves a line marked not taxable out of the taxable base', () => {
    const r = computeFee({
      lines: [
        baseLine(100000),
        { code: 'cert', type: 'certification', label: 'Certification', amountMinor: 100000, taxable: false },
      ],
      taxes: [{ code: 'gst', label: 'GST', basis: 'percent_of_taxable_net', value: 10 }],
    });
    expect(r.taxableNetMinor).toBe(100000);
    expect(r.taxTotalMinor).toBe(10000);
    expect(r.payableMinor).toBe(210000);
  });
});

describe('the breakdown a learner is shown', () => {
  it('records what each kind of instrument covered', () => {
    const r = computeFee({
      lines: [baseLine()],
      adjustments: [
        adj({ kind: 'discount', value: 10, label: 'Early' }),
        adj({ kind: 'scholarship', basis: 'fixed', value: 200000, label: 'Fund' }),
      ],
    });
    expect(r.coverage.discount).toBe(100000);
    expect(r.coverage.scholarship).toBe(200000);
    expect(r.coverage.waiver).toBe(0);
    expect(r.payableMinor).toBe(700000);
  });

  it('explains itself in sentences, in the order the money moved', () => {
    const r = computeFee({ lines: [baseLine()], adjustments: [adj({ kind: 'waiver', value: 75, label: 'Hardship' })] });
    expect(r.explain[0]).toContain('INR 10,000.00');
    expect(r.explain.join(' ')).toContain('Hardship');
    expect(r.explain[r.explain.length - 1]).toContain('INR 2,500.00');
  });

  it('says there is nothing to pay for rather than reporting a free course', () => {
    const r = computeFee({ lines: [] });
    expect(r.payableMinor).toBe(0);
    expect(r.requiresPayment).toBe(false);
    expect(r.explain[0]).toContain('no charge has been set');
  });
});

describe('what other modules already store, as adjustments', () => {
  it('a redeemed coupon covers the fee and carries its own reason', () => {
    const a = adjustmentFromCoupon({ id: 'c1', code: 'EDU-AAAA-BBBB', reason: 'Community partner' });
    expect(a.kind).toBe('coupon');
    expect(a.value).toBe(100);
    expect(a.label).toBe('Community partner');
    const r = computeFee({ lines: [baseLine()], adjustments: [a] });
    expect(r.payableMinor).toBe(0);
  });

  it('a waiver granted as a percentage becomes a percentage', () => {
    const { adjustment } = adjustmentFromWaiverRecord({ id: 'w1', grant_pct: 40, reason: 'Approved' });
    expect(adjustment?.basis).toBe('percent');
    expect(adjustment?.value).toBe(40);
  });

  it('a waiver granted as an amount becomes minor units, and keeps its own currency', () => {
    const { adjustment, currency } = adjustmentFromWaiverRecord({ id: 'w2', grant_amount: '125.50', grant_currency: 'CHF' });
    expect(adjustment?.basis).toBe('fixed');
    expect(adjustment?.value).toBe(12550);
    expect(currency).toBe('CHF');   // never converted here — an FX rate inside a waiver is money nobody decided to give away
  });

  it('a waiver record that states neither is refused, not treated as free', () => {
    const r = adjustmentFromWaiverRecord({ id: 'w3' });
    expect(r.adjustment).toBeNull();
    expect(r.error).toContain('nothing to apply');
  });
});

report();

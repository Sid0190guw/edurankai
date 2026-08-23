import { describe, it, expect } from 'vitest';
import { stripOwnershipPromise } from '@/lib/compensation-text';

describe('stripOwnershipPromise', () => {
  it('returns null for empty input', () => {
    expect(stripOwnershipPromise(null)).toBeNull();
    expect(stripOwnershipPromise(undefined)).toBeNull();
    expect(stripOwnershipPromise('   ')).toBeNull();
  });

  it('passes a clean pay string through byte-for-byte', () => {
    const clean = 'INR 20,00,000 - 40,00,000 per annum';
    expect(stripOwnershipPromise(clean)).toBe(clean);
  });

  it('drops a trailing equity clause', () => {
    expect(stripOwnershipPromise('up to INR 120 LPA + equity')).toBe('up to INR 120 LPA');
  });

  it('keeps a salary range intact instead of splitting on its hyphen', () => {
    // The regression this function exists to prevent: an earlier version split on " - " and " and "
    // and emitted "INR 50 LPA - 95 LPA base and expected contribution".
    const stored =
      'INR 50 LPA - 95 LPA base + meaningful equity. Compensation is commensurate with experience, ' +
      'capabilities, and expected contribution; the equity component is intentionally generous ' +
      'because the role compounds.';
    expect(stripOwnershipPromise(stored)).toBe('INR 50 LPA - 95 LPA base');
  });

  it('drops an equity clause from the middle and rejoins the survivors', () => {
    expect(
      stripOwnershipPromise(
        'Senior package + Top-quartile for Bharat-based AI startups + Significant ESOP allocation + Reviewed annually',
      ),
    ).toBe('Senior package + Top-quartile for Bharat-based AI startups + Reviewed annually');
  });

  it('strips a revenue share promised to an unpaid intern', () => {
    expect(
      stripOwnershipPromise(
        'Unpaid + Revenue Share on the product you ship + Fast-track to ESOP-eligible Founder Office role on exceptional contribution',
      ),
    ).toBe('Unpaid');
  });

  it('strips discretionary net-profit sharing from a public listing', () => {
    expect(
      stripOwnershipPromise(
        'Full-time compensation discussed individually with shortlisted candidates + Discretionary net-profit sharing for extraordinary C-level contribution',
      ),
    ).toBe('Full-time compensation discussed individually with shortlisted candidates');
  });

  it('returns null rather than publish a promise it cannot cut cleanly', () => {
    expect(stripOwnershipPromise('equity')).toBeNull();
    expect(stripOwnershipPromise('Generous ESOP allocation reviewed annually')).toBeNull();
  });

  it('does not mistake "budget shared openly" for a share of the firm', () => {
    const stored = 'Senior package + Market context and budget shared openly + Reviewed annually';
    expect(stripOwnershipPromise(stored)).toBe(stored);
  });

  it('leaves product ownership alone - it is responsibility, not a stake', () => {
    const stored = 'Unpaid + Full ownership of the product you ship + Direct Founder Office mentorship';
    expect(stripOwnershipPromise(stored)).toBe(stored);
  });

  it('handles an equity clause bounded on both sides', () => {
    expect(stripOwnershipPromise('Up to INR 60 LPA + program equity-share + performance bonus on outcomes'))
      .toBe('Up to INR 60 LPA + performance bonus on outcomes');
  });
});

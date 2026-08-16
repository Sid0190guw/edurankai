// src/lib/mailplatform/saas/pricing.ts — what the plans cost.
//
// A SEPARATE FILE SO THAT "THE ENGINES NEVER SEE A PRICE" IS CHECKABLE RATHER THAN ASSERTED.
// ./entitlements.ts, ./quota.ts, ./usage.ts and ./plans.ts do not import this module, and
// `saas-plans.test.ts` reads their source and fails if any of them ever does. Section 5 of the
// brief asks for prices to stay out of business logic; a rule with a test behind it is the only
// kind that survives the next patch.
//
// WHY MINOR UNITS. `amountMinor` is paise, cents, the smallest unit of the currency. Floating-point
// money is how 1199.99 becomes 1199.9899999999998 on an invoice, and an invoice is a legal
// document. Nothing here is ever divided; formatting happens once, at the edge, in `formatMoney()`.
//
// WHY THIS IS A CATALOG AND NOT A CONSTANT. Prices differ per currency and per negotiated contract.
// `priceFor()` looks up plan + currency + interval and returns null when that combination is not
// published, which the UI renders as "contact us" rather than as a wrong number. An enterprise
// contract has no published price at all, and that is the correct answer for it.

import type { PlanPricing } from './types';

/**
 * The published catalogue.
 *
 * `providerPriceRef` is null throughout because the platform runs on the manual billing provider
 * today (see ./billing.ts). When a provider is configured, its price identifiers are written into
 * these rows — that is the only change needed, and no other file learns a vendor's name.
 */
export const PLAN_PRICING: PlanPricing[] = [
  { planKey: 'free', currency: 'INR', interval: 'month', amountMinor: 0, providerPriceRef: null },
  { planKey: 'free', currency: 'INR', interval: 'year', amountMinor: 0, providerPriceRef: null },

  { planKey: 'starter', currency: 'INR', interval: 'month', amountMinor: 99_900, providerPriceRef: null },
  { planKey: 'starter', currency: 'INR', interval: 'year', amountMinor: 999_000, providerPriceRef: null },

  { planKey: 'professional', currency: 'INR', interval: 'month', amountMinor: 399_900, providerPriceRef: null },
  { planKey: 'professional', currency: 'INR', interval: 'year', amountMinor: 3_999_000, providerPriceRef: null },

  { planKey: 'business', currency: 'INR', interval: 'month', amountMinor: 1_499_900, providerPriceRef: null },
  { planKey: 'business', currency: 'INR', interval: 'year', amountMinor: 14_999_000, providerPriceRef: null },

  // Enterprise is deliberately absent. There is no published price, and inventing one on a pricing
  // page is a promise the contract will not keep.
];

export function priceFor(
  planKey: string,
  currency = 'INR',
  interval: 'month' | 'year' = 'month',
  catalog: PlanPricing[] = PLAN_PRICING,
): PlanPricing | null {
  const cur = String(currency || '').toUpperCase();
  return catalog.find((p) => p.planKey === planKey && p.currency === cur && p.interval === interval) || null;
}

/** Currencies a plan is published in. Empty means the plan is quoted, not listed. */
export function currenciesFor(planKey: string, catalog: PlanPricing[] = PLAN_PRICING): string[] {
  return Array.from(new Set(catalog.filter((p) => p.planKey === planKey).map((p) => p.currency)));
}

const SYMBOLS: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

/**
 * Minor units to a display string. The ONLY division in this file.
 *
 * A zero amount reads "Free", not "0.00" — an amount of nothing is a different statement from a
 * price of nothing, and the pricing table is read by people deciding whether to pay.
 */
export function formatMoney(amountMinor: number, currency = 'INR'): string {
  const cur = String(currency || 'INR').toUpperCase();
  if (amountMinor === 0) return 'Free';
  const symbol = SYMBOLS[cur] || cur + ' ';
  const major = amountMinor / 100;
  const body = new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
  return symbol + body;
}

/** What a year costs against twelve months, as a percentage saved. Null when either is unpublished. */
export function annualSavingPercent(planKey: string, currency = 'INR'): number | null {
  const monthly = priceFor(planKey, currency, 'month');
  const yearly = priceFor(planKey, currency, 'year');
  if (!monthly || !yearly || monthly.amountMinor === 0) return null;
  const full = monthly.amountMinor * 12;
  if (full <= 0) return null;
  return Math.round(((full - yearly.amountMinor) / full) * 100);
}

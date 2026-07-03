// Holistic checkout computation — the single source of truth for what an
// applicant actually pays. Order of operations, like every real checkout:
//   base fee (role-driven, CHF -> INR)  ->  minus admin OFFER discount
//   ->  net charge  ->  (coupon can waive it entirely)  ->  (wallet credit
//   applied)  ->  amount due.
// The OFFER is fully admin-controlled (app_settings key 'offer'); nothing
// here is hard-coded, and the same breakdown drives the pay page display,
// the real Razorpay charge, and the receipt line items.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { resolveApplicationFeeChf, isFeeExempt, type RoleLevel } from '@/lib/application-fee';
import { convertToInrPaise } from '@/lib/fx';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export interface Offer {
  enabled: boolean;
  type: 'percent' | 'flat';   // flat is in CHF
  value: number;
  label: string;
  endsAt?: string | null;      // ISO date; past = inactive
}

export async function getActiveOffer(): Promise<Offer | null> {
  try {
    const v = rows(await db.execute(sql`SELECT value FROM app_settings WHERE key = 'offer' LIMIT 1`))[0]?.value;
    if (!v || !v.enabled) return null;
    if (v.endsAt && new Date(v.endsAt).getTime() < Date.now()) return null;
    const value = Number(v.value) || 0;
    if (value <= 0) return null;
    return { enabled: true, type: v.type === 'flat' ? 'flat' : 'percent', value, label: (v.label || 'Limited-time offer').toString(), endsAt: v.endsAt || null };
  } catch { return null; }
}

export interface CheckoutBreakdown {
  feeExempt: boolean;
  baseChf: number;
  baseInrPaise: number;
  offerLabel: string | null;
  offerDiscountPaise: number;
  netInrPaise: number;        // the amount a card charge (before coupon/wallet)
  walletBalancePaise: number; // available wallet, for display
  fxRate: number;
  fxDate: string;
  fxLive: boolean;
}

export async function computeCheckout(opts: { roleFee?: number | string | null; level?: RoleLevel; userId?: string | null }): Promise<CheckoutBreakdown> {
  const exempt = isFeeExempt(opts.level);
  const baseChf = resolveApplicationFeeChf(opts);         // 0 when exempt
  const fx = await convertToInrPaise('CHF', baseChf * 100);
  const base = fx.paise;

  let disc = 0, label: string | null = null;
  if (!exempt && base > 0) {
    const offer = await getActiveOffer();
    if (offer) {
      label = offer.label;
      disc = offer.type === 'flat' ? Math.round(offer.value * 100 * (fx.rate || 1)) : Math.round(base * offer.value / 100);
      disc = Math.max(0, Math.min(base, disc));
    }
  }

  let wallet = 0;
  if (opts.userId) {
    try { const { getCreditBalance } = await import('@/lib/account-credit'); wallet = await getCreditBalance(opts.userId); } catch (_) {}
  }

  return {
    feeExempt: exempt,
    baseChf,
    baseInrPaise: base,
    offerLabel: label,
    offerDiscountPaise: disc,
    netInrPaise: Math.max(0, base - disc),
    walletBalancePaise: wallet,
    fxRate: fx.rate, fxDate: fx.date, fxLive: fx.live,
  };
}

/** Compact snapshot to persist in a payment's `notes` so the receipt can show
 *  the same line items later, and to record which offer was honoured. */
export function breakdownForNotes(b: CheckoutBreakdown) {
  return {
    baseChf: b.baseChf, baseInrPaise: b.baseInrPaise,
    offerLabel: b.offerLabel, offerDiscountPaise: b.offerDiscountPaise,
    netInrPaise: b.netInrPaise, fxRate: b.fxRate, fxDate: b.fxDate,
  };
}

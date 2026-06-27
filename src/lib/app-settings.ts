// Editable application/checkout settings — a super-admin controls the wording,
// the "what's included" list, the tax treatment and which options appear on the
// /apply/pay checkout, WITHOUT touching the charge logic (amounts stay
// role-driven and server-computed). Stored as a single jsonb row per key.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    } catch (_) { ready = null; }
  })();
  return ready;
}

export interface CheckoutSettings {
  heading: string;
  subhead: string;          // '' = use the role-based default sentence
  included: string[];
  taxMode: 'inclusive' | 'exclusive' | 'none';
  taxNote: string;
  disclaimer: string;
  showAid: boolean;         // show the financial-aid / coupon / intl options
}

export const CHECKOUT_DEFAULTS: CheckoutSettings = {
  heading: 'Process & verification fee',
  subhead: '',
  included: [
    'Identity & document verification of your submission.',
    'Reference and credential cross-checks.',
    'Secure handling and review processing.',
  ],
  taxMode: 'inclusive',
  taxNote: 'Inclusive of all applicable taxes',
  disclaimer: 'This processing & verification fee does not guarantee a job, offer, or selection. It only covers the cost of processing and verifying your application. Hiring decisions are made solely on merit.',
  showAid: true,
};

async function getRaw(key: string): Promise<any> {
  try {
    await ensure();
    return rows(await db.execute(sql`SELECT value FROM app_settings WHERE key = ${key} LIMIT 1`))[0]?.value || {};
  } catch { return {}; }
}

export async function getCheckoutSettings(): Promise<CheckoutSettings> {
  const v = await getRaw('checkout');
  return {
    ...CHECKOUT_DEFAULTS,
    ...v,
    included: Array.isArray(v.included) && v.included.length ? v.included : CHECKOUT_DEFAULTS.included,
    taxMode: ['inclusive', 'exclusive', 'none'].includes(v.taxMode) ? v.taxMode : CHECKOUT_DEFAULTS.taxMode,
    showAid: typeof v.showAid === 'boolean' ? v.showAid : CHECKOUT_DEFAULTS.showAid,
  };
}

export async function saveSettings(key: string, value: any): Promise<void> {
  await ensure();
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, updated_at = NOW()
  `);
}

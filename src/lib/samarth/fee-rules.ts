// Booking-fee rules that need no database: what a fee row must contain before it can be approved,
// and the starting draft of the payment terms. Kept apart from fees.ts so tests can import it.
import { ANY_CATEGORY, isApplicantCategory } from '@/lib/samarth/categories';
import { isSupportedCurrency, TAX_MODES } from '@/lib/samarth/currency';

export interface FeeInput {
  category: string;
  currency: string;
  amountMinor: number | null;
  taxMode: string;
  taxLabel: string;
  taxRateBp: number | null;
  processingBp: number | null;
  chargesNote: string;
  terms: string;
  note: string;
}

/** Everything a fee row needs before it can be APPROVED. Pure; also used to warn on drafts. */
export function feeProblems(f: Pick<FeeInput, 'category' | 'currency' | 'amountMinor' | 'taxMode' | 'taxLabel' | 'taxRateBp' | 'processingBp' | 'chargesNote' | 'terms'>): string[] {
  const p: string[] = [];
  if (f.category !== ANY_CATEGORY && !isApplicantCategory(f.category)) p.push('Choose an applicant category.');
  if (!isSupportedCurrency(f.currency)) p.push('Choose a supported currency.');
  if (!f.amountMinor || f.amountMinor <= 0) p.push('Enter the fee amount.');
  if (!TAX_MODES.some((t) => t.value === f.taxMode)) p.push('Say how tax applies.');
  if (f.taxMode !== 'none' && (!f.taxLabel.trim() || !f.taxRateBp || f.taxRateBp <= 0 || f.taxRateBp > 10000)) p.push('A taxed fee needs the tax name and a rate between 0 and 100%.');
  if (f.processingBp != null && (f.processingBp < 0 || f.processingBp > 1000)) p.push('A payment processing charge must be between 0% and 10%.');
  if (f.chargesNote.trim().length < 10) p.push('State how payment charges are handled (for example, that none are added, or what is added).');
  if (f.terms.trim().length < 40) p.push('Write the payment terms the applicant must accept (at least a few sentences: what the fee covers, refunds, and what happens if the call cannot take place).');
  if (/\[[^\]]*\]/.test(f.terms)) p.push('Replace every bracketed placeholder in the terms with your decision before approving.');
  return p;
}

/**
 * A STARTING DRAFT of the payment terms, for the owner to edit. Every policy choice is a bracketed
 * placeholder, and feeProblems() refuses approval while any bracket remains, so no refund or
 * cancellation policy can be published that a person did not decide.
 */
export const TERMS_TEMPLATE = [
  'SAMARTH consultation booking fee: terms of payment',
  '',
  '1. What the fee covers: one formal consultation call of up to [60] minutes with a SAMARTH consultant, arranged after the fee is confirmed, and the consultant\'s review of the information you provided.',
  '2. What it does not cover: any consultancy package, engineering, government project proposal, infrastructure, implementation or other work. Each of those is a separate engagement with its own quotation and terms.',
  '3. Payment: payable in advance, online or against an invoice. Online payments are charged in Indian rupees at the exchange rate shown before you pay; your bank may apply its own conversion and charges.',
  '4. Confirmation: the fee is confirmed only when the payment provider confirms the payment to SAMARTH, or when SAMARTH records a payment against your invoice. You receive an email confirmation and a receipt.',
  '5. Booking: after confirmation you propose times for the call; a consultant is assigned and confirms one. If no time can be agreed within [30] days, [the fee is refunded in full].',
  '6. Cancellation by you: [a full refund if you cancel before a consultant is assigned; no refund after the call has been scheduled].',
  '7. Cancellation by SAMARTH: if SAMARTH declines or cancels your request after payment, the fee is refunded in full.',
  '8. Taxes are shown separately where they apply.',
  '9. Questions: connect@edurankai.in, quoting your reference.',
].join('\n');

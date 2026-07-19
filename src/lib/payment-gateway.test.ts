// src/lib/payment-gateway.test.ts — run: npx tsx src/lib/payment-gateway.test.ts
// Payments (Prompt AP5): plans + pricing; access is unlocked ONLY by a captured, non-refunded payment
// (or a free plan); with no keys the gateway runs in a labelled SANDBOX (never a real charge); provider
// keys come from env, never hardcoded.
import { PLANS, planById, amountPaise, unlockedByPayment, getGateway, gatewayMode, SANDBOX_TOKEN } from './payment-gateway';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

console.log('\n== plans + pricing ==');
ok('free / per-course / subscription plans exist', PLANS.some((p) => p.kind === 'free') && PLANS.some((p) => p.kind === 'per-course') && PLANS.some((p) => p.kind === 'subscription'));
ok('free is 0, a course has a price', planById('free')!.priceInr === 0 && planById('course')!.priceInr > 0);
ok('amount converts to paise', amountPaise(planById('course')!) === planById('course')!.priceInr * 100);

console.log('\n== access gating: only a real captured payment unlocks ==');
ok('paid -> unlocked', unlockedByPayment('paid', planById('course')) === true);
ok('failed -> locked', unlockedByPayment('failed', planById('course')) === false);
ok('refunded -> re-locked', unlockedByPayment('refunded', planById('course')) === false);
ok('created (pending) -> still locked', unlockedByPayment('created', planById('course')) === false);
ok('free plan -> unlocked without payment', unlockedByPayment(null, planById('free')) === true);

console.log('\n== sandbox mode is honest (no keys configured in this test env) ==');
delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
const gw = getGateway();
ok('no keys -> sandbox mode (not pretending to be live)', gw.mode === 'sandbox' && gatewayMode() === 'sandbox');
ok('sandbox verify accepts only the labelled test token', gw.verify('o', 'p', SANDBOX_TOKEN) === true && gw.verify('o', 'p', 'anything-else') === false);
(async () => {
  const order = await gw.createOrder(49900, 'rcpt1');
  ok('sandbox order is clearly a TEST order', order.ok && /^test_order_/.test((order as any).order.id));

  console.log('\n== provider keys come from env, never hardcoded ==');
  const gwSrc = readFileSync('src/lib/payment-gateway.ts', 'utf8');
  const rzpSrc = readFileSync('src/lib/razorpay.ts', 'utf8');
  ok('no live/test Razorpay key literal in source', !/rzp_(live|test)_[A-Za-z0-9]/.test(gwSrc) && !/rzp_(live|test)_[A-Za-z0-9]/.test(rzpSrc));
  ok('keys are read from process.env.RAZORPAY_*', /process\.env\.RAZORPAY_KEY_ID/.test(rzpSrc) && /process\.env\.RAZORPAY_KEY_SECRET/.test(rzpSrc));
  ok('no secret string assigned inline', !/KEY_SECRET\s*=\s*['"][A-Za-z0-9]{8,}/.test(gwSrc + rzpSrc));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

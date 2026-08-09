// Tests for the in-house intent provider.
//
// The property under test is NOT accuracy — that is measured in ml/intent/train.py against a
// held-out set, and no unit test can or should re-measure it. What is tested here is the behaviour
// that decides whether a teacher can trust the thing: when the model is absent, slow, or answering
// nonsense, does the provider REFUSE with a reason, or does it hand back a confident guess?
//
// This project has repeatedly shipped code that reported success having done nothing. A model
// provider is the easiest place in the whole system to do that accidentally, because a plausible
// default ('speech') is always available and would look completely normal on screen.

// vitest, not the house shim: these tests are async (they await a provider call) and the shim's
// it() is synchronous — it never awaits the body, so assertions land after the fetch stub has
// already been torn down and the file passes while testing nothing.
import { describe, it, expect, afterEach } from 'vitest';
import { LocalIntentProvider, NullIntentProvider, intentProvider } from './intent-model';

const realFetch = globalThis.fetch;

/** Point a provider at a port nothing is listening on. */
const DEAD = 'http://127.0.0.1:9';

function stubFetch(handler: (url: string, init?: any) => Promise<any>) {
  (globalThis as any).fetch = handler;
}
function restoreFetch() {
  (globalThis as any).fetch = realFetch;
}

const jsonRes = (body: any, ok = true, status = 200) => Promise.resolve({
  ok, status, json: () => Promise.resolve(body),
} as any);

describe('when no model is serving', () => {
  it('is unavailable, and says both why and what to do about it', async () => {
    const p = new LocalIntentProvider(DEAD);
    const h = await p.health();
    expect(h.state).toBe('unavailable');
    expect(h.reason).toContain('not reachable');
    // A remedy is the difference between a dead end and a next step.
    expect(String(h.remedy)).toContain('serve.py');
  });

  it('refuses to classify rather than returning a plausible default', async () => {
    const p = new LocalIntentProvider(DEAD);
    const r = await p.classify('show the atom');
    expect(r.ok).toBe(false);
    // The refusal must carry the reason, not an empty failure.
    expect(String((r as any).reason).length > 0).toBe(true);
  });

  it('the null provider refuses every call and admits it can do nothing', async () => {
    const p = new NullIntentProvider();
    const h = await p.health();
    expect(h.state).toBe('unavailable');
    expect(p.supports('foundation.intent')).toBe(false);
    expect(p.descriptor.cannot.length > 0).toBe(true);
  });

  it('intentProvider falls back to the null provider instead of throwing', async () => {
    const p = await intentProvider(DEAD);
    expect(p.descriptor.id).toBe('foundation.intent-null');
  });
});

describe('when a model is serving', () => {
  it('returns the reading, the confidence and every class score', async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith('/health')) return jsonRes({ ok: true, device: 'cuda', threshold: 0.45 });
      return jsonRes({
        ok: true,
        results: [{
          intent: 'parameter', confidence: 0.98, abstained: false,
          scores: { speech: 0.01, parameter: 0.98, animate: 0.01 },
        }],
      });
    });
    try {
      const p = new LocalIntentProvider();
      const r = await p.classify('increase the amplitude');
      expect(r.ok).toBe(true);
      expect((r as any).value.intent).toBe('parameter');
      expect((r as any).value.confidence).toBeGreaterThan(0.9);
      // Section 66 wants the evidence, and the runner-up is most of it.
      expect(Object.keys((r as any).value.scores).length).toBeGreaterThan(1);
      // A model produced it, so it is a proposal and must be labelled as one.
      expect((r as any).determinism).toBe('stochastic');
    } finally { restoreFetch(); }
  });

  it('surfaces an abstention rather than hiding it as ordinary speech', async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith('/health')) return jsonRes({ ok: true, device: 'cpu', threshold: 0.45 });
      return jsonRes({
        ok: true,
        results: [{ intent: 'speech', confidence: 0.31, abstained: true, scores: { speech: 0.3 } }],
      });
    });
    try {
      const r = await new LocalIntentProvider().classify('let us look at that');
      expect(r.ok).toBe(true);
      // A teacher watching AES do nothing is entitled to know it almost did something.
      expect((r as any).value.abstained).toBe(true);
    } finally { restoreFetch(); }
  });

  it('refuses when the server answers with no reading at all', async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith('/health')) return jsonRes({ ok: true, device: 'cpu', threshold: 0.45 });
      return jsonRes({ ok: true, results: [] });   // ok:true, and yet nothing was classified
    });
    try {
      const r = await new LocalIntentProvider().classify('show the atom');
      expect(r.ok).toBe(false);
      expect(String((r as any).reason)).toContain('no reading');
    } finally { restoreFetch(); }
  });

  it('refuses a batch whose length does not match what was asked', async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith('/health')) return jsonRes({ ok: true, device: 'cpu', threshold: 0.45 });
      return jsonRes({ ok: true, results: [{ intent: 'speech', confidence: 0.9, scores: {} }] });
    });
    try {
      const r = await new LocalIntentProvider().classifyMany(['a', 'b', 'c']);
      // Silently zipping three utterances to one reading would misattribute intents to the wrong
      // sentences, which is worse than failing.
      expect(r.ok).toBe(false);
    } finally { restoreFetch(); }
  });

  it('refuses an HTTP error instead of treating it as narration', async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith('/health')) return jsonRes({ ok: true, device: 'cpu', threshold: 0.45 });
      return jsonRes({}, false, 500);
    });
    try {
      const r = await new LocalIntentProvider().classify('run the experiment');
      expect(r.ok).toBe(false);
    } finally { restoreFetch(); }
  });
});

describe('the descriptor tells the truth', () => {
  it('states limits, and never claims none', () => {
    const p = new LocalIntentProvider();
    expect(p.descriptor.cannot.length).toBeGreaterThan(2);
    // The honesty that matters most: it has not heard a real teacher.
    expect(p.descriptor.cannot.join(' ')).toContain('never seen a real teacher');
    expect(p.descriptor.requires.length).toBeGreaterThan(0);
  });

  it('declares intent as stochastic, because a model guessed it', () => {
    const c = new LocalIntentProvider().descriptor.capabilities.find((x) => x.id === 'foundation.intent');
    expect(c?.determinism).toBe('stochastic');
  });
});


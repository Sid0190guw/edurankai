// src/lib/aes/providers/intent-model.ts — the in-house teacher-intent classifier, as a provider.
//
// This is the first model EduRankAI trained itself: a 66M-parameter encoder over the ten intent
// classes of spec section 12, fine-tuned on the founder's own laptop GPU in about two minutes
// (ml/intent/train.py). It is not rented, not an API, and not a vendor's. Section 41 says the first
// version must be architected as if the foundation model will eventually exist; this is the first
// piece of that model actually existing.
//
// WHERE IT RUNS, AND WHY THAT IS A DESIGN DECISION, NOT A LIMITATION.
// The checkpoint is 257 MB and cannot live inside a serverless function, and nothing here may run
// on metered cloud compute. Section 23 already puts real-time inference at the EDGE. So it is
// served from the teacher's own machine (ml/intent/serve.py) and this provider talks to it over
// loopback. Warm inference measured 26 ms for a single utterance, which is what makes section 22's
// ultra-low-latency path real: intent can be classified on EVERY sentence a teacher speaks.
//
// ABSENT IS A FIRST-CLASS ANSWER. When the local server is not running, this provider is
// unavailable with a reason and a remedy, and AES falls back to the deterministic rule-based route
// in ../intent.ts. It never guesses, and the console can always say which of the two is answering.
// That distinction matters to a teacher deciding how much to trust what just happened.
//
// WHAT THIS PROVIDER IS NOT ALLOWED TO DO.
//   - It does not decide anything. An intent is a READING of what was said, routed onward; the
//     teacher authority layer still gates whatever follows (section 28).
//   - It does not compute physics. Section 20: the model reads intent, a deterministic engine
//     computes behaviour. Nothing here may write a position, a velocity or an energy.
//   - It does not learn at runtime. Section 35: corrections are captured for validation, never
//     applied to a live model. There is no training path from this file.
//   - It does not see or store a learner. It classifies a sentence and returns.

import {
  BaseProvider, NullProvider, available, unavailable, unsupportedAll,
  type AesResult, type CapabilityDecl, type Health, type ProviderDescriptor,
} from './types';
import type { IntentKind } from '../intent';

/** Where the local server listens. Loopback by default and by intent — this is not a network service. */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8577';

/** A health probe must not stall a teaching session; a slow answer is the same as no answer. */
const HEALTH_TIMEOUT_MS = 1500;
const CLASSIFY_TIMEOUT_MS = 4000;

/** How long a health result is trusted before probing again. Long enough not to hammer the server,
 *  short enough that starting it mid-session is noticed within one utterance. */
const HEALTH_TTL_MS = 10_000;

export interface IntentReading {
  intent: IntentKind;
  confidence: number;
  /** True when the model preferred an instruction but was not confident enough to say so, and the
   *  reading was downgraded to speech. Surfaced because a teacher watching AES do nothing deserves
   *  to know it ALMOST did something. */
  abstained: boolean;
  /** Every class, not just the winner. Section 66 asks for the evidence behind a conclusion, and
   *  the runner-up is most of that evidence. */
  scores: Record<string, number>;
}

const CAPABILITIES: { id: string; summary: string; determinism: 'deterministic' | 'stochastic' }[] = [
  {
    id: 'foundation.intent',
    summary: 'Classify one teacher utterance into the ten intent classes of spec section 12.',
    // Stochastic: a model produced it. It is a PROPOSAL about what was meant, and everything
    // downstream treats it as one.
    determinism: 'stochastic',
  },
];

const CANNOT = [
  'It cannot decide anything. An intent is a reading, and the teacher authority layer still gates what follows.',
  'It cannot compute physics. A deterministic engine does that; nothing here writes a position or an energy.',
  'It cannot learn from a correction at runtime. Corrections are captured for validation, never applied live.',
  'It has never seen a real teacher speak. It was trained on a synthetic seed corpus.',
  'It reads English only, and short utterances only (48 tokens).',
];

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class LocalIntentProvider extends BaseProvider {
  private cached: { health: Health; at: number } | null = null;

  constructor(private readonly endpoint: string = DEFAULT_ENDPOINT) { super(); }

  readonly descriptor: ProviderDescriptor = {
    id: 'foundation.intent-local',
    kind: 'foundation',
    title: 'In-house intent classifier (local)',
    does:
      'Reads one teacher utterance and says which of the ten section-12 intents it was, with a ' +
      'confidence and the score for every class. Trained in-house; served on this machine.',
    cannot: CANNOT,
    requires: [
      'The local intent server running (python ml/intent/serve.py).',
      'A trained checkpoint in ml/intent/model (python ml/intent/train.py).',
    ],
    capabilities: CAPABILITIES.map((c) => ({ ...c, supported: true })),
  };

  async health(): Promise<Health> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < HEALTH_TTL_MS) return this.cached.health;

    let h: Health;
    try {
      const j = await fetchJson(this.endpoint + '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
      h = j?.ok
        ? available(
            'The in-house intent classifier is running on ' + String(j.device || 'this machine') +
            ', with an abstention threshold of ' + String(j.threshold) + '. ' +
            'It was trained on a synthetic seed corpus and has never heard a real teacher speak.')
        : unavailable(
            'The intent server answered but reported that it is not ready.',
            'Check the terminal running python ml/intent/serve.py.');
    } catch (e: any) {
      // The overwhelmingly common case is simply that nobody started it, so the remedy says so
      // plainly rather than presenting a stack trace to a teacher.
      h = unavailable(
        'The in-house intent classifier is not reachable at ' + this.endpoint +
        ', so AES is reading intent with its deterministic rules instead.',
        'Start it with: python ml/intent/serve.py   (train it first with python ml/intent/train.py)');
    }
    this.cached = { health: h, at: now };
    return h;
  }

  /** Classify one utterance. Refuses rather than guessing when the server is absent. */
  async classify(text: string): Promise<AesResult<IntentReading>> {
    return this.guarded('foundation.intent', async () => {
      const j = await fetchJson(
        this.endpoint + '/classify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
        CLASSIFY_TIMEOUT_MS,
      );
      const r = j?.results?.[0];
      if (!r || typeof r.intent !== 'string') {
        throw new Error('the intent server returned no reading for that utterance');
      }
      return {
        intent: r.intent as IntentKind,
        confidence: Number(r.confidence) || 0,
        abstained: !!r.abstained,
        scores: (r.scores || {}) as Record<string, number>,
      };
    });
  }

  /** Batch form, for replaying a transcript. Same refusal semantics. */
  async classifyMany(texts: string[]): Promise<AesResult<IntentReading[]>> {
    return this.guarded('foundation.intent', async () => {
      if (texts.length > 64) throw new Error('at most 64 utterances per request');
      const j = await fetchJson(
        this.endpoint + '/classify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts }),
        },
        CLASSIFY_TIMEOUT_MS,
      );
      const rows = Array.isArray(j?.results) ? j.results : [];
      if (rows.length !== texts.length) {
        throw new Error('the intent server returned ' + rows.length + ' readings for ' + texts.length + ' utterances');
      }
      return rows.map((r: any) => ({
        intent: r.intent as IntentKind,
        confidence: Number(r.confidence) || 0,
        abstained: !!r.abstained,
        scores: (r.scores || {}) as Record<string, number>,
      }));
    });
  }
}

/** Wired in before any model exists, so a surface can depend on the interface from day one. */
export class NullIntentProvider extends NullProvider {
  constructor() {
    super(
      'No in-house intent model is configured, so AES reads intent with its deterministic rules only.',
      'Train one with python ml/intent/train.py, then serve it with python ml/intent/serve.py.',
    );
  }

  readonly descriptor: ProviderDescriptor = {
    id: 'foundation.intent-null',
    kind: 'foundation',
    title: 'Intent classifier (none configured)',
    does: 'Nothing. It exists so a caller is refused with a reason rather than handed a guess.',
    cannot: ['It cannot classify anything at all.'],
    requires: ['A trained in-house model, or another intent provider.'],
    capabilities: unsupportedAll(
      CAPABILITIES,
      'No intent model is configured on this deployment.',
    ) as CapabilityDecl[],
  };
}

/**
 * The provider AES should use. Returns the local model when it is reachable, and the null provider
 * otherwise — so the caller always holds something that answers honestly, and never has to decide
 * whether a model exists.
 */
export async function intentProvider(endpoint?: string): Promise<BaseProvider> {
  const local = new LocalIntentProvider(endpoint);
  const h = await local.health();
  return h.state === 'available' ? local : new NullIntentProvider();
}

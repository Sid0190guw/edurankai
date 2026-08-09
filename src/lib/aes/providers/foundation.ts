// src/lib/aes/providers/foundation.ts — FoundationModelProvider (spec sections 41, 42, 20, 172).
//
// THE INTERFACE IS THE PRODUCT. AES does not yet contain its own foundation model, and the first
// version is explicitly not required to. What it IS required to do is refuse to assume that some
// external model is permanently the intelligence. So the language capability is expressed here as
// two operations and nothing else:
//
//   foundation.complete — produce text for a stated task.
//   foundation.intent   — turn an utterance into a STRUCTURED INTENT that a validator supplied by
//                         the caller has accepted. If the validator rejects it, the call is
//                         REFUSED. The model never gets to hand back an unchecked value.
//
// What is deliberately NOT here, and never will be:
//   - No "compute this physics" operation. Sections 20 and 172: the model decides intent, a
//     deterministic engine computes the result. A convincing-looking number is not a result.
//   - No "write the rendering code" operation. Generated code judged by whether the picture looks
//     right is the exact failure mode the specification forbids.
//   - No streaming/token/tool-shape assumptions. A future own model, a self-hosted open-weight
//     model, and any connected model all fit behind the same two methods.
//
// VENDOR NEUTRALITY. This file names no vendor and imports no vendor SDK. It reaches configured
// model access through this project's own gateway, and translates whatever is configured into a
// neutral modelClass: 'self-hosted' (a model this organisation runs) or 'connected' (an optional
// external connector). Callers above see only that word.

import { parseLlmJson } from '@/lib/board-speech';
import {
  BaseProvider, NullProvider, available, unavailable, refuse, unsupportedAll, errText,
  type AesProvider, type AesResult, type CapabilityDecl, type Health, type ProviderDescriptor,
} from './types';

export type ModelClass = 'self-hosted' | 'connected';

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface CompletionRequest {
  /** Accounting label, e.g. 'aes.lesson-explain'. */
  feature: string;
  /** Plain-language statement of the task, for the trace a teacher can read. */
  task: string;
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
  userId?: string | null;
}

export interface CompletionValue { text: string; modelClass: ModelClass }

export interface IntentRequest<T> {
  feature: string;
  utterance: string;
  system: string;
  /** The clamp. Returns the accepted intent, or null to REJECT the model's answer outright.
   *  Section 20: an intent that nothing validated is not an intent, it is a guess. */
  validate: (raw: any) => T | null;
  maxTokens?: number;
  userId?: string | null;
}

export interface IntentValue<T> { intent: T; raw: string; modelClass: ModelClass }

export interface FoundationModelProvider extends AesProvider {
  complete(req: CompletionRequest): Promise<AesResult<CompletionValue>>;
  intent<T>(req: IntentRequest<T>): Promise<AesResult<IntentValue<T>>>;
}

export const FOUNDATION_CAPABILITIES: { id: string; summary: string; determinism: 'stochastic' }[] = [
  { id: 'foundation.complete', summary: 'Produce text for a stated task.', determinism: 'stochastic' },
  { id: 'foundation.intent', summary: 'Turn an utterance into a structured intent that a caller-supplied validator accepts.', determinism: 'stochastic' },
];

const CANNOT = [
  'Compute a physical, numerical or scientific result. Ask the simulation provider — a plausible number is not a computed one.',
  'Author rendering code, frames or pixels. It proposes intent; the rendering provider decides how anything is drawn.',
  'Decide whether its own answer is correct. A validator or a teacher decides that.',
  'Update itself from a correction. Corrections are captured and curated, never fed back as training here.',
];

// ---------------------------------------------------------------- null (honest about doing nothing)

export class NullFoundationModel extends NullProvider implements FoundationModelProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(reason = 'No foundation model is registered for this deployment.',
              remedy = 'Register a foundation provider — a model this organisation runs, or an optional connector — in the AES provider registry.') {
    super(reason, remedy);
    this.descriptor = {
      id: 'foundation.null',
      kind: 'foundation',
      title: 'No language model',
      does: 'Nothing. It exists so every AES surface can be wired to the foundation interface before any model exists, and be refused with a reason rather than left to guess.',
      cannot: ['Anything at all. Every call is refused, with the reason above.'],
      requires: ['a registered foundation model'],
      capabilities: unsupportedAll(FOUNDATION_CAPABILITIES, reason),
    };
  }

  complete(_req: CompletionRequest): Promise<AesResult<CompletionValue>> {
    return this.guarded('foundation.complete', () => { throw new Error('unreachable'); }) as Promise<AesResult<CompletionValue>>;
  }
  intent<T>(_req: IntentRequest<T>): Promise<AesResult<IntentValue<T>>> {
    return this.guarded('foundation.intent', () => { throw new Error('unreachable'); }) as Promise<AesResult<IntentValue<T>>>;
  }
}

// ------------------------------------------------------------------ the real one, over the gateway

/** The seam between this layer and whatever model access is configured. Both hooks are injectable,
 *  which is how the tests drive a configured and an unconfigured deployment without a network or a
 *  database — and how a future own-model runtime is dropped in without touching this file. */
export interface ModelAccess {
  probe(): Promise<{ ready: boolean; modelClass: ModelClass; detail: string }>;
  run(o: { feature: string; system: string; messages: ChatTurn[]; maxTokens?: number; userId?: string | null }):
    Promise<{ ok: boolean; text: string; configured: boolean; modelClass: ModelClass; error?: string }>;
}

/** Default access: this project's own gateway, imported dynamically so that merely importing the
 *  provider layer never opens a configuration read. */
export const gatewayAccess: ModelAccess = {
  async probe() {
    const g: any = await import('@/lib/llm/gateway');
    const cfg = await g.effectiveConfig();
    const modelClass: ModelClass = cfg.provider === 'own' ? 'self-hosted' : 'connected';
    const ready = !!g.isReady(cfg);
    return {
      ready,
      modelClass,
      detail: ready
        ? (modelClass === 'self-hosted' ? 'a model this organisation runs' : 'an optional external connector')
        : 'no endpoint or credential is configured',
    };
  },
  async run(o) {
    const g: any = await import('@/lib/llm/gateway');
    const r = await g.complete({
      feature: o.feature, system: o.system, messages: o.messages,
      userId: o.userId ?? null, maxTokens: o.maxTokens,
    });
    return {
      ok: !!r.ok,
      text: String(r.text || ''),
      configured: !!r.configured,
      modelClass: r.provider === 'own' ? 'self-hosted' : 'connected',
      error: r.error,
    };
  },
};

export class GatewayFoundationModel extends BaseProvider implements FoundationModelProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(private readonly access: ModelAccess = gatewayAccess) {
    super();
    const caps: CapabilityDecl[] = FOUNDATION_CAPABILITIES.map((c) => ({ ...c, supported: true }));
    this.descriptor = {
      id: 'foundation.gateway',
      kind: 'foundation',
      title: 'Configured language model',
      does: 'Sends a task to whatever language model this deployment has been configured with — a model this organisation runs, or an optional connector — and returns text, or an intent a validator has accepted.',
      cannot: CANNOT,
      requires: ['a model endpoint or credential configured for this deployment'],
      capabilities: caps,
    };
  }

  /** Configuration probe only. It does not call the model, so the console can show status without
   *  spending a request. An unreadable configuration is an unavailability, not an exception. */
  async health(): Promise<Health> {
    try {
      const p = await this.access.probe();
      if (!p.ready) {
        return unavailable(
          'This deployment has no language model configured, so every foundation call is refused.',
          'Configure a model endpoint this organisation runs, or enable an optional connector, in the model settings.',
        );
      }
      return available('A language model is configured (' + p.detail + ') and answering foundation calls.');
    } catch (e: any) {
      return unavailable(
        'The model configuration could not be read, so the foundation layer is treated as absent: ' + errText(e) + '.',
        'Check the model settings surface; until it reads cleanly, AES runs on its deterministic engines only.',
      );
    }
  }

  async complete(req: CompletionRequest): Promise<AesResult<CompletionValue>> {
    return this.guarded('foundation.complete', async () => {
      const r = await this.access.run({
        feature: req.feature, system: req.system, messages: req.messages,
        maxTokens: req.maxTokens, userId: req.userId ?? null,
      });
      if (!r.configured) throw new Error('the configured model disappeared between the health check and the call');
      if (!r.ok) throw new Error(r.error || 'the model returned no answer');
      return { text: r.text, modelClass: r.modelClass };
    });
  }

  /** Section 20 in one method: the model proposes, the caller's validator disposes. A completion
   *  that does not survive validation is a REFUSAL with a reason — never a half-accepted value. */
  async intent<T>(req: IntentRequest<T>): Promise<AesResult<IntentValue<T>>> {
    const inner = await this.guarded('foundation.intent', async () => {
      const r = await this.access.run({
        feature: req.feature, system: req.system,
        messages: [{ role: 'user' as const, content: req.utterance }],
        maxTokens: req.maxTokens, userId: req.userId ?? null,
      });
      if (!r.configured) throw new Error('the configured model disappeared between the health check and the call');
      if (!r.ok) throw new Error(r.error || 'the model returned no answer');
      return { raw: r.text, parsed: parseLlmJson(r.text), modelClass: r.modelClass };
    });
    if (!inner.ok) return inner;

    const accepted = req.validate(inner.value.parsed);
    if (accepted === null || accepted === undefined) {
      return refuse(
        this.descriptor.id, 'foundation.intent',
        'The model proposed an intent that failed validation, so it was rejected rather than used.',
        'Nothing was changed. Use the deterministic path, or state the instruction more plainly.',
      );
    }
    return {
      ok: true, providerId: this.descriptor.id, capability: 'foundation.intent', determinism: 'stochastic',
      value: { intent: accepted, raw: inner.value.raw, modelClass: inner.value.modelClass },
      elapsedMs: inner.elapsedMs,
    };
  }
}

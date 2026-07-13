# AES-100 Vol III P2 Ch 18 — Unified AI Runtime & Inference (public/aquin-inference.js)

Intelligence as a built-in, governed OS capability. Node-tested (5).
- **Model registry + capability routing**: newest healthy version-compatible model
  (v2 chosen; falls back to v1 when v2 unhealthy).
- **Context-window management** (the real LLM-runtime problem): a token budget;
  over-budget turns EVICT oldest non-pinned; a pinned system prompt survives.
- **Inference batching** for GPU throughput (20 requests → [8,8,4]).
- **Safety gate**: input/output must pass policy.
HONEST SCOPE: registry/routing/context-budget/batching/safety real; model weights,
GPU/TPU kernels, KV-cache, tokenizer declared substrates — this GOVERNS a model, it
is not the model.

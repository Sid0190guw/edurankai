<!-- Generated 2026-07-26 by the sovereignty-dependency-audit workflow (6 domain scanners + synthesis, 35 dependencies mapped). Under the First-Party Technology Sovereignty Constitution. -->

# First-Party Technology Sovereignty Audit — EduRankAI

## 1. Executive verdict

The platform is **substantially sovereign already** — far more than a typical Vercel-hosted product. The database speaks raw Postgres over a connection string (zero vendor SDK), auth/session/RBAC/WebAuthn/TOTP are hand-built on `node:crypto`, email is own-SMTP via nodemailer, search and the job queue are Postgres-native, and the one external AI *service* (Anthropic Claude) sits behind a first-party gateway whose `provider='own'` path already speaks the OpenAI `/chat/completions` protocol to any self-hosted open-weight model. The **single biggest lock-in is object storage**: `@vercel/blob` is a hard dependency called directly in ~9 upload endpoints holding the most sensitive data on the platform (government-ID images, biometric face selfies, employee docs), and its API is *not* S3-compatible — so it cannot be swapped by config alone even though a swap-ready `BlobStore` interface already exists and is used by VOD.

The org's "build everything from scratch" goal is, on the evidence of the code, **being interpreted pragmatically and correctly**: mature primitives are reused (Postgres, nodemailer, imapflow, open-weight face/OCR models), proprietary services appear as optional connectors behind first-party interfaces (KV, proctoring, payment gateway, LLM gateway), and nobody is reinventing a database engine or training a frontier model. The gaps are not philosophical — they are **incomplete adoption of interfaces that already exist** (storage, payments) plus **four legacy LLM callers that bypass the gateway**. This is a finishing job, not a rebuild.

## 2. Sovereignty scorecard

| Capability | Current dependency | Coupling | Lock-in risk | Sovereign target | Effort |
|---|---|---|---|---|---|
| Object storage — PII uploads (ID/KYC, face selfies, docs, media) | `@vercel/blob` (direct `put()` in ~9 routes) | hard | **HIGH** | MinIO/S3 via `@aws-sdk/client-s3` behind existing `src/lib/storage.ts` `BlobStore` | medium |
| LLM inference — legacy path (FAQ bot, course tutor, lang tutor, interview Q-gen) | `api.anthropic.com` hard-wired in 4 files | hard | **HIGH** | Route through `src/lib/llm/gateway.ts` → self-hosted vLLM/Ollama open-weight | small |
| Biometric face 2FA / ID verify | `@vladmandic/face-api` + weights from jsDelivr CDN | hard (delivery) | **HIGH** | Vendor lib + open weights into `public/models/`, repoint 2 URLs | small |
| LLM inference — gateway path (tutor, board, extraction) | Anthropic as one selectable provider | behind-interface | medium | `provider='own'` self-hosted open-weight (already wired, config toggle) | small |
| Payment collection (checkout) | Razorpay REST (native fetch); ~15 endpoints bypass the interface | behind-interface | medium | Route all endpoints through `src/lib/payment-gateway.ts`; add 2nd PSP impl | medium |
| Bank payout / salary disbursement | RazorpayX inline fetch in `hr-wallet.ts` (never abstracted) | optional-fallback | medium | Extract first-party `Payouts` interface; manual-settlement fallback exists | small |
| WebRTC NAT traversal | Google public STUN `stun.l.google.com` (hardcoded) | hard | medium | Self-hosted coturn; lift to `ICE_SERVERS` env; add TURN relay | small |
| ID-image storage (identity verify evidence) | `@vercel/blob` (best-effort) | optional-fallback | medium | Same S3/MinIO adapter as above | small |
| Shared cache / KV | `@vercel/kv` (env-gated, lazy, build-excluded) | optional-fallback | low | Self-hosted Redis/Valkey behind `KvStore` (`src/lib/vsm/kv.ts`) | small |
| FX rates | `frankfurter.app` (1 URL, fallback table exists) | optional-fallback | low | Self-host frankfurter or ingest ECB XML into Postgres | small |
| Primary relational DB | Managed Postgres (Supabase) via `DATABASE_URL` | behind-interface | low | Self-hosted Postgres — one env change, zero code | trivial |
| Outbound email | nodemailer / SMTP | behind-interface | low | Self-hosted Postfix (already supported) | trivial |
| Inbound email | imapflow / IMAP | behind-interface | low | Self-hosted Dovecot (already supported) | trivial |
| Browser push | `web-push` / VAPID (self-held keys) | optional-fallback | low | Already sovereign; in-app bell is DB-backed fallback | trivial |
| Remote proctoring | Honorlock/ProctorU/Examity behind interface | behind-interface | low | Self-built advisory proctor is the default | small |
| SSR host / deploy target | `@astrojs/vercel/serverless` | optional-fallback | low | `@astrojs/node` standalone (already default off-Vercel) | trivial |
| Scheduled jobs | vercel.json crons | optional-fallback | low | GitHub Actions / system cron (already used) | trivial |
| Auth / session / RBAC / TOTP / WebAuthn | `node:crypto` + `@oslojs/*` (OSS primitives) | hard | low | Already fully sovereign | trivial |
| OCR | Tesseract.js from CDN (open-source, client-side) | optional-fallback | low | Self-host engine + `.traineddata` under `/public/` | trivial |
| Search / job queue | Postgres-native (no external service) | behind-interface | low | Already sovereign | trivial |
| Reverse geocoding | Nominatim/OSM public instance | optional-fallback | low | Self-host Nominatim or server-side proxy | medium |
| Web analytics | Google gtag.js (redundant with own tracker) | optional-fallback | low | Drop it; `public/analytics.js → /api/track` already runs | trivial |
| Admin web fonts | Google Fonts CDN in `AdminLayout.astro` | hard | low | Self-host OFL woff2 under `/public/fonts` | trivial |
| Outbound email (Resend) | Vestigial config, **never invoked** | dev-only | low | Delete the dead field/env/type/UI copy | trivial |

## 3. The hard dependencies that must be broken first

These are the items where the platform **cannot run — or a core, high-sensitivity feature cannot run — without a proprietary service**. Everything else has a working fallback today.

### 3.1 Object storage (`@vercel/blob` direct callers)

**Why it's a true blocker:** ~9 endpoints import `put` directly from `@vercel/blob` and store real user PII. Without `BLOB_READ_WRITE_TOKEN` uploads fail (and per HRMS audit G15, photos silently fall back to base64 data-URLs written inline into Postgres — a data-bloat and correctness hazard). The Vercel Blob API is proprietary and **not S3-compatible**, so no config swap is possible.

- **Interface to introduce:** none new — extend the existing `BlobStore` in `src/lib/storage.ts` (already has `vercelBlobStore()`, `memoryStore()`, `getStore()`, `storageProvisioned()`). Add `s3Store()` implementing the same `put/url/kind/enabled` contract via `@aws-sdk/client-s3` (presigned PUT).
- **Open standard it should speak:** S3 REST API.
- **Self-hostable default:** MinIO (or Supabase Storage's S3 endpoint as an interim, non-Vercel option).
- **Concrete files to refactor** (replace direct `import { put }` with `getStore().put()`): `src/pages/api/auth/id-upload.ts`, `src/pages/api/uploads/employee-doc.ts`, `src/pages/api/admin/upload-image.ts`, `src/pages/api/portal/profile-photo.ts`, `src/pages/api/aquintutor/lesson-blocks/upload.ts`, `src/pages/api/aquintutor/interview/id-doc.ts`, `src/pages/api/aquintutor/interview/generate-from-doc.ts`, `src/pages/admin/api/chat/upload.ts`, `src/pages/api/auth/enroll-face-selfie.ts` (dynamic import at :63), and `src/pages/api/auth/identity-setup.ts` (:76,144-156). Also relabel the `list()` metrics read in `src/pages/admin/infra.astro:41`.

### 3.2 Biometric face-auth library delivery (`@vladmandic/face-api` from jsDelivr)

**Why it's a true blocker:** `src/middleware.ts` (lines ~279-292, `isProtected` + `hasFaceEnrolled`) **enforces face enrollment on every `/admin` and `/portal` surface**. If jsDelivr is unreachable a user cannot enroll and is gated out — the enrollment path has no library fallback. `portal/face-setup.astro` pins models to unpinned `@latest`, a supply-chain and availability hazard.

- **Interface to introduce:** none — this is pure delivery. The library is MIT and weights are open; only hosting is non-sovereign. The server-side euclidean match (`face-2fa-portable/src/lib/face.ts`, `admin/login.astro:22-26`) is already first-party.
- **Open standard:** none applicable (client-side open-weight CNN).
- **Self-hostable default:** vendor `face-api.min.js` + `ssdMobilenetv1`/`faceLandmark68Net`/`faceRecognitionNet` weight shards under `public/models/`, load same-origin.
- **Concrete files:** repoint the two `cdn.jsdelivr.net` URLs in `src/pages/enroll-face.astro:77,117` and `src/pages/portal/face-setup.astro:26,80` (and drop the `@latest` pin); mirror in `face-2fa-portable/src/pages/face-2fa/{enroll,login}.astro`. Tightens CSP as a bonus.

### 3.3 Legacy LLM callers (4 files hard-wired to `api.anthropic.com`)

**Why it belongs here:** these are the only place Anthropic is a genuine hard-wired dependency with no swap path, and several degrade **silently** (interview follow-ups vanish at `interview/turn.ts:62`; `llm.ts generateInterviewQuestions` returns `[]`), while `ai-tutor.ts:91-128` awards 4 XP against a stub reply — a correctness bug, not just a sovereignty one.

- **Interface to route through:** the existing `src/lib/llm/gateway.ts` (`chat`/`chatStream`), which already carries the `provider='own'` self-hosted path.
- **Open standard:** OpenAI-compatible `/chat/completions` HTTP.
- **Self-hostable default:** one vLLM/TGI/llama.cpp/Ollama server running a Llama/Mistral/Qwen-class open-weight model.
- **Concrete files:** `src/lib/llm.ts` (`generateInterviewQuestions`, `askFollowUp`), `src/lib/ai-tutor.ts` (`continueConversation` — and fix the XP-on-stub bug), `src/pages/api/ai/chat.ts` (FAQ bot), `src/pages/api/aquintutor/tutor.ts` (course tutor). Each is a small mechanical change: build system+messages, call `chat()`, delete the hardcoded model ID and `x-api-key` fetch.

### 3.4 WebRTC STUN (`stun.l.google.com`)

**Why it's here:** the only external service the comms domain reaches, hardcoded at `src/pages/portal/meet/[id].astro:1498-1499`; if unreachable, P2P across restrictive NATs fails.

- **Interface:** lift the hardcoded `iceServers` to an env-driven `ICE_SERVERS` constant.
- **Open standard:** STUN/TURN (RFC 5389 / RFC 8656).
- **Self-hostable default:** coturn (STUN **and** TURN — note **no TURN relay is configured anywhere today**, so symmetric-NAT peers have no fallback; close that gap when standing up coturn). The newer aquintutor huddle configures no ICE servers at all (host candidates only) and needs the same treatment.

## 4. Prioritized migration roadmap

### P0 — Now (trivial, hours, mostly config/deletion)
- **Self-host admin fonts:** download the 3 OFL woff2 families to `public/fonts`, add `@font-face`, remove the Google Fonts `<link>` in `AdminLayout.astro:253-255`.
- **Drop Google Analytics:** remove the gtag block in `BaseLayout.astro:117-127` / leave `PUBLIC_GA_ID` unset; `public/analytics.js → /api/track` already covers it.
- **Delete dead Resend config:** `resend_api_key` column read + `RESEND_API_KEY` env in `src/lib/mail.ts`, the `'resend'` union member in `mail-transport.ts`, and the "SMTP/Resend" UI copy — prevents a future "just paste a Resend key" regression.
- **Prune dormant DB deps:** remove `@neondatabase/serverless` (package.json:19) and the dead `src/lib/db/index.ts.bak`; remove unused `pg`; relabel `admin/infra.astro:36,55,73` off "Neon (Postgres)" / `NEON_FREE_BYTES` (it currently misreports the provider to operators).
- **Vendor face-api + OCR assets** into `public/models/` and `public/` (Tesseract engine, WASM, pdf.js, per-language `.traineddata`); repoint CDN URLs. Closes 3.2 and the OCR CDN lock-in in one pass; enables true offline for the rural goal.

### P1 — Near-term (small, the half-done interfaces)
- **Storage → S3 adapter (3.1):** add `s3Store()` to `src/lib/storage.ts`, refactor the ~10 direct callers through `getStore()`. **Highest-value single item in the audit** — it de-risks all PII at once and makes an off-Vercel lift a plain Node container behind nginx.
- **LLM legacy → gateway (3.3):** refactor the 4 files through `src/lib/llm/gateway.ts`; fix the `ai-tutor.ts` XP-on-stub bug in the same change.
- **STUN → env + coturn (3.4):** lift `ICE_SERVERS` to env, deploy coturn with a TURN relay.
- **KV interface parity:** add a self-hosted Redis/Valkey adapter to `src/lib/vsm/kv.ts` (interface already exists; only the adapter body changes).

### P2 — Payments uniformity (medium)
- **Route all payment endpoints through `payment-gateway.ts`:** the ~15 endpoints in `src/pages/api/payments/*`, `start-*.ts`, `founder/pay/*`, `aquintutor/checkout|confirm-payment` that call `src/lib/razorpay.ts` directly. A rail change then becomes a one-file swap.
- **Extract a `Payouts` interface** for `src/lib/hr-wallet.ts:181-213` (RazorpayX inline fetch); add an idempotency key and async payout-reconciliation webhook (reliability gap the audit flags). Manual-settlement fallback already exists.
- **FX self-hosting:** self-host frankfurter or ingest ECB daily XML into a Postgres `rates` table; swap the one URL in `src/lib/fx.ts:30`. Fallback table already present.

### P3 — Stand up the sovereign runtime (real infrastructure work)
- **Deploy one open-weight inference server** (vLLM/TGI/Ollama, Llama/Mistral/Qwen-class) behind the existing gateway `provider='own'` path; set the `own` baseUrl in super-admin DB config; flip the gateway `enabled` flag. This is a **GPU-hosting and ops commitment** (model serving, batching, uptime), not a code change — the code path already exists. Begin fine-tuning against the captured `ai_training_example` corpus once traffic accrues.
- **Full off-Vercel lift rehearsal:** `astro build` with `@astrojs/node`, run behind nginx/Caddy (reproduce `vercel.json` headers there or in `src/middleware.ts`), system-cron/GitHub-Actions the 7 CRON_SECRET endpoints, MinIO for blobs, self-hosted Postgres via `DATABASE_URL`. Everything needed is already dual-wired; this proves it end to end.
- **Self-host Nominatim** (or server-side proxy) for geocoding to respect OSM's usage policy for client-side bulk hits.

### P4 — Long-horizon / optional
- **Second payment rail** (alternate PSP or direct UPI/bank-collect) behind the now-uniform `PaymentGateway` — real sovereignty is *swappability of the rail*, since a bank rail is inherently un-self-hostable.
- **First-party fine-tuned model** trained on `ai_training_example`, replacing the general open-weight base for the grounded-tutor and Socratic tasks. This is an ML-engineering program, not a migration ticket — see Honest limits.

## 5. Honest limits

The constitution's own definition already draws the line correctly — "sovereign replacement = self-hosted OSS / open-weight models / thin first-party impl, **NOT** reinventing mature libraries or training frontier models." Holding to that:

- **Training a foundation/frontier model from scratch is not feasible** for a small self-funded org, and the directive does not ask for it. The realistic sovereign substitute is **self-hosting an open-weight model** (Llama/Mistral/Qwen-class) behind the gateway that already exists, and **fine-tuning it** on the first-party `ai_training_example` corpus for the specific tutor/Socratic/extraction tasks. That yields provider independence and data control — the actual sovereignty goals — without a frontier-lab budget. The true cost is **GPU hosting + inference ops + eval discipline**, ongoing, not one-time.

- **Writing a custom transformer/NN/tokenizer from scratch would violate the "don't reinvent mature libraries" clause** and buy nothing. Use vLLM/TGI/llama.cpp and standard tokenizers. The face-recognition and OCR CNNs are likewise correctly *used, not rebuilt* — the only work there is vendoring the weights, which P0 does.

- **Payment and bank rails cannot be self-hosted, period.** Razorpay/RazorpayX terminate at regulated banking infrastructure. The honest sovereign posture is not "own the rail" but "own the *interface* and keep two rails swappable" — which is why P2 (uniform gateway adoption) is the real deliverable, not an impossible self-hosted PSP.

- **The final Web Push hop traverses a browser vendor's endpoint** (FCM/Mozilla autopush/Apple). This is inherent to RFC 8030, not a chosen dependency; you hold your own VAPID keys and hand over only the encrypted payload the browser itself minted. No further sovereignty is achievable or needed; the DB-backed in-app bell already works without it.

- **Managed Postgres is a hosting choice, not lock-in.** Because there is no vendor SDK in the active path, "sovereign Postgres" is genuinely a one-line `DATABASE_URL` change — but self-hosting it means **owning backups, HA, and patching**, which is a real operational cost the org should adopt deliberately, not by default.

Net: nothing in the vision is being abandoned. The genuinely large item — a self-hosted, eventually fine-tuned open-weight model — is real work (P3/P4, measured in GPU spend and ML-ops, not sprints), and the code seam for it already exists. Everything else is finishing interfaces the team already designed correctly but only half-adopted.
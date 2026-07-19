# Load-test plan — the buildable app layer (Prompt AP7b)

Scope: the application layer we can load-test without provisioning the SFU/CDN (those are separate
infra follow-ups, see `huddle-sfu-followup.md`). Tools: **k6** or **autocannon** against a staging
deploy (never production; use a throwaway DB).

## Targets (per instance, staging)
| Path | Scenario | Target |
|---|---|---|
| `GET /api/aquintutor/board/stream?session=…` | N concurrent SSE viewers pulling the spec fan-out | 500 concurrent holds; p95 first-byte < 500ms |
| `POST /api/aquintutor/board` (fire) | teacher fires at 1–2/s | p95 < 300ms; no lock contention |
| `POST /api/aquintutor/broadcast/say` | 200 viewers chatting/reacting | rate-limit caps floods; p95 < 400ms |
| `GET /api/jobs/run` | worker draining 1k queued notifications | throughput > 200 jobs/batch; retries bounded |
| `POST /api/aquintutor/checkout` (create, sandbox) | 50/s | p95 < 400ms; idempotent |

## Method
1. Seed a staging DB; set `BLOB_READ_WRITE_TOKEN` + sandbox payment mode.
2. k6 ramp: 0→target over 2m, hold 5m, ramp down. Capture p50/p95/p99, error rate, DB connections.
3. Watch: Postgres connection pool saturation (pooler :6543), `edu_board_events` write rate, job-claim
   contention (`FOR UPDATE SKIP LOCKED` should keep it clean), SSE memory per held connection.

## Known ceilings (honest)
- **SSE on serverless** is short-lived (~45s) + auto-reconnect — load the reconnection storm, not a
  single long hold. Many simultaneous reconnects hit the signaling/stream endpoint; verify the DB
  poll (`eventsSince`) stays index-only.
- **Mesh video** does not scale past ~6 peers — out of scope here; SFU follow-up.
- **Postgres queue** is reliable but not a broker; if `edu_jobs` write/claim rate saturates, that is
  the signal to provision a real broker (SQS/Redis) — do not push the Postgres queue past its limits
  in a load test and call it broker throughput.

## Pass criteria
Error rate < 0.5% at target concurrency; no unbounded ret/queue growth; DB pool < 80% saturation.

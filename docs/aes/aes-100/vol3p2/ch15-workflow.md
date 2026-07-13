# AES-100 Vol III P2 Ch 15 — Distributed Scheduler & Workflow (public/aquin-workflow.js)

Coordinates long-running processes as governed DAGs. Node-tested (5).
- **DAG execution**: topological LEVELS so independent tasks run in parallel, each
  after its deps ([prep],[featurize,train],[evaluate],[deploy]).
- **Cycle detection**: dependency cycle refused.
- **Retry + halt**: failing task retried to its limit; still failing → workflow halts,
  downstream never runs (no partial corruption).
- **Checkpoint/resume**: completed tasks checkpointed; re-run resumes, skipping
  finished work (resume ran only evaluate+deploy after fixing a failure).
HONEST SCOPE: DAG scheduling/retry/checkpoint real; distributed HPC/edge/cloud
placement + task compute declared substrates. (~31.8M-LOC C++ → core.)

# docs/ops — operational runbooks

Written to be executed by a person at 2am who did not build the system. Every command in these
documents is real and runnable against this stack: Astro 5 on Vercel (Hobby), Supabase Postgres via
the transaction pooler, no migration runner, no CI.

## Which document

| Situation | Open |
| --- | --- |
| **Something is broken right now.** | [INCIDENT.md](INCIDENT.md) — start at section 1, two curl commands. |
| A deploy made it worse. | [ROLLBACK.md](ROLLBACK.md) — section 1 is the fastest safe action and costs no deploy budget. |
| Shipping a change. | [DEPLOYMENT.md](DEPLOYMENT.md) — pre-flight gate in section 2, verification in section 6. |
| About to run a rollback stage, or it is backup day. | [BACKUP.md](BACKUP.md) — section 3 is the dump that must precede any org-graph rollback. |
| Nothing is on fire and you want it to stay that way. | [MONITORING.md](MONITORING.md) — what to watch and the daily/weekly routine. |

## The three facts that explain most incidents here

1. **Pushed is not live.** `git push` proves bytes reached GitHub and nothing more. DEPLOYMENT.md
   section 6 is how you find out what is actually serving.
2. **Rolling back code does not roll back schema.** DDL self-bootstraps on first use and
   `ADD COLUMN IF NOT EXISTS` is forward-only. ROLLBACK.md section 3.
3. **Nothing is watching.** `/api/health` exists, returns 503 on a database outage, and is polled by
   no one. Every incident is currently detected by a human noticing. MONITORING.md, "Not yet in
   place".

## Every "Not yet in place" section is load-bearing

Each document ends with one. They list what is genuinely absent — no external uptime monitor, no
alerting channel, no automated backup, no CI, an unscheduled job worker — and what it would take to
close each gap. A runbook describing monitoring nobody configured is worse than none, because it is
believed. Read those sections before assuming any protection exists.

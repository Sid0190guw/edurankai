# AES-100 Vol III P2 Ch 6 — Database Runtime Engine (public/aquin-db.js)

Transactional store beneath every stateful service. Node-tested (5). Classic DB theory.
- **Indexed storage**: primary-key index → O(1) point lookups.
- **ACID transactions**: begin/commit/rollback; writes buffered, applied atomically
  on commit, discarded on rollback.
- **MVCC snapshot isolation** (Postgres-style): a txn reads a consistent snapshot
  from begin — concurrent commits are invisible (repeatable reads), own writes seen.
- **Optimistic concurrency**: commit aborts on a write-write conflict (a key we wrote
  was committed by another txn after our snapshot) — no lost updates.
HONEST SCOPE: index/transaction/MVCC/conflict logic real in-memory; on-disk B-tree
pages, WAL, durable fsync, distributed replication declared substrates.
(No detailed spec was provided for Ch 6; built from standard database theory.)

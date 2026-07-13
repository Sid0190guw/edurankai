# AES-100 Vol III P2 Ch 2 — Universal Filesystem (public/aquin-ufs.js)

Knowledge-aware filesystem core. Node-tested (8).
- **Content-addressable storage** (FNV-1a): identical content stored once (dedup —
  2 objects/1 blob, 29 bytes saved in test).
- **Native versioning**: every write appends a version; historical get.
- **Namespace quotas**: over-quota write rejected.
- **Semantic search** by tags across an object's history (meaning, not filename).
- **Journaling**: append-only mutation log.
- **Snapshots** + restore.
- **Integrity**: tampered blob detected by content-hash mismatch.
HONEST SCOPE: FS semantics real over in-memory store; physical block allocation,
on-disk journaling, encryption-at-rest, replication are declared substrates.
(~4.7M-LOC C++ → the core.)

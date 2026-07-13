# AES-100 Vol III P2 Ch 5 — Object Storage Engine (public/aquin-ose.js)

S3-style object store; the cores UFS does NOT do. Node-tested (5).
- Content-addressable, VERSIONED objects (each PUT = new version).
- **Lifecycle policies**: transition to a colder tier after N days; EXPIRE (delete)
  after M days (applyLifecycle).
- **WORM immutability**: retention lock blocks overwrite/delete until it elapses
  (also protects from lifecycle expiry); compliance/tamper-evidence.
- **Multipart** upload assembled in order.
Complements Ch 2 UFS (avoids duplication). HONEST SCOPE: object semantics real;
erasure-coded durability (see aquin-vsm.js), multi-cloud federation, on-disk storage
declared substrates.

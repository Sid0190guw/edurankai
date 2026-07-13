# AES-100 Vol III P2 Ch 3 — Virtual Storage Manager (public/aquin-vsm.js)

Virtualizes physical media into pools + tiers. Node-tested. Named algorithms.
- **Multi-tier + automatic tiering**: frequently-accessed volumes promoted to hot,
  idle ones demoted to cold (placement follows access).
- **Thin provisioning**: large logical size, physical consumed on write; a write
  exceeding real pool physical capacity is refused (no silent overcommit).
- **RAID-5 XOR erasure coding**: k data shards + 1 parity; any one lost shard
  reconstructed EXACTLY as parity ⊕ survivors (d2, d3 both recovered bit-for-bit).
HONEST SCOPE: tiering/thin-provisioning/XOR-erasure math real; NVMe/SSD/HDD drivers,
Reed-Solomon(k,m), hardware offload declared substrates.

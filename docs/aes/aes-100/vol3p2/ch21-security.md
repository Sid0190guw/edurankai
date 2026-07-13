# AES-100 Vol III P2 Ch 21 — Constitutional Security & Zero Trust (public/aquin-security.js)

Trust backbone; zero-trust identity/continuous-auth already in aquin-identity.js, so
this builds the distinct security cores. Node-tested (4). Named techniques.
- **Measured secure boot** (TPM PCR-extend): each stage folded into a running
  measurement pcr'=H(pcr‖stage); a tampered stage yields a different measurement →
  boot REFUSED (rootkit detection: d7a76b68 ≠ golden ba2bc79c).
- **Remote attestation**: measurement + nonce vs golden; replay (stale nonce) and
  untrusted measurement rejected.
- **Security domains & trust boundaries**: default-deny lower→higher trust without an
  explicit cross-boundary grant.
HONEST SCOPE: measured-boot/attestation/trust-boundary logic real; physical TPM/HSM/
Secure-Enclave, secure-boot keys, cryptographic signing declared substrates.

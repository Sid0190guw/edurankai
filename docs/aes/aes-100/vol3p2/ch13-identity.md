# AES-100 Vol III P2 Ch 13 — Platform Identity, Access & Trust (public/aquin-identity.js)

One constitutional identity per entity; continuously trust-evaluated. Node-tested.
- Lifecycle registered→verified→active→revoked; humans/AI/agents same governance.
- Pluggable auth with an auth-QUALITY score (passkey/mTLS > password) feeding trust.
- Combined authorization: RBAC AND ABAC AND a RISK gate — all must pass; explainable.
- Continuous trust from auth quality + behavior + device integrity + geo; a risk
  spike (severe compromise → risk 0.595) triggers RE-AUTHENTICATION.
- Verifiable credentials: issue + verify; tampered claim detected.
HONEST SCOPE: identity/authz/trust/credential logic real; PKI/HSM, WebAuthn/FIDO2
attestation, biometric matching, quantum-safe crypto declared substrates.
(~24.9M-LOC C++ → core.)

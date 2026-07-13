# AES-100 Vol III P2 Ch 10 — API Gateway & Developer Platform (public/aquin-gateway.js)

Single constitutional entry point. Node-tested (6).
- **Pipeline**: authenticate(401) → authorize RBAC(403) → rate-limit(429) → route;
  stops at the first failed gate; 404 for unknown APIs.
- **Token-bucket rate limiting** (real algorithm): capacity + refill/sec; 3 ok then
  429; refills over time (allowed again after 2s).
- **API versioning**: semantic resolution (asks v1 → newest major-1 = 1.2.0).
HONEST SCOPE: pipeline/RBAC/token-bucket/version routing real; TLS termination,
OAuth2/OIDC issuance, protocol translation, SDK codegen declared substrates.
(~16.3M-LOC C++ → core.)

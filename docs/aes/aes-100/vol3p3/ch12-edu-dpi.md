# AES-100 Vol III P3 Ch 12 — Global Academic Federation & Edu-DPI (public/aquin-edu-dpi.js)

Reusable, trusted, federated educational services (public-infra rail), not a central
DB. Distinct from Ch 11's direct recognition. Node-tested (5).
- **Transitive/delegated trust network**: trust is a graph; A trusts C through a
  chain with confidence DECAYING per hop (ENQA→UGC→univ-A→dept-CS = 0.553 over 3
  hops), bounded chain length; honest "no trust" when no path.
- **Once-only service**: a learner submits a verified record ONCE; any authorised
  service reuses it (admissions + scholarship both reuse the same transcript, no
  re-submission), consent-gated + logged.
HONEST SCOPE: trust-graph search/decay + once-only consent/reuse real; credential
signing (aquin-identity.js) + inter-institutional API transport declared substrates.

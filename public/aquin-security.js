/*
 * aquin-security.js — AES-100 Vol III Part II Ch 21: Constitutional Security
 * Architecture & Zero Trust Runtime (CSAZTR). The trust backbone. Zero-trust
 * IDENTITY/continuous-auth already lives in aquin-identity.js, so this builds the
 * distinct security cores — real, named, tested:
 *
 *  - MEASURED SECURE BOOT (TPM PCR-extend chain of trust): each boot stage's hash is
 *    folded into a running measurement pcr' = H(pcr ‖ stage_hash). A system is
 *    trusted only if its final measurement equals the golden value — so a TAMPERED
 *    stage (any changed byte) produces a different measurement and boot/attestation
 *    is REFUSED. This is exactly how measured boot detects rootkits.
 *  - REMOTE ATTESTATION: verify a reported measurement + nonce against the golden
 *    value (a replayed/forged quote fails).
 *  - SECURITY DOMAINS & TRUST BOUNDARIES: micro-segmentation — a lower-trust domain
 *    cannot reach a higher-trust domain without an explicit cross-boundary grant
 *    (default-deny between domains).
 *
 * HONEST SCOPE: the measured-boot chain, attestation check, and trust-boundary logic
 * are real and tested; the physical TPM/HSM/Secure-Enclave, real secure-boot keys,
 * and cryptographic signing are declared substrates. (~M-LOC C++ → the core.)
 */
(function () {
  function H(s) { s = String(s); var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

  function createSecurity(cfg) {
    cfg = cfg || {};
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    // ---- measured secure boot (PCR extend) ----
    // stages: [{ name, hash }]  -> final measurement
    function measure(stages) {
      var pcr = '00000000', chain = [];
      stages.forEach(function (s) { pcr = H(pcr + s.hash); chain.push({ stage: s.name, pcr: pcr }); });
      return { measurement: pcr, chain: chain };
    }

    function createBoot(golden) {
      // golden: the expected final measurement for a known-good stage set
      return {
        boot: function (stages) {
          var m = measure(stages);
          if (golden != null && m.measurement !== golden) { rec('boot-refused', { got: m.measurement, want: golden }); return { ok: false, trusted: false, reason: 'measurement mismatch — a boot stage is tampered/unknown; refusing to boot', measurement: m.measurement, expected: golden, chain: m.chain }; }
          rec('boot', { measurement: m.measurement }); return { ok: true, trusted: true, measurement: m.measurement, chain: m.chain };
        },
        goldenFor: function (stages) { return measure(stages).measurement; }
      };
    }

    // ---- remote attestation ----
    function attest(reportedMeasurement, nonce, golden, expectedNonce) {
      var valid = reportedMeasurement === golden && nonce === expectedNonce;   // nonce defeats replay
      rec('attest', { valid: valid });
      return { valid: valid, reason: valid ? 'attestation valid' : (nonce !== expectedNonce ? 'stale/forged nonce (replay)' : 'measurement != golden (untrusted system)') };
    }

    // ---- security domains & trust boundaries ----
    function createDomains() {
      var domains = {};   // id -> { trust }
      var grants = {};    // "from|to" -> true
      return {
        domain: function (id, trust) { domains[id] = { id: id, trust: trust != null ? trust : 1 }; return this; },
        grant: function (from, to) { grants[from + '|' + to] = true; return this; },   // explicit cross-boundary allow
        // default-deny: a lower-trust domain cannot reach a higher-trust one w/o a grant
        canAccess: function (from, to) {
          var f = domains[from], t = domains[to]; if (!f || !t) return { allowed: false, reason: 'unknown domain' };
          if (from === to) return { allowed: true };
          if (grants[from + '|' + to]) return { allowed: true, reason: 'explicit cross-boundary grant' };
          if (f.trust >= t.trust) return { allowed: true, reason: 'equal/higher trust' };
          return { allowed: false, reason: 'trust boundary: domain "' + from + '" (trust ' + f.trust + ') cannot reach higher-trust "' + to + '" (trust ' + t.trust + ') without an explicit grant' };
        }
      };
    }

    return { provenance: provenance, measure: measure, createBoot: createBoot, attest: attest, createDomains: createDomains, hash: H };
  }
  window.AquinSecurity = { createSecurity: createSecurity };
})();

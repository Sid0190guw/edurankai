/*
 * aquin-identity.js — AES-100 Vol III Part II Ch 13: Platform Identity, Access &
 * Trust Infrastructure (PIATI). Every entity — human, AI model, agent, service,
 * device — gets ONE constitutional identity, and access is continuously trust-
 * evaluated, not granted once. Real, tested cores:
 *
 *  - IDENTITY LIFECYCLE: registered → verified → active → suspended → revoked.
 *  - PLUGGABLE AUTHENTICATION with an auth-QUALITY score (a passkey/mTLS is stronger
 *    than a password) that feeds trust.
 *  - COMBINED AUTHORIZATION: RBAC (role) AND ABAC (attributes) AND a RISK gate — all
 *    must pass; the decision is explainable.
 *  - CONTINUOUS TRUST: a live score from auth quality + behavior + device integrity
 *    + geo consistency; a risk spike triggers RE-AUTHENTICATION (zero-trust).
 *  - VERIFIABLE CREDENTIALS: issue + cryptographic-style verify; a tampered claim is
 *    detected.
 *
 * HONEST SCOPE: the identity/authz/trust/credential logic is real and tested; real
 * PKI/HSM, WebAuthn/FIDO2 attestation, biometric matching, and quantum-safe crypto
 * are declared substrates. (~24.9M-LOC C++ → the core.)
 */
(function () {
  function hash(s) { s = String(s); var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  // auth method -> inherent strength (feeds trust)
  var METHOD_STRENGTH = { password: 0.4, otp: 0.6, passkey: 0.9, webauthn: 0.9, 'mtls': 0.95, biometric: 0.85, 'gov-cert': 0.95 };

  function createIdentityRuntime(cfg) {
    cfg = cfg || {};
    var ids = {}; var creds = {}; var seq = 0; var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function recomputeTrust(idv) {
      var s = idv.signals;
      var score = 0.35 * s.authQuality + 0.25 * s.behavior + 0.2 * s.deviceIntegrity + 0.2 * s.geoConsistency;
      idv.trust = { score: +score.toFixed(3), risk: +(1 - score).toFixed(3) };
    }

    var R = {
      provenance: provenance, METHOD_STRENGTH: METHOD_STRENGTH,
      registerIdentity: function (spec) {
        ids[spec.id] = { id: spec.id, type: spec.type || 'human', org: spec.org || null, state: 'registered', roles: (spec.roles || []).slice(), attrs: spec.attrs || {}, signals: { authQuality: 0.4, behavior: 0.7, deviceIntegrity: 0.7, geoConsistency: 0.8 }, trust: { score: 0.5, risk: 0.5 } };
        recomputeTrust(ids[spec.id]); rec('register-identity', { id: spec.id, type: spec.type }); return ids[spec.id];
      },
      verify: function (id) { if (ids[id] && ids[id].state === 'registered') ids[id].state = 'verified'; return this; },
      activate: function (id) { if (ids[id] && (ids[id].state === 'verified')) ids[id].state = 'active'; return this; },
      revoke: function (id) { if (ids[id]) ids[id].state = 'revoked'; return this; },

      // pluggable authentication; sets auth quality from method strength
      authenticate: function (id, attempt) {
        var idv = ids[id]; if (!idv) return { ok: false, reason: 'unknown identity' };
        if (idv.state !== 'active') return { ok: false, reason: 'identity not active (' + idv.state + ')' };
        if (attempt.valid === false) return { ok: false, reason: 'authentication failed' };
        var strength = METHOD_STRENGTH[attempt.method] != null ? METHOD_STRENGTH[attempt.method] : 0.3;
        idv.signals.authQuality = strength; recomputeTrust(idv);
        rec('authenticate', { id: id, method: attempt.method, authQuality: strength });
        return { ok: true, session: 's_' + (++seq), authQuality: strength, trust: idv.trust.score };
      },

      // RBAC AND ABAC AND risk — all must pass
      authorize: function (id, req) {
        var idv = ids[id]; if (!idv) return { allowed: false, reason: 'unknown identity' };
        if (idv.state !== 'active') return { allowed: false, reason: 'identity not active' };
        if (req.requiredRole && idv.roles.indexOf(req.requiredRole) < 0) return { allowed: false, reason: 'RBAC: missing role "' + req.requiredRole + '"' };
        if (req.requiredAttrs) { for (var k in req.requiredAttrs) { if (idv.attrs[k] !== req.requiredAttrs[k]) return { allowed: false, reason: 'ABAC: attribute ' + k + ' != ' + req.requiredAttrs[k] }; } }
        if (req.maxRisk != null && idv.trust.risk > req.maxRisk) return { allowed: false, reason: 'RISK: trust risk ' + idv.trust.risk + ' > ' + req.maxRisk + ' — re-authentication required', reauth: true };
        rec('authorize', { id: id, resource: req.resource, allowed: true });
        return { allowed: true, reason: 'RBAC+ABAC+risk all passed', trust: idv.trust.score };
      },

      // continuous auth: update a live signal; risk spike -> require re-auth
      updateSignal: function (id, sig) { var idv = ids[id]; if (!idv) return; Object.keys(sig).forEach(function (k) { if (idv.signals[k] != null) idv.signals[k] = sig[k]; }); recomputeTrust(idv); rec('signal', { id: id, risk: idv.trust.risk }); return idv.trust; },
      continuousAuth: function (id, threshold) { threshold = threshold != null ? threshold : 0.5; var idv = ids[id]; if (!idv) return { ok: false }; if (idv.trust.risk > threshold) return { ok: false, requireReauth: true, risk: idv.trust.risk, reason: 'risk ' + idv.trust.risk + ' exceeds ' + threshold }; return { ok: true, risk: idv.trust.risk }; },
      trust: function (id) { return ids[id] ? ids[id].trust : null; },

      // verifiable credentials
      issueCredential: function (issuer, subject, claims) { var id = 'vc_' + (++seq); var payload = JSON.stringify({ issuer: issuer, subject: subject, claims: claims }); creds[id] = { id: id, issuer: issuer, subject: subject, claims: claims, sig: hash(payload + (cfg.secret || 'root')) }; rec('issue-credential', { id: id, issuer: issuer }); return creds[id]; },
      verifyCredential: function (cred) { if (!cred || !creds[cred.id]) return { valid: false, reason: 'unknown credential' }; var expect = hash(JSON.stringify({ issuer: cred.issuer, subject: cred.subject, claims: cred.claims }) + (cfg.secret || 'root')); return { valid: expect === cred.sig, issuer: cred.issuer, tampered: expect !== cred.sig }; },
      identity: function (id) { return ids[id]; }
    };
    return R;
  }
  window.AquinIdentity = { createIdentityRuntime: createIdentityRuntime };
})();

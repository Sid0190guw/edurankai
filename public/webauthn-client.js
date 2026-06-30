/* EduRankAI WebAuthn client helpers — talks to our own /api/2fa/passkey/* .
   No third-party library. Converts between base64url (what our server speaks)
   and the ArrayBuffers the native navigator.credentials API needs. */
(function () {
  function b64urlToBuf(s) {
    s = (s || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s), b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b.buffer;
  }
  function bufToB64url(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function post(url, body) {
    var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) });
    var d = {}; try { d = await r.json(); } catch (_) {}
    return d;
  }

  window.eraPasskeySupported = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  // Enrol a new passkey (signed-in user).
  window.eraPasskeyRegister = async function (name) {
    var d = await post('/api/2fa/passkey/register-options', {});
    if (!d.ok) throw new Error(d.error || 'Could not start');
    var o = d.options;
    var cred = await navigator.credentials.create({ publicKey: {
      challenge: b64urlToBuf(o.challenge),
      rp: o.rp,
      user: { id: b64urlToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams,
      authenticatorSelection: o.authenticatorSelection,
      attestation: o.attestation,
      timeout: o.timeout,
      excludeCredentials: (o.excludeCredentials || []).map(function (c) { return { id: b64urlToBuf(c.id), type: c.type, transports: c.transports }; })
    } });
    var v = await post('/api/2fa/passkey/register-verify', {
      id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type,
      name: name || 'Passkey',
      transports: (cred.response.getTransports && cred.response.getTransports()) || [],
      response: { attestationObject: bufToB64url(cred.response.attestationObject), clientDataJSON: bufToB64url(cred.response.clientDataJSON) }
    });
    if (!v.ok) throw new Error(v.error || 'Could not register');
    return v;
  };

  // Passwordless login — browser offers any discoverable passkey for this site.
  window.eraPasskeyLogin = async function () {
    var d = await post('/api/2fa/passkey/login-options', {});
    if (!d.ok) throw new Error(d.error || 'Could not start');
    var o = d.options;
    var assertion = await navigator.credentials.get({ publicKey: {
      challenge: b64urlToBuf(o.challenge),
      rpId: o.rpId,
      allowCredentials: (o.allowCredentials || []).map(function (c) { return { id: b64urlToBuf(c.id), type: c.type, transports: c.transports }; }),
      userVerification: o.userVerification,
      timeout: o.timeout
    } });
    var v = await post('/api/2fa/passkey/login-verify', {
      id: assertion.id, rawId: bufToB64url(assertion.rawId), type: assertion.type,
      response: {
        authenticatorData: bufToB64url(assertion.response.authenticatorData),
        clientDataJSON: bufToB64url(assertion.response.clientDataJSON),
        signature: bufToB64url(assertion.response.signature),
        userHandle: assertion.response.userHandle ? bufToB64url(assertion.response.userHandle) : null
      }
    });
    if (!v.ok) throw new Error(v.error || 'Verification failed');
    return v;
  };
})();

/*
 * meet-mesh.js — real multi-peer WebRTC MESH for the meeting room. Turns the huddle
 * from a loopback demo into an actual N-participant call. Standard WebRTC, no
 * libraries:
 *   - full mesh: every participant holds one RTCPeerConnection to every other.
 *   - signaling over HTTP polling (/api/portal/meet/<room>/signal) — serverless-safe.
 *   - "perfect negotiation" pattern (polite/impolite) to resolve offer glare.
 *   - newcomer initiates to existing peers (avoids duplicate connections).
 *   - ICE candidates buffered until the remote description is applied.
 *   - presence heartbeat + clean leave.
 *
 * Mesh is right for classroom-sized groups (each browser uploads N-1 streams); for
 * very large rooms an SFU is the declared substrate that plugs in behind this same
 * onPeerStream/onPeerLeave interface.
 *
 * API: AquinMesh.join({ roomId, peerId, name, localStream, iceServers,
 *                       onPeerStream(id,stream), onPeerLeave(id), onRoster(list) })
 *      -> { leave(), replaceLocalStream(stream) }
 */
(function () {
  function join(opts) {
    var roomId = opts.roomId, myId = opts.peerId, base = '/api/portal/meet/' + encodeURIComponent(roomId) + '/signal';
    var iceServers = opts.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    var localStream = opts.localStream || null;
    var peers = {};      // otherId -> { pc, polite, makingOffer, ignoreOffer, pendingIce:[], hasRemote }
    var cursor = 0, alive = true, pollTimer = null, hbTimer = null;

    function post(body) { return fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ peerId: myId }, body)), keepalive: body.action === 'leave' }).then(function (r) { return r.json(); }).catch(function () { return { ok: false }; }); }
    function relay(to, kind, payload) { return post({ action: 'signal', to: to, kind: kind, payload: payload }); }

    function ensurePeer(otherId, initiate) {
      if (peers[otherId]) return peers[otherId];
      var pc = new RTCPeerConnection({ iceServers: iceServers });
      var P = peers[otherId] = { pc: pc, polite: myId > otherId, initiate: !!initiate, makingOffer: false, ignoreOffer: false, pendingIce: [], hasRemote: false };
      if (localStream) localStream.getTracks().forEach(function (t) { try { pc.addTrack(t, localStream); } catch (e) { } });
      pc.onnegotiationneeded = function () {
        if (!P.initiate) return;                          // only the initiator offers first
        (async function () { try { P.makingOffer = true; await pc.setLocalDescription(); relay(otherId, 'sdp', pc.localDescription); } catch (e) { } finally { P.makingOffer = false; } })();
      };
      pc.onicecandidate = function (e) { if (e.candidate) relay(otherId, 'ice', e.candidate); };
      pc.ontrack = function (e) { if (opts.onPeerStream) opts.onPeerStream(otherId, e.streams[0]); };
      pc.onconnectionstatechange = function () { if (['failed', 'closed', 'disconnected'].indexOf(pc.connectionState) >= 0) removePeer(otherId); };
      return P;
    }
    function removePeer(otherId) { var P = peers[otherId]; if (!P) return; try { P.pc.close(); } catch (e) { } delete peers[otherId]; if (opts.onPeerLeave) opts.onPeerLeave(otherId); }

    async function onSignal(from, kind, payload) {
      if (kind === 'leave') { removePeer(from); return; }
      if (kind === 'data') { if (opts.onData) opts.onData(from, payload); return; }   // app-level (chat/whiteboard)
      if (kind === 'join') { ensurePeer(from, true); return; }   // a newcomer -> I initiate to them
      var P = ensurePeer(from, myId < from);                     // fallback initiator rule if no prior join seen
      var pc = P.pc;
      if (kind === 'sdp') {
        var desc = payload;
        var collision = desc.type === 'offer' && (P.makingOffer || pc.signalingState !== 'stable');
        P.ignoreOffer = !P.polite && collision;
        if (P.ignoreOffer) return;
        try {
          await pc.setRemoteDescription(desc); P.hasRemote = true;
          // flush buffered ICE
          P.pendingIce.splice(0).forEach(function (c) { pc.addIceCandidate(c).catch(function () { }); });
          if (desc.type === 'offer') { await pc.setLocalDescription(); relay(from, 'sdp', pc.localDescription); }
        } catch (e) { }
      } else if (kind === 'ice') {
        if (P.hasRemote) { pc.addIceCandidate(payload).catch(function () { }); }
        else P.pendingIce.push(payload);                          // buffer until remote desc
      }
    }

    async function poll() {
      if (!alive) return;
      try {
        var r = await fetch(base + '?peerId=' + encodeURIComponent(myId) + '&since=' + cursor).then(function (x) { return x.json(); });
        if (r && r.ok) {
          cursor = r.cursor || cursor;
          if (opts.onRoster && r.roster) opts.onRoster(r.roster.filter(function (p) { return p.peerId !== myId; }));
          for (var i = 0; i < (r.signals || []).length; i++) { var s = r.signals[i]; await onSignal(s.from, s.kind, s.payload); }
        }
      } catch (e) { }
      if (alive) pollTimer = setTimeout(poll, 1000);
    }

    // join: announce presence, connect to everyone already here (I initiate to them)
    post({ action: 'join', name: opts.name || '' }).then(function (r) {
      if (r && r.roster) {
        if (opts.onRoster) opts.onRoster(r.roster.filter(function (p) { return p.peerId !== myId; }));
        r.roster.forEach(function (p) { if (p.peerId !== myId) ensurePeer(p.peerId, true); });   // newcomer initiates
      }
      poll();
    });
    hbTimer = setInterval(function () { post({ action: 'heartbeat', name: opts.name || '' }); }, 5000);

    return {
      leave: function () { alive = false; clearTimeout(pollTimer); clearInterval(hbTimer); Object.keys(peers).forEach(removePeer); post({ action: 'leave' }); },
      replaceLocalStream: function (stream) {
        localStream = stream;
        Object.keys(peers).forEach(function (id) { var pc = peers[id].pc; var senders = pc.getSenders(); stream.getTracks().forEach(function (t) { var s = senders.filter(function (x) { return x.track && x.track.kind === t.kind; })[0]; if (s) s.replaceTrack(t).catch(function () { }); else pc.addTrack(t, stream); }); });
      },
      // broadcast an app-level message (chat, whiteboard stroke) to the whole room
      broadcast: function (payload) { relay(null, 'data', payload); },
      peerCount: function () { return Object.keys(peers).length; }
    };
  }
  window.AquinMesh = { join: join };
})();

// public/aquin-broadcast-transport.js — the pluggable BROADCAST TRANSPORT interface (Prompt H3).
// One-to-many at scale is NOT a WebRTC room: viewers PULL (subscribe) and render locally; the teacher
// publishes the animation SPEC + slides over a scalable fan-out. Interface:
//   startBroadcast(id, opts) / publishSpec(id, kind, payload) / publishSlide(id, slide) /
//   stopBroadcast(id) / viewerSubscribe(id, handlers) -> { close }
// The Fanout adapter implements it against the DB-backed spec channel (the same board SSE stream +
// fire API that already scales statelessly). Video egress (HLS/CDN) is a provisioning follow-up; the
// low-bitrate default here — audio + slides + specs — is what makes reaching a huge audience cheap.
// Pure builders/classifiers are eval-tested in Node; fetch/EventSource wiring is DOM-guarded.
(function () {
  // ---- pure payloads: a SPEC/slide, never baked-into-video ----
  function buildSpecMsg(kind, payload) { return { templateId: kind === 'scene' ? 'scene' : kind === 'ink' ? 'ink' : kind, params: kind === 'scene' ? { scene: payload } : kind === 'ink' ? { strokes: payload } : payload }; }
  function buildSlide(slide) { return { title: String(slide && slide.title || '').slice(0, 200), bullets: (slide && slide.bullets || []).slice(0, 12).map(function (b) { return String(b).slice(0, 200); }) }; }
  // classify an inbound fire event for the viewer's local renderer
  function classifyFire(ev) {
    if (!ev || !ev.templateId) return 'unknown';
    if (ev.templateId === 'scene') return 'scene';
    if (ev.templateId === 'ink') return 'ink';
    if (ev.templateId === 'slide') return 'slide';
    return 'template';
  }
  function sessionId(broadcastId) { return 'bcast-' + broadcastId; }   // rides the board fan-out channel

  // ---- H3b: viewer interactions over the CHEAP pub/sub (chat/reaction/hand/poll) — never video ----
  function buildChat(from, body) { return { kind: 'chat', from: String(from || 'Viewer').slice(0, 40), body: String(body || '').slice(0, 300) }; }
  function buildReaction(r) { return { kind: 'reaction', reaction: String(r || 'clap').slice(0, 16) }; }
  function buildHand(from) { return { kind: 'hand', from: String(from || 'Viewer').slice(0, 40) }; }
  function buildVote(pollId, option) { return { kind: 'vote', pollId: String(pollId), option: Number(option) }; }
  // classify an inbound fire that is a viewer interaction (vs an animation spec/slide)
  function classifyViewerMsg(ev) {
    if (!ev || ev.templateId !== 'bcast-msg' || !ev.params) return null;
    var k = ev.params.kind;
    return (k === 'chat' || k === 'reaction' || k === 'hand' || k === 'poll' || k === 'vote') ? k : null;
  }

  // ---- Fanout adapter: implement the interface over the board fire API + SSE stream ----
  function createFanoutTransport(o) {
    o = o || {};
    var fire = o.fire || function (session, body) { return fetch('/api/aquintutor/board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ session: session }, body)) }); };
    return {
      kind: 'fanout',
      // publish a spec over the fan-out (POST fire on the broadcast's session)
      publishSpec: function (id, kind, payload) {
        if (kind === 'scene') return fire(sessionId(id), { action: 'fire-scene', spec: payload });
        if (kind === 'ink') return fire(sessionId(id), { action: 'fire-ink', strokes: payload, source: 'broadcast' });
        return fire(sessionId(id), { action: 'fire', templateId: kind, params: payload });
      },
      // publish a slide (structured text — not an image/video) over the same channel
      publishSlide: function (id, slide) { return fire(sessionId(id), { action: 'fire-slide', slide: buildSlide(slide) }); },
      // H3b viewer interactions (cheap pub/sub) via the read-allowed 'say' endpoint
      say: function (id, msg) { return fetch('/api/aquintutor/broadcast/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, msg: msg }) }).then(function (r) { return r.json(); }); },
      chat: function (id, from, body) { return this.say(id, buildChat(from, body)); },
      react: function (id, r) { return this.say(id, buildReaction(r)); },
      raiseHand: function (id, from) { return this.say(id, buildHand(from)); },
      vote: function (id, pollId, option) { return this.say(id, buildVote(pollId, option)); },
      publishPoll: function (id, poll) { return this.say(id, { kind: 'poll', pollId: String(poll.pollId), question: String(poll.question || '').slice(0, 200), options: (poll.options || []).slice(0, 6).map(function (o) { return String(o).slice(0, 80); }) }); },
      // a VIEWER subscribes by PULLING the SSE stream — it never opens a WebRTC publish connection
      viewerSubscribe: function (id, handlers) {
        if (typeof EventSource === 'undefined') return { close: function () {} };
        handlers = handlers || {};
        var qp = (handlers.signals || '');
        var es = new EventSource('/api/aquintutor/board/stream?session=' + encodeURIComponent(sessionId(id)) + (qp ? '&' + qp : ''));
        es.addEventListener('ready', function (e) { if (handlers.onReady) handlers.onReady(JSON.parse(e.data)); });
        es.addEventListener('fire', function (e) {
          var ev = JSON.parse(e.data), vmsg = classifyViewerMsg(ev);
          if (vmsg) { if (handlers.onViewerMsg) handlers.onViewerMsg(vmsg, ev.params); return; }
          var kind = classifyFire(ev);
          if (kind === 'slide' && handlers.onSlide) handlers.onSlide(ev.params && ev.params.slide);
          else if (handlers.onSpec) handlers.onSpec(ev, kind);
        });
        es.onerror = function () { if (handlers.onError) handlers.onError(); };
        return { close: function () { es.close(); }, isPeer: false };   // subscriber, NOT a WebRTC peer
      },
    };
  }

  var mod = { buildSpecMsg: buildSpecMsg, buildSlide: buildSlide, classifyFire: classifyFire, sessionId: sessionId, createFanoutTransport: createFanoutTransport, buildChat: buildChat, buildReaction: buildReaction, buildHand: buildHand, buildVote: buildVote, classifyViewerMsg: classifyViewerMsg };
  if (typeof window !== 'undefined') window.AquinBroadcast = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();

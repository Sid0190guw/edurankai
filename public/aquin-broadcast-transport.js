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
      // a VIEWER subscribes by PULLING the SSE stream — it never opens a WebRTC publish connection
      viewerSubscribe: function (id, handlers) {
        if (typeof EventSource === 'undefined') return { close: function () {} };
        handlers = handlers || {};
        var qp = (handlers.signals || '');
        var es = new EventSource('/api/aquintutor/board/stream?session=' + encodeURIComponent(sessionId(id)) + (qp ? '&' + qp : ''));
        es.addEventListener('ready', function (e) { if (handlers.onReady) handlers.onReady(JSON.parse(e.data)); });
        es.addEventListener('fire', function (e) {
          var ev = JSON.parse(e.data), kind = classifyFire(ev);
          if (kind === 'slide' && handlers.onSlide) handlers.onSlide(ev.params && ev.params.slide);
          else if (handlers.onSpec) handlers.onSpec(ev, kind);
        });
        es.onerror = function () { if (handlers.onError) handlers.onError(); };
        return { close: function () { es.close(); }, isPeer: false };   // subscriber, NOT a WebRTC peer
      },
    };
  }

  var mod = { buildSpecMsg: buildSpecMsg, buildSlide: buildSlide, classifyFire: classifyFire, sessionId: sessionId, createFanoutTransport: createFanoutTransport };
  if (typeof window !== 'undefined') window.AquinBroadcast = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();

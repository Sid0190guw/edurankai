// public/aquin-huddle-anim.js — animation board INSIDE the live huddle (Prompt H1). The animation is
// broadcast as a SPEC (template/scene/ink) over the room's existing realtime data channel
// (mesh.broadcast -> onData); EVERY participant renders it locally at their Prompt-5 tier. It is
// NOT screen-shared as video — the spec is what keeps it smooth at scale. Late-joiners request the
// current board state and the presenter replies. Pure protocol + a tiny state machine (eval-tested
// in Node); the render + mesh wiring are injected by the page.
(function () {
  // client-side Prompt-5 tier (honest mirror: weak device/network -> lite, strong -> rich)
  function pickTier(s) {
    s = s || {};
    if (s.saveData || s.effectiveType === '2g' || s.effectiveType === 'slow-2g' || (s.deviceMemory && s.deviceMemory <= 1)) return 'lite';
    if (s.deviceMemory && s.deviceMemory >= 8 && (s.effectiveType === '4g' || !s.effectiveType)) return 'rich';
    return 'standard';
  }
  function browserSignals() {
    if (typeof navigator === 'undefined') return {};
    var c = navigator.connection || {};
    return { deviceMemory: navigator.deviceMemory, effectiveType: c.effectiveType, saveData: !!c.saveData, reduceMotion: (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) };
  }

  // the broadcast payloads — a SPEC, never pixels/video
  function buildAnimMsg(kind, payload) { return { type: 'aquin-anim', kind: kind, payload: payload }; }   // kind: template | scene | ink
  function buildReq() { return { type: 'aquin-anim-req' }; }

  // opts: { canDrive, tier, send(msg), render(kind,payload,tier), requestOnJoin }
  function create(opts) {
    opts = opts || {};
    var state = { canDrive: !!opts.canDrive, tier: opts.tier || 'standard', current: null };
    var send = opts.send || function () {}, render = opts.render || function () {};
    var api = {
      // presenter drives: render locally + broadcast the spec to the whole room
      fire: function (kind, payload) { if (!state.canDrive) return false; state.current = { kind: kind, payload: payload }; render(kind, payload, state.tier); send(buildAnimMsg(kind, payload)); return true; },
      // every inbound room data message passes through here
      onMessage: function (msg) {
        if (!msg) return false;
        if (msg.type === 'aquin-anim') { state.current = { kind: msg.kind, payload: msg.payload }; render(msg.kind, msg.payload, state.tier); return true; }
        if (msg.type === 'aquin-anim-req') { if (state.canDrive && state.current) send(buildAnimMsg(state.current.kind, state.current.payload)); return true; }   // late-join reply
        return false;
      },
      requestState: function () { send(buildReq()); },      // late-joiner asks for the current board
      setCanDrive: function (v) { state.canDrive = !!v; },   // H1b presenter hand-off flips this
      getState: function () { return state.current; },
      getTier: function () { return state.tier; },
    };
    if (opts.requestOnJoin && !state.canDrive) { if (typeof setTimeout !== 'undefined') setTimeout(api.requestState, 800); }
    return api;
  }

  var mod = { pickTier: pickTier, browserSignals: browserSignals, buildAnimMsg: buildAnimMsg, buildReq: buildReq, create: create };
  if (typeof window !== 'undefined') window.AquinHuddleAnim = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();

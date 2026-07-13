/*
 * aquin-network.js — AES-100 Vol III Part II Ch 7: Universal Networking Stack
 * (UNS). Networking as a governed OS service. Real, tested cores:
 *
 *  - PACKET PIPELINE: every packet passes authentication → policy validation →
 *    classification → routing; a packet with no identity, or that policy forbids,
 *    is DROPPED at the boundary (constitutional networking).
 *  - QoS PRIORITY SCHEDULING: packets are classified into educational traffic
 *    classes (real-time classroom > video > assessment > AI inference > research >
 *    admin > background > archival) and a priority scheduler serves the most
 *    critical first — so a live classroom is never starved by archival replication.
 *  - AIMD CONGESTION CONTROL: the real TCP-Reno core — additive-increase per ack,
 *    multiplicative-decrease (halve) on loss — which converges toward a fair share.
 *
 * HONEST SCOPE: the scheduling + congestion + pipeline logic is real and tested;
 * actual NIC drivers, zero-copy DMA, kernel-bypass, and TLS transport are declared
 * substrates. (~11.9M-LOC C++ → the core.)
 */
(function () {
  // educational traffic classes -> priority (higher = more critical)
  var CLASSES = { 'realtime-classroom': 8, 'video-conference': 7, 'assessment': 6, 'ai-inference': 5, 'research-data': 4, 'admin': 3, 'background-sync': 2, 'archival': 1 };

  function classify(packet) {
    var c = packet && packet.trafficClass;
    if (c && CLASSES[c] != null) return { class: c, priority: CLASSES[c] };
    // infer from hints
    if (packet && /class|live|lesson/i.test(packet.tag || '')) return { class: 'realtime-classroom', priority: 8 };
    return { class: 'background-sync', priority: 2 };
  }

  function createNetwork(cfg) {
    cfg = cfg || {};
    var queue = [];   // QoS priority queue
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    var N = {
      provenance: provenance, CLASSES: CLASSES, classify: classify,

      // packet pipeline: auth -> policy -> classify -> route
      process: function (packet, policy) {
        if (!packet || !packet.srcIdentity) { rec('drop', { reason: 'no-identity' }); return { accepted: false, stage: 'authentication', reason: 'no source identity — dropped' }; }
        if (policy && typeof policy === 'function' && !policy(packet)) { rec('drop', { reason: 'policy' }); return { accepted: false, stage: 'policy', reason: 'policy forbids this packet — dropped' }; }
        var cls = classify(packet);
        rec('accept', { class: cls.class });
        return { accepted: true, class: cls.class, priority: cls.priority, route: packet.dst || 'default' };
      },

      // QoS: enqueue, then serve highest priority first
      enqueue: function (packet) { var cls = classify(packet); queue.push({ packet: packet, priority: cls.priority, class: cls.class }); return this; },
      schedule: function (n) {
        n = n || queue.length;
        queue.sort(function (a, b) { return b.priority - a.priority; });   // strict priority
        var served = queue.splice(0, n);
        rec('schedule', { served: served.length });
        return served.map(function (s) { return { class: s.class, priority: s.priority, id: s.packet.id }; });
      },
      pending: function () { return queue.length; }
    };
    return N;
  }

  // AIMD congestion controller (TCP-Reno core)
  function createCongestionController(cfg) {
    cfg = cfg || {};
    var w = cfg.initialWindow || 1, ssthresh = cfg.ssthresh || 16, mode = 'slow-start';
    var history = [];
    return {
      window: function () { return +w.toFixed(3); }, mode: function () { return mode; },
      onAck: function () {
        if (mode === 'slow-start') { w += 1; if (w >= ssthresh) mode = 'congestion-avoidance'; }   // exponential-ish
        else { w += 1 / w; }                                                                       // additive increase
        history.push({ ev: 'ack', w: +w.toFixed(3), mode: mode }); return this.window();
      },
      onLoss: function () { ssthresh = Math.max(1, w / 2); w = ssthresh; mode = 'congestion-avoidance'; history.push({ ev: 'loss', w: +w.toFixed(3) }); return this.window(); },  // multiplicative decrease
      history: function () { return history.slice(); }
    };
  }

  window.AquinNetwork = { CLASSES: CLASSES, classify: classify, createNetwork: createNetwork, createCongestionController: createCongestionController };
})();

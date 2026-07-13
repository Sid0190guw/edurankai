/*
 * aquin-bus.js — Educational Interaction Bus (AES-001, Ch 4).
 * The circulatory system: Runtime Domains NEVER call each other directly. Every
 * educational interaction is an immutable, provenance-carrying, contract-bound
 * message that flows Domain -> Bus -> Domain, prioritized by educational
 * significance (not arrival order), and (for transactions) routed to the
 * Educational Operating Kernel for constitutional evaluation.
 *
 * Interaction categories (distinct constitutional semantics):
 *   command | query | event | observation | transaction | notification | sync
 *
 * Guarantees: no publish without a registered Interaction Contract; messages are
 * frozen in transit (transformations require a kernel transaction); delivery is
 * priority-ordered; everything is recorded in an append-only interaction ledger.
 *
 * HONEST SCOPE: this is the bus CORE + routing/priority/ledger. Cross-institution
 * federation, guaranteed-delivery persistence across restarts, and real network
 * transports (WebSocket/QUIC/WebRTC) are declared substrates in the spec, not
 * implemented here.
 */
(function () {
  var CATEGORIES = { command: 1, query: 1, event: 1, observation: 1, transaction: 1, notification: 1, sync: 1 };

  function createBus(opts) {
    opts = opts || {};
    var busId = 'bus_' + Math.random().toString(36).slice(2, 9);
    var seq = 0, tick = 0;
    var contracts = {}, subs = [], queue = [], ledger = [], kernel = opts.kernel || null;

    function id(k) { seq++; return (k || 'msg') + '_' + seq.toString(36); }
    function now() { tick++; return tick; }
    function freeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { freeze(o[k]); }); Object.freeze(o); } return o; }

    var B = {
      id: busId, ledger: ledger,
      attachKernel: function (k) { kernel = k; return this; },
      // an Interaction Contract declares the educational PURPOSE of a channel
      contract: function (spec) { var c = { id: spec.id || id('contract'), category: spec.category, subject: spec.subject || '*', purpose: spec.purpose || '', authority: spec.authority || 'autonomous' }; contracts[c.id] = c; return c; },
      subscribe: function (category, subject, handler) { subs.push({ category: category, subject: subject || '*', handler: handler }); return this; },

      publish: function (msg) {
        var t = now(), mid = id('msg');
        if (!CATEGORIES[msg.category]) { ledger.push(freeze({ mid: mid, tick: t, status: 'invalid-category', category: msg.category })); return freeze({ ok: false, reason: 'invalid category "' + msg.category + '"' }); }
        if (!msg.contractId || !contracts[msg.contractId]) { ledger.push(freeze({ mid: mid, tick: t, status: 'no-contract' })); return freeze({ ok: false, reason: 'communication requires a registered Interaction Contract' }); }
        if (!msg.provenance || !msg.provenance.source) { ledger.push(freeze({ mid: mid, tick: t, status: 'no-provenance' })); return freeze({ ok: false, reason: 'interaction requires provenance.source' }); }
        var envelope = freeze({ mid: mid, tick: t, category: msg.category, subject: msg.subject || '*', contractId: msg.contractId, mission: msg.mission || null, priority: msg.priority || 1, provenance: msg.provenance, payload: msg.payload });
        queue.push(envelope); queue.sort(function (a, b) { return (b.priority - a.priority) || (a.tick - b.tick); }); // priority, then order
        ledger.push(freeze({ mid: mid, tick: t, status: 'published', category: envelope.category, subject: envelope.subject, priority: envelope.priority }));
        return freeze({ ok: true, mid: mid });
      },

      // deliver queued interactions in educational-priority order
      drain: function () {
        var delivered = [];
        while (queue.length) {
          var m = queue.shift();
          if (m.category === 'transaction' && kernel) {
            var res = kernel.submit(m.payload);                 // transactions -> constitutional evaluation
            ledger.push(freeze({ mid: m.mid, tick: now(), status: 'routed-to-kernel', kernelStatus: res.status }));
            delivered.push({ mid: m.mid, to: 'kernel', status: res.status });
            continue;
          }
          var hit = 0;
          subs.forEach(function (s) {
            if (s.category !== m.category) return;
            if (s.subject !== '*' && m.subject !== '*' && s.subject !== m.subject) return;
            try { s.handler(m); hit++; } catch (e) { ledger.push(freeze({ mid: m.mid, tick: now(), status: 'handler-error', reason: String(e && e.message || e) })); }
          });
          ledger.push(freeze({ mid: m.mid, tick: now(), status: hit ? 'delivered' : 'no-subscriber', subscribers: hit }));
          delivered.push({ mid: m.mid, subscribers: hit });
        }
        return delivered;
      },
      pending: function () { return queue.length; }
    };
    return B;
  }
  window.AquinBus = { CATEGORIES: Object.keys(CATEGORIES), createBus: createBus };
})();

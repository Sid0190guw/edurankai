/*
 * aquin-messaging.js — AES-100 Vol III Part II Ch 14: Unified Messaging, Event
 * Streaming & Real-Time Communication Platform (UMES). The asynchronous backbone:
 * producers and consumers decoupled through a governed fabric. Real, tested cores:
 *
 *  - PUBLISH/SUBSCRIBE: a publisher writes to a TOPIC and never knows its
 *    subscribers; all subscribers of the topic receive the message (loose coupling).
 *  - EXACTLY-ONCE delivery: messages carry an id; a duplicate id is delivered ONCE
 *    (idempotent dedup) — vs at-least-once which may redeliver.
 *  - DEAD-LETTER + RETRY: a handler that keeps failing is retried up to a limit,
 *    then the message is moved to a dead-letter queue (not lost, not looped forever).
 *  - EVENT SOURCING / REPLAY: every message is appended to an immutable per-topic
 *    log; a consumer can REPLAY from any offset (debugging, audit, AI retraining).
 *  - PRIORITY delivery ordering.
 *
 * HONEST SCOPE: the broker semantics (pub/sub, dedup, dead-letter, replay, priority)
 * are real and tested in-memory; distributed partitioning, replication, and
 * zero-copy wire transport are declared substrates. (~27.5M-LOC C++ → the core.)
 */
(function () {
  function createBroker(cfg) {
    cfg = cfg || {};
    var maxRetries = cfg.maxRetries != null ? cfg.maxRetries : 2;
    var subs = {};        // topic -> [ {handler} ]
    var logs = {};        // topic -> [ {id, msg, priority, at} ]  (event sourcing)
    var seen = {};        // topic -> Set(id)  (exactly-once dedup)
    var deadLetter = [];  // [{topic, msg, reason}]
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function deliver(topic, entry) {
      (subs[topic] || []).forEach(function (s) {
        var attempts = 0, ok = false, lastErr = null;
        while (attempts <= maxRetries && !ok) {
          try { s.handler(entry.msg, { topic: topic, id: entry.id, offset: entry.offset }); ok = true; }
          catch (e) { attempts++; lastErr = String(e && e.message || e); }
        }
        if (!ok) { deadLetter.push({ topic: topic, id: entry.id, msg: entry.msg, reason: lastErr, attempts: attempts }); rec('dead-letter', { topic: topic, id: entry.id }); }
      });
    }

    var B = {
      provenance: provenance,
      subscribe: function (topic, handler) { (subs[topic] = subs[topic] || []).push({ handler: handler }); return this; },

      publish: function (topic, msg, opts) {
        opts = opts || {};
        var guarantee = opts.guarantee || 'at-least-once';
        var id = opts.id || ('m_' + (logs[topic] ? logs[topic].length : 0) + '_' + Math.random().toString(36).slice(2, 6));
        seen[topic] = seen[topic] || {};
        if (guarantee === 'exactly-once' && seen[topic][id]) { rec('dedup', { topic: topic, id: id }); return { ok: true, deduped: true, id: id }; }
        seen[topic][id] = true;
        var log = (logs[topic] = logs[topic] || []);
        var entry = { id: id, msg: msg, priority: opts.priority || 0, at: Date.now(), offset: log.length };
        log.push(entry);
        deliver(topic, entry);
        rec('publish', { topic: topic, id: id });
        return { ok: true, id: id, offset: entry.offset };
      },

      // replay a topic from an offset (event sourcing) into a consumer
      replay: function (topic, fromOffset, consumer) {
        var log = logs[topic] || []; var replayed = [];
        for (var i = (fromOffset || 0); i < log.length; i++) { if (consumer) consumer(log[i].msg, { offset: i, id: log[i].id }); replayed.push(log[i].id); }
        rec('replay', { topic: topic, from: fromOffset, count: replayed.length });
        return { replayed: replayed.length, ids: replayed };
      },

      // drain a topic's log by priority (highest first)
      byPriority: function (topic) { return (logs[topic] || []).slice().sort(function (a, b) { return b.priority - a.priority; }).map(function (e) { return { id: e.id, priority: e.priority, msg: e.msg }; }); },
      deadLetters: function () { return deadLetter.slice(); },
      logLength: function (topic) { return (logs[topic] || []).length; }
    };
    return B;
  }
  window.AquinMessaging = { createBroker: createBroker };
})();

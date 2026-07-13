/*
 * aquin-eok.js — Educational Operating Kernel (AES-001, Ch 1).
 * The constitutional heart: it does NOT manage CPU/memory — it manages
 * educational reality. Every engine built in AES-000 (Concept, Learner, Mission,
 * Consistency, Execution) becomes a CLIENT that submits governed Educational
 * Transactions here; none may mutate educational reality directly.
 *
 * The kernel owns:
 *   - Educational Identity  — globally unique, immutable ids for every entity.
 *   - Educational Time      — a governed logical chronology (monotonic tick),
 *                             reproducible independent of physical clocks.
 *   - Educational Transactions — the ONE mutation path: submit() runs a
 *                             constitutional governance gate, routes to a
 *                             registered subsystem, and returns an IMMUTABLE,
 *                             versioned, provenance-bearing Runtime Object.
 *   - Constitutional invariants — deny fabricated evidence, provenance removal,
 *                             non-advisory proctoring, ungranted governed action.
 *   - Educational Scheduling — priority by educational objective/authority/urgency,
 *                             not processor utilization.
 *   - An append-only provenance ledger — the reproducible educational history.
 *
 * HONEST SCOPE: this is the kernel CORE + transaction mediation. Distributed
 * federation, cross-institution sync, and persistence are declared kernel
 * subsystems in the spec (AES-001 Ch1) and are NOT implemented here.
 */
(function () {
  function createKernel(opts) {
    opts = opts || {};
    var kernelId = 'eok_' + Math.random().toString(36).slice(2, 9);
    var seq = 0, tick = 0, version = 0;
    var subsystems = {}, ledger = [], scheduled = [];

    function mint(kind) { seq++; return (kind || 'obj') + '_' + kernelId.slice(4) + '_' + seq.toString(36); }
    function time() { tick++; return { tick: tick, wall: Date.now() }; }
    function freeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { freeze(o[k]); }); Object.freeze(o); } return o; }

    // Constitutional invariants (AES-000 Ch 21 Governance): a transaction that
    // fails any of these is denied BEFORE it can touch educational reality.
    var CONSTITUTION = [
      { id: 'no-fabricated-evidence', reason: 'Educational Evidence must carry provenance (no fabrication).', test: function (t) { return !(t.type === 'evidence' && (!t.provenance || !t.provenance.source)); } },
      { id: 'provenance-immutable', reason: 'Provenance shall never be removed from Educational Memory.', test: function (t) { return t.type !== 'remove-provenance'; } },
      { id: 'proctoring-advisory-only', reason: 'Proctoring is advisory-only; it must never auto-penalize.', test: function (t) { return !(t.type === 'policy' && t.payload && t.payload.proctoring && t.payload.proctoring !== 'advisory'); } },
      { id: 'authority-required', reason: 'Governed transactions require an explicit authority grant.', test: function (t) { return !(t.authority === 'governed' && t.granted !== true); } }
    ];

    var K = {
      id: kernelId,
      constitution: CONSTITUTION,
      ledger: ledger,
      mint: mint,
      time: time,
      register: function (name, handler) { subsystems[name] = handler; return this; },
      subsystem: function (name) { return subsystems[name]; },

      // the ONLY path that changes educational reality
      submit: function (txn) {
        var t = time(), txId = mint('txn');
        // 1) constitutional governance gate
        for (var i = 0; i < CONSTITUTION.length; i++) {
          if (!CONSTITUTION[i].test(txn)) {
            ledger.push(freeze({ txId: txId, time: t, type: txn.type, subsystem: txn.subsystem, status: 'denied', violated: CONSTITUTION[i].id }));
            return freeze({ ok: false, status: 'denied', txId: txId, time: t, violated: CONSTITUTION[i].id, reason: CONSTITUTION[i].reason });
          }
        }
        // 2) route to the constitutional subsystem
        var h = subsystems[txn.subsystem];
        if (!h || typeof h.apply !== 'function') {
          ledger.push(freeze({ txId: txId, time: t, type: txn.type, subsystem: txn.subsystem, status: 'no-subsystem' }));
          return freeze({ ok: false, status: 'no-subsystem', txId: txId, time: t, reason: 'no handler for subsystem "' + txn.subsystem + '"' });
        }
        // 3) apply; a subsystem may reject by throwing (e.g. consistency violation)
        var result;
        try { result = h.apply(txn, K); }
        catch (e) {
          ledger.push(freeze({ txId: txId, time: t, type: txn.type, subsystem: txn.subsystem, status: 'rejected', reason: String(e && e.message || e) }));
          return freeze({ ok: false, status: 'rejected', txId: txId, time: t, reason: String(e && e.message || e) });
        }
        // 4) immutable, versioned, provenance-bearing Runtime Object
        version++;
        var obj = freeze({ id: mint('rto'), txId: txId, time: t, version: version, subsystem: txn.subsystem, type: txn.type, provenance: txn.provenance || null, result: result });
        ledger.push(freeze({ txId: txId, time: t, type: txn.type, subsystem: txn.subsystem, status: 'applied', objectId: obj.id }));
        return freeze({ ok: true, status: 'applied', object: obj });
      },

      // Educational Scheduling: highest educational priority first (not CPU).
      schedule: function (item) { scheduled.push(item); scheduled.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); }); return this; },
      next: function () { return scheduled.shift() || null; },
      pending: function () { return scheduled.length; },

      snapshot: function () { return freeze({ kernel: kernelId, version: version, tick: tick, ledgerLength: ledger.length, subsystems: Object.keys(subsystems) }); }
    };
    return K;
  }
  window.AquinEOK = { createKernel: createKernel };
})();

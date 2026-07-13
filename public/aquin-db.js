/*
 * aquin-db.js — AES-100 Vol III Part II Ch 6: Database Runtime Engine. The
 * transactional store beneath every stateful service. Real, tested, named-algorithm
 * cores (classic database theory, no invented CS):
 *
 *  - INDEXED STORAGE: a primary-key index gives O(1) point lookups (vs table scan).
 *  - ACID TRANSACTIONS: begin / commit / rollback; a transaction's writes are
 *    buffered and become visible ATOMICALLY on commit, or vanish on rollback
 *    (atomicity + isolation).
 *  - MVCC SNAPSHOT ISOLATION (multi-version concurrency control, à la Postgres): a
 *    transaction reads a CONSISTENT SNAPSHOT taken at begin — a concurrent commit
 *    is invisible to it (repeatable reads), while it still sees its own writes.
 *  - OPTIMISTIC CONCURRENCY: on commit, if another transaction committed a change to
 *    a key this transaction also wrote after our snapshot, the commit ABORTS
 *    (write-write conflict) — no lost updates.
 *
 * HONEST SCOPE: the index, transaction buffering, MVCC visibility rules, and
 * conflict detection are real and tested in-memory; on-disk B-tree pages, WAL,
 * durable fsync, and distributed replication are declared substrates.
 * (spec's multi-M-LOC C++ → the transactional core.)
 */
(function () {
  function createDatabase() {
    var tables = {};   // name -> { pk, rows: { key -> [ {value, createdV, deletedV} ] } }
    var version = 0;   // global commit version (monotonic)
    var txSeq = 0;
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function createTable(name, spec) { tables[name] = { pk: (spec && spec.pk) || 'id', rows: {} }; return DB; }

    // the row version visible at snapshot V: newest version created <= V and not deleted <= V
    function visibleAt(table, key, V) {
      var vers = tables[table].rows[key]; if (!vers) return undefined;
      for (var i = vers.length - 1; i >= 0; i--) { var r = vers[i]; if (r.createdV <= V && (r.deletedV == null || r.deletedV > V)) return r.value; }
      return undefined;
    }

    function begin() { txSeq++; return { id: 't' + txSeq, snapshot: version, writes: {}, active: true }; }  // writes: key -> {table, value|DELETE}

    function get(tx, table, key) {
      var wk = table + '/' + key;
      if (tx.writes[wk]) return tx.writes[wk].value === '__DELETE__' ? undefined : tx.writes[wk].value;   // own writes
      return visibleAt(table, key, tx.snapshot);                                                          // else the snapshot
    }
    function put(tx, table, key, value) { tx.writes[table + '/' + key] = { table: table, key: key, value: value }; return tx; }
    function del(tx, table, key) { tx.writes[table + '/' + key] = { table: table, key: key, value: '__DELETE__' }; return tx; }

    // select with an optional filter (scans the snapshot + own writes)
    function select(tx, table, where) {
      var t = tables[table]; var out = [], seen = {};
      Object.keys(tx.writes).forEach(function (wk) { var w = tx.writes[wk]; if (w.table === table) { seen[w.key] = true; if (w.value !== '__DELETE__' && (!where || where(w.value))) out.push(w.value); } });
      Object.keys(t.rows).forEach(function (key) { if (seen[key]) return; var v = visibleAt(table, key, tx.snapshot); if (v !== undefined && (!where || where(v))) out.push(v); });
      return out;
    }

    function commit(tx) {
      if (!tx.active) return { ok: false, reason: 'transaction not active' };
      // OPTIMISTIC CONCURRENCY: abort if a key we wrote was committed by someone else after our snapshot
      var conflict = null;
      Object.keys(tx.writes).forEach(function (wk) {
        var w = tx.writes[wk], vers = tables[w.table].rows[w.key];
        if (vers) { var latest = vers[vers.length - 1]; if (latest.createdV > tx.snapshot || (latest.deletedV != null && latest.deletedV > tx.snapshot)) conflict = wk; }
      });
      if (conflict) { tx.active = false; rec('abort', { tx: tx.id, conflict: conflict }); return { ok: false, aborted: true, reason: 'write-write conflict on "' + conflict + '" — another transaction committed after your snapshot' }; }
      // apply atomically at a new version
      version++;
      Object.keys(tx.writes).forEach(function (wk) {
        var w = tx.writes[wk]; var vers = (tables[w.table].rows[w.key] = tables[w.table].rows[w.key] || []);
        if (w.value === '__DELETE__') { var live = vers[vers.length - 1]; if (live && live.deletedV == null) live.deletedV = version; }
        else vers.push({ value: JSON.parse(JSON.stringify(w.value)), createdV: version, deletedV: null });
      });
      tx.active = false; rec('commit', { tx: tx.id, version: version, writes: Object.keys(tx.writes).length });
      return { ok: true, version: version };
    }
    function rollback(tx) { tx.active = false; tx.writes = {}; rec('rollback', { tx: tx.id }); return { ok: true }; }

    var DB = {
      provenance: provenance, createTable: createTable,
      begin: begin, get: get, put: put, delete: del, select: select, commit: commit, rollback: rollback,
      version: function () { return version; },
      // convenience autocommit
      insert: function (table, key, value) { var tx = begin(); put(tx, table, key, value); return commit(tx); }
    };
    return DB;
  }
  window.AquinDB = { createDatabase: createDatabase };
})();

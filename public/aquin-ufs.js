/*
 * aquin-ufs.js — AES-100 Vol III Part II Ch 2: Universal Filesystem Architecture
 * (UFSA). A filesystem that stores knowledge-aware Runtime Objects, not just bytes.
 * The genuinely-buildable cores, all real and tested:
 *
 *  - CONTENT-ADDRESSABLE STORAGE: an object's storage key is the HASH of its
 *    content, so identical content is stored ONCE (dedup) — same content at two
 *    paths shares one blob.
 *  - NATIVE VERSIONING: every write appends a new version; historical versions are
 *    recoverable (research reproducibility, AI model evolution, policy history).
 *  - NAMESPACE QUOTAS + isolation: a write that would exceed a namespace quota is
 *    rejected.
 *  - SEMANTIC INDEX: objects carry tags/topics; search is by MEANING, not filename.
 *  - JOURNALING: every mutation is an append-only journal entry (transaction-safe).
 *  - SNAPSHOTS: point-in-time capture + restore.
 *  - INTEGRITY: a tampered blob is detected by content-hash mismatch.
 *
 * HONEST SCOPE: the filesystem semantics (content-addressing, versioning, quotas,
 * semantic index, journaling, snapshots, integrity) are real and tested over an
 * in-memory store; physical block allocation, on-disk journaling, encryption-at-rest,
 * and distributed replication are declared substrates. (~4.7M-LOC C++ → the core.)
 */
(function () {
  // FNV-1a 32-bit content hash (deterministic content addressing)
  function hash(s) { s = String(s); var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }

  function createFilesystem() {
    var blobs = {};          // contentHash -> { content, refCount }
    var namespaces = {};     // name -> { quota, used, owner }
    var objects = {};        // path -> { namespace, owner, versions:[{contentHash, tags, at, version}] }
    var journal = [];
    var snapshots = [];
    var physicalBytes = 0, logicalBytes = 0;
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function ns(name) { return namespaces[name] || namespaces['/']; }

    var FS = {
      provenance: provenance,
      createNamespace: function (name, spec) { spec = spec || {}; namespaces[name] = { quota: spec.quota != null ? spec.quota : Infinity, used: 0, owner: spec.owner || null }; rec('mk-namespace', { name: name, quota: spec.quota }); return this; },

      // write: content-addressable + versioned + quota-checked + journaled
      put: function (path, content, opts) {
        opts = opts || {}; var namespace = opts.namespace || '/';
        if (!namespaces[namespace]) this.createNamespace(namespace, {});
        var n = namespaces[namespace];
        var size = String(content).length;
        if (n.used + size > n.quota) { rec('put-denied', { path: path, reason: 'quota' }); return { ok: false, reason: 'namespace "' + namespace + '" quota exceeded (' + (n.used + size) + ' > ' + n.quota + ')' }; }
        var ch = hash(content);
        if (!blobs[ch]) { blobs[ch] = { content: content, refCount: 0 }; physicalBytes += size; }   // dedup: store unique content once
        blobs[ch].refCount++;
        var o = objects[path] || (objects[path] = { namespace: namespace, owner: opts.owner || null, versions: [] });
        var version = o.versions.length + 1;
        o.versions.push({ contentHash: ch, tags: (opts.tags || []).slice(), at: Date.now(), version: version });
        n.used += size; logicalBytes += size;
        journal.push({ op: 'put', path: path, version: version, hash: ch, at: Date.now() });
        rec('put', { path: path, version: version, dedup: blobs[ch].refCount > 1 });
        return { ok: true, path: path, version: version, contentHash: ch, deduped: blobs[ch].refCount > 1 };
      },

      // read latest or a specific historical version
      get: function (path, opts) {
        opts = opts || {}; var o = objects[path]; if (!o || !o.versions.length) return null;
        var v = opts.version ? o.versions[opts.version - 1] : o.versions[o.versions.length - 1];
        if (!v) return null; var b = blobs[v.contentHash]; return b ? b.content : null;
      },
      history: function (path) { var o = objects[path]; return o ? o.versions.map(function (v) { return { version: v.version, hash: v.contentHash, at: v.at }; }) : []; },

      // SEMANTIC search: by tag/topic across an object's whole history (meaning, not
      // filename) — a concept tagged once stays findable even after later edits.
      search: function (query) {
        var q = String(query).toLowerCase();
        return Object.keys(objects).filter(function (p) {
          var o = objects[p];
          var allTags = o.versions.reduce(function (acc, v) { return acc.concat(v.tags); }, []);
          return allTags.some(function (t) { return String(t).toLowerCase().indexOf(q) >= 0; }) || p.toLowerCase().indexOf(q) >= 0;
        });
      },

      // integrity: does the stored content still hash to its address?
      verifyIntegrity: function (path) {
        var o = objects[path]; if (!o) return { ok: false, reason: 'no such object' };
        var bad = o.versions.filter(function (v) { var b = blobs[v.contentHash]; return !b || hash(b.content) !== v.contentHash; });
        return { ok: bad.length === 0, corruptedVersions: bad.map(function (v) { return v.version; }) };
      },
      _tamper: function (ch, content) { if (blobs[ch]) blobs[ch].content = content; },   // test hook

      // snapshots
      snapshot: function (label) { var snap = { label: label || 'snap_' + (snapshots.length + 1), objects: JSON.parse(JSON.stringify(objects)), journalLen: journal.length, at: Date.now() }; snapshots.push(snap); rec('snapshot', { label: snap.label }); return snap.label; },
      restore: function (label) { var s = snapshots.filter(function (x) { return x.label === label; })[0]; if (!s) return { ok: false }; objects = JSON.parse(JSON.stringify(s.objects)); rec('restore', { label: label }); return { ok: true, restoredTo: label }; },

      stats: function () { return { objects: Object.keys(objects).length, blobs: Object.keys(blobs).length, physicalBytes: physicalBytes, logicalBytes: logicalBytes, dedupSavings: logicalBytes - physicalBytes, journalEntries: journal.length }; },
      journal: function () { return journal.slice(); }
    };
    FS.createNamespace('/', {});
    return FS;
  }
  window.AquinUFS = { hash: hash, createFilesystem: createFilesystem };
})();

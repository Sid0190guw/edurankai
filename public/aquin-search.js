/*
 * aquin-search.js — AES-100 Vol III Part II Ch 17: Universal Search, Semantic
 * Indexing & Knowledge Retrieval Engine (USSIKRE). Makes every document, dataset,
 * and educational resource searchable by MEANING, not just keywords. Real, tested,
 * named-algorithm cores:
 *
 *  - FULL-TEXT search: an inverted index ranked by BM25 (Robertson/Sparck-Jones) —
 *    the modern standard: term frequency saturated, rarer terms (higher IDF) weigh
 *    more, long documents penalised.
 *  - VECTOR (semantic) search: cosine similarity over embedding vectors — finds
 *    conceptually close content even with no shared words.
 *  - HYBRID retrieval: min-max normalise the lexical + semantic scores and fuse
 *    them (α·lexical + (1−α)·semantic) — the best of both.
 *  - RAG: retrieve the top-k passages and assemble a grounded CONTEXT for a
 *    generator (retrieval is real here; the LLM generation is a declared substrate).
 *
 * HONEST SCOPE: BM25, cosine, and the fusion/RAG assembly are real and tested; the
 * embedding MODEL that produces vectors and the generator that consumes the RAG
 * context are declared substrates. (spec's multi-M-LOC C++ → the retrieval core.)
 */
(function () {
  function tokenize(s) { return String(s).toLowerCase().match(/[a-z0-9]+/g) || []; }

  function createSearchIndex(cfg) {
    cfg = cfg || {};
    var k1 = cfg.k1 || 1.5, b = cfg.b || 0.75;
    var docs = {};        // id -> { text, tokens, len, vector, tags }
    var inverted = {};    // term -> { docId -> tf }
    var df = {};          // term -> document frequency
    var totalLen = 0, N = 0;
    var provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function idf(term) { var n = df[term] || 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); }
    function avgdl() { return N ? totalLen / N : 0; }

    var S = {
      provenance: provenance,
      index: function (id, text, opts) {
        opts = opts || {};
        var toks = tokenize(text);
        docs[id] = { text: text, tokens: toks, len: toks.length, vector: opts.vector || null, tags: opts.tags || [] };
        var tf = {}; toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
        Object.keys(tf).forEach(function (t) { (inverted[t] = inverted[t] || {})[id] = tf[t]; df[t] = (df[t] || 0) + 1; });
        totalLen += toks.length; N++;
        rec('index', { id: id, terms: Object.keys(tf).length });
        return this;
      },

      // BM25 full-text search
      searchText: function (query, topK) {
        var qterms = tokenize(query), scores = {};
        qterms.forEach(function (t) {
          var posting = inverted[t]; if (!posting) return; var _idf = idf(t);
          Object.keys(posting).forEach(function (id) {
            var tf = posting[id], dl = docs[id].len;
            var denom = tf + k1 * (1 - b + b * dl / (avgdl() || 1));
            scores[id] = (scores[id] || 0) + _idf * (tf * (k1 + 1)) / denom;
          });
        });
        return Object.keys(scores).map(function (id) { return { id: id, score: +scores[id].toFixed(4) }; }).sort(function (a, b2) { return b2.score - a.score; }).slice(0, topK || 10);
      },

      // cosine vector search
      searchVector: function (qvec, topK) {
        function cos(a, bb) { var d = 0, na = 0, nb = 0; for (var i = 0; i < a.length; i++) { d += a[i] * bb[i]; na += a[i] * a[i]; nb += bb[i] * bb[i]; } return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; }
        return Object.keys(docs).filter(function (id) { return docs[id].vector; }).map(function (id) { return { id: id, score: +cos(qvec, docs[id].vector).toFixed(4) }; }).sort(function (a, b2) { return b2.score - a.score; }).slice(0, topK || 10);
      },

      // hybrid: min-max normalise then fuse
      searchHybrid: function (query, qvec, opts) {
        opts = opts || {}; var alpha = opts.alpha != null ? opts.alpha : 0.5;
        function norm(list) { if (!list.length) return {}; var mx = Math.max.apply(null, list.map(function (x) { return x.score; })), mn = Math.min.apply(null, list.map(function (x) { return x.score; })); var o = {}; list.forEach(function (x) { o[x.id] = mx === mn ? 1 : (x.score - mn) / (mx - mn); }); return o; }
        var lex = norm(this.searchText(query, 50)), sem = norm(this.searchVector(qvec, 50));
        var ids = {}; Object.keys(lex).forEach(function (k) { ids[k] = 1; }); Object.keys(sem).forEach(function (k) { ids[k] = 1; });
        return Object.keys(ids).map(function (id) { return { id: id, score: +(alpha * (lex[id] || 0) + (1 - alpha) * (sem[id] || 0)).toFixed(4), lexical: +(lex[id] || 0).toFixed(3), semantic: +(sem[id] || 0).toFixed(3) }; }).sort(function (a, b2) { return b2.score - a.score; }).slice(0, opts.topK || 10);
      },

      // RAG: retrieve top-k passages, assemble grounded context for a generator
      rag: function (query, qvec, opts) {
        opts = opts || {}; var k = opts.k || 3;
        var hits = qvec ? this.searchHybrid(query, qvec, { topK: k }) : this.searchText(query, k);
        var passages = hits.map(function (h) { return { id: h.id, text: docs[h.id].text, score: h.score }; });
        return { query: query, retrieved: passages.length, context: passages.map(function (p) { return '[' + p.id + '] ' + p.text; }).join('\n'), passages: passages, note: 'retrieval is real; the answer generator (LLM) is a declared substrate that consumes this grounded context' };
      },
      doc: function (id) { return docs[id]; }, size: function () { return N; }
    };
    return S;
  }
  window.AquinSearch = { createSearchIndex: createSearchIndex, tokenize: tokenize };
})();

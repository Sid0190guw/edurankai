/*
 * aquin-multimodal.js — AES-100 Vol IV P2 Ch93: Enterprise Multimodal AI & Cross-Modal
 * Reasoning (EMAICMRUCPF). All modalities contribute to ONE cognitive representation.
 * The modality encoders (VLM, audio, video nets) are declared substrates; the REAL,
 * tested cores are what unifies them:
 *
 *  - UNIFIED EMBEDDING SPACE: register text / image / speech / video items as vectors
 *    in one shared space.
 *  - CROSS-MODAL RETRIEVAL: a query vector in one modality retrieves the nearest items
 *    in ANY (or a chosen) modality by cosine similarity — text-query -> image-result.
 *  - LATE FUSION: combine several modality vectors into one unified representation
 *    (weighted), with a CONSISTENCY score = average pairwise cosine agreement.
 *  - MULTIMODAL RAG: retrieve the top items across every modality store and assemble
 *    the grounded, modality-tagged context a multimodal answer is built on.
 *
 * HONEST SCOPE: the shared-space geometry, retrieval, fusion and consistency math are
 * real over supplied vectors; the neural encoders that PRODUCE aligned embeddings are
 * declared substrates.
 */
(function () {
  function cos(a, b) { var d = 0, na = 0, nb = 0; for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; }

  function createMultimodal() {
    var items = {}, memory = [], prov = [];
    function rec(op, d) { prov.push({ op: op, at: Date.now(), detail: d || null }); }

    var M = {
      provenance: prov, cosine: cos,
      register: function (id, modality, vector, meta) { items[id] = { id: id, modality: modality, vector: vector, meta: meta || {} }; rec('register', { id: id, modality: modality }); return this; },

      // cross-modal nearest neighbours: query in one modality -> results in any/target
      search: function (queryVector, opts) {
        opts = opts || {}; var out = Object.keys(items).map(function (k) { return items[k]; })
          .filter(function (it) { return !opts.modality || it.modality === opts.modality; })
          .map(function (it) { return { id: it.id, modality: it.modality, score: +cos(queryVector, it.vector).toFixed(4), meta: it.meta }; })
          .sort(function (a, b) { return b.score - a.score; });
        return out.slice(0, opts.topK || 5);
      },

      // late fusion of several modality vectors -> one unified representation + consistency
      fuse: function (vectors, weights) {
        var d = vectors[0].length, w = weights || vectors.map(function () { return 1 / vectors.length; });
        var wsum = w.reduce(function (a, b) { return a + b; }, 0);
        var out = new Array(d).fill(0);
        vectors.forEach(function (v, i) { for (var j = 0; j < d; j++) out[j] += v[j] * (w[i] / wsum); });
        // consistency = average pairwise cosine agreement across the modalities
        var pairs = 0, sum = 0; for (var i = 0; i < vectors.length; i++) for (var j = i + 1; j < vectors.length; j++) { sum += cos(vectors[i], vectors[j]); pairs++; }
        return { unified: out, consistency: pairs ? +(sum / pairs).toFixed(4) : 1 };
      },
      consistency: function (a, b) { return +cos(a, b).toFixed(4); },

      // multimodal RAG: gather the grounded context across every modality
      rag: function (queryVector, topK) {
        var hits = M.search(queryVector, { topK: topK || 4 });
        return { retrieved: hits.length, context: hits.map(function (h) { return '[' + h.modality + ':' + h.id + '] ' + (h.meta.text || h.meta.caption || h.id); }), passages: hits, note: 'cross-modal retrieval is real; the generative model that consumes this context is a declared substrate' };
      },

      // --- Ch93 deepening: cross-modal memory + bidirectional retrieval eval ---
      remember: function (id, modality, vector, meta) { memory.push({ id: id, modality: modality, vector: vector, meta: meta || {} }); rec('remember', { id: id }); return this; },
      recall: function (queryVector, topK) { return memory.map(function (m) { return { id: m.id, modality: m.modality, score: +cos(queryVector, m.vector).toFixed(4), meta: m.meta }; }).sort(function (a, b) { return b.score - a.score; }).slice(0, topK || 5); },

      // recall@1 for text->image AND image->text over aligned (text,image) vector pairs
      retrievalEval: function (pairs) {
        function r1(dir) {
          var correct = 0;
          for (var i = 0; i < pairs.length; i++) {
            var q = dir === 't2i' ? pairs[i].text : pairs[i].image, best = -1, bestS = -Infinity;
            for (var j = 0; j < pairs.length; j++) { var cand = dir === 't2i' ? pairs[j].image : pairs[j].text; var s = cos(q, cand); if (s > bestS) { bestS = s; best = j; } }
            if (best === i) correct++;
          }
          return +(correct / pairs.length).toFixed(4);
        }
        return { textToImageRecall1: r1('t2i'), imageToTextRecall1: r1('i2t') };
      }
    };
    return M;
  }
  window.AquinMultimodal = { createMultimodal: createMultimodal, cosine: cos };
})();

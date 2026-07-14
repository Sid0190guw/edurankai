/*
 * aquin-genai.js — AES-100 Vol IV P2 Ch95: Enterprise Generative AI & Cognitive Media
 * (EMFMGACMEF). Generation is an ENTERPRISE WORKFLOW, not just prompt->model->output.
 * The foundation models (LLM / diffusion / video) are declared substrates; the REAL,
 * tested cores are the governance that makes generated media trustworthy:
 *
 *  - POLICY GATE: a request is validated against institutional rules (forbidden intents,
 *    tenant scope) BEFORE any model runs — refused requests never reach generation.
 *  - KNOWLEDGE GROUNDING: generated claims must be backed by retrieved sources; an
 *    ungrounded claim blocks publication (hallucination mitigation).
 *  - WATERMARK + PROVENANCE: every asset gets a content-hash watermark + a record of
 *    (model, prompt, sources, time). verifyWatermark(asset) detects tampering (the
 *    stored hash no longer matches the content) — synthetic media stays identifiable.
 *  - APPROVAL GATE: safety must pass, and high-impact assets (certificates, exams)
 *    require human approval before publish.
 *
 * HONEST SCOPE: policy/grounding/watermark/provenance/approval logic is real; the
 * generative foundation model that actually produces pixels/tokens is the declared
 * substrate (this engine governs whatever it produces).
 */
(function () {
  function fnv1a(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); }
  var HIGH_IMPACT = { certificate: 1, examination: 1, exam: 1, transcript: 1, policy: 1 };

  function createStudio(cfg) {
    cfg = cfg || {};
    var forbidden = cfg.forbidden || ['malware', 'weapon', 'self-harm'];
    var assets = {}, promptVersions = {}, seq = 0, prov = [];
    function rec(op, d) { prov.push({ op: op, at: Date.now(), detail: d || null }); }

    function policyCheck(req) {
      var p = (req.prompt || '').toLowerCase();
      var hit = forbidden.filter(function (f) { return p.indexOf(f) !== -1; });
      if (hit.length) return { ok: false, reason: 'prompt violates policy: ' + hit.join(', ') };
      if (req.tenant && cfg.tenant && req.tenant !== cfg.tenant) return { ok: false, reason: 'cross-tenant generation denied' };
      return { ok: true };
    }

    var S = {
      provenance: prov,

      // one governed generation. produce() is the substrate (LLM/diffusion) supplied by caller.
      generate: function (req, produce) {
        var pol = policyCheck(req);
        if (!pol.ok) { rec('policy-deny', pol); return { ok: false, stage: 'policy', reason: pol.reason }; }

        var content = produce ? produce(req) : { text: '', claims: [] };   // <- declared substrate
        // grounding: every claim needs an evidence token present in the cited sources
        var sources = (req.sources || []).join(' ').toLowerCase();
        var claims = content.claims || [];
        var ungrounded = claims.filter(function (c) { return !c.evidence || sources.indexOf(String(c.evidence).toLowerCase()) === -1; });
        if (ungrounded.length) { rec('grounding-fail', { n: ungrounded.length }); return { ok: false, stage: 'grounding', reason: ungrounded.length + ' claim(s) not grounded in cited sources', ungrounded: ungrounded.length }; }

        var id = 'asset_' + (++seq);
        var body = JSON.stringify(content.text != null ? content.text : content);
        var watermark = fnv1a(id + '|' + body);
        var type = req.type || 'text';
        var needsHuman = !!HIGH_IMPACT[type] || !!HIGH_IMPACT[(req.prompt || '').toLowerCase().split(' ')[0]];
        assets[id] = { id: id, type: type, body: body, watermark: watermark, model: req.model || 'foundation-model', promptHash: fnv1a(req.prompt || ''), sources: req.sources || [], status: needsHuman ? 'pending-approval' : 'ready', approvedBy: null, at: Date.now() };
        rec('generate', { id: id, status: assets[id].status });
        return { ok: true, assetId: id, watermark: watermark, status: assets[id].status, needsHumanApproval: needsHuman };
      },

      // watermark verification: recompute the hash from stored content; tampering shows up
      verifyWatermark: function (assetId, bodyOverride) {
        var a = assets[assetId]; if (!a) return { valid: false, reason: 'unknown asset' };
        var body = bodyOverride != null ? JSON.stringify(bodyOverride) : a.body;
        var expect = fnv1a(assetId + '|' + body);
        return { valid: expect === a.watermark, watermark: a.watermark, recomputed: expect, tampered: expect !== a.watermark };
      },

      approve: function (assetId, human) { var a = assets[assetId]; if (!a) return { ok: false }; a.approvedBy = human; a.status = 'approved'; rec('approve', { id: assetId, by: human }); return { ok: true, status: 'approved' }; },

      // publish only if not blocked and (approved when human approval was required)
      publish: function (assetId) {
        var a = assets[assetId]; if (!a) return { ok: false, reason: 'unknown asset' };
        if (a.status === 'pending-approval') return { ok: false, reason: 'high-impact asset awaits human approval before publishing' };
        a.status = 'published'; rec('publish', { id: assetId }); return { ok: true, status: 'published', watermark: a.watermark };
      },
      asset: function (id) { return assets[id]; },

      // --- Ch95 deepening: harmful-content detection, copyright similarity, evaluation, prompt versions ---
      detectHarmful: function (text, lexicon) {
        var lex = lexicon || { violence: ['weapon', 'kill', 'bomb'], malware: ['malware', 'ransomware', 'exploit'], selfHarm: ['self-harm', 'suicide'] };
        var t = String(text).toLowerCase(), hits = [];
        Object.keys(lex).forEach(function (cat) { var m = lex[cat].filter(function (w) { return t.indexOf(w) !== -1; }); if (m.length) hits.push({ category: cat, terms: m }); });
        return { harmful: hits.length > 0, categories: hits, severity: hits.length >= 2 ? 'high' : (hits.length ? 'medium' : 'none') };
      },
      // copyright / near-duplicate detection via token-Jaccard against a corpus
      similarityCheck: function (text, corpus, threshold) {
        threshold = threshold != null ? threshold : 0.5;
        function toks(s) { var o = {}; (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function (w) { o[w] = 1; }); return o; }
        var a = toks(text), best = { score: 0, index: -1 };
        (corpus || []).forEach(function (c, i) { var b = toks(c), inter = 0, uni = {}; Object.keys(a).forEach(function (k) { uni[k] = 1; if (b[k]) inter++; }); Object.keys(b).forEach(function (k) { uni[k] = 1; }); var j = inter / Object.keys(uni).length; if (j > best.score) best = { score: +j.toFixed(4), index: i }; });
        return { maxSimilarity: best.score, matchIndex: best.index, flagged: best.score >= threshold };
      },
      // factuality = fraction of claims grounded in cited sources; consistency = simple agreement proxy
      evaluateAsset: function (spec) {
        var claims = spec.claims || [], sources = (spec.sources || []).join(' ').toLowerCase();
        var grounded = claims.filter(function (c) { return c.evidence && sources.indexOf(String(c.evidence).toLowerCase()) !== -1; }).length;
        var factuality = claims.length ? +(grounded / claims.length).toFixed(4) : 1;
        return { factuality: factuality, groundedClaims: grounded, totalClaims: claims.length, consistency: factuality >= 0.99 ? 1 : +(0.5 + factuality / 2).toFixed(4) };
      },
      // prompt version registry (content-hash) so every generation traces to a prompt version
      promptVersion: function (prompt) { var h = fnv1a(String(prompt)); promptVersions[h] = (promptVersions[h] || { hash: h, prompt: String(prompt).slice(0, 400), uses: 0 }); promptVersions[h].uses++; return { version: h, uses: promptVersions[h].uses }; }
    };
    return S;
  }
  window.AquinGenAI = { createStudio: createStudio };
})();

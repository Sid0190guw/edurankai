/*
 * aquin-speech.js — AES-100 Vol IV P2 Ch92: Enterprise Speech Intelligence &
 * Conversational AI (ESINLAPCAF). The acoustic ASR/TTS neural models are declared
 * substrates; what is REAL and tested here are the cores that turn speech into
 * governed conversation:
 *
 *  - VOICE BIOMETRICS: enroll a speaker's voice embedding(s); verify(claim, emb)
 *    accepts only if cosine similarity to that speaker's centroid clears a threshold
 *    (impostor rejected). identify(emb) returns the nearest enrolled speaker.
 *  - DIARIZATION: label each conversation turn with its speaker by nearest-centroid
 *    assignment ("who spoke when").
 *  - LANGUAGE DETECTION: stop-word profile scoring picks the language of an utterance.
 *  - DIALOGUE MANAGER: intent routing + slot/context tracking + a turn state machine,
 *    so a voice agent holds a real, contextual conversation (grounded answers come
 *    from aquin-brain / the LLM substrate).
 *
 * HONEST SCOPE: biometrics/diarization/language/dialogue logic are real over supplied
 * embeddings + text; the neural ASR, TTS and the speaker-embedding model itself are
 * declared substrates.
 */
(function () {
  function cos(a, b) { var d = 0, na = 0, nb = 0; for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; }
  function mean(vs) { var n = vs.length, d = vs[0].length, out = new Array(d).fill(0); vs.forEach(function (v) { for (var i = 0; i < d; i++) out[i] += v[i] / n; }); return out; }

  var STOP = {
    english: ['the', 'is', 'and', 'of', 'to', 'in', 'that', 'it', 'you', 'was'],
    spanish: ['el', 'la', 'que', 'de', 'los', 'y', 'en', 'un', 'por', 'es'],
    french: ['le', 'la', 'et', 'les', 'des', 'est', 'une', 'que', 'dans', 'pour'],
    hindi: ['hai', 'kya', 'aur', 'nahi', 'main', 'ka', 'ki', 'ko', 'mein', 'yeh']
  };

  function createSpeech() {
    var speakers = {}, audioIndex = {}, prov = [];
    function rec(op, d) { prov.push({ op: op, at: Date.now(), detail: d || null }); }

    var S = {
      provenance: prov, cosine: cos,
      enroll: function (id, embedding) { (speakers[id] = speakers[id] || []).push(embedding); rec('enroll', { id: id }); return this; },
      centroid: function (id) { return speakers[id] ? mean(speakers[id]) : null; },

      identify: function (embedding) {
        var best = null; Object.keys(speakers).forEach(function (id) { var s = cos(embedding, mean(speakers[id])); if (!best || s > best.score) best = { speaker: id, score: +s.toFixed(4) }; });
        return best || { speaker: null, score: 0 };
      },
      verify: function (claimedId, embedding, threshold) {
        threshold = threshold != null ? threshold : 0.75;
        if (!speakers[claimedId]) return { accepted: false, reason: 'speaker not enrolled' };
        var score = cos(embedding, mean(speakers[claimedId]));
        return { accepted: score >= threshold, score: +score.toFixed(4), threshold: threshold, reason: score >= threshold ? 'match' : 'below threshold (possible impostor)' };
      },

      // who spoke when: assign each turn to its nearest enrolled speaker
      diarize: function (turns) {
        return turns.map(function (t, i) { var who = S.identify(t.embedding); return { turn: i, speaker: who.speaker, confidence: who.score, text: t.text || null }; });
      },

      detectLanguage: function (text) {
        var words = String(text).toLowerCase().match(/[a-z]+/g) || [];
        var scores = {}; Object.keys(STOP).forEach(function (lang) { scores[lang] = words.filter(function (w) { return STOP[lang].indexOf(w) !== -1; }).length; });
        var best = Object.keys(scores).reduce(function (a, b) { return scores[b] > scores[a] ? b : a; }, 'english');
        return { language: scores[best] ? best : 'unknown', scores: scores };
      },

      // dialogue manager: intents = [{ name, keywords, respond(ctx,text) }]
      createDialogue: function (intents) {
        var context = {}, history = [];
        return {
          context: context, history: history,
          respond: function (text) {
            var t = String(text).toLowerCase(), best = null, bestScore = 0;
            (intents || []).forEach(function (it) { var s = (it.keywords || []).reduce(function (a, k) { return a + (t.indexOf(k) !== -1 ? k.length : 0); }, 0); if (s > bestScore) { bestScore = s; best = it; } });
            var intent = best ? best.name : 'fallback';
            // slot capture: a trailing "... my name is X" style context fill
            var m = t.match(/my name is (\w+)/); if (m) context.name = m[1];
            var reply = best && best.respond ? best.respond(context, text) : 'Could you rephrase that? I can help with ' + (intents || []).map(function (i) { return i.name; }).join(', ') + '.';
            history.push({ text: text, intent: intent }); rec('dialogue', { intent: intent });
            return { intent: intent, reply: reply, context: JSON.parse(JSON.stringify(context)) };
          }
        };
      },

      // --- Ch92 deepening: VAD, emotion, audio-embedding retrieval, unsupervised diarization ---
      // Voice Activity Detection: mark speech vs silence from per-frame energy (mean + k*std)
      vad: function (frames, opts) {
        opts = opts || {}; var energy = frames.map(function (f) { return Array.isArray(f) ? Math.sqrt(f.reduce(function (a, b) { return a + b * b; }, 0) / f.length) : Math.abs(f); });
        var m = energy.reduce(function (a, b) { return a + b; }, 0) / energy.length;
        var sd = Math.sqrt(energy.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / energy.length);
        var thr = opts.threshold != null ? opts.threshold : m + (opts.k != null ? opts.k : 0.5) * sd;
        var segs = [], cur = null;
        energy.forEach(function (e, i) { if (e >= thr) { if (!cur) cur = { start: i, end: i }; else cur.end = i; } else if (cur) { segs.push(cur); cur = null; } });
        if (cur) segs.push(cur);
        return { threshold: +thr.toFixed(4), speechSegments: segs, speechFrames: energy.filter(function (e) { return e >= thr; }).length };
      },
      // emotion distribution from supplied prosodic features [energy, pitchVar, speechRate, pauseRatio]
      emotion: function (features) {
        var f = features || [0, 0, 0, 0];
        var w = { engaged: [0.6, 0.2, 0.5, -0.4], confused: [-0.2, 0.5, -0.3, 0.6], frustrated: [0.5, 0.6, 0.4, -0.1], neutral: [0.1, -0.2, 0.0, 0.1] };
        var raw = {}, keys = Object.keys(w), mx = -Infinity;
        keys.forEach(function (k) { var s = 0; for (var i = 0; i < f.length; i++) s += (w[k][i] || 0) * f[i]; raw[k] = s; if (s > mx) mx = s; });
        var exp = {}, sum = 0; keys.forEach(function (k) { exp[k] = Math.exp(raw[k] - mx); sum += exp[k]; });
        var dist = {}, top = keys[0]; keys.forEach(function (k) { dist[k] = +(exp[k] / sum).toFixed(4); if (dist[k] > dist[top]) top = k; });
        return { emotion: top, scores: dist };
      },
      indexAudio: function (id, embedding) { audioIndex[id] = embedding; return this; },
      searchAudio: function (queryEmbedding, topK) { return Object.keys(audioIndex).map(function (id) { return { id: id, score: +cos(queryEmbedding, audioIndex[id]).toFixed(4) }; }).sort(function (a, b) { return b.score - a.score; }).slice(0, topK || 5); },
      // unsupervised diarization: cluster turn embeddings when speakers are NOT enrolled
      cluster: function (turns, threshold) {
        threshold = threshold != null ? threshold : 0.6; var clusters = [];
        var labels = turns.map(function (t) {
          var best = -1, bestS = threshold;
          clusters.forEach(function (c, ci) { var s = cos(t.embedding, c.centroid); if (s >= bestS) { bestS = s; best = ci; } });
          if (best < 0) { clusters.push({ centroid: t.embedding.slice(), members: [t.embedding] }); return clusters.length - 1; }
          var c = clusters[best]; c.members.push(t.embedding);
          for (var i = 0; i < c.centroid.length; i++) c.centroid[i] = c.members.reduce(function (a, v) { return a + v[i]; }, 0) / c.members.length;
          return best;
        });
        rec('cluster', { turns: turns.length, speakers: clusters.length });
        return { speakerCount: clusters.length, labels: labels };
      }
    };
    return S;
  }
  window.AquinSpeech = { createSpeech: createSpeech, cosine: cos };
})();

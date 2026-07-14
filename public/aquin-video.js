/*
 * aquin-video.js — AES-100 Vol IV P2 Ch94: Enterprise Video Intelligence, Spatial
 * Computing & Temporal Reasoning (EVISTRF). Time is a first-class dimension: video is
 * not isolated frames but temporally-linked observations. The per-frame object DETECTOR
 * (a neural net) is the declared substrate; the REAL, tested cores are what turn
 * detections into tracked, reasoned behaviour over time:
 *
 *  - MULTI-OBJECT TRACKING (SORT-lite): greedy IoU association links this frame's
 *    detections to existing tracks, PRESERVING identity across frames. New objects get
 *    new IDs; a briefly-OCCLUDED object (missing < maxAge frames) keeps its ID and is
 *    re-acquired; a long-gone track is dropped. Each track accrues a trajectory.
 *  - TEMPORAL EVENTS: line-crossing detection fires when a track's trajectory crosses a
 *    reference line (enter/exit, attendance, safety zones).
 *  - TEMPORAL REASONING: per-track duration and chronology.
 *
 * HONEST SCOPE: IoU, association, identity/occlusion handling, trajectories and event
 * logic are real over supplied detection boxes; the frame detector and video decode are
 * declared substrates.
 */
(function () {
  // box = [x, y, w, h]; intersection-over-union
  function iou(a, b) {
    var x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    var x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    var iw = Math.max(0, x2 - x1), ih = Math.max(0, y2 - y1), inter = iw * ih;
    var uni = a[2] * a[3] + b[2] * b[3] - inter;
    return uni > 0 ? inter / uni : 0;
  }
  function cx(box) { return box[0] + box[2] / 2; }

  function createTracker(cfg) {
    cfg = cfg || {};
    var iouThreshold = cfg.iouThreshold != null ? cfg.iouThreshold : 0.3;
    var maxAge = cfg.maxAge != null ? cfg.maxAge : 3;
    var tracks = {}, nextId = 1, frame = 0, prov = [];
    function rec(op, d) { prov.push({ op: op, at: frame, detail: d || null }); }
    // constant-velocity motion model: where do we EXPECT an occluded track to be now?
    function predicted(t) { return [t.box[0] + t.vel[0] * t.age, t.box[1] + t.vel[1] * t.age, t.box[2], t.box[3]]; }

    var T = {
      iou: iou, provenance: prov,
      // one video frame: array of detections { box:[x,y,w,h] } -> active tracks (stable ids)
      update: function (detections) {
        frame++;
        var ids = Object.keys(tracks), used = {};
        // greedy association against the PREDICTED position, so a moving occluded object is re-acquired
        ids.forEach(function (id) {
          var t = tracks[id], pbox = predicted(t), best = -1, bestScore = iouThreshold;
          detections.forEach(function (d, di) { if (used[di]) return; var s = iou(pbox, d.box); if (s >= bestScore) { bestScore = s; best = di; } });
          if (best >= 0) {
            var d = detections[best]; used[best] = true; var dt = Math.max(1, frame - t.lastObsFrame);
            t.vel = [(d.box[0] - t.box[0]) / dt, (d.box[1] - t.box[1]) / dt];   // update velocity from the gap
            t.box = d.box; t.age = 0; t.hits++; t.lastObsFrame = frame; t.trajectory.push({ frame: frame, cx: cx(d.box) });
          } else { t.age++; }
        });
        // unmatched detections -> new tracks
        detections.forEach(function (d, di) { if (used[di]) return; var id = 't' + (nextId++); tracks[id] = { id: id, box: d.box, vel: [0, 0], age: 0, hits: 1, firstFrame: frame, lastObsFrame: frame, trajectory: [{ frame: frame, cx: cx(d.box) }] }; rec('new-track', { id: id }); });
        // drop tracks lost longer than maxAge
        Object.keys(tracks).forEach(function (id) { if (tracks[id].age > maxAge) { rec('drop', { id: id }); delete tracks[id]; } });
        return T.active();
      },
      active: function () { return Object.keys(tracks).filter(function (id) { return tracks[id].age === 0; }).map(function (id) { var t = tracks[id]; return { id: id, box: t.box, hits: t.hits, ageFrames: frame - t.firstFrame + 1 }; }); },
      track: function (id) { return tracks[id]; },

      // temporal event: did a track cross a vertical reference line at x=lineX?
      lineCrossing: function (id, lineX) {
        var t = tracks[id]; if (!t || t.trajectory.length < 2) return { crossed: false };
        for (var i = 1; i < t.trajectory.length; i++) { var a = t.trajectory[i - 1].cx, b = t.trajectory[i].cx; if ((a < lineX && b >= lineX) || (a > lineX && b <= lineX)) return { crossed: true, direction: b > a ? 'right' : 'left', atFrame: t.trajectory[i].frame }; }
        return { crossed: false };
      }
    };
    return T;
  }
  window.AquinVideo = { createTracker: createTracker, iou: iou };
})();

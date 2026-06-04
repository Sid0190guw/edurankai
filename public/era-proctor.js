// EduRankAI Proctor Monitor — text-only camera/face/mic analysis.
// No bytes uploaded. Designed to be included from any page that needs live
// proctoring (tests, interviews). Exposes a single global window.eraProctor.
//
// Usage:
//   eraProctor.start({
//     postUrl: '/api/aquintutor/interview/log-event',
//     payloadKey: 'sessionId',           // server expects { sessionId, events:[] }
//     id: '<sessionId or attemptId>',
//     enableCamera: true,
//     enableMic: true,
//     thumbSelector: '#proctorVideo',    // optional preview element
//   })
//
// Emits events of types:
//   media_consent_granted / media_consent_denied / media_lost
//   face_lost / face_visible / multiple_faces / looking_away
//   voice_detected / voice_silenced
(function () {
  var queue = [];
  var flushTimer = null;
  var cfg = null;
  var stopped = false;

  function logEvent(type, severity, detail) {
    if (stopped) return;
    queue.push({ type: type, severity: severity || 'info', detail: detail || {}, clientTs: new Date().toISOString() });
    schedule();
  }
  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 2500);
  }
  function flush() {
    flushTimer = null;
    if (!queue.length || !cfg) return;
    var batch = queue.splice(0, queue.length);
    var payload = { events: batch };
    payload[cfg.payloadKey] = cfg.id;
    try {
      fetch(cfg.postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  function loadFaceApi() {
    return new Promise(function (resolve, reject) {
      if (window.faceapi) return resolve();
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist/face-api.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('face-api load failed')); };
      document.head.appendChild(s);
    });
  }

  async function startFaceMonitor(videoEl) {
    try {
      await loadFaceApi();
      try { if (window.faceapi && faceapi.tf && faceapi.tf.setBackend) await faceapi.tf.setBackend('webgl'); } catch (_) {}
      var MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@latest/model';
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    } catch (e) {
      logEvent('media_lost', 'warn', { reason: 'face_model_load_failed' });
      return;
    }
    var lastFaceCount = 1;
    var yawSince = 0;
    setInterval(async function () {
      if (stopped || videoEl.readyState < 2) return;
      try {
        var dets = await faceapi.detectAllFaces(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }));
        var n = dets.length;
        if (n === 0 && lastFaceCount > 0) logEvent('face_lost', 'warn', {});
        else if (n > 0 && lastFaceCount === 0) logEvent('face_visible', 'info', { count: n });
        if (n > 1 && lastFaceCount <= 1) logEvent('multiple_faces', 'flag', { count: n });
        lastFaceCount = n;
        if (n === 1) {
          var box = dets[0].box;
          var vidW = videoEl.videoWidth || 320;
          var cx = box.x + box.width / 2;
          var off = (cx - vidW / 2) / vidW;
          var away = Math.abs(off) > 0.22;
          if (away) {
            if (!yawSince) yawSince = Date.now();
            else if (Date.now() - yawSince > 1500) {
              logEvent('looking_away', 'warn', { offset: off.toFixed(2) });
              yawSince = Date.now() + 60000;
            }
          } else { yawSince = 0; }
        }
      } catch (_) {}
    }, 1500);
  }

  function startMicMonitor(stream) {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      var ctx = new AudioCtx();
      var src = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      var buf = new Uint8Array(analyser.fftSize);
      var voiceSince = 0;
      var voicing = false;
      setInterval(function () {
        if (stopped) return;
        analyser.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / buf.length);
        var db = 20 * Math.log10(rms || 0.00001);
        var loud = db > -45;
        if (loud) {
          if (!voiceSince) voiceSince = Date.now();
          else if (!voicing && Date.now() - voiceSince > 800) {
            voicing = true;
            logEvent('voice_detected', 'info', { db: Math.round(db) });
          }
        } else {
          if (voicing) { logEvent('voice_silenced', 'info', {}); voicing = false; }
          voiceSince = 0;
        }
      }, 250);
    } catch (e) {
      logEvent('media_lost', 'warn', { reason: 'mic_init_failed' });
    }
  }

  async function start(options) {
    cfg = Object.assign({
      postUrl: '',
      payloadKey: 'sessionId',
      id: '',
      enableCamera: true,
      enableMic: true,
      thumbSelector: null,
    }, options || {});
    if (!cfg.postUrl || !cfg.id) {
      console.warn('eraProctor.start: postUrl and id are required');
      return;
    }
    logEvent('session_listeners_attached', 'info', { ua: navigator.userAgent.slice(0, 200) });

    // Tab + window listeners
    document.addEventListener('visibilitychange', function () {
      logEvent(document.hidden ? 'tab_hidden' : 'tab_visible', document.hidden ? 'warn' : 'info', {});
    });
    window.addEventListener('blur', function () { logEvent('window_blur', 'warn', {}); });
    window.addEventListener('focus', function () { logEvent('window_focus', 'info', {}); });
    window.addEventListener('offline', function () { logEvent('network_offline', 'warn', {}); });
    window.addEventListener('online', function () { logEvent('network_online', 'info', {}); });

    if (cfg.enableCamera || cfg.enableMic) {
      try {
        var constraints = {
          video: cfg.enableCamera ? { facingMode: 'user', width: 320, height: 240 } : false,
          audio: !!cfg.enableMic,
        };
        var stream = await navigator.mediaDevices.getUserMedia(constraints);
        logEvent('media_consent_granted', 'info', { video: cfg.enableCamera, audio: cfg.enableMic });

        stream.getTracks().forEach(function (t) {
          t.addEventListener('ended', function () { logEvent('media_lost', 'flag', { kind: t.kind }); });
        });

        var videoEl = null;
        if (cfg.enableCamera) {
          if (cfg.thumbSelector) {
            videoEl = document.querySelector(cfg.thumbSelector);
          }
          if (!videoEl) {
            var pill = document.createElement('div');
            pill.id = 'eraProctorPill';
            pill.style.cssText = 'position:fixed;bottom:18px;right:18px;background:rgba(0,0,0,0.85);border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:6px 8px;z-index:55;display:flex;align-items:center;gap:8px;font-family:system-ui,sans-serif;';
            pill.innerHTML = '<video id="eraProctorVideo" autoplay muted playsinline style="width:52px;height:52px;border-radius:8px;object-fit:cover;transform:scaleX(-1);background:#000;"></video><div style="color:#fff;font-size:10px;line-height:1.3;"><p style="margin:0;font-weight:700;color:#10b981;">&#9679; LIVE</p><p style="margin:1px 0 0;color:rgba(255,255,255,0.6);font-size:9px;">monitored — no recording</p></div>';
            document.body.appendChild(pill);
            videoEl = document.getElementById('eraProctorVideo');
          }
          if (videoEl) videoEl.srcObject = stream;
        }

        if (cfg.enableCamera && videoEl) startFaceMonitor(videoEl);
        if (cfg.enableMic) startMicMonitor(stream);
      } catch (e) {
        logEvent('media_consent_denied', 'flag', { error: (e && e.name) || 'denied' });
      }
    }
  }

  function stop() { stopped = true; flush(); }

  window.eraProctor = { start: start, stop: stop, log: logEvent, flush: flush };
})();

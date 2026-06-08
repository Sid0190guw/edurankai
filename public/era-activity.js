/* EduRankAI activity + proctoring capture — TEXT ONLY, no media bytes leave the device.
 *
 * Usage:
 *   <script src="/era-activity.js"></script>
 *   <script>
 *     EraActivity.start({
 *       sessionId: 'att_123',     // unique per attempt/session
 *       stage: 'test',            // apply | purchase | learn | test | exam | certificate
 *       refId: 'test-slug',
 *       proctor: true,            // turn on per-minute camera/audio/screen sampling
 *     });
 *   </script>
 *
 * Discrete events (clicks, copy/paste, tab switches, fullscreen exits, shortcuts)
 * are logged continuously. With proctor:true it also samples, once per minute:
 *   - screen activity  (clicks, keystrokes, mouse-active %, focus, fullscreen)
 *   - audio            (RMS speech/silence + a live speech-to-text transcript)
 *   - camera presence  (face-region brightness + motion heuristic)
 * Everything is converted to a text line and shipped to /api/activity/log,
 * where it is encrypted at rest and only decrypted for a human evaluator.
 */
(function () {
  var cfg = null, queue = [], flushTimer = null, minuteTimer = null;
  var counters = { clicks: 0, keys: 0, mouseMoves: 0, copies: 0, pastes: 0, tabAway: 0 };
  var startTs = Date.now();
  var media = null, audioCtx = null, analyser = null, recog = null, transcript = '';
  var lastFrame = null, camCanvas = null, camVideo = null;

  function nowMin() { return Math.floor((Date.now() - startTs) / 60000); }

  function push(type, detail, severity) {
    queue.push({ sessionId: cfg.sessionId, stage: cfg.stage, refId: cfg.refId, type: type, detail: detail, severity: severity || 'info', minuteBucket: nowMin(), clientTs: Date.now() });
    if (queue.length >= 12) flush();
  }
  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    try {
      fetch('/api/activity/log', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ events: batch }) }).catch(function () {});
    } catch (e) {}
  }

  // ---- discrete events --------------------------------------------------------
  function wireDiscrete() {
    document.addEventListener('click', function () { counters.clicks++; }, true);
    document.addEventListener('keydown', function (e) {
      counters.keys++;
      var k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'v' || k === 'x')) push('shortcut', 'Blocked/observed ' + (e.metaKey ? 'cmd' : 'ctrl') + '+' + k, 'low');
      if (k === 'printscreen' || ((e.ctrlKey || e.metaKey) && k === 'p')) push('shortcut', 'Print/screenshot attempt', 'medium');
    }, true);
    document.addEventListener('mousemove', function () { counters.mouseMoves++; }, true);
    document.addEventListener('copy', function () { counters.copies++; push('clipboard', 'Copy event', 'low'); }, true);
    document.addEventListener('paste', function () { counters.pastes++; push('clipboard', 'Paste event', 'medium'); }, true);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { counters.tabAway++; push('tab_switch', 'Tab/window hidden — left the page', 'medium'); }
      else push('tab_return', 'Returned to the page', 'info');
    });
    window.addEventListener('blur', function () { push('focus_lost', 'Window lost focus', 'low'); });
    document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement) push('fullscreen_exit', 'Exited fullscreen', 'medium'); });
    window.addEventListener('online', function () { push('network', 'Network online', 'info'); });
    window.addEventListener('offline', function () { push('network', 'Network offline', 'low'); });
    window.addEventListener('beforeunload', flush);
  }

  // ---- per-minute proctoring sample ------------------------------------------
  function minuteSample() {
    var min = nowMin();
    // screen activity
    var mousePct = Math.min(100, Math.round(counters.mouseMoves / 6));
    var focused = document.visibilityState === 'visible' && document.hasFocus();
    var fs = !!document.fullscreenElement;
    push('minute_activity',
      'Minute ' + min + ': ' + counters.clicks + ' clicks, ' + counters.keys + ' keys, mouse-active ' + mousePct + '%, ' +
      (focused ? 'page focused' : 'PAGE NOT FOCUSED') + ', fullscreen ' + (fs ? 'on' : 'OFF') + ', tab-away events ' + counters.tabAway,
      (!focused || counters.tabAway > 0) ? 'medium' : 'info');
    counters.clicks = counters.keys = counters.mouseMoves = counters.tabAway = 0;

    // audio transcript (text from speech)
    if (transcript.trim()) { push('audio_transcript', transcript.trim().slice(0, 1500), 'info'); transcript = ''; }
    // audio level
    if (analyser) {
      var buf = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(buf);
      var sum = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
      var rms = Math.sqrt(sum / buf.length);
      push('audio_level', 'Minute ' + min + ': audio RMS ' + rms.toFixed(3) + (rms > 0.04 ? ' — speech/sound present' : ' — quiet'), rms > 0.08 ? 'low' : 'info');
    }
    // camera presence heuristic
    if (camVideo && camCanvas) {
      try {
        var c = camCanvas.getContext('2d'); camCanvas.width = 80; camCanvas.height = 60;
        c.drawImage(camVideo, 0, 0, 80, 60);
        var img = c.getImageData(0, 0, 80, 60).data;
        var bright = 0, motion = 0;
        for (var p = 0; p < img.length; p += 4) {
          var lum = (img[p] * 0.3 + img[p + 1] * 0.59 + img[p + 2] * 0.11);
          bright += lum;
          if (lastFrame) motion += Math.abs(lum - lastFrame[p / 4]);
        }
        bright = bright / (img.length / 4);
        motion = lastFrame ? motion / (img.length / 4) : 0;
        var lf = new Float32Array(img.length / 4);
        for (var q = 0; q < img.length; q += 4) lf[q / 4] = (img[q] * 0.3 + img[q + 1] * 0.59 + img[q + 2] * 0.11);
        lastFrame = lf;
        var present = bright > 40 && bright < 240;
        push('camera_presence',
          'Minute ' + min + ': camera ' + (present ? 'subject likely present' : 'NO clear subject') + ' (brightness ' + bright.toFixed(0) + ', motion ' + motion.toFixed(1) + ')',
          present ? 'info' : 'medium');
      } catch (e) {}
    }
    flush();
  }

  // ---- media setup (proctor mode) --------------------------------------------
  function startMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { push('proctor', 'Media not available in this browser', 'low'); return; }
    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: true }).then(function (stream) {
      media = stream;
      // audio analyser
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var src = audioCtx.createMediaStreamSource(stream); analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
      } catch (e) {}
      // camera frame source (NOT uploaded — only sampled to text locally)
      camVideo = document.createElement('video'); camVideo.muted = true; camVideo.playsInline = true; camVideo.srcObject = stream; camVideo.play().catch(function(){});
      camCanvas = document.createElement('canvas');
      push('proctor', 'Camera + microphone monitoring started — text only, no recording uploaded', 'info');
    }).catch(function () { push('proctor', 'Camera/mic permission denied — proctoring degraded to screen-only', 'low'); });

    // speech-to-text transcript
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      try {
        recog = new SR(); recog.continuous = true; recog.interimResults = false; recog.lang = (navigator.language || 'en-IN');
        recog.onresult = function (e) { for (var i = e.resultIndex; i < e.results.length; i++) transcript += ' ' + e.results[i][0].transcript; };
        recog.onend = function () { try { recog.start(); } catch (e) {} };
        recog.start();
      } catch (e) {}
    }
  }

  var EraActivity = {
    start: function (options) {
      cfg = options || {};
      if (!cfg.sessionId) cfg.sessionId = 'sess_' + Math.random().toString(36).slice(2, 10);
      cfg.stage = cfg.stage || 'general';
      wireDiscrete();
      push('session_start', 'Session started on ' + location.pathname, 'info');
      flushTimer = setInterval(flush, 10000);
      if (cfg.proctor) { startMedia(); minuteTimer = setInterval(minuteSample, 60000); setTimeout(minuteSample, 5000); }
      return cfg.sessionId;
    },
    event: function (type, detail, severity) { if (cfg) push(type, detail, severity); },
    stage: function (s) { if (cfg) cfg.stage = s; },
    stop: function () {
      if (cfg) push('session_end', 'Session ended', 'info');
      flush();
      clearInterval(flushTimer); clearInterval(minuteTimer);
      if (recog) try { recog.onend = null; recog.stop(); } catch (e) {}
      if (media) media.getTracks().forEach(function (t) { t.stop(); });
      if (audioCtx) try { audioCtx.close(); } catch (e) {}
    },
  };
  window.EraActivity = EraActivity;
})();

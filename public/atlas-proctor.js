/* atlas-proctor.js — AquinTutor ATLAS proctoring client (Prompt 11). Privacy-preserving:
   emits only small TEXT events. Behavioural signals (focus/fullscreen/copy/paste/network) need no
   camera. Optional face-count uses the browser's native FaceDetector (Shape Detection API) if
   present — the camera stream stays LOCAL and only a number (0/1/2+) is sent as text. No video,
   audio, or image bytes ever leave the device. Advisory only. Lean for low-end Android. */
(function () {
  var API = {
    _sid: null, _q: [], _timer: null, _stream: null, _faceTimer: null, _lastFace: -1,
    push: function (type) { this._q.push({ type: type, at: Date.now() }); },
    flush: function () {
      if (!this._sid || !this._q.length) return Promise.resolve();
      var batch = this._q.splice(0, this._q.length);
      return fetch('/api/aquintutor/proctor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: this._sid, events: batch }) }).catch(function () {});
    },
    start: function (sessionId, opts) {
      opts = opts || {}; this._sid = sessionId; var self = this;
      this._onBlur = function () { self.push('focus_lost'); };
      this._onFs = function () { if (!document.fullscreenElement) self.push('fullscreen_exit'); };
      this._onCopy = function () { self.push('copy'); };
      this._onPaste = function () { self.push('paste'); };
      this._onOffline = function () { self.push('network_drop'); };
      window.addEventListener('blur', this._onBlur);
      document.addEventListener('fullscreenchange', this._onFs);
      document.addEventListener('copy', this._onCopy);
      document.addEventListener('paste', this._onPaste);
      window.addEventListener('offline', this._onOffline);
      this._timer = setInterval(function () { self.flush(); }, 5000);
      if (opts.face && 'FaceDetector' in window && navigator.mediaDevices) this._startFace();
      return this;
    },
    _startFace: function () {
      var self = this;
      navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120 }, audio: false }).then(function (stream) {
        self._stream = stream;
        var v = document.createElement('video'); v.srcObject = stream; v.muted = true; v.play();
        var det = new window.FaceDetector({ fastMode: true });
        self._faceTimer = setInterval(function () {
          if (v.readyState < 2) return;
          det.detect(v).then(function (faces) {   // faces computed LOCALLY; only the count leaves
            var n = faces.length, type = n === 0 ? 'face_absent' : n > 1 ? 'multiple_faces' : 'face_present';
            if (type !== self._lastFace) { self.push(type); self._lastFace = type; }
          }).catch(function () {});
        }, 4000);
      }).catch(function () { /* no camera / denied -> behavioural events only */ });
    },
    stop: function () {
      if (this._timer) clearInterval(this._timer);
      if (this._faceTimer) clearInterval(this._faceTimer);
      window.removeEventListener('blur', this._onBlur);
      document.removeEventListener('fullscreenchange', this._onFs);
      document.removeEventListener('copy', this._onCopy);
      document.removeEventListener('paste', this._onPaste);
      window.removeEventListener('offline', this._onOffline);
      if (this._stream) this._stream.getTracks().forEach(function (t) { t.stop(); });
      return this.flush();
    },
  };
  window.AtlasProctor = API;
})();

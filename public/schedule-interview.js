// public/schedule-interview.js v2 - Registers with ERA.FAB on /admin/applications/[id]
(function() {
  if (!window.location.pathname.match(/^\/admin\/applications\/[^/]+/)) return;
  var appId = window.location.pathname.split('/').pop();
  if (!appId || appId === 'new') return;

  function openModal() {
    var tmrw = new Date(Date.now() + 24*60*60*1000);
    tmrw.setHours(10, 0, 0, 0);
    var defaultDate = tmrw.toISOString().slice(0,16);

    var modal = document.createElement('div');
    modal.id = 'scheduleModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9996;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = '<div style="background:#0f0f14;border:1px solid #1a1a1f;border-radius:14px;max-width:480px;width:100%;max-height:90vh;overflow-y:auto;">'
      + '<div style="padding:16px 18px;border-bottom:1px solid #1a1a1f;display:flex;justify-content:space-between;align-items:center;"><h2 style="font-size:16px;font-weight:700;color:#fff;margin:0;">Schedule Interview</h2><button onclick="document.getElementById(\'scheduleModal\').remove()" style="background:#1a1a1f;border:none;color:#8a8a94;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:18px;line-height:1;">x</button></div>'
      + '<form id="schedForm" style="padding:18px;display:flex;flex-direction:column;gap:14px;">'
      + '<div><label style="display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6e6e78;margin-bottom:6px;">Round Type</label><select id="roundType" required style="width:100%;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;"><option value="screening">Screening Call</option><option value="technical">Technical Round</option><option value="culture_fit">Culture Fit</option><option value="case_study">Case Study</option><option value="final">Final Round</option><option value="reference_check">Reference Check</option><option value="custom">Custom</option></select></div>'
      + '<div><label style="display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6e6e78;margin-bottom:6px;">Title</label><input id="title" required placeholder="e.g. Technical Round with Engineering Lead" style="width:100%;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;"/></div>'
      + '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;"><div><label style="display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6e6e78;margin-bottom:6px;">Date & Time</label><input id="schedAt" type="datetime-local" required value="' + defaultDate + '" style="width:100%;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;color-scheme:dark;"/></div>'
      + '<div><label style="display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6e6e78;margin-bottom:6px;">Duration</label><select id="duration" style="width:100%;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;"><option value="30">30 min</option><option value="45">45 min</option><option value="60" selected>60 min</option><option value="90">90 min</option><option value="120">2 hours</option></select></div></div>'
      + '<div><label style="display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6e6e78;margin-bottom:6px;">Notes for candidate</label><textarea id="notes" rows="3" placeholder="Anything to prepare? Topics to expect?" style="width:100%;background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;color:#fff;font-size:13px;outline:none;resize:vertical;font-family:inherit;"></textarea></div>'
      + '<div style="background:#15151a;border:1px solid #1a1a1f;border-radius:8px;padding:10px 12px;font-size:11px;color:#8a8a94;"><p style="margin:0 0 4px;color:#FF7040;font-weight:600;">Auto-generated:</p><p style="margin:0;">Jitsi video room link will be created and shared with the candidate.</p></div>'
      + '<button type="submit" id="schedBtn" style="background:#FF4F00;border:none;color:#fff;font-size:14px;font-weight:700;padding:12px;border-radius:10px;cursor:pointer;">Schedule & Notify Candidate</button>'
      + '</form></div>';
    document.body.appendChild(modal);

    document.getElementById('schedForm').onsubmit = function(e) {
      e.preventDefault();
      var btn = document.getElementById('schedBtn');
      btn.textContent = 'Scheduling...';
      btn.disabled = true;
      var localDate = new Date(document.getElementById('schedAt').value);
      fetch('/api/interviews/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          applicationId: appId,
          roundType: document.getElementById('roundType').value,
          title: document.getElementById('title').value,
          scheduledAt: localDate.toISOString(),
          durationMins: parseInt(document.getElementById('duration').value),
          notes: document.getElementById('notes').value
        })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.ok) {
          modal.remove();
          if (window.ERA && window.ERA.toast) window.ERA.toast('Interview scheduled. Reloading...', { type: 'success' });
          setTimeout(function() { window.location.reload(); }, 1500);
        } else {
          btn.textContent = 'Error: ' + (data.error || 'try again');
          btn.disabled = false;
        }
      }).catch(function() {
        btn.textContent = 'Network error';
        btn.disabled = false;
      });
    };
  }

  function register() {
    if (!window.ERA || !window.ERA.FAB) { setTimeout(register, 100); return; }
    window.ERA.FAB.add({
      key: 'schedule-interview',
      label: 'Schedule Interview',
      color: '#10b981',
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
      onClick: openModal
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register);
  } else {
    register();
  }
})();

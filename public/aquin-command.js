/*
 * aquin-command.js — Runtime Command Engine (AES-100, Vol II, Ch 6).
 * The constitutional execution gateway. Commands express INTENT; Events record
 * completed FACT. Nothing modifies Educational Reality except a Command that has
 * passed the full pipeline:
 *
 *   Created → Validated → Authorized → Accepted → (Scheduled) → Executing →
 *   Verified → Committed → Completed → Runtime Event published
 *
 * Guarantees proven in the tests: explicit single-intent commands; authorization
 * before execution; exactly-once via idempotency key (a replayed command is not
 * re-executed); a target handler is required; failure retries then fails; and a
 * successful command emits exactly one immutable Event (command != event).
 *
 * Composes the Scheduler (Ch 3) for placement and an injectable authorize()
 * (the Interaction authority model). HONEST SCOPE: distributed exactly-once and
 * transport are declared; this is the governed command lifecycle above them.
 */
(function () {
  function createCommandEngine(cfg) {
    cfg = cfg || {};
    var scheduler = cfg.scheduler || null;
    var authorize = cfg.authorize || function () { return { ok: true }; };
    var handlers = {};                 // targetDomain -> fn(command) -> { ok, result, event? }
    var seen = {};                     // idempotencyKey -> completed result (exactly-once)
    var events = [];                   // published Runtime Events (immutable facts)
    var provenance = [];
    var seq = 0;
    function freeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { freeze(o[k]); }); Object.freeze(o); } return o; }

    var E = {
      events: events, provenance: provenance,
      registerHandler: function (domain, fn) { handlers[domain] = fn; return this; },

      submit: function (command) {
        command = command || {};
        var cid = command.id || ('cmd_' + (++seq).toString(36));
        var life = [];
        function stage(name, ok, detail) { life.push({ stage: name, ok: ok, detail: detail || null }); }
        function reject(status, reason) { provenance.push(freeze({ command: cid, type: command.type, status: status, reason: reason, life: life })); return freeze({ accepted: false, status: status, commandId: cid, reason: reason }); }

        // 1) VALIDATE — one explicit intent, with a target
        if (!command.type || !command.targetDomain) { stage('validate', false); return reject('rejected-validation', 'command needs a single type + targetDomain'); }
        stage('validate', true);

        // 2) AUTHORIZE — before any execution
        var auth = authorize(command); stage('authorize', !!auth.ok, auth.reason || '');
        if (!auth.ok) return reject('rejected-authorization', auth.reason || 'unauthorized');

        // 3) DEDUP — exactly-once for commands carrying an idempotency key
        if (command.idempotencyKey && seen[command.idempotencyKey]) { stage('dedup', true, 'duplicate'); provenance.push(freeze({ command: cid, type: command.type, status: 'duplicate-ignored', life: life })); return freeze({ accepted: true, status: 'duplicate-ignored', commandId: cid, event: seen[command.idempotencyKey].event }); }
        stage('accept', true);

        // 4) SCHEDULE (optional placement via the Runtime Scheduler)
        if (scheduler) { scheduler.submit({ id: cid, queue: command.priorityClass || 'mission', resources: command.resources || {}, submittedAt: Date.now() }); stage('schedule', true); }

        // 5) EXECUTE — the target Runtime Domain's handler
        var h = handlers[command.targetDomain];
        if (!h) { stage('execute', false); return reject('rejected-no-handler', 'no handler for "' + command.targetDomain + '"'); }
        var out; try { out = h(command) || {}; } catch (e) { out = { ok: false, reason: String(e && e.message || e) }; }

        // 6) VERIFY — retry per policy, else fail (execution != success)
        if (!out.ok) {
          var max = (command.retryPolicy && command.retryPolicy.max) || 0, attempt = 0;
          while (!out.ok && attempt < max) { attempt++; try { out = h(command) || {}; } catch (e2) { out = { ok: false }; } }
          if (!out.ok) { stage('verify', false, { retries: attempt }); return reject('failed', 'execution not verified after ' + attempt + ' retr' + (attempt === 1 ? 'y' : 'ies')); }
          stage('verify', true, { retries: attempt });
        } else stage('verify', true);

        // 7) COMMIT + publish the immutable Runtime Event (the historical fact)
        var event = freeze({ id: 'evt_' + (++seq).toString(36), type: out.event && out.event.type ? out.event.type : (command.type + 'Completed'), commandId: cid, mission: command.missionId || null, payload: (out.event && out.event.payload) || out.result || null, at: Date.now() });
        events.push(event); stage('commit', true); stage('event', true, { event: event.type });
        var result = freeze({ accepted: true, status: 'completed', commandId: cid, result: out.result || null, event: event });
        if (command.idempotencyKey) seen[command.idempotencyKey] = result;
        provenance.push(freeze({ command: cid, type: command.type, status: 'completed', life: life, event: event.id }));
        return result;
      }
    };
    return E;
  }
  window.AquinCommand = { createCommandEngine: createCommandEngine };
})();

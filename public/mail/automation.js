/* ================================================================================================
   public/mail/automation.js — the workflow canvas.

   Nodes are DOM elements (focusable, tabbable, announced); edges are one SVG layer behind them.
   Dragging a node moves it. Dragging from a port to another node draws an edge. A condition has two
   ports, YES and NO, and its NO branch is the one people forget — so the validator names it
   explicitly rather than letting the run drop silently.

   VALIDATION IS CONTINUOUS. Every structural edit posts the graph to the pure 'validate' action and
   pins each problem to its node. Publishing asks the server the same question, so what is green here
   is what goes live.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  var root = document.getElementById('auRoot');
  if (!EM || !root) return;

  var id = root.dataset.id;
  var graph = { nodes: [], edges: [] };
  var meta = { catalogue: [], triggers: [], conditionFields: [], templates: [], fields: [] };
  try { graph = JSON.parse((document.getElementById('auGraph') || {}).textContent || '{}') || graph; } catch (_) {}
  try { meta = JSON.parse((document.getElementById('auMeta') || {}).textContent || '{}') || meta; } catch (_) {}
  if (!Array.isArray(graph.nodes)) graph.nodes = [];
  if (!Array.isArray(graph.edges)) graph.edges = [];

  var nodesHost = document.getElementById('auNodes');
  var edgesSvg = document.getElementById('auEdges');
  var inspect = document.getElementById('auInspect');
  var validBadge = root.querySelector('[data-au-valid]');
  var problemsHost = document.getElementById('auProblems');
  var statusEl = document.querySelector('[data-au-status]');

  var selected = null;
  var problems = [];
  var dirty = false;

  var W = 210;
  function nodeH(n) { return n.kind === 'condition' ? 78 : 70; }

  function labelFor(kind) {
    var c = meta.catalogue.filter(function (x) { return x.kind === kind; })[0];
    return c ? c.label : kind;
  }

  /* ---- Describe a node, mirroring describeNode() on the server ------------------------------ */

  function describe(n) {
    var c = n.config || {};
    switch (n.kind) {
      case 'trigger':
        var t = meta.triggers.filter(function (x) { return x.key === c.event; })[0];
        return t ? t.label : 'Trigger not set';
      case 'condition':
        var f = meta.conditionFields.filter(function (x) { return x.key === c.field; })[0];
        return (f ? f.label : 'Field') + ' ' + (c.op === 'is_not' ? 'is not' : 'is') + ' ' + (c.value || '…');
      case 'delay': return humanise(Number(c.minutes) || 0);
      case 'send_email':
        var tpl = meta.templates.filter(function (x) { return x.id === c.templateId; })[0];
        return tpl ? tpl.name : 'Template not chosen';
      case 'add_tag': return 'Add "' + (c.tag || '…') + '"';
      case 'remove_tag': return 'Remove "' + (c.tag || '…') + '"';
      case 'update_contact': return 'Set ' + (c.key || '…') + ' to ' + (c.value || '(blank)');
      case 'webhook': return c.url || 'URL not set';
      case 'end': return 'Run finishes';
      default: return '';
    }
  }

  function humanise(m) {
    if (!isFinite(m) || m <= 0) return 'No wait';
    if (m < 60) return 'Wait ' + Math.round(m) + ' minute' + (m === 1 ? '' : 's');
    if (m < 1440) { var h = Math.round((m / 60) * 10) / 10; return 'Wait ' + h + ' hour' + (h === 1 ? '' : 's'); }
    var d = Math.round((m / 1440) * 10) / 10;
    return 'Wait ' + d + ' day' + (d === 1 ? '' : 's');
  }

  /* ---- Draw ---------------------------------------------------------------------------------- */

  function draw() {
    nodesHost.innerHTML = '';
    var problemsByNode = {};
    problems.forEach(function (p) {
      if (!p.nodeId) return;
      (problemsByNode[p.nodeId] = problemsByNode[p.nodeId] || []).push(p.message);
    });

    graph.nodes.forEach(function (n) {
      var el = document.createElement('div');
      el.className = 'au-node' + (n.id === selected ? ' on' : '') + (problemsByNode[n.id] ? ' bad' : '');
      el.dataset.auNode = n.id;
      el.dataset.kind = n.kind;
      el.style.left = (n.x || 0) + 'px';
      el.style.top = (n.y || 0) + 'px';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', labelFor(n.kind) + ': ' + describe(n) +
        (problemsByNode[n.id] ? '. Needs attention: ' + problemsByNode[n.id].join(' ') : ''));

      el.innerHTML =
        '<div class="au-node-kind">' + EM.esc(labelFor(n.kind)) + '</div>' +
        '<div class="au-node-body">' + EM.esc(describe(n)) + '</div>' +
        (problemsByNode[n.id] ? '<div class="au-node-warn">' + EM.esc(problemsByNode[n.id][0]) + '</div>' : '');

      // Ports. A condition gets two; everything except End gets one.
      if (n.kind === 'condition') {
        el.appendChild(port(n.id, 'yes', '32%'));
        el.appendChild(port(n.id, 'no', '68%'));
        el.appendChild(portLabel('YES', '22%'));
        el.appendChild(portLabel('NO', '60%'));
      } else if (n.kind !== 'end') {
        el.appendChild(port(n.id, null, '50%'));
      }

      nodesHost.appendChild(el);
    });

    drawEdges();
  }

  function port(nodeId, branch, left) {
    var p = document.createElement('div');
    p.className = 'au-port';
    p.dataset.auPort = nodeId;
    if (branch) p.dataset.branch = branch;
    p.style.left = 'calc(' + left + ' - 6px)';
    p.style.bottom = '-7px';
    p.title = branch ? 'Drag from here for the ' + branch.toUpperCase() + ' branch' : 'Drag from here to the next step';
    return p;
  }
  function portLabel(text, left) {
    var s = document.createElement('span');
    s.className = 'au-port-label';
    s.textContent = text;
    s.style.left = left;
    s.style.bottom = '-20px';
    return s;
  }

  function anchor(n, branch) {
    var x = (n.x || 0) + (branch === 'yes' ? W * 0.32 : branch === 'no' ? W * 0.68 : W / 2);
    return { x: x, y: (n.y || 0) + nodeH(n) };
  }

  function drawEdges() {
    var byId = {};
    graph.nodes.forEach(function (n) { byId[n.id] = n; });

    var parts = ['<defs>' +
      '<marker id="auArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M0 0 L10 5 L0 10 z" fill="#7C8AA0"/></marker>' +
      '</defs>'];

    graph.edges.forEach(function (e) {
      var from = byId[e.from];
      var to = byId[e.to];
      if (!from || !to) return;
      var a = anchor(from, e.branch);
      var b = { x: (to.x || 0) + W / 2, y: (to.y || 0) };
      var mid = (a.y + b.y) / 2;
      var stroke = e.branch === 'yes' ? '#0F7B4F' : e.branch === 'no' ? '#B3261E' : '#7C8AA0';
      parts.push('<path d="M' + a.x + ' ' + a.y + ' C ' + a.x + ' ' + mid + ', ' + b.x + ' ' + mid + ', ' + b.x + ' ' + b.y +
        '" fill="none" stroke="' + stroke + '" stroke-width="2" marker-end="url(#auArrow)" opacity="0.75"/>');
    });

    edgesSvg.innerHTML = parts.join('');
  }

  /* ---- Inspector -------------------------------------------------------------------------------- */

  function row(label, control, hint) {
    return '<label class="em-field"><span class="em-label">' + EM.esc(label) + '</span>' + control +
      (hint ? '<span class="em-hint">' + hint + '</span>' : '') + '</label>';
  }
  function sel(key, value, options) {
    return '<select class="em-select" data-au-set="' + key + '">' +
      options.map(function (o) {
        return '<option value="' + EM.esc(o.value) + '"' + (String(value) === String(o.value) ? ' selected' : '') + '>' + EM.esc(o.label) + '</option>';
      }).join('') + '</select>';
  }
  function txt(key, value, attrs) {
    return '<input class="em-input" data-au-set="' + key + '" value="' + EM.esc(value == null ? '' : value) + '" ' + (attrs || '') + ' />';
  }

  function renderInspector() {
    if (!selected) {
      inspect.innerHTML = '<h3>Nothing selected</h3>' +
        '<p class="em-note">Press a step on the canvas to set it up. Drag from the dot under a step to connect it to the next one.</p>';
      return;
    }
    var n = graph.nodes.filter(function (x) { return x.id === selected; })[0];
    if (!n) { selected = null; renderInspector(); return; }
    var c = n.config || {};
    var html = '<h3>' + EM.esc(labelFor(n.kind)) + '</h3>';
    var mine = problems.filter(function (p) { return p.nodeId === n.id; });
    if (mine.length) {
      html += '<div class="em-alert warn"><p>' + mine.map(function (p) { return EM.esc(p.message); }).join('<br>') + '</p></div>';
    }

    switch (n.kind) {
      case 'trigger':
        html += row('What makes a contact enter', sel('event', c.event, [{ value: '', label: 'Choose…' }].concat(
          meta.triggers.map(function (t) { return { value: t.key, label: t.label }; }))),
          'Exactly one trigger per automation — it is the only way in.');
        break;

      case 'condition':
        html += row('Test', sel('field', c.field, [{ value: '', label: 'Choose…' }].concat(
          meta.conditionFields.map(function (f) { return { value: f.key, label: f.label }; }))));
        if (c.field === 'field') html += row('Field key', txt('key', c.key, 'placeholder="application_id"'));
        html += row('Comparison', sel('op', c.op || 'is', [{ value: 'is', label: 'is' }, { value: 'is_not', label: 'is not' }]));
        html += row('Value', txt('value', c.value));
        html += '<p class="em-hint">A condition needs <strong>both</strong> branches connected. Anybody who answers no and has nowhere to go drops out of the automation silently.</p>';
        break;

      case 'delay':
        html += row('Wait for', '<input class="em-input" type="number" min="1" max="525600" data-au-set="minutes" value="' + (c.minutes || '') + '" />',
          'In minutes. 60 = an hour, 1440 = a day, 10080 = a week. Measured from the moment the contact reaches this step.');
        html += '<div class="em-row tight">' +
          [['1 hour', 60], ['1 day', 1440], ['3 days', 4320], ['1 week', 10080]].map(function (p) {
            return '<button type="button" class="em-btn sm" data-au-preset="' + p[1] + '">' + p[0] + '</button>';
          }).join('') + '</div>';
        break;

      case 'send_email':
        html += row('Template', sel('templateId', c.templateId, [{ value: '', label: 'Choose…' }].concat(
          meta.templates.map(function (t) { return { value: t.id, label: t.name + ' — ' + t.subject }; }))),
          meta.templates.length ? 'Only active templates are listed.' :
            'No active templates. Create one on <a href="/mail/templates">Templates</a> first.');
        break;

      case 'add_tag':
      case 'remove_tag':
        html += row('Tag', txt('tag', c.tag, 'placeholder="stage-3"'));
        break;

      case 'update_contact':
        html += row('Field', sel('key', c.key, [{ value: '', label: 'Choose…' }].concat(
          meta.fields.map(function (f) { return { value: f.key, label: f.label }; }))),
          meta.fields.length ? '' : 'No custom fields declared yet. Add one on <a href="/mail/contacts/lists">Lists &amp; segments</a>.');
        html += row('Set to', txt('value', c.value));
        break;

      case 'webhook':
        html += row('URL', txt('url', c.url, 'placeholder="https://…"'),
          'Must be https. The contact and the run context are POSTed as JSON.');
        break;

      case 'end':
        html += '<p class="em-note">Nothing to configure. The run finishes here.</p>';
        break;
    }

    if (n.kind !== 'trigger') {
      html += '<div style="border-top:1px solid var(--em-line);margin-top:16px;padding-top:14px">' +
        '<button type="button" class="em-btn danger wide" data-au-del>Delete this step</button></div>';
    }
    inspect.innerHTML = html;
  }

  /* ---- Editing ----------------------------------------------------------------------------------- */

  inspect.addEventListener('input', handleSet);
  inspect.addEventListener('change', handleSet);
  function handleSet(e) {
    var el = e.target.closest('[data-au-set]');
    if (!el || !selected) return;
    var n = graph.nodes.filter(function (x) { return x.id === selected; })[0];
    if (!n) return;
    n.config = n.config || {};
    var v = el.type === 'number' ? Number(el.value) : el.value;
    n.config[el.dataset.auSet] = v;
    // A condition whose field changed keeps a value that no longer means anything; clearing it is
    // less confusing than leaving a stale one that silently never matches.
    if (el.dataset.auSet === 'field') n.config.value = '';
    touched();
  }

  inspect.addEventListener('click', function (e) {
    var preset = e.target.closest('[data-au-preset]');
    if (preset && selected) {
      var n = graph.nodes.filter(function (x) { return x.id === selected; })[0];
      if (n) { n.config = n.config || {}; n.config.minutes = Number(preset.dataset.auPreset); touched(); renderInspector(); }
      return;
    }
    if (e.target.closest('[data-au-del]') && selected) {
      var id2 = selected;
      EM.confirm({
        title: 'Delete this step?',
        body: 'It is removed along with every connection into and out of it. Contacts currently waiting at this step will stop there.',
        confirmLabel: 'Delete step',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        graph.nodes = graph.nodes.filter(function (x) { return x.id !== id2; });
        graph.edges = graph.edges.filter(function (x) { return x.from !== id2 && x.to !== id2; });
        selected = null;
        touched();
        renderInspector();
      });
    }
  });

  /* ---- Adding ------------------------------------------------------------------------------------ */

  var seq = 0;
  function newId() { seq++; return 'n' + Date.now().toString(36) + seq.toString(36); }

  root.addEventListener('click', function (e) {
    var add = e.target.closest('[data-au-add]');
    if (!add) return;
    // Placed below the lowest node, so a new step is visible rather than stacked at the origin.
    var lowest = graph.nodes.reduce(function (a, n) { return Math.max(a, n.y || 0); }, 0);
    var n = { id: newId(), kind: add.dataset.auAdd, x: 60, y: lowest + 130, config: {} };
    graph.nodes.push(n);
    selected = n.id;
    touched();
    renderInspector();
    document.getElementById('auCanvas').scrollTop = n.y - 100;
  });

  /* ---- Dragging nodes and drawing edges ------------------------------------------------------------ */

  var dragNode = null;
  var dragOffset = { x: 0, y: 0 };
  var linkFrom = null;

  nodesHost.addEventListener('mousedown', function (e) {
    var portEl = e.target.closest('[data-au-port]');
    if (portEl) {
      e.preventDefault();
      linkFrom = { id: portEl.dataset.auPort, branch: portEl.dataset.branch || undefined };
      return;
    }
    var nodeEl = e.target.closest('[data-au-node]');
    if (!nodeEl) return;
    var n = graph.nodes.filter(function (x) { return x.id === nodeEl.dataset.auNode; })[0];
    if (!n) return;
    selected = n.id;
    draw();
    renderInspector();
    dragNode = n;
    dragOffset = { x: e.clientX - nodeEl.getBoundingClientRect().left, y: e.clientY - nodeEl.getBoundingClientRect().top };
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragNode) return;
    var box = nodesHost.getBoundingClientRect();
    dragNode.x = Math.max(0, Math.round(e.clientX - box.left - dragOffset.x));
    dragNode.y = Math.max(0, Math.round(e.clientY - box.top - dragOffset.y));
    // Only the geometry moved: redraw without re-validating, which would be a request per pixel.
    draw();
  });

  document.addEventListener('mouseup', function (e) {
    if (dragNode) { dragNode = null; markDirty(); scheduleSave(); return; }
    if (!linkFrom) return;
    var target = e.target.closest('[data-au-node]');
    linkFrom = (function (from) {
      if (target && target.dataset.auNode !== from.id) {
        var to = target.dataset.auNode;
        // One edge per (from, branch). Reconnecting replaces rather than adding a second, because a
        // step with two "next" edges is ambiguous and the validator would only tell you afterwards.
        graph.edges = graph.edges.filter(function (x) { return !(x.from === from.id && x.branch === from.branch); });
        graph.edges.push({ from: from.id, to: to, branch: from.branch });
        touched();
      }
      return null;
    })(linkFrom);
  });

  /* ---- Keyboard --------------------------------------------------------------------------------- */

  nodesHost.addEventListener('keydown', function (e) {
    var nodeEl = e.target.closest('[data-au-node]');
    if (!nodeEl) return;
    var n = graph.nodes.filter(function (x) { return x.id === nodeEl.dataset.auNode; })[0];
    if (!n) return;

    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = n.id; draw(); renderInspector(); return; }
    // Arrow keys move a node, so the canvas is usable without a mouse.
    var step = e.shiftKey ? 40 : 10;
    var moved = true;
    if (e.key === 'ArrowUp') n.y = Math.max(0, (n.y || 0) - step);
    else if (e.key === 'ArrowDown') n.y = (n.y || 0) + step;
    else if (e.key === 'ArrowLeft') n.x = Math.max(0, (n.x || 0) - step);
    else if (e.key === 'ArrowRight') n.x = (n.x || 0) + step;
    else moved = false;
    if (moved) { e.preventDefault(); draw(); markDirty(); scheduleSave(); }
  });

  /* ---- Tidy ------------------------------------------------------------------------------------- */

  root.addEventListener('click', function (e) {
    if (!e.target.closest('[data-au-tidy]')) return;
    // Breadth-first from the trigger: depth becomes the row, position within the row the column.
    var byId = {};
    graph.nodes.forEach(function (n) { byId[n.id] = n; });
    var out = {};
    graph.edges.forEach(function (ed) { (out[ed.from] = out[ed.from] || []).push(ed.to); });
    var trigger = graph.nodes.filter(function (n) { return n.kind === 'trigger'; })[0];
    if (!trigger) { EM.toast('There is no trigger to lay out from.', 'bad'); return; }

    var depth = {}; depth[trigger.id] = 0;
    var queue = [trigger.id];
    var seen = {}; seen[trigger.id] = true;
    while (queue.length) {
      var cur = queue.shift();
      (out[cur] || []).forEach(function (next) {
        if (seen[next]) return;
        seen[next] = true;
        depth[next] = depth[cur] + 1;
        queue.push(next);
      });
    }
    var rows = {};
    graph.nodes.forEach(function (n) {
      var d = depth[n.id] == null ? 99 : depth[n.id];
      (rows[d] = rows[d] || []).push(n);
    });
    Object.keys(rows).forEach(function (d) {
      rows[d].forEach(function (n, i) {
        n.x = 60 + i * 260;
        n.y = 40 + Number(d) * 130;
      });
    });
    draw();
    markDirty();
    scheduleSave();
    EM.toast('Laid out top to bottom. Anything unreachable is at the bottom.', 'ok');
  });

  /* ---- Validation + save --------------------------------------------------------------------------- */

  function markDirty() { dirty = true; if (statusEl) { statusEl.textContent = 'Unsaved changes'; statusEl.style.color = 'var(--em-warn)'; } }

  function touched() { markDirty(); draw(); validate(); scheduleSave(); }

  var validate = EM.debounce(function () {
    EM.api('/api/mail/product/automations', { body: { action: 'validate', graph: graph } }).then(function (res) {
      if (!res.ok) return;
      problems = res.validation.problems || [];
      paintValidation(res.validation.ok);
      draw();
      renderInspector();
    });
  }, 300);

  function paintValidation(ok) {
    if (validBadge) {
      validBadge.textContent = ok ? 'Ready to switch on' : problems.length + ' to fix';
      validBadge.className = 'em-badge ' + (ok ? 'ok' : 'warn');
    }
    if (!problemsHost) return;
    problemsHost.hidden = ok;
    problemsHost.innerHTML = problems.map(function (p) {
      return '<p class="au-problem" data-au-jump="' + EM.esc(p.nodeId || '') + '">' +
        '<span>&#9888;</span><span>' + EM.esc(p.message) + '</span></p>';
    }).join('');
  }

  root.addEventListener('click', function (e) {
    var jump = e.target.closest('[data-au-jump]');
    if (!jump || !jump.dataset.auJump) return;
    selected = jump.dataset.auJump;
    draw();
    renderInspector();
    var el = nodesHost.querySelector('[data-au-node="' + selected + '"]');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { save(false); }, 1500);
  }

  function save(explicit) {
    var nameEl = document.getElementById('auName');
    return EM.api('/api/mail/product/automations', {
      body: { action: 'save', id: id, graph: graph, name: nameEl ? nameEl.value : undefined },
    }).then(function (res) {
      if (res.ok) {
        dirty = false;
        if (statusEl) { statusEl.textContent = 'Saved ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); statusEl.style.color = ''; }
        if (explicit) EM.toast('Saved.', 'ok');
      } else {
        if (statusEl) { statusEl.textContent = 'NOT saved — your graph is still on screen.'; statusEl.style.color = 'var(--em-bad)'; }
        if (explicit) EM.toast(res.error || 'This was NOT saved.', 'bad', 10000);
      }
      return res;
    });
  }

  root.addEventListener('click', function (e) {
    if (e.target.closest('[data-au-save]')) {
      var b = e.target.closest('[data-au-save]');
      clearTimeout(saveTimer);
      EM.busy(b, true, 'Saving');
      save(true).then(function () { EM.busy(b, false); });
    }
  });

  var nameInput = document.getElementById('auName');
  if (nameInput) nameInput.addEventListener('input', function () { markDirty(); scheduleSave(); });

  document.addEventListener('click', function (e) {
    var act = e.target.closest('[data-a-act]');
    if (!act) return;
    var action = act.dataset.aAct;

    var go = action === 'activate'
      ? EM.confirm({
          title: 'Switch this automation on?',
          body: 'From now on, every contact that matches the trigger enters and runs through it — including sending the emails in it. It is checked first, and refused if anything is unsound.',
          confirmLabel: 'Switch on',
        })
      : Promise.resolve(true);

    go.then(function (yes) {
      if (!yes) return;
      EM.busy(act, true);
      clearTimeout(saveTimer);
      save(false).then(function () {
        EM.api('/api/mail/product/automations', { body: { action: action, id: id, graph: graph } })
          .then(function (res) {
            EM.busy(act, false);
            if (!res.ok) {
              problems = res.problems || [];
              paintValidation(false);
              draw();
              EM.toast(res.error || 'That did not go through.', 'bad', 14000);
              return;
            }
            EM.toast(res.note || 'Done.', 'ok', 7000);
            setTimeout(function () { location.reload(); }, 1200);
          });
      });
    });
  });

  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- Boot -------------------------------------------------------------------------------------- */

  draw();
  renderInspector();
  validate();
})();

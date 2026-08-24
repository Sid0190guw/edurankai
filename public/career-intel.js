/* public/career-intel.js — the browser half of Career Intelligence.
 *
 * ==================================================================================================
 * WHAT THIS IS ALLOWED TO DO, AND WHAT IT IS NOT
 * ==================================================================================================
 *
 * It is an ENHANCEMENT. The page it runs on is a complete, server-rendered careers page before this
 * file loads: a search form that GETs to /careers/opportunities, a team directory, the featured
 * openings, and every static section. Everything below adds the conversation and the personalised
 * ranking on top of that. If this file fails to load, is blocked, or throws, the page it leaves
 * behind still lets somebody find and apply for a job. That is section 31 of the brief, honoured by
 * construction rather than by a try/catch.
 *
 * NO FRAMEWORK, NO BUILD STEP, NO DEPENDENCY. Plain ES5-compatible DOM code, served static, cached
 * by the CDN. The whole file is a few kilobytes and it is the only script this page adds.
 *
 * ==================================================================================================
 * THE PROFILE LIVES HERE, NOT ON THE SERVER
 * ==================================================================================================
 *
 * Everything the person tells us is held in this browser (localStorage) and posted to the ranking
 * endpoint with each request. Nothing about an anonymous visitor is written to a database. The
 * "Forget everything" control is therefore a real delete — one key removed from this browser — and
 * not a request to a server to please stop remembering.
 *
 * localStorage can throw (private windows, blocked site data), so every read and write is wrapped
 * and the page works with none of it: the profile simply lives for the length of the visit.
 */
(function () {
  'use strict';

  var KEY = 'era.career.profile.v1';
  var SESSION_KEY = 'era.career.session.v1';
  var API = '/api/careers/intel/';

  var root = document.getElementById('ci-root');
  if (!root) return;

  var boot = {};
  try {
    var bootEl = document.getElementById('ci-boot');
    if (bootEl) boot = JSON.parse(bootEl.textContent || '{}');
  } catch (e) { boot = {}; }

  /* ------------------------------------------------------------------ storage, defensively */

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function save(p) {
    try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* private window */ }
  }
  function clear() {
    try { window.localStorage.removeItem(KEY); window.localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function sessionKey() {
    try {
      var k = window.localStorage.getItem(SESSION_KEY);
      if (!k) {
        k = (Math.random().toString(36) + Math.random().toString(36)).slice(2, 18);
        window.localStorage.setItem(SESSION_KEY, k);
      }
      return k;
    } catch (e) { return null; }
  }

  var state = {
    profile: load(),
    busy: false,
    matches: null,
    offset: 0,
    lastQuestion: null,
    understood: null,
    panelOpen: false,
    // A domain the person pressed on the career map. Their choice, so it may narrow the results —
    // and it is cleared by pressing the same node again, or the button that says so.
    domain: null,
  };

  /* ------------------------------------------------------------------------------ elements */

  var els = {
    form: document.getElementById('ci-form'),
    input: document.getElementById('ci-input'),
    submit: document.getElementById('ci-submit'),
    thread: document.getElementById('ci-thread'),
    results: document.getElementById('ci-results'),
    panel: document.getElementById('ci-panel'),
    panelBody: document.getElementById('ci-panel-body'),
    panelToggle: document.getElementById('ci-panel-toggle'),
    status: document.getElementById('ci-status'),
    intro: document.getElementById('ci-intro'),
    map: document.getElementById('ci-map'),
  };
  if (!els.form || !els.input || !els.thread || !els.results) return;

  // The form no longer needs to navigate: this script can answer in place. Its no-JS action is left
  // on the element so that view-source and a failed load both still describe a working page.
  els.form.setAttribute('data-enhanced', '1');

  /* ------------------------------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function say(msg, tone) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.className = 'ci-status' + (tone ? ' is-' + tone : '');
  }

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    });
  }

  function busy(on) {
    state.busy = on;
    if (els.submit) {
      els.submit.disabled = on;
      els.submit.setAttribute('aria-busy', on ? 'true' : 'false');
    }
    root.setAttribute('data-busy', on ? '1' : '0');
  }

  /* -------------------------------------------------------------- rendering: the conversation */

  function renderThread() {
    els.thread.innerHTML = '';
    if (state.understood && state.understood.length) renderUnderstood();
    if (state.lastQuestion) renderQuestion(state.lastQuestion);
    if (state.offerResume) renderResumeOffer();
  }

  /* "Here is what I understood" — shown BEFORE anything is treated as settled, with a way to
   * disagree. This block is the whole of section 7 and it is not skippable by any code path that
   * produces an interpretation. */
  function renderUnderstood() {
    var box = el('div', 'ci-card ci-understood');
    box.appendChild(el('p', 'ci-eyebrow', 'Here is what I understood'));
    var ul = el('ul', 'ci-list');
    state.understood.forEach(function (line) { ul.appendChild(el('li', null, line)); });
    box.appendChild(ul);

    var row = el('div', 'ci-actions');
    var yes = el('button', 'ci-btn ci-btn-primary', "Yes, that's right");
    yes.type = 'button';
    yes.addEventListener('click', function () {
      confirmAll('confirm');
      state.understood = null;
      // A REFRESH, NOT JUST A RE-RENDER. Confirming raises the confidence on every signal it
      // touched, which changes what the next question is worth asking and how the openings rank.
      // Re-drawing the thread from the old response would show none of that until the next answer.
      send({ action: 'state' });
      say('Noted.', 'ok');
    });

    var adjust = el('button', 'ci-btn', 'Adjust this');
    adjust.type = 'button';
    adjust.addEventListener('click', function () { openPanel(); });

    var again = el('button', 'ci-btn', 'Let me explain differently');
    again.type = 'button';
    again.addEventListener('click', function () {
      state.understood = null;
      renderThread();
      els.input.value = '';
      els.input.focus();
      say('Go ahead — say it however you like.');
    });

    row.appendChild(yes);
    row.appendChild(adjust);
    row.appendChild(again);
    box.appendChild(row);
    els.thread.appendChild(box);
  }

  /* Every question renders its options AND a free-text box AND a skip. All three, always. */
  function renderQuestion(q) {
    var box = el('div', 'ci-card ci-question');

    var head = el('div', 'ci-q-head');
    head.appendChild(el('h3', 'ci-q-prompt', q.prompt));
    if (q.optional) head.appendChild(el('span', 'ci-chip ci-chip-quiet', 'Optional'));
    box.appendChild(head);

    // Why am I being asked this? Rendered, not hidden behind a tooltip.
    box.appendChild(el('p', 'ci-q-why', q.whyAsked));

    var picked = {};
    var opts = el('div', 'ci-options');
    (q.options || []).forEach(function (o) {
      var b = el('button', 'ci-opt', o.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        if (o.freeText) {
          var ta = box.querySelector('.ci-q-text');
          if (ta) ta.focus();
          return;
        }
        if (!q.multi) {
          Object.keys(picked).forEach(function (k) { delete picked[k]; });
          opts.querySelectorAll('.ci-opt').forEach(function (x) {
            x.setAttribute('aria-pressed', 'false');
            x.classList.remove('is-on');
          });
        }
        if (picked[o.id]) { delete picked[o.id]; b.setAttribute('aria-pressed', 'false'); b.classList.remove('is-on'); }
        else { picked[o.id] = true; b.setAttribute('aria-pressed', 'true'); b.classList.add('is-on'); }
      });
      opts.appendChild(b);
    });
    box.appendChild(opts);

    var ta = el('textarea', 'ci-q-text');
    ta.rows = 2;
    ta.placeholder = q.placeholder || 'Or say it in your own words...';
    ta.setAttribute('aria-label', q.prompt + ' — your own words');
    box.appendChild(ta);

    var row = el('div', 'ci-actions');
    // NOT named `send`: that shadows the module-level send() inside this function, and the day
    // somebody adds a direct send() call in here it would be calling a button element.
    var go = el('button', 'ci-btn ci-btn-primary', 'Continue');
    go.type = 'button';
    go.addEventListener('click', function () {
      var sel = Object.keys(picked);
      if (!sel.length && !ta.value.trim()) { say('Pick something, or write anything at all.', 'warn'); ta.focus(); return; }
      answer(q.id, sel, ta.value);
    });

    var skip = el('button', 'ci-btn ci-btn-quiet', 'Skip this');
    skip.type = 'button';
    skip.addEventListener('click', function () { skipQuestion(q.id); });

    var enough = el('button', 'ci-btn ci-btn-quiet', 'Stop asking, show me roles');
    enough.type = 'button';
    enough.addEventListener('click', function () {
      state.lastQuestion = null;
      renderThread();
      loadMatches(0);
    });

    row.appendChild(go);
    row.appendChild(skip);
    row.appendChild(enough);
    box.appendChild(row);

    // WHAT HAPPENS IF YOU SKIP, SAID OUT LOUD. One of the five questions the brief says a person
    // should never have to guess the answer to, and the only one a button label cannot carry.
    box.appendChild(el('p', 'ci-q-why',
      'Skipping is fine. We will not ask again, and it does not limit anything you can see.'));

    els.thread.appendChild(box);
  }

  /* The CV offer. An OFFER: three of its four buttons carry on without one. */
  function renderResumeOffer() {
    var box = el('div', 'ci-card ci-offer');
    box.appendChild(el('p', 'ci-eyebrow', 'Want these sharper?'));
    box.appendChild(el('p', 'ci-offer-text',
      'We can already show you relevant openings. If you want the ranking to be more accurate, any of these help — all of them optional.'));
    var row = el('div', 'ci-actions');

    var carryOn = el('button', 'ci-btn ci-btn-primary', 'Carry on exploring');
    carryOn.type = 'button';
    carryOn.addEventListener('click', function () { state.offerResume = false; renderThread(); });

    var tell = el('button', 'ci-btn', 'Tell you more about my background');
    tell.type = 'button';
    tell.addEventListener('click', function () {
      state.offerResume = false;
      renderThread();
      els.input.focus();
      say('Tell us about what you have done — projects, subjects, tools, anything.');
    });

    var cv = el('a', 'ci-btn', 'Take my CV into account');
    cv.href = '/careers/opportunities';
    cv.addEventListener('click', function (ev) {
      ev.preventDefault();
      state.offerResume = false;
      renderThread();
      els.input.focus();
      // HONEST ABOUT WHAT WE DO AND DO NOT DO. There is no CV parser on this page and pretending
      // otherwise would be the one fiction this whole feature is built to avoid. Paste is real, an
      // upload promise would not be.
      say('Paste the relevant parts of your CV into the box and we will read them. Nothing is uploaded and nothing is stored on our servers.');
    });

    row.appendChild(carryOn);
    row.appendChild(tell);
    row.appendChild(cv);
    box.appendChild(row);
    els.thread.appendChild(box);
  }

  /* ------------------------------------------------------------------- rendering: the results */

  var TIER_TONE = { strong: 'strong', potential: 'potential', adjacent: 'adjacent', explore: 'explore' };

  function renderResults(data, append) {
    if (!append) els.results.innerHTML = '';

    if (!data.readable) {
      // NOT "no roles match". The catalogue could not be read, and the page says which.
      var err = el('div', 'ci-card ci-note ci-note-warn');
      err.appendChild(el('p', null, 'We could not read the catalogue just now. Every opening is still browsable:'));
      var a = el('a', 'ci-btn ci-btn-primary', 'Browse all opportunities');
      a.href = '/careers/opportunities';
      err.appendChild(a);
      els.results.appendChild(err);
      return;
    }

    if (!append) {
      var head = el('div', 'ci-results-head');
      var count = el('p', 'ci-count');
      count.appendChild(el('strong', null, String(data.total)));
      // TWO NUMBERS, NEVER ONE STANDING IN FOR THE OTHER. `total` is how many matched; the
      // catalogue total is how many are open. Letting one be printed as the other is exactly what
      // made the old page report its own fetch cap as the size of the catalogue. And -1 is not a
      // count: openPostingCount returns it when the count FAILED, so the phrase is dropped rather
      // than rendered as "of  open positions".
      var tail = (data.total === 1 ? ' opening' : ' openings');
      if (data.catalogueTotal > 0) tail += ' of ' + data.catalogueTotal + ' open';
      if (data.personalised) tail += ', ranked for what you told us';
      count.appendChild(document.createTextNode(tail));
      head.appendChild(count);
      els.results.appendChild(head);

      if (data.notPersonalisedNote) {
        els.results.appendChild(note(data.notPersonalisedNote, 'quiet'));
      }
      if (data.widened) {
        els.results.appendChild(note(
          'Nothing matched our reading of what you said, so this is the whole catalogue instead. '
          + 'That is our reading being too narrow, not a shortage of openings.', 'warn'));
      }
      if (data.degraded) {
        els.results.appendChild(note(
          'Discipline and classification filters could not be applied on this request, so these results are wider than what you asked for.', 'warn'));
      }
      if (data.lookedIn && (data.lookedIn.disciplines.length || data.lookedIn.terms.length)) {
        var looked = data.lookedIn.disciplines.concat(data.lookedIn.terms).join(', ');
        els.results.appendChild(note('We looked in: ' + looked + '.', 'quiet'));
      }
    }

    // APPEND INTO THE EXISTING GROUP, DO NOT ADD A SECOND ONE WITH THE SAME HEADING. Rendering a
    // fresh section per response gave two "Strong alignment" headings after Show more, which reads
    // as two different things rather than more of one.
    if (!append) renderMap(data.map, data.mapBands, data.focusedDomain);

    (data.groups || []).forEach(function (g) {
      var existing = els.results.querySelector('[data-tier="' + g.tier + '"] .ci-cards');
      if (append && existing) {
        g.matches.forEach(function (m) { existing.appendChild(renderCard(m, g.tier)); });
        return;
      }
      els.results.appendChild(renderGroup(g));
    });

    var more = els.results.querySelector('.ci-more');
    if (more) more.remove();
    if (data.hasMore) {
      var btn = el('button', 'ci-btn ci-more', 'Show more openings');
      btn.type = 'button';
      btn.addEventListener('click', function () { loadMatches(data.nextOffset, true); });
      els.results.appendChild(btn);
    } else if (data.total > 0) {
      els.results.appendChild(note('That is all ' + data.total + ' of them.', 'quiet'));
    }
  }

  /* ------------------------------------------------------------ rendering: the career map
   *
   * A LIST WITH HEADINGS. There is no canvas, no force layout and no animation — the brief asks for
   * lightweight, keyboard navigable and understandable without motion, and headed lists of buttons
   * are all three without needing an accessible alternative bolted on beside them.
   *
   * Each node narrows the results to that domain, which is a real server-side query, and the
   * narrowing is undone by one clearly-labelled button that is always present while it is active.
   */
  function renderMap(map, bands, focused) {
    if (!els.map) return;
    els.map.innerHTML = '';
    if (!map || !map.nodes || !map.nodes.length || !map.meaningful) {
      els.map.hidden = true;
      return;
    }
    els.map.hidden = false;
    els.map.appendChild(el('h2', 'ci-map-title', 'Your career map'));
    els.map.appendChild(el('p', 'ci-map-caption', map.caption));

    (bands || []).forEach(function (band) {
      var nodes = map.nodes.filter(function (n) { return n.band === band.key; });
      if (!nodes.length) return;
      var sec = el('div', 'ci-map-band');
      sec.appendChild(el('p', 'ci-map-band-h', band.label));
      sec.appendChild(el('p', 'ci-map-band-note', band.note));
      var ul = el('ul', 'ci-map-nodes');
      nodes.forEach(function (n) {
        var li = el('li');
        // An anchor, so it works without this script and opens in a new tab if somebody wants it —
        // and intercepted here so a click narrows the results in place instead of navigating away.
        var a = el('a', 'ci-map-node');
        a.href = n.href;
        a.setAttribute('data-band', n.band);
        if (focused && focused.key === n.key) {
          a.classList.add('is-on');
          a.setAttribute('aria-current', 'true');
        }
        a.appendChild(el('span', 'ci-map-node-label', n.label));
        a.appendChild(el('span', 'ci-map-node-why', n.because));
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          state.domain = (focused && focused.key === n.key) ? null : n.key;
          loadMatches(0);
        });
        li.appendChild(a);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      els.map.appendChild(sec);
    });

    if (focused) {
      var clear = el('button', 'ci-btn ci-btn-quiet ci-map-clear', 'Showing ' + focused.label + ' only — show everything again');
      clear.type = 'button';
      clear.addEventListener('click', function () { state.domain = null; loadMatches(0); });
      els.map.appendChild(clear);
    }
  }

  function note(text, tone) {
    var n = el('p', 'ci-note ci-note-' + (tone || 'quiet'), text);
    return n;
  }

  function renderGroup(g) {
    var sec = el('section', 'ci-group');
    sec.setAttribute('data-tier', g.tier);
    var h = el('h3', 'ci-group-title', g.label);
    sec.appendChild(h);
    sec.appendChild(el('p', 'ci-group-meaning', g.meaning));
    var list = el('div', 'ci-cards');
    g.matches.forEach(function (m) { list.appendChild(renderCard(m, g.tier)); });
    sec.appendChild(list);
    return sec;
  }

  function renderCard(m, tier) {
    var c = m.card;
    var e = m.explanation;
    var art = el('article', 'ci-role ci-role-' + (TIER_TONE[tier] || 'explore'));

    var a = el('a', 'ci-role-title', c.title);
    a.href = c.href;
    art.appendChild(a);

    var meta = el('p', 'ci-role-meta');
    var bits = [c.level, c.engagementType, c.location];
    if (c.department) bits.splice(1, 0, c.department);
    meta.textContent = bits.filter(Boolean).join(' · ');
    art.appendChild(meta);

    art.appendChild(el('p', 'ci-role-fn', c.functionText));

    if (e.headline) art.appendChild(el('p', 'ci-role-why', e.headline));

    // "Why this opportunity" in full, folded. Every line in it came from a contribution that moved
    // the ranking — see src/lib/career-intel/explain.ts.
    if (e.aligned.length || e.needMoreInfo.length || e.couldDevelop.length || e.demotedBecause.length) {
      var det = el('details', 'ci-why');
      var sum = el('summary', null, 'Why this opportunity?');
      det.appendChild(sum);
      if (e.aligned.length) {
        det.appendChild(el('p', 'ci-why-h', 'What lines up'));
        var ul = el('ul', 'ci-list');
        e.aligned.forEach(function (x) {
          var li = el('li');
          li.appendChild(el('span', 'ci-why-signal', x.signal));
          li.appendChild(document.createTextNode(' — ' + x.matched));
          ul.appendChild(li);
        });
        det.appendChild(ul);
      }
      if (e.nothingMatched) det.appendChild(el('p', 'ci-why-none', boot.matchedNothing || 'Nothing you have told us so far lines up with this one. It is here so the list is not narrower than you are.'));
      if (e.needMoreInfo.length) {
        det.appendChild(el('p', 'ci-why-h', 'What we could not check'));
        var ul2 = el('ul', 'ci-list');
        e.needMoreInfo.forEach(function (x) { ul2.appendChild(el('li', null, x)); });
        det.appendChild(ul2);
      }
      if (e.couldDevelop.length) {
        det.appendChild(el('p', 'ci-why-h', 'What could strengthen your alignment'));
        det.appendChild(el('p', 'ci-why-note', e.couldDevelop.join(' · ')));
        // THE CAVEAT COMES WITH THE DATA. Typing a copy of it here is how the two drift and how a
        // gap list eventually appears on a screen without the sentence that makes it honest.
        det.appendChild(el('p', 'ci-why-note ci-why-caveat', e.couldDevelopNote || ''));
      }
      if (e.demotedBecause.length) {
        det.appendChild(el('p', 'ci-why-h', 'Why it is lower down'));
        e.demotedBecause.forEach(function (x) { det.appendChild(el('p', 'ci-why-note', x)); });
      }
      art.appendChild(det);
    }

    var actions = el('div', 'ci-role-actions');
    var open = el('a', 'ci-btn ci-btn-primary', 'Read the full posting');
    open.href = c.href;
    open.addEventListener('click', function () { feedback(c.id, 'opened', tier, null); });
    actions.appendChild(open);

    var no = el('button', 'ci-btn ci-btn-quiet', 'Not for me');
    no.type = 'button';
    no.addEventListener('click', function () {
      feedback(c.id, 'not_interested', tier, null);
      art.classList.add('is-dismissed');
      art.setAttribute('aria-hidden', 'false');
      var undo = el('button', 'ci-btn ci-btn-quiet', 'Undo');
      undo.type = 'button';
      undo.addEventListener('click', function () { art.classList.remove('is-dismissed'); undo.remove(); });
      actions.appendChild(undo);
    });
    actions.appendChild(no);

    art.appendChild(actions);
    return art;
  }

  /* ---------------------------------------------------------- rendering: what we understand */

  function renderPanel(u) {
    if (!els.panelBody) return;
    els.panelBody.innerHTML = '';
    if (!u) return;

    var any = false;

    function section(title, items, onRemove) {
      if (!items || !items.length) return;
      any = true;
      els.panelBody.appendChild(el('p', 'ci-panel-h', title));
      var wrap = el('div', 'ci-tags');
      items.forEach(function (t) {
        var tag = el('span', 'ci-tag');
        tag.appendChild(document.createTextNode(t.label));
        if (onRemove) {
          var x = el('button', 'ci-tag-x', '×');
          x.type = 'button';
          x.setAttribute('aria-label', 'Remove ' + t.label);
          x.addEventListener('click', function () { onRemove(t); });
          tag.appendChild(x);
        }
        wrap.appendChild(tag);
      });
      els.panelBody.appendChild(wrap);
    }

    section('Interests', u.interests, function (t) { correct('interests', t.key, 'reject'); });
    section('Things you have worked with', u.skills, function (t) { correct('skills', t.key, 'reject'); });
    section('Not for you', u.avoid, function (t) { correct('avoid', t.key, 'reject'); });

    if (u.stage && u.stage !== 'unknown') {
      any = true;
      els.panelBody.appendChild(el('p', 'ci-panel-h', 'Career stage'));
      els.panelBody.appendChild(el('p', 'ci-panel-line', u.stage));
    }

    var used = (u.dimensions || []).filter(function (d) { return d.usedForMatching; });
    var only = (u.dimensions || []).filter(function (d) { return !d.usedForMatching; });

    if (used.length) {
      any = true;
      els.panelBody.appendChild(el('p', 'ci-panel-h', 'How you said you like to work'));
      used.forEach(function (d) { els.panelBody.appendChild(dimRow(d)); });
    }
    if (only.length) {
      any = true;
      els.panelBody.appendChild(el('p', 'ci-panel-h', 'For your own picture only'));
      els.panelBody.appendChild(el('p', 'ci-panel-note',
        'These are not used to decide which openings you are shown, or in what order.'));
      only.forEach(function (d) { els.panelBody.appendChild(dimRow(d)); });
    }

    if (u.contexts && u.contexts.length) {
      any = true;
      els.panelBody.appendChild(el('p', 'ci-panel-h', 'Where it depends'));
      u.contexts.forEach(function (c) {
        els.panelBody.appendChild(el('p', 'ci-panel-line', c.label + ': “' + c.quote + '”'));
      });
    }

    if (u.responses && u.responses.length) {
      any = true;
      els.panelBody.appendChild(el('p', 'ci-panel-h', 'Your own words'));
      els.panelBody.appendChild(el('p', 'ci-panel-note',
        'Kept exactly as you typed them, separately from our reading of them. Remove any of them and we forget what we read out of it.'));
      u.responses.forEach(function (r) {
        if (!r.text) return;
        var row = el('div', 'ci-panel-quote');
        row.appendChild(el('span', null, r.text));
        var x = el('button', 'ci-tag-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove this answer');
        x.addEventListener('click', function () { removeResponse(r.id); });
        row.appendChild(x);
        els.panelBody.appendChild(row);
      });
    }

    if (u.reflection) {
      els.panelBody.appendChild(el('p', 'ci-panel-h', u.reflection.label + ' — optional reflection'));
      els.panelBody.appendChild(el('p', 'ci-panel-line', u.reflection.prompt));
      els.panelBody.appendChild(el('p', 'ci-panel-note', u.reflectionDisclaimer));
      var forget = el('button', 'ci-btn ci-btn-quiet', 'Remove this');
      forget.type = 'button';
      forget.addEventListener('click', function () { send({ action: 'forget-reflection' }); });
      els.panelBody.appendChild(forget);
    }

    if (!any) {
      els.panelBody.appendChild(el('p', 'ci-panel-note', 'Nothing yet. Tell us anything and it appears here, where you can change or remove it.'));
    }

    var reset = el('button', 'ci-btn ci-btn-danger', 'Forget everything');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      clear();
      state.profile = null;
      state.understood = null;
      state.lastQuestion = null;
      state.matches = null;
      state.domain = null;
      els.results.innerHTML = '';
      if (els.map) { els.map.innerHTML = ''; els.map.hidden = true; }
      renderThread();
      renderPanel(null);
      if (els.intro) els.intro.hidden = false;
      say('Everything has been removed from this browser.', 'ok');
    });
    els.panelBody.appendChild(reset);
  }

  function dimRow(d) {
    var row = el('div', 'ci-dim');
    row.appendChild(el('span', 'ci-dim-label', d.label));
    var actions = el('span', 'ci-dim-actions');
    var yes = el('button', 'ci-tag-x', '✓');
    yes.type = 'button';
    yes.title = 'Yes, that is right';
    yes.setAttribute('aria-label', 'Confirm: ' + d.label);
    yes.addEventListener('click', function () { correctDim(d.key, 'confirm'); });
    var no = el('button', 'ci-tag-x', '×');
    no.type = 'button';
    no.title = 'No, that is not right';
    no.setAttribute('aria-label', 'Reject: ' + d.label);
    no.addEventListener('click', function () { correctDim(d.key, 'reject'); });
    actions.appendChild(yes);
    actions.appendChild(no);
    row.appendChild(actions);
    if (d.confirmation === 'confirmed') row.classList.add('is-confirmed');
    return row;
  }

  /* ------------------------------------------------------------------------------- actions */

  function apply(res) {
    if (!res || !res.body) return;
    var b = res.body;
    if (b.ok === false) { say(b.error || 'Something went wrong.', 'warn'); return; }
    state.profile = b.profile || state.profile;
    if (state.profile) save(state.profile);
    state.lastQuestion = b.next || null;
    state.understood = (b.understood && b.understood.length) ? b.understood : null;
    state.offerResume = !!b.offerResume;
    if (b.couldNotRead) {
      // Said plainly, with the plain search offered instead of a pretend understanding.
      say('We could not make much of that. You can still search the catalogue directly, or say it another way.', 'warn');
    }
    renderThread();
    renderPanel(b.understanding);
    if (els.intro && (state.understood || state.lastQuestion)) els.intro.hidden = true;
  }

  function send(payload) {
    if (state.busy) return;
    busy(true);
    say('Reading that...');
    post('interpret', Object.assign({ profile: state.profile }, payload))
      .then(function (res) {
        apply(res);
        if (!res.body || res.body.ok !== false) say('');
        return loadMatches(0);
      })
      .catch(function () {
        say('We could not reach Career Intelligence just now. The catalogue below still works, and so does search.', 'warn');
      })
      .then(function () { busy(false); });
  }

  function answer(questionId, selected, text) {
    send({ action: 'answer', questionId: questionId, selected: selected, text: text });
  }
  function skipQuestion(id) { send({ action: 'skip', questionId: id }); }
  function correct(list, key, verdict) { send({ action: 'confirm', target: list, key: key, verdict: verdict }); }
  function correctDim(key, verdict) { send({ action: 'confirm', target: 'dimension', key: key, verdict: verdict }); }
  function removeResponse(id) { send({ action: 'remove', responseId: id }); }

  function confirmAll(verdict) {
    // One request, not one per item: the person pressed one button and it means one thing.
    var p = state.profile;
    if (!p || !p.dimensions) return;
    var keys = Object.keys(p.dimensions);
    if (!keys.length) return;
    keys.forEach(function (k) {
      if (p.dimensions[k].confirmation === 'unconfirmed') {
        p.dimensions[k].confirmation = verdict === 'confirm' ? 'confirmed' : 'rejected';
        p.dimensions[k].source = 'stated';
        p.dimensions[k].confidence = verdict === 'confirm' ? Math.max(p.dimensions[k].confidence, 0.9) : 1;
      }
    });
    save(p);
  }

  function loadMatches(offset, append) {
    return fetch(API + 'matches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: state.profile,
        offset: offset || 0,
        limit: 24,
        domain: state.domain || undefined,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.matches = data;
        renderResults(data, append);
        if (!append && els.results.firstChild) {
          els.results.setAttribute('tabindex', '-1');
          els.results.focus({ preventScroll: false });
        }
      })
      .catch(function () {
        renderResults({ readable: false }, false);
      });
  }

  function feedback(roleId, event, tier, reason) {
    try {
      fetch(API + 'feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ roleId: roleId, event: event, tier: tier, reason: reason, sessionKey: sessionKey() }),
      }).catch(function () {});
    } catch (e) { /* a lost signal costs a slightly worse ranking, and nothing else */ }
  }

  /* ---------------------------------------------------------------------------------- wiring */

  els.form.addEventListener('submit', function (ev) {
    var text = (els.input.value || '').trim();
    if (!text) return; // let the plain form do its job — a search with no term is a browse
    ev.preventDefault();
    els.input.value = '';
    send({ action: 'answer', questionId: null, text: text });
  });

  // Pathway chips. Each is a real link to a filtered catalogue page, so it works with this script
  // absent; with it present, it starts the conversation instead of navigating.
  var chips = document.querySelectorAll('[data-ci-pathway]');
  Array.prototype.forEach.call(chips, function (chip) {
    chip.addEventListener('click', function (ev) {
      ev.preventDefault();
      send({ action: 'answer', questionId: 'direction.kind', selected: [], text: chip.getAttribute('data-ci-text') || chip.textContent });
    });
  });

  if (els.panelToggle && els.panel) {
    els.panelToggle.addEventListener('click', function () { openPanel(!state.panelOpen); });
  }
  function openPanel(open) {
    state.panelOpen = open === undefined ? true : !!open;
    els.panel.hidden = !state.panelOpen;
    els.panelToggle.setAttribute('aria-expanded', state.panelOpen ? 'true' : 'false');
    if (state.panelOpen) els.panel.focus({ preventScroll: true });
  }

  // The optional reflection layer. Opt-in, and its own control — never part of a question flow.
  var reflectForm = document.getElementById('ci-reflect-form');
  if (reflectForm) {
    reflectForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var d = document.getElementById('ci-reflect-date');
      if (!d || !d.value) return;
      send({ action: 'reflect', birthDate: d.value });
      openPanel(true);
    });
  }

  /* --------------------------------------------------------------------------- resuming a visit */

  if (state.profile && state.profile.rawResponses && state.profile.rawResponses.length) {
    // Somebody who has been here before comes back to what they said, not to a blank slate. The
    // server has never seen this profile — it came out of this browser — so 'state' is the request
    // that reads it and returns the next question and the understanding panel. It records nothing.
    if (els.intro) els.intro.hidden = true;
    send({ action: 'state' });
    say('Picking up where you left off. Everything you told us is in this browser only.', 'quiet');
  }
})();

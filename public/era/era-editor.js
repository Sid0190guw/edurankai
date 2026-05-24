/* era-editor.js - lightweight code editor for the ERA design system
   Depends on: era-highlight.js
   Loads with: <link rel="stylesheet" href="/era/era-editor.css">
                <script src="/era/era-highlight.js"></script>
                <script src="/era/era-editor.js"></script>
   Usage:
     var ed = new ERA.Editor('#myDiv', {
       language: 'python', value: 'def hi():\n  pass',
       readonly: false, lineNumbers: true,
       onChange: function(code) {},
       onSave: function(code) {}
     });
*/
(function(global) {
  'use strict';
  var ERA = global.ERA = global.ERA || {};
  var DEBUG = false;

  // ===== BRACKET MAP =====
  var OPEN_CLOSE = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  var CLOSE_OPEN = { ')': '(', ']': '[', '}': '{', '"': '"', "'": "'" };
  function isOpen(c) { return OPEN_CLOSE.hasOwnProperty(c); }
  function isClose(c) { return CLOSE_OPEN.hasOwnProperty(c); }

  // ===== CARET UTILITIES =====
  // Get text-content offset (start, end) of current selection within rootEl
  function saveCaret(rootEl) {
    var sel = global.getSelection ? global.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    if (!rootEl.contains(range.startContainer) && !rootEl.contains(range.endContainer)) return null;
    var startOffset = offsetWithin(rootEl, range.startContainer, range.startOffset);
    var endOffset = offsetWithin(rootEl, range.endContainer, range.endOffset);
    return { start: startOffset, end: endOffset };
  }

  function offsetWithin(rootEl, node, offset) {
    var total = 0;
    var walker = global.document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (n === node) return total + offset;
      total += n.nodeValue.length;
    }
    // If node is an element (e.g. selection at start of element)
    // fall back: compute textContent length up to node
    var beforeText = textContentBefore(rootEl, node);
    return beforeText + offset;
  }

  function textContentBefore(rootEl, node) {
    var range = global.document.createRange();
    range.selectNodeContents(rootEl);
    try { range.setEnd(node, 0); } catch (e) { return 0; }
    return range.toString().length;
  }

  function restoreCaret(rootEl, pos) {
    if (!pos) return;
    var sel = global.getSelection();
    if (!sel) return;
    var start = findNodeAtOffset(rootEl, pos.start);
    var end = (pos.end === pos.start) ? start : findNodeAtOffset(rootEl, pos.end);
    if (!start || !end) return;
    try {
      var range = global.document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      if (DEBUG) console.log('restoreCaret failed', e);
    }
  }

  function findNodeAtOffset(rootEl, offset) {
    var walker = global.document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    var total = 0;
    var lastNode = null;
    while (walker.nextNode()) {
      var n = walker.currentNode;
      lastNode = n;
      var len = n.nodeValue.length;
      if (total + len >= offset) {
        return { node: n, offset: offset - total };
      }
      total += len;
    }
    // offset beyond text — place at end of last text node
    if (lastNode) return { node: lastNode, offset: lastNode.nodeValue.length };
    // empty editor - place inside the root itself
    return { node: rootEl, offset: 0 };
  }

  // ===== HTML BUILDERS =====
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function tokensToHtml(tokens) {
    var html = '';
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'whitespace') {
        html += escapeHtml(t.value);
      } else {
        html += '<span class="era-tok-' + t.type + '">' + escapeHtml(t.value) + '</span>';
      }
    }
    return html;
  }

  // ===== EDITOR CLASS =====
  function Editor(target, options) {
    if (!(this instanceof Editor)) return new Editor(target, options);
    options = options || {};
    var el = typeof target === 'string' ? global.document.querySelector(target) : target;
    if (!el) throw new Error('era-editor: target not found - ' + target);

    this.host = el;
    this.options = options;
    this.language = options.language || 'javascript';
    this.readonly = !!options.readonly;
    this.showLineNumbers = options.lineNumbers !== false;
    this.placeholder = options.placeholder || '';
    this.listeners = { change: [], save: [] };
    if (typeof options.onChange === 'function') this.listeners.change.push(options.onChange);
    if (typeof options.onSave === 'function') this.listeners.save.push(options.onSave);

    this._build();
    this._attach();
    this.setValue(options.value || '');
    this._rerender();
  }

  Editor.prototype._build = function() {
    var host = this.host;
    host.innerHTML = '';
    host.classList.add('era-editor');
    if (this.readonly) host.setAttribute('data-readonly', 'true');

    // Find bar
    this.findBar = global.document.createElement('div');
    this.findBar.className = 'era-editor-find';
    this.findBar.innerHTML =
      '<input type="text" placeholder="Find..." aria-label="Search code">' +
      '<span class="era-editor-find-count">0/0</span>' +
      '<button type="button" data-act="prev" aria-label="Previous match" title="Shift+Enter">&uarr;</button>' +
      '<button type="button" data-act="next" aria-label="Next match" title="Enter">&darr;</button>' +
      '<button type="button" data-act="close" aria-label="Close find" title="Escape">x</button>';
    host.appendChild(this.findBar);
    this.findInput = this.findBar.querySelector('input');
    this.findCount = this.findBar.querySelector('.era-editor-find-count');

    // Body (gutter + content)
    this.body = global.document.createElement('div');
    this.body.className = 'era-editor-body';
    host.appendChild(this.body);

    if (this.showLineNumbers) {
      this.gutter = global.document.createElement('div');
      this.gutter.className = 'era-editor-gutter';
      this.gutter.setAttribute('aria-hidden', 'true');
      this.body.appendChild(this.gutter);
    }

    this.currentLineEl = global.document.createElement('div');
    this.currentLineEl.className = 'era-editor-currentline';
    this.body.appendChild(this.currentLineEl);

    this.content = global.document.createElement('div');
    this.content.className = 'era-editor-content';
    this.content.setAttribute('contenteditable', this.readonly ? 'false' : 'true');
    this.content.setAttribute('spellcheck', 'false');
    this.content.setAttribute('role', 'textbox');
    this.content.setAttribute('aria-multiline', 'true');
    this.content.setAttribute('aria-label', this.options.ariaLabel || 'Code editor');
    if (this.placeholder) this.content.setAttribute('data-placeholder', this.placeholder);
    this.body.appendChild(this.content);
  };

  Editor.prototype._attach = function() {
    var self = this;
    this._handlers = [];

    function on(target, type, handler) {
      target.addEventListener(type, handler);
      self._handlers.push({ target: target, type: type, handler: handler });
    }

    // Re-render debounced
    var debouncedRender = ERA.debounce
      ? ERA.debounce(function() { self._rerender(); }, 50)
      : function() { setTimeout(function() { self._rerender(); }, 50); };

    on(this.content, 'input', function() {
      self._updatePlaceholderState();
      self._emitChange();
      debouncedRender();
    });

    on(this.content, 'keydown', function(e) { self._onKeyDown(e); });
    on(this.content, 'beforeinput', function(e) { self._onBeforeInput(e); });
    on(this.content, 'click', function() { self._updateCurrentLine(); self._updateBracketMatch(); });
    on(this.content, 'keyup', function() { self._updateCurrentLine(); self._updateBracketMatch(); });
    on(this.content, 'paste', function(e) { self._onPaste(e); });

    // Find bar buttons
    on(this.findBar, 'click', function(e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'next') self._findStep(1);
      else if (act === 'prev') self._findStep(-1);
      else if (act === 'close') self._closeFind();
    });
    on(this.findInput, 'input', function() { self._findUpdate(self.findInput.value); });
    on(this.findInput, 'keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); self._findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); self._closeFind(); }
    });

    // Scroll sync (gutter <-> content)
    on(this.body, 'scroll', function() {
      self._updateCurrentLine();
    });
  };

  Editor.prototype._onBeforeInput = function(e) {
    // Bracket auto-close + auto-skip
    if (this.readonly) return;
    if (e.inputType !== 'insertText') return;
    var data = e.data;
    if (!data || data.length !== 1) return;

    var sel = global.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0);
    if (!range.collapsed) return; // selection: let default handle

    var caret = saveCaret(this.content);
    if (!caret) return;
    var text = this.getValue();
    var nextChar = text[caret.start] || '';
    var prevChar = text[caret.start - 1] || '';

    // Auto-skip if typing the matching close char that's already there
    if (isClose(data) && nextChar === data) {
      e.preventDefault();
      this._setCaret(caret.start + 1);
      return;
    }

    // Auto-close brackets
    if (isOpen(data)) {
      // Skip if next char is alphanumeric (don't auto-close inside identifiers)
      if (/[A-Za-z0-9_]/.test(nextChar)) return;
      // For quotes, also skip if prev char is alphanumeric (likely string literal in identifier)
      if ((data === '"' || data === "'") && /[A-Za-z0-9_]/.test(prevChar)) return;
      var close = OPEN_CLOSE[data];
      e.preventDefault();
      this._insertAtCaret(data + close);
      this._setCaret(caret.start + 1);
    }
  };

  Editor.prototype._onKeyDown = function(e) {
    var self = this;
    var key = e.key;
    var mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd + F: find
    if (mod && (key === 'f' || key === 'F')) {
      e.preventDefault();
      this._openFind();
      return;
    }
    // Ctrl/Cmd + S: save
    if (mod && (key === 's' || key === 'S')) {
      e.preventDefault();
      var code = this.getValue();
      this._emitSave(code);
      if (ERA.toast) ERA.toast('Saved', { type: 'success', duration: 1500 });
      return;
    }
    if (this.readonly) return;

    if (key === 'Tab') {
      e.preventDefault();
      var sel = global.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
        this._indentSelection(e.shiftKey ? -1 : 1);
      } else if (e.shiftKey) {
        this._unindentAtCaret();
      } else {
        this._insertAtCaret('  ');
      }
      this._emitChange();
      this._rerender();
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      this._handleEnter();
      this._emitChange();
      this._rerender();
      return;
    }

    if (key === 'Backspace') {
      // Delete matched empty pair
      var caret = saveCaret(this.content);
      if (caret && caret.start === caret.end && caret.start > 0) {
        var text = this.getValue();
        var prev = text[caret.start - 1];
        var next = text[caret.start];
        if (isOpen(prev) && OPEN_CLOSE[prev] === next) {
          e.preventDefault();
          this._spliceText(caret.start - 1, caret.start + 1, '');
          this._setCaret(caret.start - 1);
          this._emitChange();
          this._rerender();
          return;
        }
      }
    }
  };

  Editor.prototype._handleEnter = function() {
    var caret = saveCaret(this.content);
    if (!caret) return;
    var text = this.getValue();
    var lineStart = text.lastIndexOf('\n', caret.start - 1) + 1;
    var currentLine = text.substring(lineStart, caret.start);
    var indentMatch = currentLine.match(/^[ \t]+/);
    var indent = indentMatch ? indentMatch[0] : '';
    var endsWithBlock = /[\{\(\[:]\s*$/.test(currentLine);
    var extra = endsWithBlock ? '  ' : '';
    var insert = '\n' + indent + extra;
    var charAfter = text[caret.start] || '';
    var charBefore = text[caret.start - 1] || '';

    // If pressing Enter between { and }: insert extra newline so } drops one line
    if ((charBefore === '{' && charAfter === '}') ||
        (charBefore === '(' && charAfter === ')') ||
        (charBefore === '[' && charAfter === ']')) {
      var tailIndent = '\n' + indent;
      this._insertAtCaret(insert + tailIndent);
      this._setCaret(caret.start + insert.length);
    } else {
      this._insertAtCaret(insert);
      this._setCaret(caret.start + insert.length);
    }
  };

  Editor.prototype._indentSelection = function(direction) {
    var caret = saveCaret(this.content);
    if (!caret) return;
    var text = this.getValue();
    var start = text.lastIndexOf('\n', caret.start - 1) + 1;
    var end = caret.end;
    var lines = text.substring(start, end).split('\n');
    var newStartAdj = 0;
    var newEndAdj = 0;
    var changed = lines.map(function(line, i) {
      if (direction > 0) {
        if (i === 0) newStartAdj += 2;
        newEndAdj += 2;
        return '  ' + line;
      } else {
        var trimmed = line.replace(/^ {1,2}/, '');
        var removed = line.length - trimmed.length;
        if (i === 0) newStartAdj -= removed;
        newEndAdj -= removed;
        return trimmed;
      }
    }).join('\n');
    this._spliceText(start, end, changed);
    var newStart = caret.start + newStartAdj;
    var newEnd = caret.end + newEndAdj;
    if (newStart < start) newStart = start;
    if (newEnd < newStart) newEnd = newStart;
    // Restore as selection
    var self = this;
    setTimeout(function() {
      var first = findNodeAtOffset(self.content, newStart);
      var last = findNodeAtOffset(self.content, newEnd);
      if (first && last) {
        try {
          var r = global.document.createRange();
          r.setStart(first.node, first.offset);
          r.setEnd(last.node, last.offset);
          var sel = global.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (e) {}
      }
    }, 0);
  };

  Editor.prototype._unindentAtCaret = function() {
    var caret = saveCaret(this.content);
    if (!caret) return;
    var text = this.getValue();
    var lineStart = text.lastIndexOf('\n', caret.start - 1) + 1;
    var lineHead = text.substring(lineStart, caret.start);
    if (/^ {2}/.test(lineHead)) {
      this._spliceText(lineStart, lineStart + 2, '');
      this._setCaret(caret.start - 2);
    }
  };

  Editor.prototype._onPaste = function(e) {
    if (this.readonly) return;
    e.preventDefault();
    var clip = e.clipboardData || global.clipboardData;
    if (!clip) return;
    var text = clip.getData('text/plain');
    if (!text) return;
    this._insertAtCaret(text);
    this._emitChange();
    this._rerender();
  };

  // ===== TEXT MUTATION HELPERS =====
  Editor.prototype._insertAtCaret = function(str) {
    var caret = saveCaret(this.content);
    if (!caret) {
      // append
      var current = this.getValue();
      this.setValue(current + str);
      return;
    }
    this._spliceText(caret.start, caret.end, str);
    this._setCaret(caret.start + str.length);
  };

  Editor.prototype._spliceText = function(start, end, replacement) {
    var current = this.getValue();
    var next = current.substring(0, start) + replacement + current.substring(end);
    this.content.textContent = next;
    this._updatePlaceholderState();
  };

  Editor.prototype._setCaret = function(offset) {
    var pos = findNodeAtOffset(this.content, offset);
    if (!pos) return;
    try {
      var range = global.document.createRange();
      range.setStart(pos.node, pos.offset);
      range.setEnd(pos.node, pos.offset);
      var sel = global.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  };

  // ===== RENDER =====
  Editor.prototype._rerender = function() {
    if (!ERA.highlight) return;
    var caret = saveCaret(this.content);
    var code = this.getValue();
    var tokens = ERA.highlight.tokenize(code, this.language);
    var html = tokensToHtml(tokens);
    // If find active, wrap matches AFTER rendering
    this.content.innerHTML = html || '';
    if (caret) restoreCaret(this.content, caret);
    this._updateGutter(code);
    this._updateCurrentLine();
    this._updateBracketMatch();
    if (this._findQuery) this._findUpdate(this._findQuery, /*silent*/ true);
    this._updatePlaceholderState();
  };

  Editor.prototype._updateGutter = function(code) {
    if (!this.showLineNumbers || !this.gutter) return;
    var lines = code.split('\n').length;
    if (lines < 1) lines = 1;
    var buf = '';
    for (var i = 1; i <= lines; i++) {
      buf += i + (i < lines ? '\n' : '');
    }
    this.gutter.textContent = buf;
  };

  Editor.prototype._updateCurrentLine = function() {
    if (!this.currentLineEl) return;
    var caret = saveCaret(this.content);
    if (!caret) { this.currentLineEl.style.display = 'none'; return; }
    var text = this.getValue();
    var before = text.substring(0, caret.start);
    var lineIdx = (before.match(/\n/g) || []).length;
    var lineHeight = 1.6;
    var fontSize = parseFloat(getComputedStyle(this.content).fontSize) || 14;
    var paddingTop = 14;
    var top = paddingTop + (lineIdx * lineHeight * fontSize) - this.body.scrollTop;
    this.currentLineEl.style.display = '';
    this.currentLineEl.style.top = top + 'px';
    this.currentLineEl.style.height = (lineHeight * fontSize) + 'px';
  };

  Editor.prototype._updateBracketMatch = function() {
    // Remove previous highlight by re-rendering tokens (already plain via this._rerender path)
    // For simplicity: visual bracket-match via class on token spans is omitted to keep code small.
    // Caret-near-bracket detection is still useful for future expansion; left as no-op v1.
  };

  Editor.prototype._updatePlaceholderState = function() {
    if (!this.placeholder) return;
    var empty = !this.getValue();
    if (empty) this.content.setAttribute('data-empty', 'true');
    else this.content.removeAttribute('data-empty');
  };

  // ===== FIND BAR =====
  Editor.prototype._openFind = function() {
    if (this.readonly) return;
    this.findBar.classList.add('open');
    this.findInput.focus();
    this.findInput.select();
  };
  Editor.prototype._closeFind = function() {
    this.findBar.classList.remove('open');
    this._findQuery = '';
    this._findMatches = [];
    this._findIdx = -1;
    this.findCount.textContent = '0/0';
    this._rerender();
    this.content.focus();
  };
  Editor.prototype._findUpdate = function(query, silent) {
    this._findQuery = query || '';
    var code = this.getValue();
    var matches = [];
    if (this._findQuery) {
      var lc = code.toLowerCase();
      var q = this._findQuery.toLowerCase();
      var idx = lc.indexOf(q, 0);
      while (idx !== -1) {
        matches.push({ start: idx, end: idx + q.length });
        idx = lc.indexOf(q, idx + 1);
      }
    }
    this._findMatches = matches;
    if (!silent) this._findIdx = matches.length > 0 ? 0 : -1;
    this.findCount.textContent = (this._findIdx + 1 || (matches.length > 0 ? 1 : 0)) + '/' + matches.length;
    this._renderFindHighlights();
  };
  Editor.prototype._findStep = function(dir) {
    if (!this._findMatches || this._findMatches.length === 0) return;
    this._findIdx = (this._findIdx + dir + this._findMatches.length) % this._findMatches.length;
    this.findCount.textContent = (this._findIdx + 1) + '/' + this._findMatches.length;
    this._renderFindHighlights();
    var m = this._findMatches[this._findIdx];
    this._setCaret(m.start);
    this._scrollCaretIntoView();
  };
  Editor.prototype._renderFindHighlights = function() {
    if (!this._findMatches || this._findMatches.length === 0) {
      this._rerenderRaw();
      return;
    }
    var code = this.getValue();
    var tokens = ERA.highlight.tokenize(code, this.language);
    // Build flat list of {start, end, type, value} from tokens
    var flat = [];
    var pos = 0;
    for (var i = 0; i < tokens.length; i++) {
      flat.push({ start: pos, end: pos + tokens[i].value.length, type: tokens[i].type, value: tokens[i].value });
      pos += tokens[i].value.length;
    }
    var matches = this._findMatches;
    var html = '';
    var matchIdx = 0;
    var active = this._findIdx;
    for (var t = 0; t < flat.length; t++) {
      var tok = flat[t];
      // For each token, slice it where find matches overlap
      var cursor = tok.start;
      while (cursor < tok.end) {
        // Find next match touching this token
        while (matchIdx < matches.length && matches[matchIdx].end <= cursor) matchIdx++;
        var m = matches[matchIdx];
        var sliceEnd = tok.end;
        var inMatch = false;
        if (m && m.start < tok.end && m.end > cursor) {
          if (m.start > cursor) {
            sliceEnd = Math.min(m.start, tok.end);
          } else {
            sliceEnd = Math.min(m.end, tok.end);
            inMatch = true;
          }
        }
        var slice = tok.value.substring(cursor - tok.start, sliceEnd - tok.start);
        var cls = 'era-tok-' + tok.type;
        if (inMatch) {
          var isActive = active >= 0 && matches[active] === m;
          cls += ' era-find-match' + (isActive ? ' era-find-match-active' : '');
        }
        if (tok.type === 'whitespace' && !inMatch) {
          html += escapeHtml(slice);
        } else {
          html += '<span class="' + cls + '">' + escapeHtml(slice) + '</span>';
        }
        cursor = sliceEnd;
      }
    }
    var caret = saveCaret(this.content);
    this.content.innerHTML = html;
    if (caret) restoreCaret(this.content, caret);
  };
  Editor.prototype._rerenderRaw = function() {
    var caret = saveCaret(this.content);
    var code = this.getValue();
    var tokens = ERA.highlight.tokenize(code, this.language);
    this.content.innerHTML = tokensToHtml(tokens);
    if (caret) restoreCaret(this.content, caret);
  };
  Editor.prototype._scrollCaretIntoView = function() {
    // Best-effort: scroll body so currentLineEl is in view
    var top = parseFloat(this.currentLineEl.style.top) || 0;
    var bodyH = this.body.clientHeight;
    if (top < 0) this.body.scrollTop += top - 20;
    else if (top > bodyH - 40) this.body.scrollTop += (top - bodyH + 60);
  };

  // ===== EMIT =====
  Editor.prototype._emitChange = function() {
    var code = this.getValue();
    for (var i = 0; i < this.listeners.change.length; i++) {
      try { this.listeners.change[i](code); } catch (e) { if (DEBUG) console.log(e); }
    }
  };
  Editor.prototype._emitSave = function(code) {
    for (var i = 0; i < this.listeners.save.length; i++) {
      try { this.listeners.save[i](code); } catch (e) { if (DEBUG) console.log(e); }
    }
  };

  // ===== PUBLIC API =====
  Editor.prototype.getValue = function() {
    // Use textContent (covers token spans + plain text)
    return this.content.textContent || '';
  };
  Editor.prototype.setValue = function(code) {
    this.content.textContent = String(code == null ? '' : code);
    this._rerender();
    this._updatePlaceholderState();
  };
  Editor.prototype.setLanguage = function(lang) {
    this.language = lang || 'javascript';
    this._rerender();
  };
  Editor.prototype.focus = function() {
    this.content.focus();
    // Place caret at end if no selection
    var caret = saveCaret(this.content);
    if (!caret) this._setCaret(this.getValue().length);
  };
  Editor.prototype.find = function(query) {
    this._openFind();
    this.findInput.value = query || '';
    this._findUpdate(this.findInput.value);
  };
  Editor.prototype.insertText = function(text) {
    this._insertAtCaret(text);
    this._emitChange();
    this._rerender();
  };
  Editor.prototype.on = function(event, handler) {
    if (this.listeners[event]) this.listeners[event].push(handler);
  };
  Editor.prototype.setReadonly = function(flag) {
    this.readonly = !!flag;
    this.content.setAttribute('contenteditable', this.readonly ? 'false' : 'true');
    if (this.readonly) {
      this.host.setAttribute('data-readonly', 'true');
      this._closeFind();
    } else {
      this.host.removeAttribute('data-readonly');
    }
  };
  Editor.prototype.destroy = function() {
    if (this._handlers) {
      for (var i = 0; i < this._handlers.length; i++) {
        var h = this._handlers[i];
        h.target.removeEventListener(h.type, h.handler);
      }
    }
    this.host.innerHTML = '';
    this.host.classList.remove('era-editor');
    this.host.removeAttribute('data-readonly');
  };

  ERA.Editor = Editor;
})(typeof window !== 'undefined' ? window : this);

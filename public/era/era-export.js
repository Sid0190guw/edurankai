/* era-export.js - CSV / JSON export utilities
   Usage:
     ERA.export.csv(filename, data)  // data = array of objects
     ERA.export.csvFromTable(tableElement, filename)
     ERA.export.json(filename, data)
*/
(function(global) {
  'use strict';
  if (!global.ERA) global.ERA = {};

  function escapeCSV(val) {
    if (val == null) return '';
    var s = String(val);
    // Quote if contains comma, quote, or newline
    if (/[",\n\r]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function download(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  function csv(filename, data, columns) {
    if (!Array.isArray(data) || data.length === 0) {
      if (global.ERA.toast) global.ERA.toast('No data to export', { type: 'warn' });
      return;
    }
    // Detect columns if not provided
    if (!columns) {
      columns = Object.keys(data[0]);
    }
    // Header row
    var rows = [columns.map(escapeCSV).join(',')];
    // Data rows
    for (var i = 0; i < data.length; i++) {
      var row = columns.map(function(col) {
        var val = data[i][col];
        if (val instanceof Date) val = val.toISOString();
        else if (typeof val === 'object' && val !== null) val = JSON.stringify(val);
        return escapeCSV(val);
      });
      rows.push(row.join(','));
    }
    var csvContent = rows.join('\n');
    // Add BOM for Excel to recognize UTF-8
    download(filename, '\uFEFF' + csvContent, 'text/csv;charset=utf-8');
    if (global.ERA.toast) global.ERA.toast('Exported ' + data.length + ' rows', { type: 'success' });
  }

  function csvFromTable(tableEl, filename) {
    if (!tableEl) return;
    var rows = tableEl.querySelectorAll('tr');
    var lines = [];
    rows.forEach(function(tr) {
      var cells = tr.querySelectorAll('th, td');
      var cellsArr = [];
      cells.forEach(function(c) {
        // Skip cells with data-skip-export
        if (c.hasAttribute('data-skip-export')) return;
        // Use data-export-value if present, else text
        var v = c.getAttribute('data-export-value') || c.textContent.trim();
        cellsArr.push(escapeCSV(v));
      });
      if (cellsArr.length > 0) lines.push(cellsArr.join(','));
    });
    if (lines.length === 0) {
      if (global.ERA.toast) global.ERA.toast('Nothing to export', { type: 'warn' });
      return;
    }
    download(filename, '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
    if (global.ERA.toast) global.ERA.toast('Exported ' + (lines.length - 1) + ' rows', { type: 'success' });
  }

  function csvFromCards(containerEl, filename, mapper) {
    // For lists not in <table> format - cards/grid
    // mapper: function(cardElement) -> { col1: value, col2: value }
    if (!containerEl || typeof mapper !== 'function') return;
    var cards = containerEl.querySelectorAll('[data-export-row]');
    if (cards.length === 0) {
      if (global.ERA.toast) global.ERA.toast('No data found', { type: 'warn' });
      return;
    }
    var data = [];
    cards.forEach(function(card) {
      var row = mapper(card);
      if (row) data.push(row);
    });
    csv(filename, data);
  }

  function jsonExport(filename, data) {
    download(filename, JSON.stringify(data, null, 2), 'application/json');
    if (global.ERA.toast) global.ERA.toast('Exported as JSON', { type: 'success' });
  }

  // Helper: auto-add export button to any element with data-export-target
  function autoWire() {
    document.querySelectorAll('[data-export-csv]').forEach(function(btn) {
      if (btn._eraExportWired) return;
      btn._eraExportWired = true;
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        var target = document.querySelector(btn.getAttribute('data-export-csv'));
        var filename = btn.getAttribute('data-export-filename') || 'export.csv';
        if (target && target.tagName === 'TABLE') {
          csvFromTable(target, filename);
        } else if (target) {
          // Try cards mode - find rows by data-export-row
          var cards = target.querySelectorAll('[data-export-row]');
          if (cards.length > 0) {
            var data = [];
            cards.forEach(function(card) {
              var row = {};
              card.querySelectorAll('[data-export-field]').forEach(function(field) {
                var key = field.getAttribute('data-export-field');
                var val = field.getAttribute('data-export-value') || field.textContent.trim();
                row[key] = val;
              });
              data.push(row);
            });
            csv(filename, data);
          } else {
            if (global.ERA.toast) global.ERA.toast('No exportable data found', { type: 'warn' });
          }
        }
      });
    });
  }

  global.ERA.export = {
    csv: csv,
    csvFromTable: csvFromTable,
    csvFromCards: csvFromCards,
    json: jsonExport,
    autoWire: autoWire,
    _escape: escapeCSV
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoWire);
  } else {
    autoWire();
  }
})(typeof window !== 'undefined' ? window : this);

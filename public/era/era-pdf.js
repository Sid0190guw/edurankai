/* era-pdf.js - PDF generation utilities
   Uses native browser APIs + minimal lightweight code
   For complex PDFs, leverages window.print() with print-friendly CSS
   Usage:
     ERA.PDF.printElement(element, filename)  - opens print dialog with element only
     ERA.PDF.downloadElementAsPDF(element, filename) - browser save-as-PDF
*/
(function(global) {
  'use strict';

  function printElement(element, options) {
    options = options || {};
    var html = element.outerHTML;
    var styles = '';
    // Collect computed styles for the element
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      try {
        var rules = sheets[i].cssRules || sheets[i].rules;
        if (rules) {
          for (var j = 0; j < rules.length; j++) {
            styles += rules[j].cssText + '\n';
          }
        }
      } catch(e) { /* CORS-blocked sheets */ }
    }
    // Inline styles from element
    var inlineStyles = [];
    var styleTags = element.querySelectorAll('style');
    styleTags.forEach(function(s) { inlineStyles.push(s.innerHTML); });

    var w = window.open('', '_blank', 'width=900,height=1200');
    if (!w) {
      alert('Pop-ups blocked. Please allow pop-ups and try again.');
      return false;
    }
    w.document.write('<!doctype html><html><head><meta charset="utf-8"/>');
    w.document.write('<title>' + (options.title || 'Document') + '</title>');
    w.document.write('<style>' + styles + '\n' + inlineStyles.join('\n') + '</style>');
    w.document.write('<style>@media print { @page { margin: 0; } body { margin: 0; padding: 0; } } body { background: white; }</style>');
    w.document.write('</head><body>');
    w.document.write(html);
    w.document.write('<script>window.onload = function() { setTimeout(function() { window.print(); }, 300); };<\/script>');
    w.document.write('</body></html>');
    w.document.close();
    return true;
  }

  function elementToCanvas(element, options) {
    // Lightweight: uses SVG foreignObject for high-fidelity rendering
    options = options || {};
    var scale = options.scale || 2;
    var rect = element.getBoundingClientRect();
    var width = rect.width;
    var height = rect.height;

    // Clone the element including all computed styles inline
    return new Promise(function(resolve, reject) {
      var clone = element.cloneNode(true);
      // Inline computed styles for fidelity
      function inlineStyles(orig, cl) {
        var cs = window.getComputedStyle(orig);
        var s = '';
        for (var i = 0; i < cs.length; i++) {
          s += cs[i] + ':' + cs.getPropertyValue(cs[i]) + ';';
        }
        cl.setAttribute('style', s);
        for (var i = 0; i < orig.children.length; i++) {
          inlineStyles(orig.children[i], cl.children[i]);
        }
      }
      try {
        inlineStyles(element, clone);
      } catch(e) {}
      var serializer = new XMLSerializer();
      var html = serializer.serializeToString(clone);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
                '<foreignObject width="100%" height="100%">' +
                '<div xmlns="http://www.w3.org/1999/xhtml" style="background:white;">' + html + '</div>' +
                '</foreignObject></svg>';
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        var ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = options.background || '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  global.ERA = global.ERA || {};
  global.ERA.PDF = {
    print: printElement,
    download: function(element, filename) {
      // Browser's "Save as PDF" via print dialog
      return printElement(element, { title: filename || 'Document' });
    },
    toCanvas: elementToCanvas,
    toImage: function(element, filename) {
      elementToCanvas(element).then(function(canvas) {
        var link = document.createElement('a');
        link.download = filename || 'image.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      });
    }
  };
})(typeof window !== 'undefined' ? window : this);

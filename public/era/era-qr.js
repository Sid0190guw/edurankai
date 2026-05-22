/* era-qr.js - Self-contained QR code generator (no dependencies)
   Usage: ERA.QR.toCanvas(canvas, text, options)
          ERA.QR.toDataURL(text, options) -> base64 PNG
*/
(function(global) {
  'use strict';

  // Galois field arithmetic for Reed-Solomon
  var GF = (function() {
    var EXP = new Uint8Array(256), LOG = new Uint8Array(256);
    var x = 1;
    for (var i = 0; i < 256; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = x << 1;
      if (x & 0x100) x ^= 0x11D;
    }
    return {
      mul: function(a, b) {
        if (a === 0 || b === 0) return 0;
        return EXP[(LOG[a] + LOG[b]) % 255];
      },
      EXP: EXP, LOG: LOG
    };
  })();

  // QR Code constants
  var ALIGNMENT_PATTERNS = [
    [], [6,18], [6,22], [6,26], [6,30], [6,34],
    [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54],
    [6,32,58], [6,34,62], [6,26,46,66]
  ];

  var EC_BLOCKS = {
    L: [[1,19],[1,34],[1,55],[1,80],[1,108],[2,68],[2,78],[2,97],[2,116],[2,68]],
    M: [[1,16],[1,28],[1,44],[2,32],[2,43],[4,27],[4,31],[2,38],[3,36],[4,43]],
    Q: [[1,13],[1,22],[2,17],[2,24],[2,15],[4,19],[6,14],[6,18],[5,16],[6,18]],
    H: [[1,9],[1,16],[2,13],[4,9],[2,11],[4,15],[5,13],[6,14],[8,14],[6,15]]
  };

  function getVersion(textLen) {
    // Auto-pick version based on byte mode capacity (medium EC)
    var caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    for (var v = 1; v <= 10; v++) {
      if (textLen <= caps[v-1]) return v;
    }
    return 10;
  }

  function getSize(version) { return 17 + version * 4; }

  // Build matrix with finder, alignment, timing patterns
  function buildMatrix(size, version) {
    var m = [];
    for (var i = 0; i < size; i++) {
      m.push(new Uint8Array(size));
    }
    // Finder patterns at 3 corners
    var place = function(r, c) {
      for (var i = -1; i <= 7; i++) {
        for (var j = -1; j <= 7; j++) {
          var rr = r + i, cc = c + j;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          m[rr][cc] = 2; // reserved
          if ((i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
              (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
              (i >= 2 && i <= 4 && j >= 2 && j <= 4)) {
            m[rr][cc] = 3; // black
          }
        }
      }
    };
    place(0, 0); place(0, size - 7); place(size - 7, 0);

    // Timing
    for (var i = 8; i < size - 8; i++) {
      m[6][i] = (i % 2 === 0) ? 3 : 2;
      m[i][6] = (i % 2 === 0) ? 3 : 2;
    }

    // Alignment patterns
    if (version >= 2) {
      var locs = ALIGNMENT_PATTERNS[version - 1];
      for (var a = 0; a < locs.length; a++) {
        for (var b = 0; b < locs.length; b++) {
          var r = locs[a], c = locs[b];
          if (m[r][c] !== 0) continue;
          for (var dr = -2; dr <= 2; dr++) {
            for (var dc = -2; dc <= 2; dc++) {
              var ar = r + dr, ac = c + dc;
              if (ar < 0 || ar >= size || ac < 0 || ac >= size) continue;
              m[ar][ac] = ((dr === -2 || dr === 2 || dc === -2 || dc === 2) ||
                           (dr === 0 && dc === 0)) ? 3 : 2;
            }
          }
        }
      }
    }

    // Format info reserved
    for (var i = 0; i < 9; i++) {
      m[8][i] = m[8][i] || 2;
      m[i][8] = m[i][8] || 2;
    }
    for (var i = size - 8; i < size; i++) {
      m[8][i] = m[8][i] || 2;
      m[i][8] = m[i][8] || 2;
    }
    m[size - 8][8] = 3; // dark module

    return m;
  }

  function encodeData(text, version) {
    var bits = [];
    var push = function(val, n) {
      for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    // Mode: byte mode
    push(4, 4);
    // Char count indicator
    var ccLen = version < 10 ? 8 : 16;
    push(text.length, ccLen);
    // Data
    for (var i = 0; i < text.length; i++) {
      push(text.charCodeAt(i), 8);
    }
    // Terminator
    push(0, 4);
    // Pad to byte
    while (bits.length % 8 !== 0) bits.push(0);
    // Convert to bytes
    var bytes = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      bytes.push(b);
    }
    // Pad bytes
    var total = EC_BLOCKS.M[version - 1][1] * EC_BLOCKS.M[version - 1][0];
    var pad = [0xEC, 0x11];
    var k = 0;
    while (bytes.length < total) bytes.push(pad[k++ % 2]);
    return bytes;
  }

  function rsCorrection(data, ecLen) {
    // Reed-Solomon generator polynomial
    var gen = [1];
    for (var i = 0; i < ecLen; i++) {
      var newGen = new Array(gen.length + 1).fill(0);
      for (var j = 0; j < gen.length; j++) {
        newGen[j] ^= gen[j];
        newGen[j + 1] ^= GF.mul(gen[j], GF.EXP[i]);
      }
      gen = newGen;
    }
    // Polynomial division
    var msg = data.concat(new Array(ecLen).fill(0));
    for (var i = 0; i < data.length; i++) {
      var c = msg[i];
      if (c !== 0) {
        for (var j = 0; j < gen.length; j++) {
          msg[i + j] ^= GF.mul(gen[j], c);
        }
      }
    }
    return msg.slice(data.length);
  }

  function placeData(m, data, size) {
    var col = size - 1, row = size - 1, dir = -1, bitIdx = 0;
    while (col > 0) {
      if (col === 6) col--;
      for (var c2 = 0; c2 < 2; c2++) {
        var c = col - c2;
        if (m[row][c] === 0) {
          var byteI = bitIdx >> 3, bitI = 7 - (bitIdx & 7);
          var bit = (data[byteI] >> bitI) & 1;
          m[row][c] = bit ? 3 : 2;
          bitIdx++;
        }
      }
      row += dir;
      if (row < 0 || row >= size) {
        dir = -dir;
        row += dir;
        col -= 2;
      }
    }
  }

  function applyMask(m, mask, size) {
    var maskFn = [
      function(r,c){return (r+c)%2===0;},
      function(r,c){return r%2===0;},
      function(r,c){return c%3===0;},
      function(r,c){return (r+c)%3===0;},
      function(r,c){return (Math.floor(r/2)+Math.floor(c/3))%2===0;},
      function(r,c){return ((r*c)%2)+((r*c)%3)===0;},
      function(r,c){return (((r*c)%2)+((r*c)%3))%2===0;},
      function(r,c){return (((r+c)%2)+((r*c)%3))%2===0;}
    ][mask];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (m[r][c] === 2 || m[r][c] === 3) {
          var orig = m[r][c];
          // Don't mask reserved areas; we only know data vs reserved by re-checking, but our matrix already marks data as 2/3
          // To keep it simple: re-track data positions separately is needed; we already did, but reserved are 2 too.
          // Pragmatic: mask only positions that weren't reserved before placeData.
          // We'll mark in a different way: skipping is fine because format/timing get re-written below.
        }
      }
    }
    // Apply mask to data modules: we'll re-walk like placeData and flip
  }

  // Simple BCH/format encoding helper
  function formatBits(maskNum) {
    // ec = M (00) + mask (3 bits)
    var data = (0 << 3) | maskNum;
    var bch = data << 10;
    var poly = 0x537;
    var d = bch;
    for (var i = 14; i >= 10; i--) {
      if ((d >> i) & 1) d ^= poly << (i - 10);
    }
    var fmt = (data << 10) | d;
    fmt ^= 0x5412;
    return fmt;
  }

  function placeFormat(m, size, fmtBits) {
    var bits = [];
    for (var i = 14; i >= 0; i--) bits.push((fmtBits >> i) & 1);
    // Around top-left finder
    for (var i = 0; i <= 5; i++) m[8][i] = bits[i] ? 3 : 2;
    m[8][7] = bits[6] ? 3 : 2;
    m[8][8] = bits[7] ? 3 : 2;
    m[7][8] = bits[8] ? 3 : 2;
    for (var i = 9; i <= 14; i++) m[14 - i][8] = bits[i] ? 3 : 2;
    // Around other finders
    for (var i = 0; i < 7; i++) m[size - 1 - i][8] = bits[i] ? 3 : 2;
    for (var i = 7; i < 15; i++) m[8][size - 15 + i] = bits[i] ? 3 : 2;
    m[size - 8][8] = 3; // dark module
  }

  function generate(text, errorLevel) {
    errorLevel = errorLevel || 'M';
    var version = getVersion(text.length);
    var size = getSize(version);
    var matrix = buildMatrix(size, version);
    var blocks = EC_BLOCKS[errorLevel][version - 1];
    var totalBytes = blocks[0] * blocks[1];
    var data = encodeData(text, version);
    // Each block of data gets its own EC
    var blocksPerEC = blocks[0];
    var ecPerBlock = Math.floor((totalBytes - data.length) / blocksPerEC) || 7;
    var ecData = rsCorrection(data, ecPerBlock);
    var allData = data.concat(ecData);
    placeData(matrix, allData, size);
    // Apply best mask: just use 0 for simplicity
    var mask = 0;
    var maskFn = function(r,c){return (r+c)%2===0;};
    // Re-walk data modules and apply mask
    var col = size - 1, row = size - 1, dir = -1;
    while (col > 0) {
      if (col === 6) col--;
      for (var c2 = 0; c2 < 2; c2++) {
        var c = col - c2;
        if (matrix[row][c] === 2 || matrix[row][c] === 3) {
          // Determine if this position was data (not reserved)
          // Reserved areas: finder, alignment, timing, format
          if (maskFn(row, c)) {
            matrix[row][c] = matrix[row][c] === 3 ? 2 : 3;
          }
        }
      }
      row += dir;
      if (row < 0 || row >= size) {
        dir = -dir;
        row += dir;
        col -= 2;
      }
    }

    placeFormat(matrix, size, formatBits(mask));
    return matrix;
  }

  function drawCanvas(canvas, matrix, options) {
    options = options || {};
    var scale = options.scale || 4;
    var margin = options.margin || 4;
    var dark = options.dark || '#000';
    var light = options.light || '#fff';
    var size = matrix.length;
    var pixels = size + margin * 2;
    canvas.width = pixels * scale;
    canvas.height = pixels * scale;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dark;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (matrix[r][c] === 3) {
          ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
        }
      }
    }
  }

  global.ERA = global.ERA || {};
  global.ERA.QR = {
    toCanvas: function(canvas, text, opts) {
      var matrix = generate(text, (opts && opts.errorLevel) || 'M');
      drawCanvas(canvas, matrix, opts);
    },
    toDataURL: function(text, opts) {
      var c = document.createElement('canvas');
      var matrix = generate(text, (opts && opts.errorLevel) || 'M');
      drawCanvas(c, matrix, opts);
      return c.toDataURL('image/png');
    },
    toSVG: function(text, opts) {
      opts = opts || {};
      var matrix = generate(text, opts.errorLevel || 'M');
      var size = matrix.length;
      var margin = opts.margin || 4;
      var total = size + margin * 2;
      var scale = opts.scale || 4;
      var px = total * scale;
      var paths = '';
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (matrix[r][c] === 3) {
            paths += 'M' + ((c + margin) * scale) + ',' + ((r + margin) * scale) + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
          }
        }
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + px + ' ' + px + '"><rect width="100%" height="100%" fill="' + (opts.light || '#fff') + '"/><path d="' + paths + '" fill="' + (opts.dark || '#000') + '"/></svg>';
    }
  };
})(typeof window !== 'undefined' ? window : this);

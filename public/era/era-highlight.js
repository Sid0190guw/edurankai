/* era-highlight.js - lightweight syntax tokenizer
   Languages: javascript, python, sql, html, css
   API: ERA.highlight.tokenize(code, language) -> [{type, value}, ...]
        ERA.highlight.registerLanguage(name, rules)
   Token types: keyword, string, number, comment, function, operator,
                punctuation, identifier, whitespace, plain
*/
(function(global) {
  'use strict';
  var ERA = global.ERA = global.ERA || {};

  // ===== KEYWORD SETS =====
  var KW = {};
  KW.javascript = wordSet('const let var if else for while do switch case break continue return function class extends new this super import export from as default async await try catch finally throw typeof instanceof in of true false null undefined static get set yield void delete');
  KW.python = wordSet('def class if elif else for while try except finally with as import from return yield lambda True False None and or not in is pass break continue global nonlocal raise assert del');
  KW.sql = wordSetCi('SELECT FROM WHERE JOIN INNER LEFT RIGHT OUTER FULL CROSS ON GROUP BY HAVING ORDER LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER INDEX VIEW DATABASE SCHEMA AS DISTINCT UNION ALL CASE WHEN THEN ELSE END AND OR NOT IN BETWEEN LIKE IS NULL TRUE FALSE');

  function wordSet(str) {
    var s = {};
    str.split(/\s+/).forEach(function(w) { s[w] = true; });
    return s;
  }
  function wordSetCi(str) {
    var s = {};
    str.split(/\s+/).forEach(function(w) { s[w.toUpperCase()] = true; });
    return { ci: true, has: function(w) { return s[w.toUpperCase()] === true; } };
  }
  function isKeyword(set, word) {
    if (!set) return false;
    if (set.ci) return set.has(word);
    return set[word] === true;
  }

  // ===== RULE-BASED TOKENIZER =====
  // Each language is an ordered list of {regex, type, transform}.
  // regex must be anchored with ^ - we test against remaining input.
  // transform(value) can return a different type (e.g. identifier vs keyword).
  function tokenizeWithRules(code, rules, kwSet) {
    var tokens = [];
    var i = 0;
    while (i < code.length) {
      var rest = code.slice(i);
      var matched = false;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        var m = rule.regex.exec(rest);
        if (m && m.index === 0 && m[0].length > 0) {
          var type = rule.type;
          var value = m[0];
          if (rule.transform) {
            type = rule.transform(value, kwSet) || type;
          }
          tokens.push({ type: type, value: value });
          i += value.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        tokens.push({ type: 'plain', value: code[i] });
        i++;
      }
    }
    return mergePlain(tokens);
  }

  function mergePlain(tokens) {
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var last = out[out.length - 1];
      if (last && last.type === t.type && (t.type === 'plain' || t.type === 'whitespace')) {
        last.value += t.value;
      } else {
        out.push({ type: t.type, value: t.value });
      }
    }
    return out;
  }

  // ===== COMMON BUILDING BLOCKS =====
  var R = {
    whitespace: /^[ \t\r\n]+/,
    lineComment2: /^\/\/[^\n]*/,
    lineCommentHash: /^#[^\n]*/,
    lineCommentDash: /^--[^\n]*/,
    blockComment: /^\/\*[\s\S]*?\*\//,
    strDouble: /^"(?:[^"\\\n]|\\.)*"/,
    strSingle: /^'(?:[^'\\\n]|\\.)*'/,
    strTemplate: /^`(?:[^`\\]|\\.)*`/,
    strTripleDouble: /^"""[\s\S]*?"""/,
    strTripleSingle: /^'''[\s\S]*?'''/,
    // Number: optional sign handled by operator/identifier context, just match bare
    number: /^(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/,
    identifier: /^[A-Za-z_$][A-Za-z0-9_$]*/,
    identifierPlusOpenParen: /^[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/,
    operator: /^(?:===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|\*\*|=>|\?\?|\.\.\.|\?\.|<<|>>|<|>|\+|-|\*|\/|%|=|!|\?|:|&|\||\^|~)/,
    punctuation: /^[(){}\[\];,.]/
  };

  // ===== JAVASCRIPT =====
  ERA.highlight = ERA.highlight || {};
  var LANGUAGES = {};

  LANGUAGES.javascript = [
    { regex: R.whitespace, type: 'whitespace' },
    { regex: R.blockComment, type: 'comment' },
    { regex: R.lineComment2, type: 'comment' },
    { regex: R.strTemplate, type: 'string' },
    { regex: R.strDouble, type: 'string' },
    { regex: R.strSingle, type: 'string' },
    { regex: R.number, type: 'number' },
    { regex: R.identifierPlusOpenParen, type: 'function' },
    {
      regex: R.identifier,
      type: 'identifier',
      transform: function(value, kw) { return isKeyword(kw, value) ? 'keyword' : 'identifier'; }
    },
    { regex: R.operator, type: 'operator' },
    { regex: R.punctuation, type: 'punctuation' }
  ];

  // ===== PYTHON =====
  // Python adds: f-strings, triple-quoted strings, # comments
  var PY_RULES = [
    { regex: R.whitespace, type: 'whitespace' },
    { regex: R.lineCommentHash, type: 'comment' },
    { regex: R.strTripleDouble, type: 'string' },
    { regex: R.strTripleSingle, type: 'string' },
    // f-string prefix (matches f"..." or f'...' or rb"..." etc)
    { regex: /^[fFrRbBuU]{1,2}"(?:[^"\\\n]|\\.)*"/, type: 'string' },
    { regex: /^[fFrRbBuU]{1,2}'(?:[^'\\\n]|\\.)*'/, type: 'string' },
    { regex: R.strDouble, type: 'string' },
    { regex: R.strSingle, type: 'string' },
    { regex: R.number, type: 'number' },
    { regex: R.identifierPlusOpenParen, type: 'function' },
    {
      regex: R.identifier,
      type: 'identifier',
      transform: function(value, kw) { return isKeyword(kw, value) ? 'keyword' : 'identifier'; }
    },
    { regex: R.operator, type: 'operator' },
    { regex: R.punctuation, type: 'punctuation' }
  ];
  LANGUAGES.python = PY_RULES;

  // ===== SQL =====
  LANGUAGES.sql = [
    { regex: R.whitespace, type: 'whitespace' },
    { regex: R.blockComment, type: 'comment' },
    { regex: R.lineCommentDash, type: 'comment' },
    // SQL strings: single-quoted only, with '' as escape
    { regex: /^'(?:[^']|'')*'/, type: 'string' },
    // Double-quoted in SQL = identifier (Postgres) - tokenize as identifier
    { regex: /^"(?:[^"]|"")*"/, type: 'identifier' },
    { regex: R.number, type: 'number' },
    {
      regex: R.identifierPlusOpenParen,
      type: 'function',
      transform: function(value, kw) { return isKeyword(kw, value) ? 'keyword' : 'function'; }
    },
    {
      regex: R.identifier,
      type: 'identifier',
      transform: function(value, kw) { return isKeyword(kw, value) ? 'keyword' : 'identifier'; }
    },
    { regex: R.operator, type: 'operator' },
    { regex: R.punctuation, type: 'punctuation' }
  ];

  // ===== HTML =====
  // Simpler scanner: tags, attributes, comments, text
  LANGUAGES.html = [
    { regex: /^<!--[\s\S]*?-->/, type: 'comment' },
    { regex: /^<!DOCTYPE[^>]*>/i, type: 'keyword' },
    // Opening / self-closing tag
    {
      regex: /^<\/?[A-Za-z][^>]*>/,
      type: 'keyword',
      transform: function(value) {
        // Split tag into parts via simple inline tokenize? Keep whole tag as 'keyword' for simplicity.
        return 'keyword';
      }
    },
    { regex: R.whitespace, type: 'whitespace' }
    // Anything else becomes 'plain'
  ];

  // ===== CSS =====
  LANGUAGES.css = [
    { regex: R.whitespace, type: 'whitespace' },
    { regex: R.blockComment, type: 'comment' },
    // @-rules
    { regex: /^@[A-Za-z-]+/, type: 'keyword' },
    // Properties: identifier followed by colon
    { regex: /^[A-Za-z-]+(?=\s*:)/, type: 'function' },
    // Strings
    { regex: R.strDouble, type: 'string' },
    { regex: R.strSingle, type: 'string' },
    // Numbers with optional unit
    { regex: /^-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|fr|ch|ex|pt|pc|cm|mm|in)?/, type: 'number' },
    // Hex colors
    { regex: /^#[0-9a-fA-F]{3,8}\b/, type: 'number' },
    // Selectors / values - identifiers
    { regex: /^[.#&]?[A-Za-z][A-Za-z0-9_-]*/, type: 'identifier' },
    { regex: /^[{};:,()>+~*]/, type: 'punctuation' }
  ];

  // ===== PUBLIC API =====
  ERA.highlight.tokenize = function(code, language) {
    if (code == null) return [];
    language = (language || 'javascript').toLowerCase();
    // Aliases
    if (language === 'js') language = 'javascript';
    if (language === 'ts' || language === 'typescript') language = 'javascript';
    if (language === 'py') language = 'python';
    if (language === 'plain' || language === 'text') {
      return [{ type: 'plain', value: String(code) }];
    }
    var rules = LANGUAGES[language];
    if (!rules) {
      return [{ type: 'plain', value: String(code) }];
    }
    return tokenizeWithRules(String(code), rules, KW[language]);
  };

  ERA.highlight.registerLanguage = function(name, rules, keywords) {
    LANGUAGES[name.toLowerCase()] = rules;
    if (keywords) KW[name.toLowerCase()] = wordSet(keywords);
  };

  // Expose languages list (useful for UI dropdowns)
  ERA.highlight.languages = function() {
    return Object.keys(LANGUAGES);
  };

})(typeof window !== 'undefined' ? window : this);

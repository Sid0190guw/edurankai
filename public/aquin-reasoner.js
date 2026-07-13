/*
 * aquin-reasoner.js — Deep Symbolic Reasoning & Constraint-Propagation Engine
 * (real-depth build of the cognition/reasoning layer). "Reasoning" in most AI
 * products means "call an LLM." This is the honest alternative: real symbolic
 * inference you can machine-check.
 *
 * Two complementary engines, both classic and both fully implemented:
 *
 *  A) INFERENCE ENGINE — first-order Horn-clause reasoning:
 *     - unification with occurs-check
 *     - forward chaining to a deductive fixpoint
 *     - backward chaining that returns a PROOF TREE + variable bindings
 *     - all-solutions query, and contradiction detection over a conflict relation
 *
 *  B) CONSTRAINT PROPAGATION — a finite-domain CSP solver:
 *     - AC-3 arc-consistency (prunes impossible values before searching)
 *     - backtracking search with MRV (minimum-remaining-values) heuristic
 *     - detects unsatisfiable constraints early
 *
 * Every conclusion carries WHY it follows (a proof or a pruning trace) — which is
 * what real explainability requires. Educational uses proven in the tests:
 * derive learner readiness from prerequisites, diagnose a misconception as the
 * root cause, and solve a prerequisite-ordering / scheduling CSP with propagation.
 *
 * HONEST SCOPE: definite clauses over a finite fact base + finite-domain CSPs. Full
 * first-order resolution with function symbols and probabilistic/modal reasoning are
 * extensions behind the same term representation.
 */
(function () {
  // ---------- terms ----------
  function V(name) { return { v: name }; }
  function atom(pred) { return { pred: pred, args: Array.prototype.slice.call(arguments, 1) }; }
  function isVar(t) { return t && typeof t === 'object' && 'v' in t; }
  function isAtom(t) { return t && typeof t === 'object' && 'pred' in t; }
  function walk(t, s) { while (isVar(t) && s[t.v] !== undefined) t = s[t.v]; return t; }
  function occurs(v, t, s) { t = walk(t, s); if (isVar(t)) return t.v === v.v; if (isAtom(t)) return t.args.some(function (x) { return occurs(v, x, s); }); return false; }

  // most-general unifier (or null). Pure.
  function unify(a, b, s) {
    s = s || {}; a = walk(a, s); b = walk(b, s);
    if (isVar(a)) { if (isVar(b) && a.v === b.v) return s; if (occurs(a, b, s)) return null; var s1 = Object.assign({}, s); s1[a.v] = b; return s1; }
    if (isVar(b)) { if (occurs(b, a, s)) return null; var s2 = Object.assign({}, s); s2[b.v] = a; return s2; }
    if (isAtom(a) && isAtom(b)) {
      if (a.pred !== b.pred || a.args.length !== b.args.length) return null;
      for (var i = 0; i < a.args.length; i++) { s = unify(a.args[i], b.args[i], s); if (s === null) return null; }
      return s;
    }
    return a === b ? s : null;
  }
  function subst(t, s) { t = walk(t, s); if (isAtom(t)) return { pred: t.pred, args: t.args.map(function (x) { return subst(x, s); }) }; return t; }
  function key(t) { return isAtom(t) ? t.pred + '(' + t.args.map(key).join(',') + ')' : (isVar(t) ? '?' + t.v : String(t)); }
  var counter = 0;
  function rename(rule) {
    var map = {}; counter++;
    function rt(t) { if (isVar(t)) { if (!map[t.v]) map[t.v] = V(t.v + '_' + counter); return map[t.v]; } if (isAtom(t)) return { pred: t.pred, args: t.args.map(rt) }; return t; }
    return { head: rt(rule.head), body: (rule.body || []).map(rt) };
  }
  function collectVars(t) { if (isVar(t)) return [t.v]; if (isAtom(t)) return t.args.reduce(function (a, x) { return a.concat(collectVars(x)); }, []); return []; }
  function readable(goal, s) { var out = {}; collectVars(goal).forEach(function (v) { out[v] = key(walk(V(v), s)); }); return out; }

  // ---------- A) inference engine ----------
  function createReasoner() {
    var facts = [], rules = [], conflicts = [], provenance = [], known = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }

    function matchBody(body, base, s, emit) {
      if (body.length === 0) { emit(s); return; }
      var first = body[0], rest = body.slice(1);
      for (var i = 0; i < base.length; i++) { var s2 = unify(first, base[i], s); if (s2) matchBody(rest, base, s2, emit); }
    }

    var R = {
      V: V, atom: atom, provenance: provenance,
      fact: function (a) { facts.push(a); return this; },
      rule: function (head, body) { rules.push({ head: head, body: body || [] }); return this; },
      conflict: function (a, b) { conflicts.push([a, b]); return this; },
      facts: function () { return facts.map(key); },

      // FORWARD CHAINING to a fixpoint; also stashes the ground atom objects in `known`
      forwardChain: function (maxIters) {
        maxIters = maxIters || 100;
        known = facts.slice(); var seen = {}; known.forEach(function (f) { seen[key(f)] = true; });
        var derived = [];
        for (var iter = 0; iter < maxIters; iter++) {
          var added = 0;
          for (var r = 0; r < rules.length; r++) {
            var rl = rename(rules[r]);
            matchBody(rl.body, known, {}, function (s) {
              var head = subst(rl.head, s), k = key(head);
              if (!seen[k]) { seen[k] = true; known.push(head); derived.push({ fact: k, via: rules[r].head.pred }); added++; }
            });
          }
          if (added === 0) break;
        }
        rec('forward-chain', { derived: derived.length });
        return { all: known.map(key), derived: derived, objects: known.slice() };
      },

      // BACKWARD CHAINING — prove a goal, return proof tree + bindings
      prove: function (goal, opts) {
        opts = opts || {}; var maxDepth = opts.maxDepth || 40;
        var result = solve(goal, {}, 0);
        rec('prove', { goal: key(goal), proved: !!result });
        if (!result) return { proved: false };
        return { proved: true, bindings: readable(goal, result.s), proof: result.proof };

        function solve(g, s, depth) {
          if (depth > maxDepth) return null;
          g = subst(g, s);
          for (var i = 0; i < facts.length; i++) { var u = unify(g, facts[i], s); if (u) return { s: u, proof: { goal: key(subst(g, u)), by: 'fact' } }; }
          for (var r = 0; r < rules.length; r++) {
            var rl = rename(rules[r]); var u2 = unify(g, rl.head, s); if (!u2) continue;
            var subProofs = [], cur = u2, ok = true;
            for (var b = 0; b < rl.body.length; b++) { var sub = solve(rl.body[b], cur, depth + 1); if (!sub) { ok = false; break; } cur = sub.s; subProofs.push(sub.proof); }
            if (ok) return { s: cur, proof: { goal: key(subst(g, cur)), by: 'rule:' + rules[r].head.pred, from: subProofs } };
          }
          return null;
        }
      },

      // all solutions to a query variable, from the deductive closure
      query: function (goal, varName) {
        var base = this.forwardChain().objects, out = [];
        base.forEach(function (f) { var s = unify(goal, f, {}); if (s && s[varName] !== undefined) out.push(key(walk(V(varName), s))); });
        return out.filter(function (v, i, a) { return a.indexOf(v) === i; });
      },

      // contradiction detection over the closure + conflict relation
      contradictions: function () {
        var base = this.forwardChain().objects, found = [];
        conflicts.forEach(function (pair) {
          base.forEach(function (fa) {
            var sa = unify(pair[0], fa, {}); if (!sa) return;
            base.forEach(function (fb) { var sb = unify(pair[1], fb, sa); if (sb) found.push({ a: key(fa), b: key(fb) }); });
          });
        });
        rec('contradictions', { count: found.length });
        return found;
      }
    };
    return R;
  }

  // ---------- B) constraint propagation (finite-domain CSP) ----------
  // vars: { name: [values...] }   constraints: [ {x, y, ok:(a,b)->bool} ]  (binary)
  function createCSP() {
    var domains = {}, constraints = [], provenance = [];
    function rec(op, d) { provenance.push({ op: op, at: Date.now(), detail: d || null }); }
    var C = {
      provenance: provenance,
      variable: function (name, values) { domains[name] = values.slice(); return this; },
      constrain: function (x, y, ok) { constraints.push({ x: x, y: y, ok: ok }); constraints.push({ x: y, y: x, ok: function (a, b) { return ok(b, a); } }); return this; },

      // AC-3 arc consistency: prune values that can never satisfy a constraint
      ac3: function () {
        var dom = {}; Object.keys(domains).forEach(function (k) { dom[k] = domains[k].slice(); });
        var queue = constraints.map(function (c) { return [c.x, c.y]; });
        var prunings = 0;
        while (queue.length) {
          var arc = queue.shift(), xi = arc[0], xj = arc[1];
          if (revise(dom, xi, xj)) {
            prunings++;
            if (dom[xi].length === 0) { rec('ac3', { result: 'unsatisfiable', variable: xi }); return { consistent: false, domains: dom, unsatisfiable: xi }; }
            constraints.filter(function (c) { return c.y === xi && c.x !== xj; }).forEach(function (c) { queue.push([c.x, xi]); });
          }
        }
        rec('ac3', { result: 'arc-consistent', prunings: prunings });
        return { consistent: true, domains: dom, prunings: prunings };
      },

      // full solve: AC-3 then backtracking search with MRV
      solve: function () {
        var pre = this.ac3(); if (!pre.consistent) return { solved: false, reason: 'AC-3 proved unsatisfiable at ' + pre.unsatisfiable };
        var result = backtrack({}, pre.domains);
        rec('solve', { solved: !!result });
        return result ? { solved: true, assignment: result } : { solved: false, reason: 'no assignment satisfies all constraints' };
      }
    };

    function revise(dom, xi, xj) {
      var removed = false;
      var cs = constraints.filter(function (c) { return c.x === xi && c.y === xj; });
      if (!cs.length) return false;
      dom[xi] = dom[xi].filter(function (a) {
        // keep a only if SOME b in dom[xj] satisfies every xi-xj constraint
        var supported = dom[xj].some(function (b) { return cs.every(function (c) { return c.ok(a, b); }); });
        if (!supported) removed = true;
        return supported;
      });
      return removed;
    }
    function backtrack(assign, dom) {
      var unassigned = Object.keys(dom).filter(function (k) { return !(k in assign); });
      if (!unassigned.length) return assign;
      // MRV: pick the variable with the fewest remaining values
      unassigned.sort(function (a, b) { return dom[a].length - dom[b].length; });
      var v = unassigned[0];
      for (var i = 0; i < dom[v].length; i++) {
        var val = dom[v][i];
        if (consistentWith(assign, v, val)) {
          var a2 = Object.assign({}, assign); a2[v] = val;
          var r = backtrack(a2, dom); if (r) return r;
        }
      }
      return null;
    }
    function consistentWith(assign, v, val) {
      return constraints.filter(function (c) { return c.x === v && (c.y in assign); }).every(function (c) { return c.ok(val, assign[c.y]); });
    }
    return C;
  }

  window.AquinReasoner = { V: V, atom: atom, unify: unify, createReasoner: createReasoner, createCSP: createCSP };
})();

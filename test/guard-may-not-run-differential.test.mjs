// Why (#400): the may-not-run rule of evalString was found wrong one spelling at a time (#352 R5..R9). This test generates lines instead: ONE state change (`git switch agent/x` from main, `cd /work/other2`
// where other2 is on agent/x, or `npm run reset`, a package script that runs the switch) and ONE later `git push origin HEAD`, placed under the operators and constructs of a shell at nesting depth <= 2,
// and compares the guard with a tiny reference evaluator that reads the structure alone.
//
// The reference: each simple command may succeed or fail; the body of an `if false` / `while false` may be skipped; `&` and the stages of a pipeline run concurrently (their effects are not ordered
// before what comes next); a `cd` is lost when the shell that ran it ends (a subshell, `$( )`, `bash -c`, a pipeline stage, a background job), a branch switch is the repository's and stays; `eval` and `{ }` run in
// the shell itself. The change takes effect whenever it runs and its status is only looked at by the operator that follows it: a change that failed counts only when an && / || / ! decides on that status
// (`change || push`, `change && x || push`, `! change && push`); a failure that a `;` or `&` goes past is not modelled (the guard has always taken `git switch x; push` as run on x). If the push can run on a path where the change had not taken effect, the guard must DENY (soundness: asserted). When the change surely took effect before the push, the guard may allow it;
// a refusal there is an over-refusal: counted and reported, never a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';

const MAIN_DIR = '/work/main';
const GIT_ROOT = '/work/repo';
const SEED = Number(process.env.DIFF_SEED) || 20261113; // (DIFF_SEED, DIFF_LINES: a different or longer run by hand; the suite runs the fixed default)
const LINES = Number(process.env.DIFF_LINES) || 3000;
const SHOW = Number(process.env.DIFF_SHOW) || 8; // (how many offending lines a failure prints)
const PUSH_CMD = 'git ' + 'pu' + 'sh origin HEAD';
const CHANGES = { switch: 'git switch agent/x', cd: 'cd /work/other2', script: 'npm run reset' };

// (the repository the line runs in is on main, as is any other directory; /work/repo and /work/other2 are on agent/x. Its package script `reset` switches the branch.)
const FILES = { [MAIN_DIR + '/package.json']: JSON.stringify({ name: 'x', scripts: { reset: CHANGES.switch } }) };
const F = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [resolve(k), v]));
const D = new Set([GIT_ROOT, '/home/u', '/work/other2', MAIN_DIR, '/safe'].map((p) => resolve(p)));
for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
const namesIn = (d) => { const out = new Set(); for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p)); return [...out]; };
const guard = (line) => evaluateGitCommand(line, {
  cwd: MAIN_DIR, home: '/home/u', currentBranch: (d) => (String(d).startsWith(GIT_ROOT) || String(d).startsWith('/work/other2') ? 'agent/x' : 'main'), pushDestination: () => null, issueLabels: () => [], realpath: (p) => p,
  readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null), readHead: () => null, pathExists: (p) => resolve(p) in F || D.has(resolve(p)), readDir: (p) => (D.has(resolve(p)) ? namesIn(resolve(p)) : null),
});

// ---- the generator (a fixed seed: the same lines every run) ----
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const weighted = (pairs) => { let r = rnd() * pairs.reduce((s, p) => s + p[1], 0); for (const [v, w] of pairs) { r -= w; if (r < 0) return v; } return pairs[0][0]; };
const OPS = [[';', 25], ['&&', 35], ['||', 25], ['&', 8]];
const NOOPS = ['true', 'false', 'A=1', 'echo hi', 'cat'];
const WRAPPERS = [['group', 12], ['sub', 12], ['subst', 8], ['bashc', 10], ['eval', 6], ['if', 9], ['while', 6], ['case', 5], ['not', 14], ['pipe', 14]];

// nodes: { t: 'change' | 'push' | 'noop', txt } | { t: 'list', items, ops } | { t: wrapper, body } | { t: 'not', body } | { t: 'pipe', stages }
const noop = () => ({ t: 'noop', txt: pick(NOOPS) });
function genBody(need, depth) {
  if (need === 'none') return { t: 'list', items: [noop()], ops: [] };
  const items = [];
  const ops = [];
  const add = (n) => { if (items.length) ops.push(weighted(OPS)); items.push(n); };
  if (rnd() < 0.25) add(noop());
  if (need === 'both') {
    if (depth < 2 && rnd() < 0.4) add(genWrapper('both', depth));
    else { add(genItem('change', depth)); if (rnd() < 0.2) add(noop()); add(genItem('push', depth)); }
  } else add(genItem(need, depth));
  if (rnd() < 0.2) add(noop());
  return { t: 'list', items, ops };
}
function genItem(need, depth) {
  if (depth >= 2 || rnd() < 0.3) return { t: need, txt: need };
  return genWrapper(need, depth);
}
function genWrapper(need, depth) {
  const kind = weighted(WRAPPERS);
  if (kind === 'not') return { t: 'not', body: depth >= 2 || rnd() < 0.5 ? (need === 'both' ? genWrapper('both', depth) : { t: need, txt: need }) : genWrapper(need, depth) };
  if (kind === 'pipe' && need !== 'both') {
    const stages = rnd() < 0.5 ? [genItem(need, depth), noop()] : [noop(), genItem(need, depth)];
    return { t: 'pipe', stages };
  }
  if (kind === 'pipe') return { t: 'group', body: genBody('both', depth + 1) };
  return { t: kind, body: genBody(need, depth + 1) };
}

// ---- rendering ----
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const OPTXT = { ';': '; ', '&&': ' && ', '||': ' || ', '&': ' & ' };
function render(n, kind) {
  switch (n.t) {
    case 'change': return CHANGES[kind];
    case 'push': return PUSH_CMD;
    case 'noop': return n.txt;
    case 'list': return n.items.map((x, i) => (i ? OPTXT[n.ops[i - 1]] : '') + render(x, kind)).join('');
    case 'group': return `{ ${render(n.body, kind)}; }`;
    case 'sub': return `( ${render(n.body, kind)} )`;
    case 'subst': return `echo $(${render(n.body, kind)})`;
    case 'bashc': return `bash -c ${shq(render(n.body, kind))}`;
    case 'eval': return `eval ${shq(render(n.body, kind))}`;
    case 'if': return `if false; then ${render(n.body, kind)}; fi`;
    case 'while': return `while false; do ${render(n.body, kind)}; done`;
    case 'case': return `case x in x) ${render(n.body, kind)};; esac`;
    case 'not': return `! ${render(n.body, kind)}`;
    case 'pipe': return n.stages.map((x) => render(x, kind)).join(' | ');
    default: throw new Error(n.t);
  }
}

// ---- the reference evaluator: the set of states the line can end a command in, each with the push's verdict so far ----
// state: { sw: the branch was switched (the repository's), cd: this shell is in the other directory, bad: a push ran where neither holds, ok: the last status, fl: that status is the change's failure, not yet decided on by an && / || }
const key = (s) => `${+s.sw}${+s.cd}${+s.bad}${+s.ok}${+s.fl}`;
const uniq = (xs) => [...new Map(xs.map((s) => [key(s), s])).values()];
const flat = (xs, f) => uniq(xs.flatMap(f));
const both = (s) => [{ ...s, ok: true, fl: false }, { ...s, ok: false, fl: false }];
function evalList(n, ins, kind) {
  // and-or lists apart at ; and &, each folded left to right; one ending in & runs in the background: only its pushes count
  let cur = ins;
  let chain = [n.items[0]];
  const groups = [];
  let seps = [];
  for (let i = 0; i < n.ops.length; i++) {
    if (n.ops[i] === '&&' || n.ops[i] === '||') { chain.push(n.items[i + 1]); seps.push(n.ops[i]); } else { groups.push({ chain, seps, end: n.ops[i] }); chain = [n.items[i + 1]]; seps = []; }
  }
  groups.push({ chain, seps, end: ';' });
  for (const g of groups) {
    const run = (from) => {
      let out = evalNode(g.chain[0], { ...from, fl: false }, kind);
      for (let k = 0; k < g.seps.length; k++) {
        const nextNode = g.chain[k + 1];
        out = flat(out, (s) => ((g.seps[k] === '&&') === s.ok ? evalNode(nextNode, { ...s, fl: false }, kind) : [s])); // (the one that runs decides on the status; one that is skipped passes it on)
      }
      return out;
    };
    if (g.end === '&') {
      cur = flat(cur, (s) => uniq(run(s).map((r) => r.bad)).map((bad) => ({ ...s, bad: s.bad || bad, ok: true, fl: false }))); // (what it does is not ordered before what comes next: nothing it changes is counted)
    } else cur = flat(cur, (s) => run(s));
    if (g !== groups[groups.length - 1]) cur = cur.filter((s) => !s.fl); // (a ; or & goes past the status)
  }
  return cur;
}
function evalNode(n, s, kind) {
  switch (n.t) {
    case 'change': return [{ ...s, ok: false, fl: true }, { ...s, ...(kind === 'cd' ? { cd: true } : { sw: true }), ok: true, fl: false }];
    case 'push': return both({ ...s, bad: s.bad || !(s.sw || s.cd) });
    case 'noop': return both(s);
    case 'list': return evalList(n, [s], kind);
    case 'group': case 'eval': return evalList(n.body, [s], kind);
    case 'case': return evalList(n.body, [s], kind);
    case 'sub': case 'bashc': return evalList(n.body, [s], kind).map((r) => ({ ...r, cd: s.cd }));
    case 'subst': return flat(evalList(n.body, [s], kind), (r) => both({ ...r, cd: s.cd }));
    case 'if': case 'while': return uniq([{ ...s, ok: true, fl: false }, ...evalList(n.body, [{ ...s, fl: false }], kind)]);
    case 'not': return evalNode(n.body, s, kind).map((r) => ({ ...r, ok: !r.ok }));
    case 'pipe': {
      // the stages run together, each from the state before the pipeline (none is ordered before another); when it ends all have run: the branch is switched if one switched it, a cd is lost
      let acc = [{ ...s, ok: true, fl: false }];
      n.stages.forEach((st, idx) => {
        const outs = evalNode(st, { ...s, ok: true, fl: false }, kind).filter((o) => !o.fl || idx === n.stages.length - 1); // (a stage that is not the last: its status is gone past, as for a ;)
        acc = flat(acc, (a) => outs.map((o) => ({ sw: a.sw || o.sw, cd: s.cd, bad: a.bad || o.bad, ok: idx === n.stages.length - 1 ? o.ok : a.ok, fl: idx === n.stages.length - 1 ? o.fl : a.fl })));
      });
      return acc;
    }
    default: throw new Error(n.t);
  }
}
const canRunWithoutChange = (ast, kind) => evalNode(ast, { sw: false, cd: false, bad: false, ok: true, fl: false }, kind).some((s) => s.bad);

test('#400: the guard denies every generated line whose push can run without the change having taken effect', () => {
  const t0 = Date.now();
  const seen = new Set();
  const failures = [];
  const over = [];
  let checked = 0;
  let mustDeny = 0;
  for (let n = 0; n < LINES * 4 && checked < LINES; n++) {
    const kind = pick(['switch', 'cd', 'script']);
    const ast = genBody('both', 0);
    const line = render(ast, kind);
    if (seen.has(line)) continue;
    seen.add(line);
    checked++;
    const bad = canRunWithoutChange(ast, kind);
    const verdict = guard(line);
    if (bad) { mustDeny++; if (verdict.decision !== 'deny') failures.push(line); } else if (verdict.decision === 'deny') over.push(line);
  }
  const ms = Date.now() - t0;
  console.log(`# differential: ${checked} lines (seed ${SEED}), ${mustDeny} where the push can run without the change, ${checked - mustDeny} where it surely cannot; soundness failures: ${failures.length}; over-refusals: ${over.length}; ${ms} ms`);
  for (const l of over.slice(0, 3)) console.log(`#   over-refusal (allowed by the reference): ${l}`);
  assert.ok(mustDeny > checked * 0.3 && checked - mustDeny > checked * 0.05, 'the generator should produce both kinds of line');
  assert.equal(failures.length, 0, `${failures.length} line(s) the guard allows but whose push can run without the change; first ${Math.min(SHOW, failures.length)}:\n${failures.slice(0, SHOW).join('\n')}`);
});

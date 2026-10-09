// Why: agents and the owner share one GitHub identity, so this evaluator is the local barrier against an agent
// approving or merging its own work. It decides, for one Bash/PowerShell command line, whether any hidden simple
// command (see shell-parse.mjs) pushes to main/master, force-pushes, admin-merges, edits protection/rulesets/repo
// settings, adds an owner-only approval label, removes a guard label, or closes a pause/rollback issue.
// Pure on purpose (branch, push-destination and label lookups are injected) so tests and `pipeline job start` share it.
// Policy: anything we cannot verify is denied (unknown branch, lookup failure, truncated parse, run-time labels).
// It also tracks what earlier commands on the SAME line change (checkout/switch/branch -m, upstream and push config,
// variables, aliases) so `git checkout main && git push` is judged against main, and it covers the same-intent routes
// (gh api label/issue/merge/contents/status/check endpoints, also under the numeric `repositories/{id}/...` alias and
// with repeated slashes or dot segments, `--label` on create, a graphql mutation allowlist, `--input` bodies)
// because "use the API instead" is the first thing a blocked agent tries.
// Residual (documented): label approval is protected against accidental and casual misuse, not an agent that writes
// its own API client or script; aliases defined in git/gh config files, push.default=matching, remote.*.push set in
// config files, and checkouts that happen inside scripts are not seen.
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandName, simpleCommands, splitArgs, scriptFileOf, scriptFeedsOf, startupFilesOf } from './shell-parse.mjs';
import { catchAllReason, guardedCommandText } from './guarded-text.mjs';
import { scriptCandidates, defaultReadDir, defaultReadHead, isShellHead, newEvalBudget, checkDeadline, countScript, substitute, GuardLimit } from './script-candidates.mjs';

const PROTECTED_BRANCHES = ['main', 'master'];
const APPROVAL_LABELS = ['human-approved', 'test-change-approved'];
const GUARD_LABELS = ['needs-human', 'pipeline-blocked', 'awaiting-review', 'pipeline-pause', 'pipeline-rollback'];
const HOLD_LABELS = ['pipeline-pause', 'pipeline-rollback'];
const ALL_LABELS = [...APPROVAL_LABELS, ...GUARD_LABELS];
const MAX_NESTING = 5;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_LINE_CHARS = 200_000; // a longer command line is not parsed (the hook has a 15 s budget)
const OWNER_ONLY = 'This is reserved for the repository owner.';

// The only graphql mutations an agent may run (comments, PR lifecycle, review threads). Everything else is denied.
const GRAPHQL_ALLOWED_MUTATIONS = new Set([
  'addComment', 'updateIssueComment', 'createPullRequest', 'enablePullRequestAutoMerge', 'disablePullRequestAutoMerge',
  'markPullRequestReadyForReview', 'convertPullRequestToDraft', 'addPullRequestReview', 'resolveReviewThread', 'minimizeComment',
]);
const PUSH_LONG_VALUE = ['repo', 'receive-pack', 'exec', 'push-option', 'recurse-submodules'];
const GIT_GLOBAL_VALUE = ['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'];
const API_LONG_VALUE = ['method', 'field', 'raw-field', 'header', 'input', 'jq', 'template', 'preview', 'hostname', 'cache'];
const VAR_BUILTINS = ['export', 'declare', 'typeset', 'local', 'readonly'];
const DYNAMIC = /[$`]/;
const RUN_TIME_SUBCOMMAND = 'the git / gh subcommand is only known at run time ($VAR expansion, ${...}, $(...) or backticks), so what it does cannot be verified. Write the subcommand out literally.';
// The only run-time destinations a push may use: "whatever branch I am on" (the branch itself is then checked).
const CURRENT_BRANCH_IDIOM = /^(?:\$\(|`)\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+--short\s+HEAD)\s*(?:\)|`)$/;
// Config the environment can inject into git (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS, GIT_CONFIG_GLOBAL/SYSTEM).
const GIT_ENV_CONFIG = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)$/i;
// Config that can redirect a bare `git push` somewhere the branch name does not suggest.
const RISKY_CONFIG = (key, value) => /^remote\..*\.push$/.test(key) || /^branch\./.test(key)
  || (key === 'push.default' && /^(upstream|tracking|matching)$/i.test(value));

const deny = (reason) => ({ decision: 'deny', reason });
const allowed = () => ({ decision: 'allow', reason: '' });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// lowercase basename without .exe/.cmd/.bat/.com; handles /usr/bin/git and C:\Git\bin\GIT.EXE alike
const baseName = (w) => commandName(w);
// A command the parser could only partly resolve (`$g push`, `bash -c "$X"`, `curl … | sh`) is judged by what it mentions.
const GUARDED_WORDS = /push|merge|human-approved|test-change-approved|needs-human|pipeline-pause|pipeline-rollback|pipeline-blocked|awaiting-review|protection|ruleset|issue\s+close/i;
const isProtectedBranch = (b) => PROTECTED_BRANCHES.includes(String(b).toLowerCase());
const isPrefixOf = (name, full, min = 1) => name.length >= min && full.startsWith(name);
// Label names are case-insensitive on GitHub; a name only counts when it is not part of a longer one.
const labelRe = (name) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, 'i');
const mentionsAny = (text, names) => names.some((n) => labelRe(n).test(text));
const splitLabels = (v) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const stripHeads = (b) => String(b).replace(/^refs\/heads\//, '').replace(/^heads\//, '');

function defaultReadText(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_INPUT_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Minimal getopt: long flags (--x, --x=v, optionally abbreviated), short clusters (-fu, -oVALUE, -X=VALUE) and
// positionals. `longValue` / `shortValue` list the flags that consume a value. Treating an unknown value-taking
// flag as boolean is harmless (its value just becomes a positional); the reverse would swallow real flags, so
// only list flags that really take a value.
function parseOpts(args, { longValue = [], shortValue = '', abbrev = false } = {}) {
  const flags = [];
  const positionals = [];
  const takesValue = (name) => longValue.some((v) => (abbrev ? name.length >= 2 && v.startsWith(name) : v === name));
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) flags.push({ name: t.slice(2, eq), short: false, value: t.slice(eq + 1) });
      else flags.push({ name: t.slice(2), short: false, value: takesValue(t.slice(2)) ? (args[++i] ?? '') : null });
    } else if (t.length > 1 && t[0] === '-') {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k];
        if (!shortValue.includes(ch)) { flags.push({ name: ch, short: true, value: null }); continue; }
        let value = t.slice(k + 1);
        if (value.startsWith('=')) value = value.slice(1);
        else if (value === '') value = args[++i] ?? '';
        flags.push({ name: ch, short: true, value });
        break;
      }
    } else positionals.push(t);
  }
  return { flags, positionals };
}

const flagValues = (flags, longNames, shortNames = '') => flags
  .filter((f) => (f.short ? shortNames.includes(f.name) : longNames.includes(f.name)) && f.value !== null)
  .map((f) => f.value);

// ---- directories, variables, branch state ---------------------------------------------------------------------

// $NAME / ${NAME} that an earlier command on the same line assigned; anything else is left as written.
// A value is substituted as written (never expanded again), but a long value used in many words still multiplies, so the
// text produced is capped per result and per evaluation (substitute throws GuardLimit, which evaluateGitCommand denies).
function expandVars(text, ctx) {
  return substitute(ctx.budget, String(text), /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => ctx.vars[a ?? b] ?? m);
}

// What the policy's own tracking knows about variable `n` for a use the command's prefix does not override: its value, and
// `$n` when it is unsure or tainted (the callers read that as "run-time value").
const knownValues = (ctx, n) => [ctx.vars[n], unsureVar(ctx, n) ? `$${n}` : undefined];

// A variable assigned more than once in what is judged (`B=main; false && B=agent/x`) is unknown from then on: which
// assignment ran depends on control flow the parser does not model, so its value is left as `$B` (dynamic).
// Only an assignment on the line itself (level 0) makes a tainted variable known again; one inside a judged script is ignored for it.
function setVar(ctx, k, v, level) {
  if (level === 0) ctx.tainted.delete(k);
  else if (ctx.tainted.has(k)) return;
  if (k in ctx.vars || ctx.unsureVars.has(k)) { delete ctx.vars[k]; ctx.unsureVars.add(k); } else ctx.vars[k] = v;
}
const recordVars = (env, ctx, level) => { for (const k of Object.keys(env)) setVar(ctx, k, env[k], level); };

// A variable whose value is unknown: assigned more than once (or where it may not run), or tainted (a script that may
// or may not be the one sourced earlier on the line may have set it).
const unsureVar = (ctx, k) => ctx.unsureVars.has(k) || ctx.tainted.has(k);

// Every variable name assigned on the line so far, including the ones that became unknown by being assigned twice or
// tainted. Anything that inspects WHICH variables are set (not their values) must use this, never Object.keys(ctx.vars) alone.
const assignedNames = (ctx) => [...Object.keys(ctx.vars), ...ctx.unsureVars, ...ctx.tainted];

// A variable that selects the repository (GIT_DIR, GH_REPO). Only this command's own prefix (`NAME=v git …`,
// `env NAME=v git …`) is certain to reach it. An assignment or export earlier on the line may never run
// (`false && export GIT_DIR=…`), may not be exported at all, or may be overridden by control flow the parser does not
// model, so the value is unknown (`known: false`) and the caller must fail closed. `value` is undefined when unset.
function envVar(env, ctx, name) {
  if (Object.hasOwn(env, name)) return { known: true, value: env[name] };
  if (name in ctx.vars || unsureVar(ctx, name)) return { known: false, value: undefined };
  return { known: true, value: undefined };
}

// Expansion leaves `$NAME` in place for a variable assigned more than once (which assignment ran is unknown). A
// protected argument (API endpoint, label, issue number, branch, directory) written with one cannot be checked, and
// every pattern below matches the expanded text, so the whole git / gh command fails closed instead.
const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;
function unsureVarUsed(words, ctx) {
  if (ctx.unsureVars.size === 0 && ctx.tainted.size === 0) return null;
  for (const w of words) {
    for (const m of String(w).matchAll(VAR_REF)) if (unsureVar(ctx, m[1] ?? m[2])) return m[1] ?? m[2];
  }
  return null;
}

// Resolves `target` against `dir`. Returns null when the result cannot be known statically ($VAR, $(..), `cd -`).
function joinDir(dir, target, ctx) {
  if (typeof target !== 'string') return null;
  let t = expandVars(target, ctx);
  if (DYNAMIC.test(t) || t === '-') return null;
  if (t === '~' || t.startsWith('~/')) t = ctx.home + t.slice(1);
  else if (t.startsWith('~')) return null;
  if (path.isAbsolute(t)) return path.resolve(t);
  return dir === null ? null : path.resolve(dir, t);
}

function nextDir(dir, name, argv, ctx) {
  if (name === 'popd') return null;
  const args = argv.slice(1);
  const k = args.indexOf('--');
  const operands = k >= 0 ? args.slice(k + 1) : args.filter((a) => !(a.length > 1 && a[0] === '-'));
  if (operands.length === 0) return name === 'cd' ? ctx.home : null;
  return joinDir(dir, operands[0], ctx);
}

function branchOf(dir, gitDir, ctx) {
  if (dir === null) return null;
  let b;
  try { b = ctx.currentBranch(dir, { gitDir }); } catch { return null; }
  if (typeof b !== 'string') return null;
  b = b.trim().replace(/^refs\/heads\//, '');
  return b === '' || b === 'HEAD' ? null : b;
}

// A command earlier on the line may have switched this directory's branch: that, not the real checkout, is what a
// later bare/HEAD push acts on. `name === null` records "switched to something we cannot name".
function setBranch(ctx, dir, name, trackMain = false) {
  if (dir === null) return;
  if (name !== null && DYNAMIC.test(name)) name = null; // still holds `$B` / `$(…)` after expansion: unknown, not a name
  ctx.branches.set(dir, { name: name === null ? null : stripHeads(name), trackMain });
}

function effectiveBranch(dir, gitDir, ctx) {
  if (dir !== null && ctx.branches.has(dir)) {
    const o = ctx.branches.get(dir);
    return { branch: o.name, overridden: true, trackMain: o.trackMain };
  }
  return { branch: branchOf(dir, gitDir, ctx), overridden: false, trackMain: false };
}

// Where git itself says a bare `git push` would go (`rev-parse [<branch>@]{push}`, e.g. origin/main). null when unknown.
function pushDestOf(dir, gitDir, ctx, branch) {
  if (dir === null) return null;
  let d;
  try { d = ctx.pushDestination(dir, branch === undefined ? { gitDir } : { gitDir, branch }); } catch { return null; }
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

// origin/main, upstream/master, refs/heads/main, refs/remotes/origin/master, main
const isProtectedRef = (ref) => /^(?:[^/]+\/)?(?:main|master)$/i.test(ref.replace(/^refs\/(?:heads|remotes)\//, ''));

// ---- git push -------------------------------------------------------------------------------------------

const FORCE_REASON = 'force-pushing (-f, --force*, +refspec, --mirror) is blocked. Push your agent branch with a plain `git push`.';

// An argument that names a repository (URL, scp-like host:path, path) rather than a refspec.
function looksLikeRemote(p) {
  return !p.includes(':')
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)
    || /^[^\s/@:]+@[^\s:]+:/.test(p)
    || /^[A-Za-z]:[\\/]/.test(p)
    || /^[^\s:/]+\.[^\s:/]+:/.test(p);
}

function globMatchesProtected(pattern) {
  if (pattern.includes('[')) return true;
  const re = new RegExp(`^${[...pattern].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRe(c))).join('')}$`, 'i');
  return PROTECTED_BRANCHES.some((b) => re.test(b));
}

function checkRefspec(spec, dir, gitDir, ctx) {
  if (spec.startsWith('+')) return deny(FORCE_REASON);
  const colon = spec.indexOf(':');
  const src = colon < 0 ? spec : spec.slice(0, colon);
  let dst = colon < 0 ? spec : spec.slice(colon + 1);
  dst = expandVars(dst, ctx); // `B=agent/x; git push origin HEAD:$B`
  if (colon >= 0 && src === '' && dst === '') return deny('`git push <remote> :` pushes every matching branch, including main. Name your branch explicitly.');
  if (dst === '') dst = src; // `src:` is not a destination git accepts; judge it by the source name
  dst = stripHeads(dst);
  if (DYNAMIC.test(dst)) {
    // `git push origin "$(git branch --show-current)"` is common and means the current branch: accept exactly that
    // spelling (a variable that holds a literal has already been expanded above), and only when the branch is known
    // and not protected. Any other run-time text (${B:-main}, $(cat f), m${x}ain, a loop variable) can be main.
    const { branch: b } = effectiveBranch(dir, gitDir, ctx);
    if (!CURRENT_BRANCH_IDIOM.test(dst.replace(/\s+/g, ' ')) || b === null || isProtectedBranch(b)) {
      return deny(`the destination "${dst}" cannot be resolved here, so it cannot be verified. Write the branch name out: git push -u origin agent/<slug>.`);
    }
    return null;
  }
  if (dst === 'HEAD' || dst === '@') {
    const { branch: b } = effectiveBranch(dir, gitDir, ctx);
    if (b === null) return deny('cannot determine the current branch for `git push … HEAD`, so it cannot be verified. Name the destination branch explicitly.');
    dst = b;
  }
  if (isProtectedBranch(dst)) return deny(`pushing to ${dst} is blocked. Push an agent/<slug> branch and open a PR; the owner merges.`);
  if (/[*?[]/.test(dst) && globMatchesProtected(dst)) return deny(`the refspec pattern "${spec}" can update main/master. Name your branch explicitly.`);
  return null;
}

function checkPush(args, dir, gitDir, ctx, configs) {
  const { flags, positionals: rawPositionals } = parseOpts(args, { longValue: PUSH_LONG_VALUE, shortValue: 'o', abbrev: true });
  const positionals = rawPositionals.map((p) => expandVars(p, ctx));
  let repoGiven = false;
  for (const f of flags) {
    if (f.short) {
      if (f.name === 'f') return deny(FORCE_REASON);
      continue;
    }
    const n = f.name.toLowerCase();
    if (isPrefixOf(n, 'force-with-lease') || isPrefixOf(n, 'force-if-includes')) return deny(FORCE_REASON);
    if (isPrefixOf(n, 'mirror')) return deny('`git push --mirror` overwrites every remote ref, including main. It is blocked.');
    if (isPrefixOf(n, 'all') || isPrefixOf(n, 'branches')) return deny('`git push --all` pushes every branch, including main. Push your agent branch by name.');
    if (n === 'repo' || isPrefixOf(n, 'repo', 3)) repoGiven = true;
  }
  if (positionals.some((p) => p.startsWith('+'))) return deny(FORCE_REASON);
  let refspecs;
  if (repoGiven || (positionals.length && !looksLikeRemote(positionals[0]))) refspecs = positionals;
  else refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    if (dir === null) return deny('cannot tell which directory this `git push` runs in (unresolved cd / -C), so the current branch cannot be verified.');
    if (ctx.cfgDirty || ctx.envCfgDirty || configs.some((c) => RISKY_CONFIG(c.key, c.value))) {
      return deny('this line changes upstream/push configuration (git config, branch -u, -c push.default/remote.*.push), so where a bare `git push` goes cannot be verified. Push explicitly: git push -u origin HEAD:agent/<slug>.');
    }
    const { branch: b, overridden, trackMain } = effectiveBranch(dir, gitDir, ctx);
    if (overridden && trackMain) {
      return deny('the branch created earlier on this line tracks origin/main, so a bare `git push` could update main. Push explicitly: git push -u origin HEAD:agent/<slug>.');
    }
    // push.default=upstream (or a branch created from origin/main) can send agent/x to main: ask git where it goes
    const dest = overridden ? (b === null ? null : pushDestOf(dir, gitDir, ctx, b)) : pushDestOf(dir, gitDir, ctx);
    if (dest !== null && isProtectedRef(dest)) return deny(`a bare \`git push\` here would update ${dest} (the branch's push destination). Push explicitly: git push -u origin HEAD:agent/<slug>.`);
    if (b === null) return deny('cannot determine the current branch (detached HEAD, switched to an unknown ref earlier on the line, or not a repository), so a push with no refspec cannot be verified. Name the branch: `git push -u origin agent/<slug>`.');
    if (isProtectedBranch(b)) return deny(`this checkout is on ${b}; a push with no refspec would push it. Switch to an agent/<slug> branch.`);
    return null;
  }
  for (const spec of refspecs) {
    const v = checkRefspec(spec, dir, gitDir, ctx);
    if (v) return v;
  }
  return null;
}

// ---- git: global options, state tracking ------------------------------------------------------------------

function parseGitGlobal(argv, dir, env, ctx) {
  let d = dir;
  const envGitDir = envVar(env, ctx, 'GIT_DIR');
  let gitDirUnknown = !envGitDir.known; // exported twice: which repository the command acts on cannot be told
  let gitDir = typeof envGitDir.value === 'string' && envGitDir.value ? joinDir(d, envGitDir.value, ctx) : null;
  const configs = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-C') { d = joinDir(d, argv[++i], ctx); continue; }
    if (t === '-c') {
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      configs.push({ key: (eq < 0 ? kv : kv.slice(0, eq)).toLowerCase(), value: eq < 0 ? '' : kv.slice(eq + 1) });
      continue;
    }
    if (t.startsWith('--git-dir=')) { gitDir = joinDir(d, t.slice('--git-dir='.length), ctx); gitDirUnknown = false; continue; }
    if (t === '--git-dir') { gitDir = joinDir(d, argv[++i], ctx); gitDirUnknown = false; continue; }
    if (GIT_GLOBAL_VALUE.includes(t)) { i++; continue; }
    if (t.startsWith('-')) continue; // boolean global option, or --opt=value
    break;
  }
  return { d, gitDir, gitDirUnknown, configs, sub: argv[i], args: argv.slice(i + 1) };
}

// checkout / switch: which branch is the directory on afterwards?
function trackSwitch(sub, args, d, ctx) {
  const isSwitch = sub === 'switch';
  const createShort = isSwitch ? 'cC' : 'bB';
  const { flags, positionals } = parseOpts(args, {
    longValue: ['orphan', 'create', 'force-create', 'conflict', 'pathspec-from-file'],
    shortValue: createShort,
  });
  const create = flags.find((f) => (f.short ? createShort.includes(f.name) : ['create', 'force-create', 'orphan'].includes(f.name)));
  if (create) {
    const start = positionals[0];
    const noTrack = flags.some((f) => !f.short && f.name === 'no-track');
    setBranch(ctx, d, expandVars(create.value, ctx), !noTrack && start !== undefined && /^[^/]+\/(main|master)$/i.test(start));
    return;
  }
  if (flags.some((f) => (f.short ? f.name === 'd' : f.name === 'detach'))) { setBranch(ctx, d, null); return; }
  if (!isSwitch && args.includes('--')) return; // `checkout [<tree-ish>] -- <paths>` restores files only
  if (positionals.length === 0 || (!isSwitch && positionals.length > 1)) return; // paths, or nothing to switch to
  const x = expandVars(positionals[0], ctx);
  if (x === '-' || /^@\{-\d*\}$/.test(x) || DYNAMIC.test(x)) { setBranch(ctx, d, null); return; }
  if (x === 'HEAD' || x === '@') return;
  if (!isSwitch && d !== null && ctx.pathExists(path.resolve(d, x))) return; // a file on disk: path checkout, or git refuses
  setBranch(ctx, d, x);
}

function trackBranch(args, d, gitDir, ctx) {
  const { flags, positionals } = parseOpts(args, { longValue: ['set-upstream-to', 'contains', 'merged', 'no-merged', 'sort', 'format'], shortValue: 'u' });
  if (flags.some((f) => (f.short ? f.name === 'u' : ['set-upstream-to', 'unset-upstream', 'set-upstream'].includes(f.name)))) ctx.cfgDirty = true;
  if (flags.some((f) => (f.short ? 'mM'.includes(f.name) : f.name === 'move'))) {
    if (positionals.length === 1) setBranch(ctx, d, expandVars(positionals[0], ctx));
    else if (positionals.length >= 2) {
      const [from, to] = positionals.map((p) => expandVars(p, ctx));
      const { branch: cur } = effectiveBranch(d, gitDir, ctx);
      if (cur === from) setBranch(ctx, d, to);
    }
  }
}

function trackConfig(args, ctx) {
  let { flags, positionals } = parseOpts(args, { longValue: ['file', 'blob', 'type', 'default', 'comment'], shortValue: 'f' });
  let writes = positionals.length >= 2 || flags.some((f) => ['unset', 'unset-all', 'add', 'replace-all', 'remove-section', 'rename-section'].includes(f.name));
  if (['set', 'unset'].includes(positionals[0])) { writes = true; positionals = positionals.slice(1); }
  const key = String(positionals[0] ?? '').toLowerCase();
  if (key.startsWith('alias.') && positionals.length >= 2) ctx.gitAliases[key.slice('alias.'.length)] = positionals[1];
  if (writes && RISKY_CONFIG(key, String(positionals[1] ?? ''))) ctx.cfgDirty = true;
}

function trackGit(sub, args, g, ctx) {
  const { d } = g;
  if (sub === 'checkout' || sub === 'switch') trackSwitch(sub, args, d, ctx);
  else if (sub === 'branch') trackBranch(args, d, g.gitDir, ctx);
  else if (sub === 'config') trackConfig(args, ctx);
  else if (sub === 'rebase') {
    // `git rebase <upstream> <branch>` checks <branch> out first
    const { positionals } = parseOpts(args, { longValue: ['onto', 'exec', 'strategy', 'strategy-option', 'whitespace'], shortValue: 'xsXC' });
    if (positionals.length >= 2) setBranch(ctx, d, DYNAMIC.test(positionals[1]) ? null : expandVars(positionals[1], ctx));
  } else if (sub === 'symbolic-ref') {
    const { positionals } = parseOpts(args, { shortValue: 'm' });
    if (positionals.length === 2 && positionals[0] === 'HEAD') setBranch(ctx, d, positionals[1]);
  } else if (sub === 'worktree' && args[0] === 'add') {
    const { flags, positionals } = parseOpts(args.slice(1), { longValue: ['reason'], shortValue: 'bB' });
    const target = joinDir(d, positionals[0], ctx);
    const named = flags.find((f) => f.short && 'bB'.includes(f.name));
    if (target === null) return;
    if (named) setBranch(ctx, target, expandVars(named.value, ctx));
    else if (flags.some((f) => !f.short && f.name === 'detach')) setBranch(ctx, target, null);
    else if (positionals[1] !== undefined) setBranch(ctx, target, DYNAMIC.test(positionals[1]) ? null : expandVars(positionals[1], ctx));
    else setBranch(ctx, target, path.basename(target));
  }
}

function checkGit(argv, env, dir, ctx, raw, level = 0) {
  const g = parseGitGlobal(argv, dir, env, ctx);
  const { sub, args } = g;
  if (sub === undefined) return null;
  // The subcommand must be written literally: `git $X origin main` (even with X=push on the line), `git "$(printf push)"`,
  // `git ${X}${Y:-sh}` — what git does is decided by a value the checks below would never see.
  if (DYNAMIC.test(sub)) return deny(RUN_TIME_SUBCOMMAND);
  // GIT_DIR assigned twice: the branch the checks read could belong to another repository than the one git acts on
  if (g.gitDirUnknown && (sub === 'push' || sub === 'send-pack' || sub === 'branch')) {
    return deny('GIT_DIR was assigned more than once on this line, so which repository this command acts on cannot be verified. Assign it once, or use -C / --git-dir.');
  }

  // aliases defined on this very line (`git config alias.p push && git p …`, `git -c alias.p=push p …`)
  const aliasConfig = g.configs.find((c) => c.key === `alias.${sub.toLowerCase()}`);
  if (ctx.aliasUnsure.has(`git:${sub.toLowerCase()}`)) return deny(`the git alias "${sub}" may have been (re)defined by a script that may or may not run, so what it expands to cannot be verified. Write the command out.`);
  const alias = aliasConfig ? aliasConfig.value : ctx.gitAliases[sub.toLowerCase()];
  if (alias !== undefined && level < MAX_NESTING) {
    if (alias.startsWith('!')) {
      const v = evalString(`${alias.slice(1)} ${args.map(shellQuote).join(' ')}`, g.d, ctx, level + 1);
      return v.decision === 'deny' ? v : null;
    }
    return checkGit(['git', ...splitArgs(alias), ...args], env, g.d, ctx, raw, level + 1);
  }

  if (sub === 'push' || sub === 'send-pack') { // send-pack is push without the remote configuration
    if (/\bxargs\b/.test(raw)) return deny('`xargs git push` takes its refspecs from stdin, so it cannot be verified. Push the branch by name.');
    // config handed in through the environment (this command's prefix / `env`, or an earlier assignment or export on the line)
    ctx.envCfgDirty = [...Object.keys(env), ...assignedNames(ctx)].some((k) => GIT_ENV_CONFIG.test(k));
    return checkPush(args, g.d, g.gitDir, ctx, g.configs);
  }
  trackGit(sub, args, g, ctx);
  return null;
}

// ---- gh -------------------------------------------------------------------------------------------------

// Splits `gh [-R x] <group> <verb> …` without being fooled by flags (and their values) in between.
function splitGh(args) {
  const words = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const t = args[i];
    if (t === '-R' || t === '--repo') { i++; continue; }
    if (t.startsWith('-')) continue;
    words.push(i);
    if (words.length === 1 && t.toLowerCase() === 'api') break;
  }
  return {
    group: words.length ? args[words[0]].toLowerCase() : undefined,
    verb: words.length > 1 ? args[words[1]].toLowerCase() : undefined,
    rest: args.filter((_, k) => !words.includes(k)),
  };
}

// null when GH_REPO was assigned twice and no -R names the repository: the labels cannot be looked up in the right one.
const repoArgsOf = (flags, env, ctx) => {
  const [repo] = flagValues(flags, ['repo'], 'R');
  if (repo) return ['-R', repo];
  const ghRepo = envVar(env, ctx, 'GH_REPO');
  if (!ghRepo.known) return null;
  return typeof ghRepo.value === 'string' && ghRepo.value ? ['-R', ghRepo.value] : [];
};

// Closing/deleting/transferring an issue that carries pipeline-pause or pipeline-rollback is the owner's call.
function checkIssueHold(num, repoArgs, dir, ctx, action) {
  if (DYNAMIC.test(num)) return deny(`the issue number "${num}" is built at run time, so whether it carries pipeline-pause or pipeline-rollback cannot be verified. Name the issue number.`);
  let labels;
  try {
    // no -R / GH_REPO: the repository is the directory's — unknown after a cd that may not have run
    if (dir === null && !(repoArgs && repoArgs.length)) throw new Error('cannot tell which directory (so which repository) this runs in; name it with -R owner/repo');
    labels = ctx.issueLabels(num, repoArgs, dir ?? ctx.cwd);
    if (!Array.isArray(labels)) throw new Error('unexpected lookup result');
  } catch (err) {
    return deny(`could not verify issue labels for ${num} (${err?.message ?? err}); refusing to ${action} it without knowing whether it carries pipeline-pause or pipeline-rollback.`);
  }
  const hit = labels.map((l) => String(l).trim().toLowerCase()).find((l) => HOLD_LABELS.includes(l));
  return hit ? deny(`issue ${num} carries ${hit}; only the owner may ${action} it. ${OWNER_ONLY}`) : null;
}

// Field values and --input bodies of a `gh api` call. `unknown` means part of the body cannot be read here.
// `fields` are the key=value pairs; `queries` are the graphql documents found in `query=` fields or JSON inputs.
function gatherBody(flags, dir, ctx) {
  let text = '';
  let unknown = false;
  const fields = [];
  const queries = [];
  const fromFile = (p) => {
    if (dir !== null) countScript(ctx.budget); // a file read like any other (its size is up to 1 MB), so it is counted
    const t = dir === null ? null : ctx.readText(path.resolve(dir, p));
    if (typeof t === 'string') { text += `\n${t}`; return t; }
    unknown = true;
    return null;
  };
  for (const f of flags) {
    if (f.value === null) continue;
    const typed = f.short ? f.name === 'F' : f.name === 'field';
    const raw = f.short ? f.name === 'f' : f.name === 'raw-field';
    if (typed || raw) {
      text += `\n${f.value}`;
      const eq = f.value.indexOf('=');
      const key = eq < 0 ? f.value : f.value.slice(0, eq);
      let value = eq < 0 ? '' : f.value.slice(eq + 1);
      const at = typed ? /^@(.+)$/.exec(value) : null;
      if (at) value = fromFile(at[1]) ?? '';
      fields.push({ key, value });
      if (key === 'query') queries.push(value);
    } else if (!f.short && f.name === 'input') {
      if (f.value === '-') { unknown = true; text += `\n${ctx.fullText}`; continue; }
      const t = fromFile(f.value);
      if (t === null) continue;
      try {
        const j = JSON.parse(t);
        for (const o of Array.isArray(j) ? j : [j]) if (o && typeof o.query === 'string') queries.push(o.query);
        for (const [k, v] of Object.entries(Array.isArray(j) ? {} : (j && typeof j === 'object' ? j : {}))) if (typeof v === 'string') fields.push({ key: k, value: v });
      } catch { queries.push(t); }
    }
  }
  return { text, unknown, fields, queries };
}

// ---- graphql mutation allowlist ---------------------------------------------------------------------------

// Comments and string literals removed, so braces/parens inside them cannot confuse the scanner.
const stripGraphql = (q) => q.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/#[^\n]*/g, '');

// Root field names of every `mutation` operation in a graphql document; null when the document cannot be understood.
function graphqlMutations(query) {
  const toks = stripGraphql(query).match(/\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[{}()[\]:!=@$|&]|[^\s{}()[\]:!=@$|&,]+/g) ?? [];
  const names = [];
  let i = 0;
  const skipBalanced = (open, close) => {
    let depth = 0;
    for (; i < toks.length; i++) {
      if (toks[i] === open) depth++;
      else if (toks[i] === close && --depth === 0) { i++; return true; }
    }
    return false;
  };
  while (i < toks.length) {
    const t = toks[i];
    if (t === '(') { if (!skipBalanced('(', ')')) return null; continue; }
    if (t === '{') { if (!skipBalanced('{', '}')) return null; continue; }
    if (t !== 'mutation') { i++; continue; }
    i++;
    while (i < toks.length && toks[i] !== '{') {
      if (toks[i] === '(') { if (!skipBalanced('(', ')')) return null; } else i++; // operation name, variable definitions
    }
    if (i >= toks.length) return null;
    let depth = 0;
    for (; i < toks.length; i++) {
      const x = toks[i];
      if (x === '{' || x === '(' || x === '[') depth++;
      else if (x === '}' || x === ')' || x === ']') { if (--depth === 0) { i++; break; } }
      else if (depth === 1) {
        if (x === '...') return null; // fragment spread / inline fragment at the root: cannot tell what runs
        if (/^[A-Za-z_]/.test(x) && toks[i - 1] !== '@' && toks[i + 1] !== ':') names.push(x);
      }
    }
    if (depth !== 0) return null;
  }
  return names;
}

function checkGraphql(body) {
  for (const q of body.queries) {
    if (/^\s*(\$\(|`|\$\{?[A-Za-z_])/.test(q)) return deny('the graphql query is built at run time, so it cannot be verified. Pass the query text directly.');
    const names = graphqlMutations(q);
    if (names === null) return deny('the graphql query contains a mutation that cannot be parsed, so it cannot be verified.');
    const bad = names.find((n) => !GRAPHQL_ALLOWED_MUTATIONS.has(n));
    if (bad) return deny(`the graphql mutation ${bad} is not on the allowed list (${[...GRAPHQL_ALLOWED_MUTATIONS].join(', ')}). ${OWNER_ONLY}`);
  }
  if (body.unknown) return deny('cannot verify the graphql body (--input - / unreadable file).');
  return null;
}

// ---- gh api -----------------------------------------------------------------------------------------------

// Canonical form of an endpoint, so every rule anchored on `repos/{owner}/{repo}/...` sees what GitHub would route:
// URL host, query and fragment dropped; percent-escapes decoded; repeated slashes collapsed; `.` / `..` segments
// resolved; and the numeric alias `repositories/{id}/...` (GitHub serves the same resources there) rewritten to
// `repos/{repository-id}/{id}/...`. The `{...}` owner is a placeholder (like gh's own `{owner}`), so callers that
// need a real owner/name fall back to the current repository instead of passing a bogus `-R`.
function normaliseEndpoint(raw) {
  const e = safeDecode(String(raw ?? '').trim().replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, '').replace(/[?#].*$/, ''));
  const segs = [];
  for (const s of e.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') segs.pop();
    else segs.push(s);
  }
  if (segs.length >= 2 && segs[0].toLowerCase() === 'repositories') segs.splice(0, 2, 'repos', '{repository-id}', segs[1]);
  return segs.join('/');
}

function checkApi(rest, env, dir, ctx) {
  const { flags, positionals } = parseOpts(rest, { longValue: API_LONG_VALUE, shortValue: 'XfFHqtp' });
  const explicit = flagValues(flags, ['method'], 'X').map((m) => m.toUpperCase());
  const hasBody = flags.some((f) => (f.short ? 'fF'.includes(f.name) : ['field', 'raw-field', 'input'].includes(f.name)));
  const method = explicit.length ? (explicit.find((m) => m !== 'GET') ?? 'GET') : (hasBody ? 'POST' : 'GET');
  if (method === 'GET') return null;
  const ep = normaliseEndpoint(positionals[0]);
  const p = `/${ep}`;

  // -- published rules: protection, rulesets, repo settings, access, Actions permissions
  if (/\/branches\/.+\/protection/i.test(p)) return deny(`${method} to branch protection is blocked. ${OWNER_ONLY}`);
  if (/\/branches\/[^/]+\/rename$/i.test(p)) return deny(`renaming a branch through the API is blocked. ${OWNER_ONLY}`);
  if (/\/rulesets/i.test(p)) return deny(`${method} to rulesets is blocked. ${OWNER_ONLY}`);
  if (/^repos\/[^/]+\/[^/]+$/i.test(ep)) return deny(`${method} to repository settings is blocked. ${OWNER_ONLY}`);
  if (/\/collaborators/i.test(p)) return deny(`${method} to collaborators is blocked. ${OWNER_ONLY}`);
  if (/\/actions\/permissions/i.test(p)) return deny(`${method} to Actions permissions is blocked. ${OWNER_ONLY}`);

  const body = gatherBody(flags, dir, ctx);
  const haystack = safeDecode(`${rest.join('\n')}\n${body.text}`);
  const approval = mentionsAny(haystack, APPROVAL_LABELS);
  const guard = mentionsAny(haystack, GUARD_LABELS);
  const dynamicLabel = body.fields.some((f) => /^(labels(\[\])?|name|new_name)$/.test(f.key) && DYNAMIC.test(f.value));

  // -- labels: adding approval labels, removing/renaming guard labels, replacing or clearing a whole set
  if (/\/labels(\/|$)/i.test(p)) {
    if (dynamicLabel) return deny('the label set dynamically ($VAR / $(...)) cannot be verified. Name the label.');
    if (approval && method !== 'DELETE') return deny(`adding or editing an approval label (${APPROVAL_LABELS.join(', ')}) through the API is blocked. ${OWNER_ONLY}`);
    if (guard && ['DELETE', 'PATCH', 'PUT'].includes(method)) return deny(`removing or renaming a guard label (${GUARD_LABELS.join(', ')}) through the API is blocked. ${OWNER_ONLY}`);
    if (/^repos\/[^/]+\/[^/]+\/(issues|pulls)\/[^/]+\/labels$/i.test(ep)) {
      if (method === 'PUT' || method === 'DELETE') return deny('replacing or clearing all labels of an issue/PR can drop guard labels. Add or remove single labels with `gh pr edit`.');
      if (body.unknown) return deny('cannot verify the labels in the request body (--input - / unreadable file); use `gh pr edit --add-label` instead.');
    }
  }

  // -- the issue/PR object itself: labels and state live there too
  const issue = /^repos\/([^/]+)\/([^/]+)\/issues\/([^/]+)$/i.exec(ep);
  if (issue) {
    if (approval) return deny(`setting an approval label through the issue API is blocked. ${OWNER_ONLY}`);
    if (/\blabels\b/i.test(body.text)) return deny('setting `labels` through the issue API replaces the whole label set and can drop guard labels. Use `gh pr edit --add-label`.');
    if (body.unknown) return deny('cannot verify the request body (--input - / unreadable file); use `gh issue edit` instead.');
    if (/state["']?\s*[=:]\s*["']?closed/i.test(body.text)) {
      const placeholder = /[{}:]/.test(issue[1] + issue[2]);
      return checkIssueHold(issue[3], placeholder ? [] : ['-R', `${issue[1]}/${issue[2]}`], dir, ctx, 'close');
    }
  }

  // -- committing straight to a branch: only an explicit non-main branch is acceptable
  if (/\/contents\//i.test(p)) {
    const named = body.fields.find((f) => f.key === 'branch')?.value ?? /"branch"\s*:\s*"([^"]*)"/.exec(body.text)?.[1];
    if (named === undefined || DYNAMIC.test(named) || isProtectedBranch(stripHeads(named))) {
      return deny(`${method} to the contents API commits straight to a branch (the default branch unless \`branch=\` names another). Name a non-main branch with -f branch=agent/<slug>, or use git.`);
    }
  }

  // -- commit statuses and check runs: an agent posting its own `Hard-stop scan` / `Test integrity` / `pipeline-approval: *` status
  //    would forge the guard's verdict or an approval receipt. Only the pipeline-guards workflow writes them.
  if (/^repos\/[^/]+\/[^/]+\/statuses\/[^/]+$/i.test(ep)) return deny(`${method} to the commit statuses API is blocked: the guard statuses and approval receipts are written only by the pipeline-guards workflow. ${OWNER_ONLY}`);
  if (/^repos\/[^/]+\/[^/]+\/check-(runs|suites)(\/|$)/i.test(ep)) return deny(`${method} to the checks API is blocked: check results are written only by CI. ${OWNER_ONLY}`);

  // -- merging or moving main without going through the merge gate
  if (method === 'PUT' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(ep)) return deny(`merging through the API bypasses the merge gate, like --admin. ${OWNER_ONLY}`);
  if (method === 'POST' && /\/merges$/i.test(p)) return deny(`merging branches through the API can move main without a PR. ${OWNER_ONLY}`);
  if (/\/git\/refs\/heads\/(main|master)$/i.test(p)) return deny(`${method} to the main/master ref is a push to main. It is blocked.`);
  if (method === 'POST' && /\/git\/refs$/i.test(p) && /refs\/heads\/(main|master)\b/i.test(haystack)) return deny('creating the main/master ref through the API is blocked.');

  if (/^graphql$/i.test(ep)) return checkGraphql(body);
  return null;
}

function checkGh(argv, env, dir, ctx, raw, level = 0) {
  // The group and verb must be written literally (`gh pr $X`, `gh pr ${X%-base}`, `gh pr "$(printf merge)"`): a variable's
  // value on the line is not proof — `X=merge; true || X=view; gh pr $X` runs merge.
  const written = splitGh(argv.slice(1));
  if ((written.group !== undefined && DYNAMIC.test(written.group)) || (written.verb !== undefined && DYNAMIC.test(written.verb))) return deny(RUN_TIME_SUBCOMMAND);
  const args = argv.slice(1).map((a) => expandVars(a, ctx));
  const { group, verb, rest } = splitGh(args);
  if (!group) return null;

  // aliases: `gh alias set NAME EXPANSION` is checked as if it ran, and a name defined on this line is expanded
  if (group === 'alias' && verb === 'set') {
    const { flags, positionals } = parseOpts(rest, { shortValue: '' });
    const [name, expansion] = positionals;
    if (name !== undefined && expansion !== undefined) {
      const shell = expansion.startsWith('!') || flags.some((f) => f.name === 's' || f.name === 'shell');
      ctx.ghAliases[name.toLowerCase()] = { expansion, shell };
      const v = shell ? evalString(expansion.replace(/^!/, ''), dir, ctx, level + 1) : checkGh(['gh', ...splitArgs(expansion)], env, dir, ctx, raw, level + 1);
      if (v && v.decision === 'deny') return deny(`gh alias "${name}" would expand to a blocked command: ${v.reason}`);
    }
    return null;
  }
  if (ctx.aliasUnsure.has(`gh:${group}`)) return deny(`the gh alias "${group}" may have been (re)defined by a script that may or may not run, so what it expands to cannot be verified. Write the command out.`);
  const alias = ctx.ghAliases[group];
  if (alias !== undefined && level < MAX_NESTING) {
    if (alias.shell) {
      const v = evalString(`${alias.expansion.replace(/^!/, '')} ${[verb, ...rest].filter((x) => x !== undefined).map(shellQuote).join(' ')}`, dir, ctx, level + 1);
      return v.decision === 'deny' ? v : null;
    }
    return checkGh(['gh', ...splitArgs(alias.expansion), ...args.slice(1)], env, dir, ctx, raw, level + 1);
  }

  if (group === 'api') return checkApi(rest, env, dir, ctx);

  if (group === 'repo' && ['edit', 'delete', 'rename'].includes(verb)) return deny(`\`gh repo ${verb}\` changes repository settings and is blocked. ${OWNER_ONLY}`);
  if ((group === 'ruleset' || group === 'rs') && ['create', 'edit', 'update', 'delete'].includes(verb)) return deny(`\`gh ruleset ${verb}\` is blocked. ${OWNER_ONLY}`);

  if (group === 'label' && (verb === 'delete' || verb === 'edit')) {
    const { positionals } = parseOpts(rest, { longValue: ['color', 'description', 'name', 'repo'], shortValue: 'cdnR' });
    const name = (positionals[0] ?? '').toLowerCase();
    if (ALL_LABELS.includes(name)) return deny(`\`gh label ${verb} ${name}\` would break a pipeline label and is blocked. ${OWNER_ONLY}`);
    return null;
  }

  if (group === 'pr' && verb === 'merge') {
    if (rest.some((t) => t === '--admin' || t.startsWith('--admin='))) return deny(`\`gh pr merge --admin\` bypasses the merge gate and is blocked. Use \`--auto\` / the pipeline merge command. ${OWNER_ONLY}`);
    return null;
  }

  if ((group === 'pr' || group === 'issue') && (verb === 'edit' || verb === 'create')) {
    const { flags } = parseOpts(rest, { longValue: ['add-label', 'remove-label', 'label', 'repo'], shortValue: 'lR' });
    const addRaw = flagValues(flags, ['add-label', 'label'], 'l');
    const removeRaw = flagValues(flags, ['remove-label']);
    if ([...addRaw, ...removeRaw].some((v) => DYNAMIC.test(v))) {
      return deny('the label set dynamically ($VAR / $(...)) cannot be verified against the owner-only labels. Name the label literally.');
    }
    const bad = addRaw.flatMap(splitLabels).find((l) => APPROVAL_LABELS.includes(l));
    if (bad) return deny(`adding the approval label ${bad} is blocked. ${OWNER_ONLY} Ask the owner to review and add it.`);
    const kept = removeRaw.flatMap(splitLabels).find((l) => GUARD_LABELS.includes(l));
    if (kept) return deny(`removing the guard label ${kept} is blocked. ${OWNER_ONLY}`);
    return null;
  }

  if (group === 'issue' && ['close', 'delete', 'transfer'].includes(verb)) {
    const { flags, positionals } = parseOpts(rest, { longValue: ['repo', 'comment', 'reason'], shortValue: 'Rcr' });
    // `transfer N DEST` has the destination second; close/delete take every number given
    const numbers = verb === 'transfer' ? positionals.slice(0, 1) : positionals;
    if (numbers.length === 0) {
      return /\bxargs\b/.test(raw) ? deny('`xargs gh issue ' + verb + '` takes the issue number from stdin, so it cannot be checked for pipeline-pause/pipeline-rollback. Name the issue number.') : null; // gh refuses a missing number itself
    }
    for (const n of numbers) {
      const repoArgs = repoArgsOf(flags, env, ctx);
      if (repoArgs === null) return deny('GH_REPO was assigned more than once on this line, so the repository this issue belongs to cannot be verified. Pass -R OWNER/REPO.');
      const v = checkIssueHold(n, repoArgs, dir, ctx, verb);
      if (v) return v;
    }
  }
  return null;
}

// ---- pipeline job runner --------------------------------------------------------------------------------

const shellQuote = (w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`);

// `node …/pipeline.mjs job start NAME [opts] -- CMD…` (or `pipeline job start …`) runs CMD detached; judge CMD itself.
// Returns the command lines to evaluate, or null. The runner may spawn the words as argv (`bash -c 'git push'`
// stays one script word, so re-quote them) or hand the joined text to a shell (`-- "git push origin main"` is one
// word that a shell would split), so both readings are judged and either one can deny.
// Recognised when argv[0] is the pipeline entry or a JS runtime followed by it (variables expanded first), or
// when the words contain `job start NAME --` anywhere (an unresolved `$P job start x -- …`).
function jobStartCommands(argv, ctx) {
  const w = argv.map((a) => expandVars(a, ctx));
  const first = baseName(w[0]);
  if (first === 'echo' || first === 'printf') return null;
  const isEntry = (x) => /^pipeline(\.mjs)?$/.test(baseName(x));
  let k = -1;
  if (isEntry(w[0]) || ['node', 'nodejs', 'bun', 'deno', 'npx'].includes(first)) {
    const limit = Math.min(w.length, 10);
    for (let j = isEntry(w[0]) ? 0 : 1; j < limit; j++) {
      if (isEntry(w[j])) { k = j; break; }
    }
  }
  let at = -1; // index of `job` in `job start`
  if (k >= 0) {
    for (let j = k + 1; j < Math.min(w.length - 1, k + 6); j++) if (w[j] === 'job' && w[j + 1] === 'start') { at = j; break; }
  }
  if (at < 0) {
    for (let j = 0; j + 3 < w.length; j++) if (w[j] === 'job' && w[j + 1] === 'start' && w[j + 3] === '--') { at = j; break; }
  }
  if (at < 0) return null;
  const dd = w.indexOf('--', at + 2);
  const cmd = dd >= 0 ? w.slice(dd + 1) : w.slice(at + 3); // no `--`: everything after NAME
  return [...new Set([cmd.map(shellQuote).join(' '), cmd.join(' ')])].filter((s) => s.trim());
}

// ---- script files and strings the parser cannot unwrap ----------------------------------------------------

const SHEBANG_PROGRAM = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(\S+)/;
const isNodeModulesOrPipelineHome = (p) => /[\\/]node_modules[\\/]/.test(p) || /[\\/]\.claude[\\/]pipeline[\\/]/.test(p);

// `bash push.sh`, `source f`, `./f`, `node f.mjs`: read the file (up to 1 MB) from the directory the command runs in and judge
// it like the same text typed on the line. A shell script that exists but cannot be read is denied (what runs is
// unknown); one that does not exist runs nothing. Programs run by path and interpreter files are only scanned when
// readable (a binary, a huge generated file or a package under node_modules is not ours to judge).
function checkScriptFile(sf, dir, ctx, level) {
  if (sf.ambiguous) return checkCandidateScripts(sf, dir, ctx, level);
  // a candidate is a final path (a glob match, or a word already expanded): the shell never expands it a second time
  const file = sf.candidate ? sf.file : expandVars(sf.file, ctx);
  if (!sf.candidate && /^\$\{?HOME\}?(?=\/|$)/.test(file)) return checkScriptFile({ ...sf, file: ctx.home + file.replace(/^\$\{?HOME\}?/, '') }, dir, ctx, level);
  if (!sf.candidate && DYNAMIC.test(file)) {
    // quoting is lost (`'x$y.sh'` reads as `x$y.sh`): if the word as written is a file, judge it before the textual rule
    const lit = checkScriptFile({ kind: sf.kind, file: sf.file, candidate: true }, dir, ctx, level);
    if (lit) return lit;
    return sf.kind !== 'exec' && GUARDED_WORDS.test(ctx.fullText)
      ? deny(`the script "${sf.file}" is named at run time and the line mentions a guarded operation, so what it runs cannot be verified. Name the file.`)
      : null;
  }
  const home = !sf.candidate && (file === '~' || file.startsWith('~/')) ? ctx.home + file.slice(1) : file;
  // a relative script after a cd that may not have run: which file runs is unknown, never the starting directory's
  // (a scan word is a guess at a file name, not a script: it is looked up in the starting directory instead)
  if (dir === null && sf.kind !== 'scan' && !path.isAbsolute(home)) return deny(`cannot tell which directory this runs in, so which ${sf.file} runs cannot be verified. Use an absolute path, or chain the cd with &&.`);
  const abs = path.resolve(dir ?? ctx.cwd, home);
  checkDeadline(ctx.budget);
  const text = ctx.readText(abs);
  if (typeof text !== 'string') {
    if (sf.candidate && ctx.readDir(abs)) return null; // a shell cannot run a directory
    if (sf.kind === 'shell' && ctx.pathExists(abs)) return deny(`cannot read the script ${sf.file} (missing permission, a directory or larger than 1 MB), so what it runs cannot be verified.`);
    // over the read cap: a program run by path is peeked at (a shell script is refused, a binary or an interpreter file is not
    // ours to judge); text a rewriting command computes from a file we cannot read cannot be scanned
    if (sf.kind === 'exec' || sf.kind === 'scan') {
      const head = ctx.readHead(abs);
      if (typeof head === 'string' && (sf.kind === 'scan' || isShellHead(head))) return deny(`${sf.file} is too large to verify (over 1 MB), so what it runs (or feeds a shell) cannot be known.`);
    }
    return null; // missing: nothing will run
  }
  countScript(ctx.budget); // every script read and judged counts, named or candidate: the work multiplies with each level
  // text a command rewrites on its way to a shell (sed, awk, base64 ...) is computed at run time: a file holding a guarded word is refused
  if (sf.kind === 'scan') return GUARDED_WORDS.test(text) ? deny(`${sf.file} is read by a command that feeds a shell, and mentions a guarded operation, so what the shell runs cannot be verified. Write the command out literally.`) : null;
  let kind = sf.kind;
  if (kind === 'exec') {
    if (text.slice(0, 4096).includes('\u0000')) return null; // a binary
    const prog = SHEBANG_PROGRAM.exec(text)?.[1] ?? '';
    kind = /^(?:node|nodejs|deno|bun|tsx|ts-node|python[\d.]*|ruby|perl|php)$/.test(prog.split('/').pop()) ? 'interp' : 'shell';
  }
  if (kind === 'interp') {
    if (isNodeModulesOrPipelineHome(abs)) return null;
    const why = guardedCommandText(text);
    return why ? deny(`the program ${sf.file} contains a guarded command (${why}); it cannot be verified by the guard. Run the operation directly.`) : null;
  }
  if (level >= MAX_NESTING) return deny(`the script ${sf.file} is nested too deeply (scripts running scripts) to verify.`);
  const v = judgeScoped(text, dir, ctx, level, sf);
  return v.decision === 'deny' ? deny(`the script ${sf.file} would run a blocked command: ${v.reason}`) : null;
}

// Variables set inside a script do not leave a child shell (`bash f.sh`, `./f`): the line's own values stay. `source` does
// change the caller's variables, which is believed for a named file; a candidate that may or may not be the sourced file
// puts the line's old values back and marks the variables it set as uncertain (a later use is also unknown at run time).
// What a script judged here may change, by ctx field:
//   vars, tainted, unsureVars     shell-local: die with a child shell (restored), a speculative source taints them (below)
//   branches                      repository state: a child really switches the branch, so a definite script's change is kept;
//                                 a speculative candidate may not run, so what it changed becomes an unknown branch
//   cfgDirty, envCfgDirty         repository/global config: only ever set, never restored (a candidate that may not run
//                                 still leaves them dirty); envCfgDirty is recomputed from vars AND tainted names
//   gitAliases, ghAliases         config on disk: kept; one a speculative candidate (re)defines is also unsure (aliasUnsure)
//   cwd, home, fullText, readers  constants of the evaluation; budget (script reads, deadline, expansion) is shared on purpose (never restored)
// (a `cd` inside a sourced file is not followed: evalString's directory is local to each call)
function judgeScoped(text, dir, ctx, level, sf) {
  if (text.length > MAX_LINE_CHARS) return judgeLongText(text);
  if (sf.sourced && !sf.candidate) return evalString(text, dir, ctx, level + 1);
  const saved = Object.assign(Object.create(null), ctx.vars);
  const savedTaint = new Set(ctx.tainted);
  const savedUnsure = new Set(ctx.unsureVars);
  const spec = sf.candidate ? { branches: new Map(ctx.branches), git: { ...ctx.gitAliases }, gh: { ...ctx.ghAliases } } : null;
  try {
    return evalString(text, dir, ctx, level + 1);
  } finally {
    if (spec) { // anything added, changed or removed: unknown (it may not have run), never the candidate's value nor the old one
      for (const d of new Set([...spec.branches.keys(), ...ctx.branches.keys()])) {
        if (spec.branches.get(d) !== ctx.branches.get(d)) ctx.branches.set(d, { name: null, trackMain: false });
      }
      for (const n of new Set([...Object.keys(spec.git), ...Object.keys(ctx.gitAliases)])) {
        if (spec.git[n] !== ctx.gitAliases[n]) ctx.aliasUnsure.add(`git:${n}`);
      }
      for (const n of new Set([...Object.keys(spec.gh), ...Object.keys(ctx.ghAliases)])) {
        if (spec.gh[n] !== ctx.ghAliases[n]) ctx.aliasUnsure.add(`gh:${n}`);
      }
    }
    const after = Object.assign(Object.create(null), ctx.vars);
    for (const k of Object.keys(ctx.vars)) delete ctx.vars[k];
    Object.assign(ctx.vars, saved);
    if (!sf.sourced) {
      // a child shell takes nothing back up, taint and unsure variables included
      ctx.tainted.clear();
      for (const k of savedTaint) ctx.tainted.add(k);
      ctx.unsureVars.clear();
      for (const k of savedUnsure) ctx.unsureVars.add(k);
    } else {
      // uncertain from here on and only ever more so: unknown to every use ($F stays $F), and a word that picks the script is refused
      for (const k of new Set([...Object.keys(after), ...Object.keys(saved)])) {
        if (after[k] === saved[k]) continue;
        ctx.tainted.add(k);
        delete ctx.vars[k];
      }
    }
  }
}

// A word before the script expands at run time (`X=+n; bash $X f.sh`, `bash $(..) f.sh`, `source $X`, `bash *.sh`), so which
// word the shell runs is unknown. Judge every word that could be it (see script-candidates.mjs) like a named script. A
// word that is still unknown (`$UNSET`) cannot be judged: denied when the line mentions a guarded operation, as for a
// script named at run time.
function checkCandidateScripts(sf, dir, ctx, level) {
  const here = path.resolve(dir ?? ctx.cwd);
  const expand = (w) => {
    let e = expandVars(w, ctx).replace(/^\$\{?HOME\}?(?=\/|$)/, ctx.home);
    if (e === '~' || e.startsWith('~/')) e = ctx.home + e.slice(1);
    return e;
  };
  // a variable a sourced script may have set picks the script: refused whatever else is on the line
  for (const w of sf.words) {
    for (const m of w.matchAll(/\$(?:\{(\w+)|(\w+))/g)) {
      if (ctx.tainted.has(m[1] ?? m[2])) return deny(`the script is picked by $${m[1] ?? m[2]}, which a script sourced earlier on the line may have set, so it cannot be verified. Name the file.`);
    }
  }
  // after a cd that may not have run, a relative word (or a glob over one) names a file in an unknown directory
  if (dir === null && sf.kind !== 'scan' && sf.words.some((w) => !path.isAbsolute(expand(w)))) return deny('cannot tell which directory this runs in, so which script it runs cannot be verified. Use an absolute path, or chain the cd with &&.');
  const c = scriptCandidates(sf, { expand, dirs: [here], joinPath: (d, r) => path.resolve(d, r), readDir: ctx.readDir, ifs: ctx.vars.IFS });
  if (c.over) return deny('too many words, a glob matching too many files, or glob syntax that cannot be resolved could be the script this command runs, so it cannot be verified. Name the script file.');
  if (c.dynamic && GUARDED_WORDS.test(ctx.fullText)) {
    return deny('which word is the script this command runs is only known at run time ($VAR / $(...) / a glob) and the line mentions a guarded operation, so it cannot be verified. Name the file and write the options literally.');
  }
  for (const file of c.files) {
    const v = checkScriptFile({ kind: sf.kind, file, candidate: true, sourced: sf.sourced }, dir, ctx, level);
    if (v) return v;
  }
  return null;
}

// ---- entry point ----------------------------------------------------------------------------------------

// The parser drops compound-command keywords but leaves them at the start of the command's raw text (`while ! gh …`,
// `do sleep 30`, `then git push`); `for` / `case` / `select` stay as the command name.
const FLOW_START = /^\s*(?:if|then|elif|else|while|until|for|do|case|select)(?=[\s;&|(){]|$)/;
// Index of the first command that may run conditionally or repeatedly because of control flow; every command from
// there on is treated that way (conservative after the loop / if ends). -1: none. 0: the whole line: a ( subshell, which
// the parser reports (it reads quotes, escapes, $'…' and heredocs like a shell, so prose such as `-m "fix (again)"` does
// not count), or a parse cut short, where a subshell may have gone unseen.
function flowStart(cmds) {
  if (cmds.subshell || cmds.truncated) return 0;
  return cmds.findIndex((c) => FLOW_START.test(c.raw ?? '') || ['for', 'case', 'select'].includes(c.argv[0]));
}
const inFlow = (from, i) => from >= 0 && i >= from;

// A command followed by | or & ran in a subshell (a pipeline stage / background job): what it assigned or changed is lost.
const ranInSubshell = (cmds, i) => cmds[i]?.sep === '|' || cmds[i + 1]?.sep === '|' || cmds[i + 1]?.sep === '&';
const VALUE_BINDERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'unset', 'let', 'printf', 'select']);
const STATE_GIT = new Set(['checkout', 'switch', 'branch', 'rebase', 'symbolic-ref', 'worktree', 'config']);

// Collects every assignment on the line BEFORE any command is judged. A name assigned more than once, or assigned
// where it may not run (after && / ||, in a pipeline, a subshell, an if / loop / case), is unsure for the whole line.
function collectAssignments(cmds, ctx) {
  const counts = new Map();
  const bump = (k, n) => counts.set(k, (counts.get(k) ?? (k in ctx.vars || ctx.unsureVars.has(k) ? 1 : 0)) + n);
  const from = flowStart(cmds);
  for (const [i, c] of cmds.entries()) {
    const n = inFlow(from, i) || c.depth > 0 || c.sep === '&&' || c.sep === '||' || ranInSubshell(cmds, i) ? 2 : 1;
    // builtins that bind a variable without a NAME=value word: its value is whatever was read / parsed at run time
    if (c.argv.length && VALUE_BINDERS.has(baseName(c.argv[0]))) {
      for (const a of c.argv.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(a);
        if (m) bump(m[1], 2);
      }
    }
    for (const k of Object.keys(c.env)) bump(k, n);
    if (c.argv.length && VAR_BUILTINS.includes(baseName(c.argv[0]))) {
      // `declare -n X=F` makes X a NAMEREF: $X reads $F at run time, while the text says "F". Unknown, like a binder.
      const nameref = c.argv.slice(1).some((a) => /^-[A-Za-z]*n[A-Za-z]*$/.test(a));
      for (const a of c.argv.slice(1)) {
        const m = (nameref ? /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/ : /^([A-Za-z_][A-Za-z0-9_]*)=/).exec(a);
        if (m) bump(m[1], nameref ? 2 : n);
      }
    }
  }
  for (const [k, n] of counts) if (n > 1) { delete ctx.vars[k]; ctx.unsureVars.add(k); }
}

// Commands that may be handed an unsure value: they print, compare, count or wait, and run nothing. An ALLOWLIST on purpose
// — a list of the commands that run code is never complete (awk's system(), sed's `e`, find -exec, tar --to-command,
// rsync -e, git aliases …). Shell keywords and the variable builtins are here because the parser emits them as commands;
// what they bind is tracked by collectAssignments and the taint pass below. Anything not listed is sensitive.
const UNSURE_OK = new Set([
  'echo', 'printf', 'test', '[', '[[', 'true', 'false', ':', 'sleep', 'seq', 'wc', 'head', 'tail', 'cat', 'sort', 'uniq',
  'cut', 'tr', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'date', 'basename', 'dirname', 'expr', 'ls', 'stat', 'pwd',
  'case', 'for', 'select', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', '!',
  'break', 'continue', 'return', 'exit', 'shift',
  ...VAR_BUILTINS, ...VALUE_BINDERS,
]);
const DIR_CHANGERS = ['cd', 'pushd', 'popd'];

// A line that defines a function (its body is parsed as if it ran — `f(){ cd /safe; }; git push` never runs the cd),
// an alias, a trap (`trap "cd …" DEBUG` runs before every command) or changes shell options / builtins can change
// where a later command runs in ways the walk below does not model: the directory and branch are unknown for the whole line.
const STATE_HAZARD_CMDS = new Set([
  'alias', 'unalias', 'trap', 'enable', 'disable', 'setopt', 'unsetopt', 'shopt', 'hash', 'functions', 'autoload',
  'zmodload', 'unfunction', 'emulate',
]);
// `set` is everywhere (`set -euo pipefail`); only an option outside these (zsh `set -o autocd`, …) is a hazard.
const SAFE_SET_ARG = /^(?:[-+][euxvfCo]+|pipefail|errexit|nounset|xtrace|verbose|noglob|noclobber|--)$/;
const isStateHazard = (c) => {
  if (!c.argv.length) return false;
  const nm = baseName(c.argv[0]);
  return STATE_HAZARD_CMDS.has(nm) || (nm === 'set' && c.argv.slice(1).some((a) => !SAFE_SET_ARG.test(a)));
};
const FUNCTION_DEF = /(?:^|[\s;&|(){])(?:function\s+[^\s(){};&|<>]+|[A-Za-z_][\w.:-]*\s*\(\s*\))/;
// `source` / `.` run a file in THIS shell: it may cd, check out a branch or reassign any variable.
const SOURCING = ['source', '.'];

// An unsure variable (assigned more than once, or where it may not run) that reaches a command whose effect may depend on
// the value — anything outside UNSURE_OK, a path or dynamic command name, or the command name itself — directly (argv,
// env prefix, a redirect such as `<<< "$F"`) or through a pipe (`echo "$F" | xargs git push`: every stage of a pipeline
// with a sensitive stage counts). Returns the variable's name, or null.
function unsureVarReachingCommand(cmds, ctx) {
  // taint: a variable assigned from an unsure one is unsure (`X=$F; bash "$X"`), to a fixed point
  const assigns = [];
  for (const c of cmds) {
    if (!c.argv.length) assigns.push(...Object.entries(c.env));
    else if (VAR_BUILTINS.includes(baseName(c.argv[0]))) {
      for (const a of c.argv.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
        if (m) assigns.push([m[1], m[2]]);
      }
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, v] of assigns) {
      if (!ctx.unsureVars.has(k) && unsureVarUsed([v], ctx) !== null) { delete ctx.vars[k]; ctx.unsureVars.add(k); changed = true; }
    }
  }
  const sensitive = (c) => {
    const head = c.argv[0];
    return !UNSURE_OK.has(baseName(head)) || head.includes('/') || DYNAMIC.test(head) || unsureVarUsed([head], ctx) !== null;
  };
  const words = (c) => [...c.argv, ...Object.values(c.env), ...(c.redirects ?? []).map((r) => r.target ?? '')];
  // pipelines: runs of commands joined by | (command-substitution bodies are commands of their own in this list)
  const groups = [];
  for (const [i, c] of cmds.entries()) {
    if (i > 0 && c.sep === '|' && groups.length) groups[groups.length - 1].push(c);
    else groups.push([c]);
  }
  for (const g of groups) {
    const live = g.filter((c) => c.argv.length);
    if (!live.some(sensitive)) continue;
    for (const c of g) {
      const hit = unsureVarUsed(words(c), ctx);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function evalString(str, startDir, ctx, level) {
  checkDeadline(ctx.budget);
  if (level > MAX_NESTING) return deny('pipeline job start / alias is nested too deeply to verify.');
  const cmds = simpleCommands(str);
  // Truncated means part of the line was never looked at, so nothing on it can be called harmless (`g''it push` after
  // 500 `true;` must not slip through on a word match).
  if (cmds.truncated) return deny('command too complex to verify (the parser gave up). Split it into simpler commands.');
  if (cmds.dynamic && GUARDED_WORDS.test(str)) {
    return deny('the command that runs is only known at run time ($VAR / $(...) / piped into a shell) and the line mentions a guarded operation, so it cannot be verified. Write the command out literally.');
  }
  // A variable whose value is not certain (see collectAssignments) denies the line when it reaches git / gh, a command
  // that runs code, cd / pushd / popd or a command name: the checks below read the expanded text.
  collectAssignments(cmds, ctx);
  if (ctx.unsureVars.size || ctx.tainted.size) {
    const unsure = unsureVarReachingCommand(cmds, ctx);
    if (unsure !== null) return deny(`$${unsure} is assigned more than once (or where it may not run) on this line, so its value at run time cannot be verified. Assign it once, unconditionally.`);
  }
  let dir = startDir;
  const from = flowStart(cmds);
  let uncertain = false; // an earlier cd / branch change may not have taken effect for the commands that follow
  const forgetState = () => { dir = null; for (const e of ctx.branches.values()) e.name = null; };
  // sticky: a later `cd /abs` does not make it known again (`alias cd=true; cd /safe`, a DEBUG trap that cds back)
  const hazard = FUNCTION_DEF.test(str) || cmds.some(isStateHazard);
  for (const [i, c] of cmds.entries()) {
    checkDeadline(ctx.budget); // a lookup (branch, labels) can take seconds; the evaluation as a whole may not
    const argv = c.argv;
    if (hazard) forgetState();
    // Only commands chained with && after it are certain to see the change (`cd d && git push`); anything else may run
    // without it (`false && cd d; git push`, `cd d &`, `(cd d)`, `cd d || git push`), so the state is unknown.
    if (uncertain && c.sep !== '&&') {
      forgetState();
      uncertain = false;
    }
    if (argv.length) {
      const nm = baseName(argv[0]);
      const changesState = DIR_CHANGERS.includes(nm) || (nm === 'git' && argv.some((w) => STATE_GIT.has(w)) && !argv.some((w) => w === '--show-current' || w === '--list' || w === '-l'));
      // `cd d || exit`: when the cd fails nothing after it runs, so the commands that do run see the change
      const orExits = cmds[i + 1]?.sep === '||' && ['exit', 'return'].includes(cmds[i + 1].argv[0]) && cmds[i + 2]?.sep !== '|' && cmds[i + 2]?.sep !== '&';
      if (changesState && (inFlow(from, i) || c.depth > 0 || c.sep === '&&' || c.sep === '||' || ranInSubshell(cmds, i) || (cmds[i + 1]?.sep === '||' && !orExits))) uncertain = true;
    }
    if (!argv.length) { recordVars(c.env, ctx, level); continue; } // a bare `NAME=value`
    const name = baseName(argv[0]);
    let verdict = null;
    if (VAR_BUILTINS.includes(name)) {
      for (const a of argv.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
        if (m) setVar(ctx, m[1], m[2], level);
      }
    } else if (name === 'cd' || name === 'pushd' || name === 'popd') dir = nextDir(dir, name, argv, ctx);
    else if (name === 'git' || name === 'gh') {
      const unsure = unsureVarUsed([...argv.slice(1), ...Object.values(c.env)], ctx);
      if (unsure !== null) verdict = deny(`$${unsure} was assigned more than once on this line, so its value (and what this ${name} command does with it) cannot be verified. Assign it once, or write the value out.`);
      else verdict = name === 'git' ? checkGit(argv, c.env, dir, ctx, c.raw ?? '') : checkGh(argv, c.env, dir, ctx, c.raw ?? '');
    }
    else {
      for (const inner of jobStartCommands(argv, ctx) ?? []) {
        const v = evalString(inner, dir, ctx, level + 1);
        if (v.decision === 'deny') { verdict = v; break; }
      }
      if (!verdict) {
        // a string or program text the parser cannot unwrap (node -e, osascript, make CMD=...) that carries a guarded command
        const why = catchAllReason(argv);
        if (why) verdict = deny(`${name} was given a string that contains a guarded command (${why}). Run the operation directly so it can be checked.`);
      }
      const sf = verdict ? null : scriptFileOf(argv, c.raw, str);
      if (sf) {
        if (name === 'source' || name === '.') sf.sourced = true;
        verdict = checkScriptFile(sf, dir, ctx, level);
      }
      // script text that reaches a shell without being named (`bash < f.sh`, `cat f.sh | bash`, `eval "$(cat f.sh)"`): its files are judged like `bash f.sh`
      if (!verdict) for (const fd of scriptFeedsOf(c, str)) { verdict = checkScriptFile(fd, dir, ctx, level); if (verdict) break; }
      // a shell runs its startup files (BASH_ENV, ENV, ZDOTDIR/.zshenv ...) before the script it was given: judged like `bash FILE`
      if (!verdict) for (const st of startupFilesOf(c, cmds, { env: ctx.env, inherited: (n) => knownValues(ctx, n), exec: sf?.kind === 'exec' })) { verdict = checkScriptFile(st, dir, ctx, level); if (verdict) break; }
    }
    if (verdict && verdict.decision === 'deny') return verdict;
    if (SOURCING.includes(name)) {
      // what the sourced file did is not modelled: every later command sees an unknown directory, branch and variables
      forgetState();
      for (const k of Object.keys(ctx.vars)) { delete ctx.vars[k]; ctx.unsureVars.add(k); }
      // the check above ran before these became unsure: run it again for what follows (`F=run.sh; source env.sh; bash "$F"`)
      const unsure = unsureVarReachingCommand(cmds.slice(i + 1), ctx);
      if (unsure !== null) return deny(`$${unsure} may be reassigned by the file ${name === '.' ? '.' : 'source'} runs, so its value at run time cannot be verified. Use it before sourcing, or write the value out.`);
    }
  }
  return allowed();
}

// Text too long to parse inside the time budget is judged by what it mentions once quotes and escapes are removed.
function judgeLongText(text) {
  return GUARDED_WORDS.test(text.replace(/['"`\\]/g, '')) ? deny('this text is too long to verify and mentions a guarded operation. Split it into simpler commands.') : allowed();
}

export function evaluateGitCommand(command, {
  cwd,
  home = os.homedir(),
  currentBranch = () => null,
  pushDestination = () => null,
  issueLabels = () => { throw new Error('no issue label lookup is available'); },
  readText = defaultReadText,
  readHead = defaultReadHead,
  pathExists = existsSync,
  readDir = defaultReadDir,
  now = Date.now, // injectable clock (tests)
  env = {}, // the hook process's environment (BASH_ENV / ENV / ZDOTDIR name startup files the shells run); {} keeps tests hermetic
} = {}) {
  const text = typeof command === 'string' ? command : String(command ?? '');
  if (text.length > MAX_LINE_CHARS) return judgeLongText(text);
  const base = cwd || process.cwd();
  const ctx = {
    cwd: base, home, currentBranch, pushDestination, issueLabels, readText, pathExists, readDir, readHead, env, budget: newEvalBudget(now), fullText: text,
    vars: Object.create(null), unsureVars: new Set(), tainted: new Set(), aliasUnsure: new Set(), gitAliases: Object.create(null), ghAliases: Object.create(null),
    branches: new Map(), cfgDirty: false, envCfgDirty: false,
  };
  // Why: a hook that throws or times out is allowed by Claude Code, so a limit hit (GuardLimit) and ANY other exception (a
  // readText that throws, a stack overflow) end here as a denial that names the cause.
  try {
    return evalString(text, path.resolve(base), ctx, 0);
  } catch (err) {
    if (err instanceof GuardLimit) return deny(err.message);
    return deny(`internal error while checking this command (${err instanceof Error ? err.message : String(err)}), so it cannot be verified.`);
  }
}

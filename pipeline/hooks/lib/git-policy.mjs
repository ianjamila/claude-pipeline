// Why: agents and the owner share one GitHub identity, so this evaluator is the local barrier against an agent
// approving or merging its own work. It decides, for one Bash/PowerShell command line, whether any hidden simple
// command (see shell-parse.mjs) pushes to main/master, force-pushes, admin-merges, edits protection/rulesets/repo
// settings, adds an owner-only approval label, removes a guard label, or closes a pause/rollback issue.
// Pure on purpose (branch, push-destination and label lookups are injected) so tests and `pipeline job start` share it.
// Policy: anything we cannot verify is denied (unknown branch, lookup failure, truncated parse, run-time labels).
// It also tracks what earlier commands on the SAME line change (checkout/switch/branch -m, upstream and push config,
// variables, aliases) so `git checkout main && git push` is judged against main, and it covers the same-intent routes
// (gh api label/issue/merge/contents endpoints, `--label` on create, a graphql mutation allowlist, `--input` bodies)
// because "use the API instead" is the first thing a blocked agent tries.
// Residual (documented): label approval is protected against accidental and casual misuse, not an agent that writes
// its own API client or script; aliases defined in git/gh config files, push.default=matching, remote.*.push set in
// config files, and checkouts that happen inside scripts are not seen.
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandName, simpleCommands, splitArgs, scriptFileOf } from './shell-parse.mjs';
import { catchAllReason, guardedCommandText } from './guarded-text.mjs';

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
// `merge-base` is read-only (it names a commit); without the lookahead, any script with a
// run-time command name that also computed a merge base for a diff was denied.
const GUARDED_WORDS = /push|merge(?!-base)|human-approved|test-change-approved|needs-human|pipeline-pause|pipeline-rollback|pipeline-blocked|awaiting-review|protection|ruleset|issue\s+close/i;
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
function expandVars(text, vars) {
  return String(text).replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => vars[a ?? b] ?? m);
}

const recordVars = (env, ctx) => { for (const k of Object.keys(env)) ctx.vars[k] = env[k]; };

// Resolves `target` against `dir`. Returns null when the result cannot be known statically ($VAR, $(..), `cd -`).
function joinDir(dir, target, ctx) {
  if (typeof target !== 'string') return null;
  let t = expandVars(target, ctx.vars);
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
  dst = expandVars(dst, ctx.vars); // `B=agent/x; git push origin HEAD:$B`
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
  const positionals = rawPositionals.map((p) => expandVars(p, ctx.vars));
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
  let gitDir = typeof env.GIT_DIR === 'string' && env.GIT_DIR ? joinDir(d, env.GIT_DIR, ctx) : null;
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
    if (t.startsWith('--git-dir=')) { gitDir = joinDir(d, t.slice('--git-dir='.length), ctx); continue; }
    if (t === '--git-dir') { gitDir = joinDir(d, argv[++i], ctx); continue; }
    if (GIT_GLOBAL_VALUE.includes(t)) { i++; continue; }
    if (t.startsWith('-')) continue; // boolean global option, or --opt=value
    break;
  }
  return { d, gitDir, configs, sub: argv[i], args: argv.slice(i + 1) };
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
    setBranch(ctx, d, expandVars(create.value, ctx.vars), !noTrack && start !== undefined && /^[^/]+\/(main|master)$/i.test(start));
    return;
  }
  if (flags.some((f) => (f.short ? f.name === 'd' : f.name === 'detach'))) { setBranch(ctx, d, null); return; }
  if (!isSwitch && args.includes('--')) return; // `checkout [<tree-ish>] -- <paths>` restores files only
  if (positionals.length === 0 || (!isSwitch && positionals.length > 1)) return; // paths, or nothing to switch to
  const x = expandVars(positionals[0], ctx.vars);
  if (x === '-' || /^@\{-\d*\}$/.test(x) || DYNAMIC.test(x)) { setBranch(ctx, d, null); return; }
  if (x === 'HEAD' || x === '@') return;
  if (!isSwitch && d !== null && ctx.pathExists(path.resolve(d, x))) return; // a file on disk: path checkout, or git refuses
  setBranch(ctx, d, x);
}

function trackBranch(args, d, gitDir, ctx) {
  const { flags, positionals } = parseOpts(args, { longValue: ['set-upstream-to', 'contains', 'merged', 'no-merged', 'sort', 'format'], shortValue: 'u' });
  if (flags.some((f) => (f.short ? f.name === 'u' : ['set-upstream-to', 'unset-upstream', 'set-upstream'].includes(f.name)))) ctx.cfgDirty = true;
  if (flags.some((f) => (f.short ? 'mM'.includes(f.name) : f.name === 'move'))) {
    if (positionals.length === 1) setBranch(ctx, d, expandVars(positionals[0], ctx.vars));
    else if (positionals.length >= 2) {
      const [from, to] = positionals.map((p) => expandVars(p, ctx.vars));
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
    if (positionals.length >= 2) setBranch(ctx, d, DYNAMIC.test(positionals[1]) ? null : expandVars(positionals[1], ctx.vars));
  } else if (sub === 'symbolic-ref') {
    const { positionals } = parseOpts(args, { shortValue: 'm' });
    if (positionals.length === 2 && positionals[0] === 'HEAD') setBranch(ctx, d, positionals[1]);
  } else if (sub === 'worktree' && args[0] === 'add') {
    const { flags, positionals } = parseOpts(args.slice(1), { longValue: ['reason'], shortValue: 'bB' });
    const target = joinDir(d, positionals[0], ctx);
    const named = flags.find((f) => f.short && 'bB'.includes(f.name));
    if (target === null) return;
    if (named) setBranch(ctx, target, expandVars(named.value, ctx.vars));
    else if (flags.some((f) => !f.short && f.name === 'detach')) setBranch(ctx, target, null);
    else if (positionals[1] !== undefined) setBranch(ctx, target, DYNAMIC.test(positionals[1]) ? null : expandVars(positionals[1], ctx.vars));
    else setBranch(ctx, target, path.basename(target));
  }
}

function checkGit(argv, env, dir, ctx, raw, level = 0) {
  const g = parseGitGlobal(argv, dir, env, ctx);
  const { sub, args } = g;
  if (sub === undefined) return null;

  // aliases defined on this very line (`git config alias.p push && git p …`, `git -c alias.p=push p …`)
  const aliasConfig = g.configs.find((c) => c.key === `alias.${sub.toLowerCase()}`);
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
    ctx.envCfgDirty = [...Object.keys(env), ...Object.keys(ctx.vars)].some((k) => GIT_ENV_CONFIG.test(k));
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

const repoArgsOf = (flags, env) => {
  const [repo] = flagValues(flags, ['repo'], 'R');
  if (repo) return ['-R', repo];
  return typeof env.GH_REPO === 'string' && env.GH_REPO ? ['-R', env.GH_REPO] : [];
};

// Closing/deleting/transferring an issue that carries pipeline-pause or pipeline-rollback is the owner's call.
function checkIssueHold(num, repoArgs, dir, ctx, action) {
  if (DYNAMIC.test(num)) return deny(`the issue number "${num}" is built at run time, so whether it carries pipeline-pause or pipeline-rollback cannot be verified. Name the issue number.`);
  let labels;
  try {
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

function normaliseEndpoint(raw) {
  let e = String(raw ?? '').trim().replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, '');
  e = e.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return safeDecode(e);
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

  // -- merging or moving main without going through the merge gate
  if (method === 'PUT' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(ep)) return deny(`merging through the API bypasses the merge gate, like --admin. ${OWNER_ONLY}`);
  if (method === 'POST' && /\/merges$/i.test(p)) return deny(`merging branches through the API can move main without a PR. ${OWNER_ONLY}`);
  if (/\/git\/refs\/heads\/(main|master)$/i.test(p)) return deny(`${method} to the main/master ref is a push to main. It is blocked.`);
  if (method === 'POST' && /\/git\/refs$/i.test(p) && /refs\/heads\/(main|master)\b/i.test(haystack)) return deny('creating the main/master ref through the API is blocked.');

  if (/^graphql$/i.test(ep)) return checkGraphql(body);
  return null;
}

function checkGh(argv, env, dir, ctx, raw, level = 0) {
  const args = argv.slice(1).map((a) => expandVars(a, ctx.vars));
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
      const v = checkIssueHold(n, repoArgsOf(flags, env), dir, ctx, verb);
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
function jobStartCommands(argv, vars) {
  const w = argv.map((a) => expandVars(a, vars));
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
  const file = expandVars(sf.file, ctx.vars);
  if (/^\$\{?HOME\}?(?=\/|$)/.test(file)) return checkScriptFile({ ...sf, file: ctx.home + file.replace(/^\$\{?HOME\}?/, '') }, dir, ctx, level);
  if (DYNAMIC.test(file)) {
    return sf.kind !== 'exec' && GUARDED_WORDS.test(ctx.fullText)
      ? deny(`the script "${sf.file}" is named at run time and the line mentions a guarded operation, so what it runs cannot be verified. Name the file.`)
      : null;
  }
  const home = file === '~' || file.startsWith('~/') ? ctx.home + file.slice(1) : file;
  const abs = path.resolve(dir ?? ctx.cwd, home);
  const text = ctx.readText(abs);
  if (typeof text !== 'string') {
    if (sf.kind === 'shell' && ctx.pathExists(abs)) return deny(`cannot read the script ${sf.file} (missing permission, a directory or larger than 1 MB), so what it runs cannot be verified.`);
    return null; // missing: nothing will run
  }
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
  const v = text.length > MAX_LINE_CHARS ? judgeLongText(text) : evalString(text, dir, ctx, level + 1);
  return v.decision === 'deny' ? deny(`the script ${sf.file} would run a blocked command: ${v.reason}`) : null;
}

// ---- entry point ----------------------------------------------------------------------------------------

function evalString(str, startDir, ctx, level) {
  if (level > MAX_NESTING) return deny('pipeline job start / alias is nested too deeply to verify.');
  const cmds = simpleCommands(str);
  // Truncated means part of the line was never looked at, so nothing on it can be called harmless (`g''it push` after
  // 500 `true;` must not slip through on a word match).
  if (cmds.truncated) return deny('command too complex to verify (the parser gave up). Split it into simpler commands.');
  if (cmds.dynamic && GUARDED_WORDS.test(str)) {
    return deny('the command that runs is only known at run time ($VAR / $(...) / piped into a shell) and the line mentions a guarded operation, so it cannot be verified. Write the command out literally.');
  }
  let dir = startDir;
  for (const c of cmds) {
    const argv = c.argv;
    if (!argv.length) { recordVars(c.env, ctx); continue; } // a bare `NAME=value`
    const name = baseName(argv[0]);
    let verdict = null;
    if (VAR_BUILTINS.includes(name)) {
      for (const a of argv.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(a);
        if (m) ctx.vars[m[1]] = m[2];
      }
    } else if (name === 'cd' || name === 'pushd' || name === 'popd') dir = nextDir(dir, name, argv, ctx);
    else if (name === 'git') verdict = checkGit(argv, c.env, dir, ctx, c.raw ?? '');
    else if (name === 'gh') verdict = checkGh(argv, c.env, dir, ctx, c.raw ?? '');
    else {
      for (const inner of jobStartCommands(argv, ctx.vars) ?? []) {
        const v = evalString(inner, dir, ctx, level + 1);
        if (v.decision === 'deny') { verdict = v; break; }
      }
      if (!verdict) {
        // a string or program text the parser cannot unwrap (node -e, osascript, make CMD=...) that carries a guarded command
        const why = catchAllReason(argv);
        if (why) verdict = deny(`${name} was given a string that contains a guarded command (${why}). Run the operation directly so it can be checked.`);
      }
      const sf = verdict ? null : scriptFileOf(argv);
      if (sf) verdict = checkScriptFile(sf, dir, ctx, level);
    }
    if (verdict && verdict.decision === 'deny') return verdict;
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
  pathExists = existsSync,
} = {}) {
  const text = typeof command === 'string' ? command : String(command ?? '');
  if (text.length > MAX_LINE_CHARS) return judgeLongText(text);
  const base = cwd || process.cwd();
  const ctx = {
    cwd: base, home, currentBranch, pushDestination, issueLabels, readText, pathExists, fullText: text,
    vars: Object.create(null), gitAliases: Object.create(null), ghAliases: Object.create(null),
    branches: new Map(), cfgDirty: false, envCfgDirty: false,
  };
  return evalString(text, path.resolve(base), ctx, 0);
}

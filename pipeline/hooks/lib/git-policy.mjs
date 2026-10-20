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
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourcePathSearch, commandName, simpleCommands, splitArgs, scriptFileOf, scriptFeedsOf, sqlShellEscapes, startupFilesOf, pathValuesOf, isEqualsWord, shebangShell, declAttrs, applyTransform, splicesOptions, spliceText, implicitBindsOf, ZSH_NAME_BINDERS, SHELL_SET_NAMES, withoutLiteralText, INDIRECT_EXPANSION, indirectExpansionOnLine, arithAssignedNames } from './shell-parse.mjs';
export { withoutLiteralText, INDIRECT_EXPANSION };
import { PM_RUN_ALIASES, PM_WRAPPERS, pmScriptOf, pmCannotRunScript, pmCall, pmMoverName, packageScripts, localBin, nameAtRunTimeIn, markPackageState, pkgOwnWrite, pkgMarkersFor, pmStartDirs, binIsProgram, binSite, binInterpreter, MAX_BIN_INTERPRETERS, lineNames, defaultLexists } from './package-scripts.mjs';
import { catchAllReason, guardedCommandText, dataLessArgs } from './guarded-text.mjs';
import { flattenProgram, newWriteFrame, exportRecords, writtenTo, writtenCandidates, joinedReadings, writtenNamesIn, writeSignature, unmodelledBefore, flowStart, inFlow, mayNotRun } from './line-writes.mjs';
import { ZSH_MODIFIED, zshModifiedNames, scriptCandidates, spliceLines, execLinesOf, assigningDefaults, defaultReadDir, defaultReadHead, isShellHead, newEvalBudget, checkDeadline, countScript, countReading, substitute, GuardLimit } from './script-candidates.mjs';

const PROTECTED_BRANCHES = ['main', 'master'];
const APPROVAL_LABELS = ['human-approved', 'test-change-approved'];
const GUARD_LABELS = ['needs-human', 'pipeline-blocked', 'awaiting-review', 'pipeline-pause', 'pipeline-rollback'];
const HOLD_LABELS = ['pipeline-pause', 'pipeline-rollback'];
const ALL_LABELS = [...APPROVAL_LABELS, ...GUARD_LABELS];
const MAX_NESTING = 5;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_LINE_CHARS = 200_000; // a longer command line is not parsed (the hook has a 15 s budget)
const OWNER_ONLY = 'This is reserved for the repository owner.';

// The only graphql mutations an agent may run (new comments, PR lifecycle, review threads). Everything else is denied.
// (updateIssueComment is NOT here: run events are PR comments, and editing a comment could rewrite one; docs/plans/2026-10-20-chat-mode-no-needs-human.md D1.)
const GRAPHQL_ALLOWED_MUTATIONS = new Set([
  'addComment', 'createPullRequest', 'enablePullRequestAutoMerge', 'disablePullRequestAutoMerge',
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
// A key or push.default value built at run time (`-c $K=HEAD:main`, `-c push.default=${V:-up}stream`) can be any of them.
const RISKY_CONFIG = (key, value) => DYNAMIC.test(key) || /^remote\..*\.push$/.test(key) || /^branch\./.test(key)
  || (key === 'push.default' && (DYNAMIC.test(value) || /^(upstream|tracking|matching)$/i.test(value)));

// Index of the first `sep` that is NOT inside a `${…}`, `$(…)`, `$((…))` or backtick expansion; -1 when there is none or the
// word cannot be split reliably (an unbalanced expansion, or a quote / backslash inside one, which can hide a bracket or the
// separator). -1 makes the caller treat the whole word as ONE run-time value, which is then denied: `${B:-x}` is a single
// unresolvable word, never the refspec `${B` : `-x}`.
function splitIndex(word, sep) {
  const stack = [];
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    const top = stack[stack.length - 1];
    if (c === '\\') { if (stack.length) return -1; i++; continue; }
    if (stack.length && (c === "'" || c === '"')) return -1;
    if (c === '`') { if (top === '`') stack.pop(); else stack.push('`'); continue; }
    if (c === '$' && (word[i + 1] === '{' || word[i + 1] === '(')) { stack.push(word[i + 1] === '{' ? '}' : ')'); i++; continue; }
    if (c === '(' && top === ')') { stack.push(')'); continue; }
    if (stack.length && c === top) { stack.pop(); continue; }
    if (!stack.length && c === sep) return i;
  }
  return -1;
}

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
// Run events of the two owner-stop kinds (run-events.mjs) are comments that START with this marker. Only the pipeline CLI may post them: a forged
// release would otherwise unblock a stopped PR. Matched case-insensitively on the DECODED text (percent-, \\uXXXX- and \\xXX-escapes undone).
const EVENT_MARKER = /claude-pipeline:event:owner-stop/i;
const unescapeText = (s) => safeDecode(String(s ?? '')
  .replace(/\\u\{?([0-9a-f]{4,6})\}?/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
  .replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))));
const mentionsEventMarker = (...texts) => texts.some((x) => EVENT_MARKER.test(unescapeText(x)));
const EVENT_FORGE = 'the text carries a claude-pipeline owner-stop event marker. Those comments are posted only by the pipeline CLI (P summary / P checkpoint), after the owner\'s reply. ' + 'This is reserved for the repository owner.';
const COMMENT_MUTATIONS = ['addComment', 'addPullRequestReview', 'addPullRequestReviewComment', 'addPullRequestReviewThreadReply'];
const COMMENT_UNREADABLE = 'the comment text cannot be read here (--input - / stdin / an unreadable file), so it cannot be checked for a pipeline event marker. Pass the text with --body, -f body=... or a readable file.';
// A comment text built at run time ($VAR, $(...), backticks) cannot be checked for the marker, so it is refused like an unreadable one. The one run-time form that IS
// readable: `$(cat <<'EOF' ... EOF)` (a quoted heredoc is literal; an unquoted one only when its body has no $ ` or backslash), because the heredoc body is part of the line
// the marker scan reads. Nothing may follow the delimiter on the heredoc line, and nothing else on the word may be dynamic.
const COMMENT_RUNTIME = 'the comment text is built at run time ($VAR / $(...) / backticks), so it cannot be checked for a pipeline event marker. Write the text out (a literal --body, or a quoted heredoc `"$(cat <<\'EOF\' ... EOF)"`) or pass a readable --body-file.';
const QUOTED_HEREDOC_SUBST = /\$\(\s*cat\s+<<-?\s*(['"])(\w+)\1[ \t]*\n[\s\S]*?\n[ \t]*\2[ \t]*\n?\s*\)/g;
const BARE_HEREDOC_SUBST = /\$\(\s*cat\s+<<-?\s*([A-Za-z_]\w*)[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*\n?\s*\)/g;
const runTimeText = (v) => DYNAMIC.test(String(v ?? '').replace(QUOTED_HEREDOC_SUBST, '').replace(BARE_HEREDOC_SUBST, (m, _d, body) => (/[$`\\]/.test(body) ? m : '')));
const COMMENT_ROUTE = /^repos\/[^/]+\/[^/]+\/(?:issues\/[^/]+\/comments|pulls\/[^/]+\/(?:comments|reviews))$/i;
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

// Every flag `gh pr merge` has (short: -A -b -F -d -m -r -s -t -R -h)
const GH_MERGE_LONG = ['admin', 'author-email', 'auto', 'body', 'body-file', 'delete-branch', 'disable-auto', 'help', 'match-head-commit', 'merge', 'rebase', 'repo', 'squash', 'subject'];
const GH_MERGE_SHORT = 'AbFdmrstRh';
// A boolean long flag's effective setting (the last one wins, as in gh): 'on', 'off' (also when absent) or 'bad' (a value gh would reject).
function boolFlag(flags, name) {
  const last = flags.filter((f) => !f.short && f.name === name).at(-1);
  if (!last) return 'off';
  if (last.value === null) return 'on';
  const v = last.value.toLowerCase();
  return v === '1' || v === 't' || v === 'true' ? 'on' : v === '0' || v === 'f' || v === 'false' ? 'off' : 'bad';
}

const flagValues = (flags, longNames, shortNames = '') => flags
  .filter((f) => (f.short ? shortNames.includes(f.name) : longNames.includes(f.name)) && f.value !== null)
  .map((f) => f.value);

// ---- directories, variables, branch state ---------------------------------------------------------------------

// $NAME / ${NAME} that an earlier command on the same line assigned; anything else is left as written.
// A value is substituted as written (never expanded again), but a long value used in many words still multiplies, so the
// text produced is capped per result and per evaluation (substitute throws GuardLimit, which evaluateGitCommand denies).
// (an unbraced name that zsh would read a modifier or a subscript after is left as written: ZSH_MODIFIED, #74; `${B}:r` is no modifier). Defence in depth: collectAssignments already makes a name the line assigns and reads so unsure, so the guard also holds without this lookahead for those; it keeps
// the text of one reaching expandVars by another way (a value from a sourced file, a script judged alone) from being read as the value.
const EXPAND_RE = new RegExp(`\\$(?:\\{([A-Za-z_][A-Za-z0-9_]*)\\}|([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])${ZSH_MODIFIED})`, 'g');
function expandVars(text, ctx) {
  return substitute(ctx.budget, String(text), EXPAND_RE, (m, a, b) => ctx.vars[a ?? b] ?? m);
}

// Everything a script judged here can depend on: the directory, the nesting level and the line's variable / branch / config / alias state.
// (and the writes of the line that count for the command: a script the line wrote is judged on what was written)
const stateFingerprint = (ctx, dir, level) => JSON.stringify([dir, level, ctx.vars, [...ctx.unsureVars], [...ctx.tainted], [...ctx.branches], ctx.cfgDirty, ctx.envCfgDirty, ctx.gitAliases, ctx.ghAliases, [...ctx.aliasUnsure], writeSignature(ctx.writeFrames)]);

// What the policy's own tracking knows about variable `n` for a use the command's prefix does not override: its value, and
// `$n` when it is unsure or tainted (the callers read that as "run-time value").
const knownValues = (ctx, n) => [ctx.vars[n], unsureVar(ctx, n) ? `$${n}` : undefined];

// A variable assigned more than once in what is judged (`B=main; false && B=agent/x`) is unknown from then on: which
// assignment ran depends on control flow the parser does not model, so its value is left as `$B` (dynamic).
// Only an assignment on the line itself (level 0) makes a tainted variable known again; one inside a judged script is ignored for it.
// #81: the readings of one text (the line, or a script the guard opened) belong to that text's level: a script judged under a reading of the line, or
// a script it runs, has none of the line's pins and may take readings of its own (judgeReadings puts the outer ones back when it is done).
const pinsAt = (ctx, level) => (ctx.pins && ctx.pinsLevel === level ? ctx.pins : undefined);
function setVar(ctx, k, v, level) {
  // (a reading of the line pins how its one assignment of k went: it ran, or it did not; see judgeReadings)
  const pins = pinsAt(ctx, level);
  if (pins?.has(k)) { if (pins.get(k) === 'set') ctx.vars[k] = v; return; }
  if (level === 0) ctx.tainted.delete(k);
  else if (ctx.tainted.has(k)) return;
  if (sameValue(ctx, k, v)) return;
  if (k in ctx.vars || ctx.unsureVars.has(k)) { delete ctx.vars[k]; ctx.unsureVars.add(k); } else ctx.vars[k] = v;
}
// Why: a name set again to the literal value it already holds (a startup file the nested shell reads again) is still certain; it is not "assigned more than once".
const sameValue = (ctx, k, v) => !DYNAMIC.test(v) && !ctx.unsureVars.has(k) && !ctx.tainted.has(k) && Object.hasOwn(ctx.vars, k) && ctx.vars[k] === v;
const recordVars = (env, ctx, level) => { for (const k of Object.keys(env)) setVar(ctx, k, env[k], level); };
// Why (#56, a live bypass on main): `S=run; F=$S.sh; bash $F` ran run.sh while the guard read `bash $S.sh`, a script only known at run time, allowed on a line
// that names no guarded operation. The shell works a value out when it assigns it, so a bare assignment's value is expanded here with what is known at that
// point, left to right (`A=1 B=$A`). Only when the assignment's own text shows that every `$` in it expands: the parser removes quotes, so `F='$S'` and
// `F=$S` give the same value; a single quote or a backslash in the text keeps the value as written (unknown at run time, as before).
function recordAssigned(c, ctx, level) {
  const raw = typeof c.raw === 'string' ? c.raw : '';
  const exact = raw !== '' && !/['\\]/.test(raw);
  for (const k of Object.keys(c.env)) setVar(ctx, k, exact && c.env[k].includes('$') ? expandVars(c.env[k], ctx) : c.env[k], level);
}

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
  if (t === '~' || t.startsWith('~/')) {
    const home = lineHome(ctx);
    if (home === null) return null;
    t = home + t.slice(1);
  } else if (t.startsWith('~')) return null;
  const lexical = path.isAbsolute(t) ? path.resolve(t) : dir === null ? null : path.resolve(dir, t);
  // Why: `cd -P link/..`, `set -P`, zsh chaselinks: a `..` after a symlink goes to the target's parent, not the link's. When the two readings differ the directory is unknown.
  if (lexical !== null && /[^/]\/\.\.(?:\/|$)/.test(t)) {
    let cur = path.isAbsolute(t) ? path.parse(t).root : dir;
    for (const seg of t.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg !== '..') { cur = path.join(cur, seg); continue; }
      let real = cur;
      try { real = ctx.realpath(cur); } catch { /* not there: the lexical parent */ }
      cur = path.dirname(real);
    }
    if (path.resolve(cur) !== lexical) return null;
  }
  return lexical;
}

// Why: with CDPATH set (zsh's lowercase `cdpath` array is the same list) a relative `cd sub` goes to the first entry that holds `sub`, not to <cwd>/sub; the hook's environment, an assignment
// anywhere on the line (also `NAME[1]=`, `export CDPATH`, `typeset -T CDPATH cdpath`) or a name that is not sure counts. A name that starts with / ./ ../ or ~ is not searched.
function cdpathMaybe(cmds, ctx) {
  const is = (n) => n === 'CDPATH' || n === 'cdpath';
  return (ctx.env?.CDPATH ?? '') !== '' || Object.keys(ctx.vars).some((n) => is(n) && ctx.vars[n] !== '') || [...ctx.unsureVars, ...ctx.tainted].some(is)
    || cmds.some((c) => Object.keys(c.env ?? {}).some((n) => is(n) && c.env[n] !== '') || c.argv.some((a) => /^(?:CDPATH|cdpath)(?:\+?=|\[)/.test(a) || (is(a) && c.argv.length > 1 && VAR_BUILTINS.includes(baseName(c.argv[0])))));
}

// Why: `~` expands to the HOME the line has when the word is expanded: one the line assigned (known, or unsure: null), else the real home
function lineHome(ctx) {
  if (unsureVar(ctx, 'HOME')) return null;
  const h = Object.hasOwn(ctx.vars, 'HOME') ? ctx.vars.HOME : ctx.home;
  return typeof h === 'string' && path.isAbsolute(h) && !DYNAMIC.test(h) ? h : null;
}
function nextDir(dir, name, argv, ctx, cdpath = false, env = {}) {
  if (name === 'popd') return null;
  // (the words as the cd sees them: `cd -"$N"` is an option or a stack entry only once $N is known)
  const args = argv.slice(1).map((a) => expandVars(a, ctx));
  // Why: neither form below goes to its operand, and an unsure value now reaches a cd (see unsureVarReachingCommand): a directory-stack entry (`cd -1`, `cd +2`,
  // `pushd +1`, zsh and bash) and zsh's `cd OLD NEW` (OLD replaced by NEW in the current directory; bash refuses it) leave the directory unknown, and so does
  // a word still holding a run-time part (`cd -"$N"` may be a stack entry; Codex review 3 of #50)
  if (args.some((a) => /^[+-]\d+$/.test(a) || DYNAMIC.test(a))) return null;
  const k = args.indexOf('--');
  const operands = k >= 0 ? args.slice(k + 1) : args.filter((a) => !(a.length > 1 && a[0] === '-'));
  if (operands.length > 1) return null;
  // Why: a bare cd goes to the HOME the cd builtin sees: its own prefix (`HOME=d cd`), else the line's (Codex review 3 of #50)
  if (operands.length === 0) {
    if (name !== 'cd') return null;
    if (!Object.hasOwn(env, 'HOME')) return lineHome(ctx);
    const h = expandVars(env.HOME, ctx);
    return path.isAbsolute(h) && !DYNAMIC.test(h) ? path.resolve(h) : null;
  }
  if (cdpath && !path.isAbsolute(operands[0]) && !/^(?:\.\.?(?:\/|$)|~)/.test(operands[0])) return null;
  return joinDir(dir, operands[0], ctx);
}

// The repository does not change while a line is judged, so each lookup is made once per evaluation (a push judged in many mixes, a
// script judged in many readings, must not repeat a call that can take seconds). Errors are remembered as unknown too.
function memoLookup(ctx, key, fn) {
  const memo = (ctx.budget.lookups ??= new Map());
  const k = JSON.stringify(key);
  if (!memo.has(k)) { try { memo.set(k, { v: fn() }); } catch { memo.set(k, { err: true }); } }
  const e = memo.get(k);
  if (e.err) throw new Error('lookup failed');
  return e.v;
}

function branchOf(dir, gitDir, ctx) {
  if (dir === null) return null;
  let b;
  try { b = memoLookup(ctx, ['branch', dir, gitDir ?? null], () => ctx.currentBranch(dir, { gitDir })); } catch { return null; }
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
  try { d = memoLookup(ctx, ['push', dir, gitDir ?? null, branch ?? null], () => ctx.pushDestination(dir, branch === undefined ? { gitDir } : { gitDir, branch })); } catch { return null; }
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
  const colon = splitIndex(spec, ':');
  const src = colon < 0 ? spec : spec.slice(0, colon);
  // A run-time source can carry a `+` (force) prefix or word-split into more refspecs (`${B:-${C:-+HEAD}}:agent/x`), so a
  // source that is not literal text cannot be verified either, not only the destination.
  if (colon >= 0 && DYNAMIC.test(src)) {
    return deny(`the refspec source "${src}" is built at run time, so what is pushed (a force prefix, extra refspecs) cannot be verified. Write the refspec out: git push -u origin HEAD:agent/<slug>.`);
  }
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

// `HEAD:$(git branch --show-current)` is the one run-time word a push may carry (checkRefspec judges it).
const CURRENT_BRANCH_WORD = new RegExp(`(^|:)${CURRENT_BRANCH_IDIOM.source.slice(1, -1)}$`);

// Every word of a push is read as written: an option or remote built at run time (`--${F:-mirror}`, `-${F:-f}`, `"$R"`) can be
// any option, and a variable with a known value that holds blanks or glob characters splits into several words when it is
// unquoted (`R="x HEAD:main"; git push origin $R`; zsh does not split, so both readings are denied).
// Can the shell split on something other than blanks? IFS written anywhere in the text judged (assignment, `read`, `local`,
// `unset`), set in the environment, or a sourced script that may have set variables.
// A name can be written without the letters IFS in a row (`eval "I""FS=,"`, `read $N`, `printf -v $N`, `declare I""FS=,`, `N=IFS; export $N`),
// so the commands that assign a variable by a computed or split-up name count as well.
const SETS_BY_NAME = /\b(?:eval|read|mapfile|readarray|getopts|source)\b|\bprintf\s+-[A-Za-z]*v|(?:^|[\s;&|(])\.\s|\b(?:export|unset|declare|typeset|local|readonly)\b[^;&|\n]*[$`'"]/;
// Both the text as written and with its quotes and backslashes removed (`printf -vI""FS ,` spells the name only once they are gone).
// Why (#81 Codex R1-B1 follow-up): a script the guard opens is judged with its own text too -- `bash wrapper.sh` hid `declare -n r=IFS; r=x` from the outer line. Whole-line comments are left out of
// the binder test only (a comment that says "read" is no binder); the name IFS anywhere, a comment included, still counts.
// A line is left out only when the scan is CERTAIN it is a comment line: its first non-blank character is `#` and nothing is open from the lines before it (a quote, a backtick, `$( )`, `${ }`, a
// backslash-newline). A line is dropped whole or kept whole, never cut: a `#` in the middle of a line is read by no rule here (an escaped blank, `\ #`, makes it a word, a quote may hide it),
// so the first such `#`, any `$'` / `$"`, or a heredoc (`<<`, not `<<<`) makes the scan unsure and every line from there on is kept. Unsure means more text tested, never less; the cost is a
// refusal where a script has a trailing comment that says `read` (documented in the tests).
// Defensive (mutation check): the heredoc exit, the `$( )` depth and the `${ }` depth only keep MORE lines; a heredoc body is judged as a script of its own, bash reads a `#` line inside `$( )` as a comment too, and the text of a `${x:-word}` is data, not a command.
function withoutCommentLines(s) {
  if (/<<(?!<)/.test(s)) return s;
  const out = [];
  let sq = false, dq = false, bt = false, depth = 0, braces = 0, cont = false, unsure = false;
  for (const line of s.split('\n')) {
    if (!unsure && !cont && !sq && !dq && !bt && depth === 0 && braces === 0 && /^\s*#/.test(line)) continue;
    out.push(line);
    if (unsure) continue;
    let esc = false;
    for (let i = 0; i < line.length && !unsure; i++) {
      const c = line[i];
      if (esc) { esc = false; continue; }
      if (sq) { if (c === "'") sq = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '$' && (line[i + 1] === "'" || line[i + 1] === '"')) { unsure = true; continue; }
      if (c === "'" && !dq) { sq = true; continue; }
      if (c === '"') { dq = !dq; continue; }
      if (c === '`') { bt = !bt; continue; }
      if (c === '$' && line[i + 1] === '(') { depth++; continue; }
      if (c === '$' && line[i + 1] === '{') { braces++; continue; }
      if (c === ')' && depth > 0) { depth--; continue; }
      if (c === '}' && braces > 0) { braces--; continue; }
      if (c === '#' && !dq && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) unsure = true; // (a comment, or a word that only looks like one: not told apart)
    }
    cont = esc;
  }
  return out.join('\n');
}
// Defensive (mutation check): the binder test (SETS_BY_NAME) and the quote-stripped spelling (`I""FS`) of a script are also held by collectAssignments, which makes every name such a script binds unknown (bindsRunTimeName, indirectExpansion, tainted); only the name IFS written out (a nameref, an alias) needs this line.
const ifsInScope = (ctx) => (ctx.scopeTexts ?? []).some((s) => [String(s), String(s).replace(/['"\\]/g, '')].some((v) => /IFS/.test(v) || SETS_BY_NAME.test(withoutCommentLines(v))));
const ifsMayBeSet = (ctx) => ifsInScope(ctx) || [ctx.fullText ?? '', String(ctx.fullText ?? '').replace(/['"\\]/g, '')].some((t) => /IFS/.test(t) || SETS_BY_NAME.test(t)) || assignedNames(ctx).includes('IFS') || Object.hasOwn(ctx.env ?? {}, 'IFS') || ctx.tainted.size > 0;

function unverifiableWord(raw, ctx) {
  if (raw.includes(LITERAL_MARK)) return null; // (a word judged as the plain text it spells)
  const x = expandVars(raw, ctx);
  // an unquoted empty value drops the word (`E=; git push origin $E` is a push with no refspec), shifting every later argument
  if (x === '' && raw !== '') return `the word "${raw}" expands to nothing, which removes it from the push's arguments, so the push cannot be verified. Write the arguments out.`;
  if (x !== raw && ifsMayBeSet(ctx)) return `the word "${raw}" holds a variable and IFS may be set here, so where the shell splits its value cannot be verified. Write the arguments out.`;
  const w = x.replace(CURRENT_BRANCH_WORD, '$1X');
  if (x !== raw && /[\s*?[]/.test(w)) return `the word "${raw}" expands to text with blanks or glob characters, which the shell may split into several arguments, so it cannot be verified. Write the arguments out.`;
  if (DYNAMIC.test(w)) return `the argument "${x}" is built at run time (an option, remote or refspec can hide in it), so it cannot be verified. Write the push out: git push -u origin agent/<slug>.`;
  return null;
}

// The policy sees words after quote removal, so `'$O'` (a literal branch name) and `$O` (an option) look the same, and each word of a
// line may be either. A push is judged for EVERY mix: each word that holds a `$` or backtick is taken as the variable it names or as the
// plain text it spells (its `$` then marked so no later step expands or flags it), and denied if any mix denies. More than MAX_MIXED such
// words is too many mixes to judge, so it is refused.
const LITERAL_MARK = '\u0001';
const MAX_MIXED = 8;
const asText = (a) => a.replace(/\$/g, `${LITERAL_MARK}d`).replace(/`/g, `${LITERAL_MARK}b`);
function checkPush(args, dir, gitDir, ctx, configs) {
  const idx = args.map((a, i) => (DYNAMIC.test(a) ? i : -1)).filter((i) => i >= 0);
  const seen = new Set();
  const judge = (mask) => {
    checkDeadline(ctx.budget); // up to 2^MAX_MIXED mixes: the evaluation as a whole has a deadline
    const mixed = args.map((a, i) => { const j = idx.indexOf(i); return j >= 0 && (mask >> j) & 1 ? asText(a) : a; });
    for (const a of mixed) {
      const why = unverifiableWord(a, ctx);
      if (why) return deny(why);
    }
    // (an option held in a variable, `F=--mirror; git push origin $F`, is an option)
    const expanded = mixed.map((a) => expandVars(a, ctx));
    const key = JSON.stringify(expanded);
    if (seen.has(key)) return null; // a mix that reads the same as one already judged
    seen.add(key);
    return pushReading(expanded, dir, gitDir, ctx, configs);
  };
  const first = judge(0); // every word as the variable it names (the expansion budget is spent here first)
  if (first) return first;
  if (idx.length > MAX_MIXED) return deny(`this push has ${idx.length} words with a variable or substitution; every way each could be quoted cannot be judged, so it cannot be verified. Write the arguments out.`);
  for (let mask = 1; mask < (1 << idx.length); mask++) {
    const v = judge(mask);
    if (v) return v;
  }
  return null;
}

function pushReading(args, dir, gitDir, ctx, configs) {
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
    if (dir === null) return deny('cannot tell which directory this `git push` runs in (unresolved cd / -C), so the current branch cannot be verified. Rewrite: name the branch (`git push origin agent/x`), or give the directory literally (`git -C /abs/repo push`, or `cd /abs/repo && git push`).');
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
      // Only the KEY is expanded (`-c $K=v`). The value stays as written: an alias body (`alias.p='!V=…; git push origin $V'`)
      // runs in its own shell, where the line's variables are not the ones it sees.
      const kv = argv[++i] ?? '';
      const eq = splitIndex(kv, '=');
      configs.push({ raw: kv, key: expandVars(eq < 0 ? kv : kv.slice(0, eq), ctx).toLowerCase(), value: eq < 0 ? '' : kv.slice(eq + 1) });
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
    // a `-c` word that expands to blanks / glob characters (or may) splits into more git arguments (`-c $KV push …`, `-c k=$V`)
    for (const c of g.configs) {
      const why = unverifiableWord(c.raw, ctx);
      if (why) return deny(why);
    }
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
      fields.push({ key, value, rt: !at && runTimeText(value) });
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

// A comment-creating mutation whose text is built at run time: a command substitution or backtick anywhere in the document (graphql has
// neither), a `$name`/`${name}` inside a string literal (a shell variable there), or a `$name` outside one that the operation never declares
// (a graphql variable always is declared, so an undeclared one is a shell variable). Literal graphql variables stay allowed.
const GRAPHQL_STRINGS = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"/g;
function graphqlBuiltAtRunTime(q) {
  if ((q.match(GRAPHQL_STRINGS) ?? []).some((s) => runTimeText(s))) return true;
  // (comments are kept for the substitution test: the shell expands them too, and an output with a newline ends the comment)
  const outside = q.replace(GRAPHQL_STRINGS, '""');
  if (/\$\(|\$\{|`/.test(outside)) return true;
  const declared = new Set([...stripGraphql(q).matchAll(/\$([A-Za-z_]\w*)\s*:/g)].map((m) => m[1]));
  return [...outside.matchAll(/\$([A-Za-z_]\w*)/g)].some((m) => !declared.has(m[1]));
}

function checkGraphql(body, dir = null, ctx = null) {
  for (const q of body.queries) {
    if (/^\s*(\$\(|`|\$\{?[A-Za-z_])/.test(q)) return deny('the graphql query is built at run time, so it cannot be verified. Pass the query text directly.');
    const names = graphqlMutations(q);
    if (names === null) return deny('the graphql query contains a mutation that cannot be parsed, so it cannot be verified.');
    const bad = names.find((n) => !GRAPHQL_ALLOWED_MUTATIONS.has(n));
    if (bad === 'updateIssueComment') return deny(`editing a comment through graphql (updateIssueComment) is blocked: run events are comments and must not be rewritten. ${OWNER_ONLY}`);
    if (bad) return deny(`the graphql mutation ${bad} is not on the allowed list (${[...GRAPHQL_ALLOWED_MUTATIONS].join(', ')}). ${OWNER_ONLY}`);
    // (the query text AND the variables: `-f body=...`, `-F body=@file`, an --input JSON's values)
    if (names.some((n) => COMMENT_MUTATIONS.includes(n))
      && mentionsEventMarker(q, body.text, ...body.fields.map((x) => x.value), ...body.queries)) return deny(EVENT_FORGE);
    // (the query text itself, built at run time: `body:"$(cat f)"`, `body:"$BODY"`: the marker never appears in the text the guard reads)
    if (names.some((n) => COMMENT_MUTATIONS.includes(n)) && graphqlBuiltAtRunTime(q)) return deny(COMMENT_RUNTIME);
    // (the variables of a comment mutation: `-f b="$(cat file)"`. The query itself is judged above; `data` is the curl route's own check)
    if (names.some((n) => COMMENT_MUTATIONS.includes(n)) && body.fields.some((x) => x.rt && x.key !== 'query' && x.key !== 'data')) return deny(COMMENT_RUNTIME);
    // #58: auto-merge names the PR by its node id, which says nothing about whether the owner said "merge" for it, nor which repository it is in.
    // Why (#58 round 3): the node id can name a PR in a chat repo whatever directory this runs in, so the target repository can never be resolved
    // here: it is judged as a chat repo's (the owner's "merge" is needed, and a node id cannot match one), not as the current directory's.
    if (names.includes('enablePullRequestAutoMerge') && ctx?.ownerGo) {
      return deny('turning on auto-merge through the API skips the owner\'s "merge": it names the PR by a node id, so its repository (owner_approval: chat?) and head cannot be checked. In an owner_approval: chat repository agents merge only through `P merge --pr N`.');
    }
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

  // -- run events are PR comments: a comment is never edited or deleted (chat mode's owner stops; the viewer's token could rewrite one)
  if (/^repos\/[^/]+\/[^/]+\/issues\/comments\/[^/]+$/i.test(ep)) return deny(`${method} to an issue/PR comment is blocked: pipeline run events and owner stops live in comments and must not be rewritten or removed. Post a new comment instead.`);

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
  // -- a comment (or review) that carries an owner-stop event marker is forged, and one whose text cannot be read cannot be shown not to be
  if (COMMENT_ROUTE.test(ep)) {
    if (body.unknown) return deny(COMMENT_UNREADABLE);
    if (mentionsEventMarker(haystack, ...body.fields.map((x) => x.value))) return deny(EVENT_FORGE);
    if (body.fields.some((x) => x.rt)) return deny(COMMENT_RUNTIME);
  }
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

  if (/^graphql$/i.test(ep)) return checkGraphql(body, dir, ctx);
  return null;
}

// ---- #58: direct merges in an owner_approval: chat repo ----------------------------------------------------------------
// Why: P merge checks the owner's recorded "merge" (hooks/lib/owner-go.mjs) and every open owner stop before it merges, but a plain
// `gh pr merge`, the repo's own merge command or auto-merge through the API skipped P merge entirely (Codex design review of #58,
// verified). Since the chat-mode-without-needs-human change (docs/plans/2026-10-20-chat-mode-no-needs-human.md, N2) an agent merges
// in a chat repo ONLY through P merge: a same-head "merge" given before a stop would otherwise still open a direct merge, and the direct
// path reads no stop. P merge runs the merge command as its own child process, which the guard never sees, so it keeps working.
// `gh pr merge --disable-auto` stays allowed (it cancels). Label mode and repos without a pipeline config are untouched.
// Without the owner-go wiring (tests, older callers) nothing here applies.
function ownerGoMode(dir, ctx) {
  if (!ctx?.ownerGo) return 'none';
  if (dir === null) return 'chat'; // (which repository is unknown)
  try {
    return ctx.ownerGo.mode(dir);
  } catch {
    return 'chat'; // (a pipeline.yml that cannot be read)
  }
}
const prNumberOf = (w) => {
  const m = /^#?(\d{1,7})$/.exec(String(w ?? '')) ?? /\/pull\/(\d{1,7})(?:[/?#]|$)/.exec(String(w ?? ''));
  return m ? Number(m[1]) : null;
};
// `elsewhere`: the command names another repository (-R, a PR URL), whose mode is unknown here: judged as a chat repo.
// `head`: the head the command pins (gh: --match-head-commit; the repo command: the flag before its {sha}); a merge that pins no full
// head could land a later push the owner never saw, so it is refused, and the owner's "merge" must be for exactly that head.
const CHAT_MERGE_ROUTE = 'in an owner_approval: chat repository agents merge only through `P merge --pr N` (it checks the owner\'s "merge" and any open owner stop); the owner merges in the GitHub UI.';
function directMergeVerdict(pr, head, dir, ctx, what, elsewhere = false) {
  if (!ctx?.ownerGo) return null;
  if (!elsewhere && ownerGoMode(dir, ctx) !== 'chat') return null;
  const where = elsewhere ? ' (a merge named by -R, a PR URL or GH_REPO: its repository may be a chat repository)' : '';
  return deny(`${what}${pr === null ? '' : ` #${pr}`}${where}: ${CHAT_MERGE_ROUTE}`);
}
// (the package-manager argv reading -- PM_RUN_ALIASES, canonPm, pmScriptOf ... -- lives in package-scripts.mjs: the two guards open package scripts with it too)
// The repo's own merge command (pipeline.yml merge.command, e.g. `npm run merge -- {pr} --expect-head {sha}`) typed by hand. A `gh …`
// command is judged as gh.
// Why (#58 round 4, strict shape): when the template is a package script, the guard does not try to recognise every package runner (npm / yarn /
// pnpm / bun, wrappers, `run-script`, `--prefix` / `-C` / `--cwd` / workspaces, words before `--` that npm forwards …). Only the template's exact
// spelling — its own words, then the PR and the pin after them, with nothing in between — is approvable (read as before: PR and head against the
// owner-go record). Any other command that may run that script is refused in a chat repo with the canonical form named. A manager option that
// moves the target directory is judged as a chat repo whatever the current directory is.
const pmName = (w) => baseName(String(w ?? '')).replace(/@[^@/]*$/, '').toLowerCase();
const isPmWord = (w) => Object.hasOwn(PM_RUN_ALIASES, pmName(w));
const MOVES_DIR = /^(?:--prefix|--cwd|--dir|--workdir|--workspaces?|--filter|--filter-prod|--include-workspace-root|--userconfig|--globalconfig|--global|--location|-w|-ws|-C|-F|-g)(?:=.*)?$|^-[CwF]./;
// (a package-manager setting the line gives — `npm_config_prefix=/chat npm run merge …`, `export npm_config_…`, `env YARN_…` — may move it the same way: npm reads
// npm_config_* like its options, whatever the case. Fails closed on any such name; the guard's variables hold only what the line sets.)
const pmSettingOnLine = (ctx) => [...Object.keys(ctx.vars ?? {}), ...(ctx.unsureVars ?? []), ...(ctx.tainted ?? [])].some((k) => /^(?:npm_config_|yarn_|pnpm_|bun_|berry_|init_cwd$|npm_package_json$)/i.test(k)); // (#81 t9: and INIT_CWD / npm_package_json, which name the project a script call starts from)
function pmScriptRefusal(prefix, shaFlag, raw, dir, ctx) {
  const script = pmScriptOf(prefix);
  const end = raw.indexOf('--');
  const before = raw.slice(1, end < 0 ? undefined : end);
  // (the manager, or a wrapper — npx / pnpx / bunx / corepack / exec / dlx … — that runs one, with the script's name on the line or a word built at run time before `--`)
  const same = isPmWord(raw[0]);
  const wrapped = (same || PM_WRAPPERS.has(pmName(raw[0]))) && raw.some((w) => PM_WRAPPERS.has(String(w).toLowerCase())) && raw.some(isPmWord);
  const mayRun = ((same && (before.includes(script) || before.some((w) => DYNAMIC.test(w)))) || (wrapped && raw.includes(script))) && !pmCannotRunScript(raw);
  if (!mayRun) return undefined;
  const moved = before.some((w) => MOVES_DIR.test(w) || w === 'workspace') || pmSettingOnLine(ctx);
  if (!moved && ownerGoMode(dir, ctx) !== 'chat') return null;
  return deny(`\`${raw.join(' ').slice(0, 120)}\` may run the merge script \`${script}\`${moved ? ' (a manager option moves its target directory, so it is judged as a chat repository)' : ''}: ${CHAT_MERGE_ROUTE}`);
}
function repoMergeCommandVerdict(argv, dir, ctx) {
  if (!ctx?.ownerGo) return null;
  // (an unknown directory is judged by the session's own; a pipeline.yml that cannot be read leaves `npm run merge` as the guess, as the mode of an unreadable one is chat)
  let templates = [];
  try {
    templates = ctx.ownerGo.mergeTemplates(dir ?? ctx.cwd) ?? [];
  } catch {
    templates = [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: null }];
  }
  const raw = argv.map((a) => expandVars(a, ctx));
  const usable = templates.filter((t) => Array.isArray(t.prefix) && t.prefix.length && baseName(t.prefix[0]) !== 'gh');
  // Package-script templates: the canonical shape of any of them is approvable; anything else that may run a template's script is refused.
  const scripts = usable.filter((t) => pmScriptOf(t.prefix));
  for (const { prefix, shaFlag } of scripts) {
    if (pmSettingOnLine(ctx)) break; // (judged below as a moved target)
    if (raw.length < prefix.length || baseName(raw[0]) !== baseName(prefix[0]) || !prefix.every((w, i) => i === 0 || raw[i] === w)) continue;
    // (npm keeps every option written before `--` for itself: a template without `--` hands the script no option)
    const tail = raw.slice(prefix.length);
    const given = baseName(prefix[0]) === 'npm' && !prefix.includes('--') ? tail.filter((w) => !w.startsWith('-')) : tail;
    let head = null;
    if (shaFlag) {
      // (exactly one head flag: with two, which one the script honours is unknown)
      const vals = given.flatMap((w, j, all) => (w === shaFlag ? [all[j + 1]] : w.startsWith(`${shaFlag}=`) ? [w.slice(shaFlag.length + 1)] : []));
      head = vals.length === 1 ? vals[0] ?? null : null;
    }
    return directMergeVerdict(prNumberOf(given[0]), head, dir, ctx, `\`${prefix.join(' ')}\``, false, shaFlag);
  }
  for (const { prefix, shaFlag } of scripts) {
    const v = pmScriptRefusal(prefix, shaFlag, raw, dir, ctx);
    if (v !== undefined) return v;
  }
  for (const { prefix, shaFlag } of usable) {
    if (pmScriptOf(prefix)) continue;
    const plain = raw.filter((w) => w !== '--');
    const p = prefix.filter((w) => w !== '--');
    if (plain.length < p.length || baseName(plain[0]) !== baseName(p[0]) || !p.slice(1).every((w, i) => plain[i + 1] === w)) continue;
    let head = null;
    if (shaFlag) {
      const vals = plain.flatMap((w, j, all) => (w === shaFlag ? [all[j + 1]] : w.startsWith(`${shaFlag}=`) ? [w.slice(shaFlag.length + 1)] : []));
      head = vals.length === 1 ? vals[0] ?? null : null;
    }
    return directMergeVerdict(prNumberOf(plain[p.length]), head, dir, ctx, `\`${prefix.join(' ')}\``, false, shaFlag);
  }
  return null;
}

// `gh pr|issue comment`: no --edit-last / --delete-last (a run event could be rewritten), no owner-stop event marker in the text, and the text must be readable.
function checkGhComment(rest, dir, ctx) {
  const { flags } = parseOpts(rest, { longValue: ['body', 'body-file', 'repo'], shortValue: 'bFR' });
  if (flags.some((f) => !f.short && (f.name === 'edit-last' || f.name === 'delete-last'))) {
    return deny('editing or deleting the last comment (--edit-last / --delete-last) is blocked: pipeline run events and owner stops live in comments and must not be rewritten or removed. Post a new comment instead.');
  }
  // (--editor: the text is typed in an editor the guard cannot see)
  if (flags.some((f) => f.short ? f.name === 'e' : f.name === 'editor')) return deny(COMMENT_UNREADABLE);
  const texts = [rest.join('\n'), ctx.fullText ?? ''];
  for (const fl of flags) {
    if (fl.value === null) continue;
    if (fl.short ? fl.name === 'b' : fl.name === 'body') {
      if (runTimeText(fl.value)) return deny(COMMENT_RUNTIME);
      texts.push(fl.value);
    }
    else if (fl.short ? fl.name === 'F' : fl.name === 'body-file') {
      if (fl.value === '-' || dir === null) return deny(COMMENT_UNREADABLE);
      countScript(ctx.budget);
      const text = ctx.readText(path.resolve(dir, fl.value));
      if (typeof text !== 'string') return deny(COMMENT_UNREADABLE);
      texts.push(text);
    }
  }
  return mentionsEventMarker(...texts) ? deny(EVENT_FORGE) : null;
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

  if ((group === 'pr' || group === 'issue') && verb === 'comment') return checkGhComment(rest, dir, ctx);

  if (group === 'pr' && verb === 'merge') {
    if (rest.some((t) => t === '--admin' || t.startsWith('--admin='))) return deny(`\`gh pr merge --admin\` bypasses the merge gate and is blocked. Use \`--auto\` / the pipeline merge command. ${OWNER_ONLY}`);
    const { flags, positionals } = parseOpts(rest, { longValue: ['author-email', 'body', 'body-file', 'match-head-commit', 'repo', 'subject'], shortValue: 'AbFtR' });
    // (a real `--disable-auto` flag whose LAST setting is on, with `--auto` not on, turns a queued merge off and merges nothing. `--disable-auto`
    // as the value of --subject / --body …, `--disable-auto=false`, or one next to `--auto` is no cancellation: the PR merges)
    // (and only when every flag is one gh pr merge has, and no word is built at run time: an unknown flag or a `$(…)` word could be what makes it a merge)
    const known = flags.every((f) => (f.short ? GH_MERGE_SHORT.includes(f.name) : GH_MERGE_LONG.includes(f.name)));
    if (known && !rest.some((t) => DYNAMIC.test(t)) && boolFlag(flags, 'disable-auto') === 'on' && boolFlag(flags, 'auto') === 'off') return null;
    // (gh reads the repository from -R, a PR URL or GH_REPO: set on this command, earlier on the line (unknown if it ran) or inherited. An empty GH_REPO selects nothing)
    const ghRepo = envVar(env, ctx, 'GH_REPO');
    const viaEnv = !ghRepo.known || (Object.hasOwn(env, 'GH_REPO') ? ghRepo.value !== '' : (ghRepo.value !== undefined && ghRepo.value !== '') || (typeof ctx.env?.GH_REPO === 'string' && ctx.env.GH_REPO !== ''));
    const elsewhere = flagValues(flags, ['repo'], 'R').length > 0 || /\/pull\//.test(positionals[0] ?? '') || viaEnv;
    // (gh uses the LAST --match-head-commit: a repeated one could pin another head than the one checked, so it pins nothing)
    const pins = flagValues(flags, ['match-head-commit']);
    return directMergeVerdict(prNumberOf(positionals[0]), pins.length === 1 ? pins[0] : null, dir, ctx, '`gh pr merge`', elsewhere);
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

// ---- curl / wget / httpie / xh to GitHub ------------------------------------------------------------------
// Why: with the viewer's token such a command can merge a PR, rewrite a comment (a run event), post a forged one or call graphql without touching any `gh` rule.
// A call to github.com / api.github.com with a non-GET method is rewritten as the `gh api` call it is and judged by checkApi (+ the merge / refs rules below).
// Residual: `node -e "fetch(...)"`, `python -c`, any program the agent writes.
const HTTP_TOOLS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'xhs']);
const GH_HOST = /(?:^|\.)github\.com\.?$/i; // (a trailing dot is the same host)
// Flags whose NEXT word is their value, per tool: a flag missing here would leave its value among the URL candidates (harmless), but a flag listed here that is
// a switch in that tool would swallow the URL (a hole), so the sets are per tool.
const CURL_VALUE_FLAGS = new Set(['-H', '--header', '-o', '--output', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-w', '--write-out', '--connect-timeout', '-m', '--max-time', '--retry', '--retry-delay',
  '--retry-max-time', '-x', '--proxy', '--cacert', '--cert', '-E', '--key', '--resolve', '--connect-to', '--interface', '--limit-rate', '--max-redirs', '-r', '--range', '-C', '--continue-at', '-D', '--dump-header', '-y', '-Y', '-z', '-Q', '--proxy-user', '-U', '--oauth2-bearer', '--aws-sigv4']);
const WGET_VALUE_FLAGS = new Set(['-o', '--output-file', '-a', '--append-output', '-e', '--execute', '-t', '--tries', '-T', '--timeout', '-O', '--output-document', '-w', '--wait', '-P', '--directory-prefix', '-U', '--user-agent', '-B', '--base', '-Q', '--quota', '-l', '--level',
  '-A', '--accept', '-R', '--reject', '-D', '--domains', '-I', '--include-directories', '-X', '--exclude-directories', '--header', '--user', '--password', '--http-user', '--http-password', '--referer', '--load-cookies', '--save-cookies', '--certificate', '--ca-certificate', '--private-key']);
const HTTPIE_VALUE_FLAGS = new Set(['-A', '--auth-type', '-a', '--auth', '-o', '--output', '-p', '--print', '-s', '--style', '--pretty', '--ssl', '--verify', '--cert', '--cert-key', '--cert-key-pass', '--proxy', '--timeout', '--max-redirects', '--max-headers', '--session', '--session-read-only',
  '--default-scheme', '--format-options', '--response-charset', '--response-mime', '--path-as-is', '--bearer', '--unsorted', '--sorted', '--ciphers']);
const HTTP_DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-T', '--upload-file', '-F', '--form', '--form-string', '--post-data', '--post-file', '--body-data', '--body-file']);
const HTTP_FILE_FLAGS = new Set(['-T', '--upload-file', '--post-file', '--body-file']);
const URL_FILE_FLAGS = new Set(['-i', '--input-file']); // wget reads its URLs from a file
const CURL_SHORT_VALUE = 'XHdobuAecwmxKFTEyYzrCDQU';
const HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
// A curl config file (-K) as the words it stands for: "url = \"...\"" -> --url ...; "silent" -> --silent; "X = PUT" -> -X PUT. Comments and blank lines are skipped.
function curlConfigWords(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln || ln.startsWith('#')) continue;
    const m = /^(-{0,2}[A-Za-z][A-Za-z0-9-]*)\s*(?:[=:]\s*|\s+)?([\s\S]*)$/.exec(ln);
    if (!m) continue;
    const name = m[1].replace(/^-+/, '');
    out.push(name.length === 1 ? `-${name}` : `--${name}`);
    let v = m[2].trim();
    if (/^"[\s\S]*"$/.test(v)) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    if (v !== '') out.push(v);
  }
  return out;
}
function checkHttpTool(argv, dir, ctx, tool = 'curl') {
  const httpie = ['http', 'https', 'xh', 'xhs'].includes(tool);
  const valueFlags = tool === 'curl' ? CURL_VALUE_FLAGS : tool === 'wget' ? WGET_VALUE_FLAGS : HTTPIE_VALUE_FLAGS;
  // curl bundles short flags (-sXPUT, -sSd@f): split them into separate words, a value-taking letter ends the bundle
  const unbundle = (w) => {
    if (tool !== 'curl' || !/^-[A-Za-z]/.test(w) || w.length <= 2) return [w];
    const out = [];
    for (let k = 1; k < w.length; k++) {
      out.push(`-${w[k]}`);
      if (CURL_SHORT_VALUE.includes(w[k])) { if (k + 1 < w.length) out.push(w.slice(k + 1)); break; }
    }
    return out;
  };
  let words = argv.slice(1).map((a) => expandVars(a, ctx)).flatMap(unbundle);
  const methods = [];
  let implied = false;
  let sawNext = false;
  const urls = [];
  const data = [];
  let unknown = false;
  let urlFile = false;
  let configs = 0;
  let configUnreadable = false;
  let globoff = false; // curl -g / --globoff: without it curl expands [a-b] ranges and {x,y} lists in a URL, even a quoted one
  let requestTarget = false; // curl --request-target: the path sent, whatever the URL says
  let strangeFlag = null; // an option this parser does not know that carries a /repos/ path
  const readData = (v, isFile) => {
    const value = v;
    const urlenc = /^[^=@\s]*@(.+)$/.exec(value); // --data-urlencode name@file
    if (!isFile && !value.startsWith('@') && !/^[^=\s]+=@/.test(value) && !urlenc) { data.push(value); return; }
    const p = isFile ? value : (value.startsWith('@') ? value.slice(1) : urlenc && !value.includes('=') ? urlenc[1] : value.slice(value.indexOf('=@') + 2));
    if (p === '-' || p === '' || dir === null) { unknown = true; return; }
    countScript(ctx.budget);
    const text = ctx.readText(path.resolve(dir, p));
    if (typeof text === 'string') { data.push(text); data.push(value); } else unknown = true;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { urls.push(...words.slice(i + 1)); break; }
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    const flag = eq > 0 ? w.slice(0, eq) : (!httpie && /^-[A-Za-z]./.test(w) && !w.startsWith('--') ? w.slice(0, 2) : w);
    const attached = eq > 0 ? w.slice(eq + 1) : (!httpie && /^-[A-Za-z]./.test(w) && !w.startsWith('--') ? w.slice(2) : null);
    const value = () => (attached !== null ? attached : (words[++i] ?? ''));
    if (flag === '--next' || flag === '-:') { sawNext = true; continue; }
    if (flag === '-X' || flag === '--request' || flag === '--method') { methods.push(value().toUpperCase()); continue; }
    if (tool === 'curl' && (flag === '--url')) { urls.push(value()); continue; }
    if (tool === 'curl' && (flag === '-K' || flag === '--config')) {
      const file = value();
      if (file === '-' || file === '' || dir === null || ++configs > 3) { configUnreadable = true; continue; }
      countScript(ctx.budget);
      const text = ctx.readText(path.resolve(dir, file));
      if (typeof text !== 'string') { configUnreadable = true; continue; }
      words = [...words.slice(0, i + 1), ...curlConfigWords(text).map((x) => expandVars(x, ctx)), ...words.slice(i + 1)];
      continue;
    }
    if (tool === 'curl' && flag === '--request-target') { requestTarget = true; value(); continue; }
    if (URL_FILE_FLAGS.has(flag) && tool === 'wget') { value(); urlFile = true; continue; }
    if (HTTP_DATA_FLAGS.has(flag) && !(httpie && flag.length === 2 && flag !== '-F')) { implied = true; readData(value(), HTTP_FILE_FLAGS.has(flag)); continue; }
    if (valueFlags.has(flag)) { value(); continue; }
    if (w.startsWith('-')) {
      if (eq > 0 && /(?:^|[/=])(?:repos|repositories)\/[^/]+\/[^/]+/i.test(w.slice(eq + 1))) strangeFlag ??= flag;
      continue;
    }
    if (httpie && HTTP_METHODS.includes(w.toUpperCase())) { methods.push(w.toUpperCase()); continue; }
    if (!httpie && /^[A-Z]{3,7}$/.test(w) && HTTP_METHODS.includes(w) && urls.length === 0 && methods.length === 0) { methods.push(w); continue; }
    if (!/:\/\//.test(w) && (/^[A-Za-z0-9_.\[\]-]+(?::=|=@?|:)/.test(w) && !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/:]|$)/.test(w))) {
      if (!/^[A-Za-z0-9_.\[\]-]+==/.test(w) && /=/.test(w)) { implied = true; readData(w, false); } // (httpie / xh data item; `key==v` is a query parameter, `Name:v` a header)
      continue;
    }
    urls.push(w);
  }
  // (a curl config file may set the URL, the method and the data: one that cannot be read here is refused whatever else the line says)
  if (configUnreadable) return deny('the curl config file (-K / --config) cannot be read here (stdin, a missing file or too many), and it may set the URL and the method, so the call cannot be verified. Put the options on the command line.');
  // Every method named anywhere counts (--next starts a new transfer with its own options: the last -X must not hide an earlier PUT). Data without a method is a POST.
  const bad = methods.find((m) => !SAFE_METHODS.includes(m));
  const nonGet = bad !== undefined || (implied && (methods.length === 0 || sawNext));
  const verb = bad ?? 'POST';
  if (nonGet && (urlFile || unknown && urls.length === 0)) return deny(`${verb} whose URL or config comes from a file / stdin / a config file that cannot be read here, so what it calls cannot be verified. Write the URL on the command line.`);
  if (nonGet && urls.length === 0) return deny(`${verb} with no URL on the command line (it comes from stdin, xargs or a config), so what it calls cannot be verified. Write the URL out.`);
  for (const w of urls) {
    const host = (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^/@?#]*@)?([^/:?#]*)/.exec(w) ?? [])[1] ?? '';
    // (curl expands `pulls/[3-3]/merge` to `pulls/3/merge` and `{comments,comments}` lists, so the endpoint judged below is not the one called.
    // -g / --globoff is NOT trusted to switch this off: a later --no-globoff, a -g taken as the value of an option this parser does not
    // know, or a config file can each leave globbing on, and no real GitHub write needs [ or { in its URL.)
    const v6 = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^/@?#]*@)?\[[0-9A-Fa-f:.]*\]/.exec(w); // an IPv6 literal host ([::1]) is not a glob and not github.com
    const globbed = tool === 'curl' && /[[{]/.test(v6 ? w.slice(v6[0].length) : w);
    const hostUnknown = host === '' || DYNAMIC.test(host) || /[{}]/.test(host); // ({} is the placeholder of xargs / find: the URL comes from elsewhere)
    if (!hostUnknown && !GH_HOST.test(host) && !(globbed && !v6 && /[[{]/.test(host))) continue; // (a glob in the host can expand to github.com)
    if (!nonGet) {
      if (!hostUnknown && DYNAMIC.test(w) && /\$\(|`/.test(w)) return deny('the URL is built at run time ($(...) / backticks) for a github.com host, so what it calls cannot be verified. Write the URL out.');
      continue;
    }
    if (globbed) return deny(`${verb} to a URL with curl globbing ([a-b] / {x,y}) that may point at github.com: curl expands it, so the endpoint it calls cannot be verified (-g / --globoff does not change this). Write the URL without [ ] { }.`);
    if (hostUnknown || DYNAMIC.test(w)) return deny(`${verb} to a URL built at run time ($VAR / $(...)) that may point at github.com cannot be verified. Write the URL out.`);
    if (requestTarget) return deny(`${verb} with curl --request-target to a github.com host: it replaces the path of the URL, so the endpoint it calls cannot be verified. Put the path in the URL.`);
    if (strangeFlag) return deny(`${verb} to a github.com host with an option this guard does not know (${strangeFlag}) that carries a repository path: it may replace the endpoint, so the call cannot be verified. Put the path in the URL.`);
    const ep = normaliseEndpoint(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(w) ? w : `https://${w}`);
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(ep)) return deny(`merging through the API bypasses the merge gate, like --admin. ${OWNER_ONLY}`);
    if (/\/merges$/i.test(`/${ep}`)) return deny(`merging branches through the API can move main without a PR. ${OWNER_ONLY}`);
    if (/\/git\/refs(\/|$)/i.test(`/${ep}`)) return deny(`${verb} to git refs through the API is blocked. ${OWNER_ONLY}`);
    // (a body built at run time on a comment route, or a graphql document with a command substitution, cannot be read)
    if (COMMENT_ROUTE.test(ep) && data.some((d) => runTimeText(d))) return deny(COMMENT_RUNTIME);
    if (ep === 'graphql' && data.some((d) => /\$\(|`|\$\{/.test(d))) return deny('the graphql document is built at run time, so it cannot be verified. Write the query text out.');
    const queries = [];
    for (const d of data) {
      try {
        const j = JSON.parse(d);
        for (const o of Array.isArray(j) ? j : [j]) if (o && typeof o.query === 'string') queries.push(o.query);
      } catch { if (/\bmutation\b/.test(d)) queries.push(d); }
    }
    const rest = ['-X', verb, ep, ...data.flatMap((d) => ['-f', `data=${d}`]), ...queries.flatMap((q) => ['-f', `query=${q}`]), ...(unknown ? ['--input', '-'] : [])];
    const v = checkApi(rest, {}, dir, ctx);
    if (v) return v;
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

// Every directory a command list may run in: where it starts and each cd / pushd target (chained ones too), like files-policy's collectDirs.
// (startDir null: where the list starts is unknown — a script judged after the line lost its directory — so no place is named; the bare word stays the fallback, see locate)
function cdTargets(cmds, startDir, ctx) {
  const dirs = startDir === null ? [] : [startDir];
  for (const c of cmds) {
    const nm = c.argv.length ? baseName(c.argv[0]) : '';
    if (nm !== 'cd' && nm !== 'pushd') continue;
    const t = c.argv.slice(1).find((a) => !a.startsWith('-'));
    const e = t === undefined ? '~' : expandVars(t, ctx).replace(/^\$\{?HOME\}?(?=\/|$)/, () => lineHome(ctx) ?? '$HOME');
    if (DYNAMIC.test(e) || e === '-') continue;
    // (a HOME the line or the cd's prefix sets: see nextDir)
    const home = t === undefined && Object.hasOwn(c.env ?? {}, 'HOME') ? null : lineHome(ctx);
    if ((e === '~' || e.startsWith('~/')) && home === null) continue;
    const target = e === '~' || e.startsWith('~/') ? home + e.slice(1) : e;
    for (const d of [...dirs]) {
      const nd = path.resolve(d, target);
      if (!dirs.includes(nd) && dirs.length < 32) dirs.push(nd);
    }
  }
  return dirs;
}

// Where `p` really is: the realpath of its longest existing prefix (symlinks followed) with the missing tail kept; null when the OS refuses
// (a loop, no permission), which the write model reads as "cannot tell".
function realLocation(realpath, p) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 256; i++) {
    try {
      return path.join(realpath(cur), ...tail.slice().reverse());
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes(e?.code)) return null;
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

// ---- script files and strings the parser cannot unwrap ----------------------------------------------------

const SHEBANG_PROGRAM = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(\S+)/;
const isNodeModulesOrPipelineHome = (p) => /[\\/]node_modules[\\/]/.test(p) || /[\\/]\.claude[\\/]pipeline[\\/]/.test(p);

// `bash push.sh`, `source f`, `./f`, `node f.mjs`: read the file (up to 1 MB) from the directory the command runs in and judge
// it like the same text typed on the line. A shell script that exists but cannot be read is denied (what runs is
// unknown); one that does not exist runs nothing. Programs run by path and interpreter files are only scanned when
// readable (a binary, a huge generated file or a package under node_modules is not ours to judge).
function checkScriptFile(sf, dir, ctx, level) {
  if (sf.kind === 'sqllines') return judgeSqlEscapes(sf.lines, sf, dir, ctx, level);
  if (sf.joined) return checkJoinedScripts(sf, dir, ctx, level);
  if (sf.ambiguous) return checkCandidateScripts(sf, dir, ctx, level);
  // a candidate is a final path (a glob match, or a word already expanded): the shell never expands it a second time
  const file = sf.candidate ? sf.file : expandVars(sf.file, ctx);
  if (!sf.candidate && /^\$\{?HOME\}?(?=\/|$)/.test(file)) return checkScriptFile({ ...sf, file: ctx.home + file.replace(/^\$\{?HOME\}?/, '') }, dir, ctx, level);
  if (!sf.candidate && DYNAMIC.test(file)) {
    // quoting is lost (`'x$y.sh'` reads as `x$y.sh`): if the word as written is a file, judge it before the textual rule
    const lit = checkScriptFile({ kind: sf.kind, family: sf.family, file: sf.file, candidate: true }, dir, ctx, level);
    if (lit) return lit;
    // Defensive (mutation check): every word with a `$` is `ambiguous` and goes to checkCandidateScripts above, whose own fallback (judgedTexts) holds this; kept for a word that reaches here as a plain name.
    return sf.kind !== 'exec' && judgedTexts(ctx).some((x) => GUARDED_WORDS.test(x))
      ? deny(`the script "${sf.file}" is named at run time and the line mentions a guarded operation, so what it runs cannot be verified. Name the file.`)
      : null;
  }
  const home = !sf.candidate && (file === '~' || file.startsWith('~/')) ? ctx.home + file.slice(1) : file;
  // a relative script after a cd that may not have run: which file runs is unknown, never the starting directory's
  // (a scan word is a guess at a file name, not a script: it is looked up in the starting directory instead)
  // Why: a `~/…` word (also the as-written reading of an rc glob such as ~/.psqlrc-*) is the home, whatever directory the line is in
  if (dir === null && sf.kind !== 'scan' && !path.isAbsolute(home) && !(sf.candidate && /^~(?:\/|$)/.test(sf.file))) return deny(`cannot tell which directory this runs in, so which ${sf.file} runs cannot be verified. Use an absolute path, or chain the cd with &&.`);
  const abs = path.resolve(dir ?? ctx.cwd, home);
  checkDeadline(ctx.budget);
  // a script the line itself wrote (or may have written) before this command is judged on every content it may hold, as well as on the file as it is now
  if (!sf.noWrites) {
    const w = writtenTo(ctx.writeFrames, abs, { exists: ctx.pathExists, readText: ctx.readText, ignoreUnmodelled: sf.startup === true || ctx.ignoreUnmodelled === true });
    if (w) {
      if (w.viaUnmodelled) ctx.budget.unmodelledSeen = (ctx.budget.unmodelledSeen ?? 0) + 1;
      const v = judgeWrittenScript(w, sf, abs, dir, ctx, level);
      if (v) return v;
    }
  }
  const text = ctx.readText(abs);
  if (typeof text !== 'string') {
    if (sf.candidate && ctx.readDir(abs)) return null; // a shell cannot run a directory
    if ((sf.kind === 'shell' || sf.whole) && ctx.pathExists(abs)) return deny(`cannot read the script ${sf.file} (missing permission, a directory or larger than 1 MB), so what it runs cannot be verified.`);
    // over the read cap: a program run by path is peeked at (a shell script is refused, a binary or an interpreter file is not
    // ours to judge); text a rewriting command computes from a file we cannot read cannot be scanned
    if (sf.kind === 'exec' || sf.kind === 'scan' || sf.kind === 'sql') {
      const head = ctx.readHead(abs);
      if (typeof head === 'string' && (sf.kind === 'scan' || sf.kind === 'sql' || isShellHead(head))) return deny(`${sf.file} is too large to verify (over 1 MB), so what it runs (or feeds a shell) cannot be known.`);
    }
    return null; // missing: nothing will run
  }
  return judgeScriptText(text, sf, abs, dir, ctx, level);
}

// The text of a script file (as read, or as the line writes it), judged by what kind of file it is.
function judgeScriptText(text, sf, abs, dir, ctx, level) {
  countScript(ctx.budget); // every script read and judged counts, named or candidate: the work multiplies with each level
  // text a command rewrites on its way to a shell (sed, awk, base64 ...) is computed at run time: a file holding a guarded word is refused
  if (sf.kind === 'scan') return GUARDED_WORDS.test(text) ? deny(`${sf.file} is read by a command that feeds a shell, and mentions a guarded operation, so what the shell runs cannot be verified. Write the command out literally.`) : null;
  // Why: psql / mysql / sqlite3 run only the shell escapes in their input (\! , \g |cmd, .shell ...): those lines are judged like a script
  if (sf.kind === 'sql') return judgeSqlEscapes(sqlShellEscapes(text, { family: sf.family, sources: [abs] }), sf, dir, ctx, level);
  let kind = sf.kind;
  if (kind === 'exec') {
    if (!text.startsWith('#!') && text.slice(0, 512).includes('\u0000')) return null; // a binary (the test binIsProgram uses: a shebang line makes it a script whatever follows)
    const prog = SHEBANG_PROGRAM.exec(text)?.[1] ?? '';
    kind = !sf.asShell && /^(?:node|nodejs|deno|bun|tsx|ts-node|python[\d.]*|ruby|perl|php)$/.test(prog.split('/').pop()) ? 'interp' : 'shell'; // (asShell: binKind found the interpreter to be the project's own file -- a shell script whatever the shebang names)
    // Why: the kernel starts the shebang's shell, which reads the startup files its options ask for (`#!/bin/bash -l`, `#!/bin/zsh`): judged like `bash -l f` / `zsh f`
    const sh = kind === 'shell' && ctx.execCmd ? shebangShell(text) : null;
    if (sh) {
      const { c, cmds } = ctx.execCmd;
      const v = judgeStartupList(startupFilesOf({ ...c, argv: [...sh, abs] }, cmds, { env: ctx.env, inherited: (n) => knownValues(ctx, n) }), c, dir, ctx, level);
      if (v) return v;
    }
  }
  if (kind === 'interp') {
    if (isNodeModulesOrPipelineHome(abs)) return null;
    const why = guardedCommandText(text);
    return why ? deny(`the program ${sf.file} contains a guarded command (${why}); it cannot be verified by the guard. Run the operation directly.`) : null;
  }
  if (level >= MAX_NESTING) return deny(`the script ${sf.file} is nested too deeply (scripts running scripts) to verify.`);
  const v = judgeScoped(text, dir, ctx, level, sf, !sf.sourced); // (a script of its own takes readings (judgeReadings); a sourced file shares the line's variables, which evalString's check after `source` makes unsure: the same as before)
  return v.decision === 'deny' ? deny(`the script ${sf.file} would run a blocked command: ${v.reason}`) : null;
}

// #81 t9: `npm run deploy`, `npm test`, `pnpm ship`, `yarn run x`, `bun run x` run the text package.json holds for the script (and its pre / post hooks, with the words after `--` appended), in the
// package's directory: judged like `bash -c TEXT` run there (a script of its own: readings, nested scripts). The same text runs whatever manager spells it; see package-scripts.mjs.
// A script, directory or setting that is only known at run time cannot be read: refused when the line mentions a guarded operation (as for `bash $F`); a setting that moves the package.json
// (npm_config_prefix, INIT_CWD, PNPM_* ...) always, as which package.json the manager reads is then unknown.
const pkgEnv = (ctx, cwd) => ({
  cwd, home: ctx.home, nodePrefix: ctx.nodePrefix, readText: ctx.readText, pathExists: ctx.pathExists, lexists: ctx.lexists, readDir: ctx.readDir, cache: (ctx.budget.pkgCache ??= new Map()), p: path, tick: () => checkDeadline(ctx.budget),
  written: (abs) => pkgFileWritten(ctx, abs),
  mentionsGuarded: () => lineMentionsGuarded(ctx),
  lineNames: () => lineNames(ctx.fullText),
});
// #89 t2: do the line's writes reach a file the manager reads (package.json, a configuration file)? Asked like the plain-script path asks about a script file (checkScriptFile): 'known' is a write that names the file;
// 'maybe' is one it cannot (a target only known at run time, a link it cannot follow, an extraction below a directory). A file that is missing is NOT "something an unmodelled command may have created" here (a rc file is usually missing, and the
// existing run.sh of `node -e '...' && bash run.sh` is not either): only the writes themselves count.
// A write that may reach the file but is certain to hold nothing the guard minds (a copy from a source that does not exist) is none; one whose text or source mentions a guarded operation is refused as a known write.
function pkgFileWritten(ctx, abs) {
  if (writtenTo(ctx.writeFrames, abs, { exists: ctx.pathExists, readText: ctx.readText, ignoreUnmodelled: true, foldCase: true })?.named) return 'known';
  const w = writtenTo(ctx.writeFrames, abs, { exists: (x) => x === abs || ctx.pathExists(x), readText: ctx.readText, ignoreUnmodelled: ctx.ignoreUnmodelled === true, genericAsUnknown: true, foldCase: true });
  if (!w) return null;
  const now = ctx.readText(abs); // (what the file holds now is no write: a target only known at run time leaves it as it is, and its own words are not the line's, whether it stands alone or in front of an append)
  const added = (t) => (typeof now === 'string' && now !== '' ? t.split(now).join('') : t);
  const sources = w.files.map((f) => ctx.readText(f)).filter((t) => typeof t === 'string');
  if ([...w.texts, ...w.joined.map(added), ...sources].some((t) => GUARDED_WORDS.test(t) || guardedCommandText(t))) return 'known';
  return w.unknown || w.pieces || w.authored || w.programs.length || w.scans.length || w.texts.length || sources.length ? 'maybe' : null;
}

const MARKERS_MSG = (said, kind) => `package script: an earlier command on the line (mkdir, touch, rm, mv, cp, ln ...) ${kind === 'known' ? 'creates, removes or renames' : 'may create, remove or rename (a path only known at run time), while the line mentions a guarded operation,'} a package.json, node_modules, server.js, binding.gyp or configuration file that \`${said}\` depends on (in the package's directory or above it), so which script it runs cannot be verified. Run it in a command of its own.`;
function packageScriptVerdict(argv, dir, ctx, level) {
  const call = pmCall(argv.map((a) => expandVars(a, ctx)));
  if (!call) return null;
  const said = argv.slice(0, 4).join(' ');
  if (call.unresolved) return deny('package script: ' + call.unresolved);
  // (a variable family the managers read, or a name exported that is only known at run time: `export $N=x`)
  const mover = call.mover ? call.mover : pmMoverName([...Object.keys(ctx.vars), ...ctx.unsureVars, ...ctx.tainted]) ?? ((ctx.nameRun ??= nameAtRunTimeIn(ctx.fullText)) ? 'a variable named at run time' : null);
  if (mover) return deny(`package script: ${mover} may point the package manager at another package.json or configuration, so which script \`${said}\` runs cannot be verified. Run it without it (set the directory with --prefix).`);
  // (the manager's own write earlier on the line, or in a script it ran, changed package.json or a configuration file: markPackageState)
  if (pkgOwnWrite(ctx.budget)) return deny(`package script: an earlier command on the line (npm pkg set, npm set-script, npm config set, npm init ...) changes package.json or the package manager's configuration before \`${said}\` reads them, so which script it runs cannot be verified. Run it in a command of its own.`);
  if (call.dynamic || call.dirDynamic) {
    return lineMentionsGuarded(ctx)
      ? deny('package script: the script (or directory) \`' + said + '\` runs is only known at run time and the line mentions a guarded operation, so what it runs cannot be verified. Name the script.')
      : null;
  }
  if (dir === null) {
    // a directory the guard lost track of (after a sourced file or a cd it cannot follow): judged like a script named at run time (`bash $F`) -- refused when the line mentions a guarded operation (t11)
    return lineMentionsGuarded(ctx) ? deny('package script: the directory this runs in is unknown (after a cd or a sourced file the guard cannot follow) and the line mentions a guarded operation, so which package.json `' + said + '` reads cannot be verified. Chain the cd with &&, or use an absolute --prefix.') : null;
  }
  const plan = packageScripts(call, pkgEnv(ctx, dir));
  if (plan.refuse) return deny(plan.refuse);
  const marked = pkgMarkersFor(ctx.budget, pmStartDirs(call, [dir], ctx.home, path), { pathExists: ctx.pathExists, real: (q) => realLocation(ctx.realpath, q), p: path });
  if (marked === 'known' || (marked === 'maybe' && lineMentionsGuarded(ctx))) return deny(MARKERS_MSG(said, marked));
  for (const run of plan.runs ?? []) {
    // (the manager puts every node_modules/.bin from the package's directory upward on the PATH of the script's commands: a bare command name in it may be one of those bins)
    const outerBinDir = ctx.scriptBinDir;
    ctx.scriptBinDir = run.binDir ?? run.dir;
    try {
      const v = judgeScriptText(run.text, { kind: 'shell', file: run.label }, run.file, run.dir, ctx, level);
      if (v) return v;
    } finally {
      ctx.scriptBinDir = outerBinDir;
    }
  }
  // (yarn / pnpm / bun NAME with no script of that name run node_modules/.bin/NAME)
  if (call.bin && !(plan.runs ?? []).some((r) => r.name === call.main)) return binVerdict(call.bin, dir, ctx, level);
  return null;
}

// #81 t9: `npx tool`, `npm exec tool`, `pnpm exec tool`, `yarn tool`: a bare name is the bin node_modules/.bin/tool of the nearest directory that has one; when that is a shell script it is judged like `./tool`.
// (A program in another language, the usual bin, is not opened: checkScriptFile leaves node_modules programs alone, and a path word is already judged as a program run by path.)
// An install earlier on the line may add the bin: refused when the line mentions a guarded operation, as for any file that only exists at run time.
// #89 t2: a bin that is a program in another language (a node shebang: vitest, tsc, eslint ...) is none of the shell's. The text a heredoc appends to some other
// file, or a copy back from a backup, is not what it runs, so only a write the guard places on the bin itself (the line replacing the program) is judged.
// What decides is the file's first bytes alone (binIsProgram): the extension and the target of a link never do, as a file without a shebang is run by sh.
// 'open': a shell script (or one that cannot be read, which checkScriptFile refuses or sizes up); 'program': not opened.
function binKind(bin, ctx, dir) {
  const site = binSite(bin, dir, ctx.pathExists, path);
  const text = ctx.readText(bin);
  if (typeof text === 'string') return binIsProgram(text, site) ? 'program' : 'open';
  if (!ctx.pathExists(bin) || ctx.readDir(bin)) return 'open'; // (missing: the line's own write is judged by checkScriptFile)
  const head = ctx.readHead(bin);
  if (typeof head !== 'string') return 'unreadable';
  return binIsProgram(head, site) ? 'program' : 'open';
}
// R2-B1: the shebang of an opened bin names a file the project controls (binInterpreter): THAT file runs, with the bin as its argument, so it is judged as the bin is (opened as a shell script unless it is itself a program),
// and the one its own shebang names after it. A loop (a node_modules/.bin/node whose shebang finds itself) or a chain of more than MAX_BIN_INTERPRETERS cannot be verified: refused.
function interpreterVerdict(bin, dir, ctx, level) {
  const site = binSite(bin, dir, ctx.pathExists, path);
  const seen = new Set([bin]);
  for (let cur = bin; ;) {
    const interp = binInterpreter(ctx.readText(cur), site);
    if (!interp) return null;
    if (seen.has(interp) || seen.size > MAX_BIN_INTERPRETERS) return deny(`${bin} runs through the interpreter ${interp}, which loops back or sits in a chain of more than ${MAX_BIN_INTERPRETERS} interpreters, so what it runs cannot be verified.`);
    seen.add(interp);
    if (!ctx.pathExists(interp) || ctx.readDir(interp)) return null; // (missing: execve fails, nothing runs)
    const kind = binKind(interp, ctx, dir);
    if (kind === 'unreadable') return deny(`cannot read the interpreter ${interp} of ${bin} (missing permission), so what it runs cannot be verified.`);
    if (kind !== 'open') return null;
    const v = checkScriptFile({ kind: 'exec', file: interp, candidate: true, asShell: true }, dir, ctx, level);
    if (v) return v;
    cur = interp;
  }
}
// `quiet`: the lookup of a command inside a package script (PATH has node_modules/.bin): a name with no bin there is an ordinary command, nothing to refuse
function binVerdict(name, dir, ctx, level, quiet = false, lookup = dir) {
  // (a bin is a program file like a script: the plain-script reading of what the line writes, a missing one included)
  // (quiet: every command word of a script is looked up, so only a write that certainly puts a bin there counts, not one that may)
  const written = (abs) => (writtenTo(ctx.writeFrames, abs, { exists: ctx.pathExists, readText: ctx.readText, ignoreUnmodelled: true }) ? 'known' : !quiet && writtenTo(ctx.writeFrames, abs, { exists: ctx.pathExists, readText: ctx.readText, ignoreUnmodelled: ctx.ignoreUnmodelled === true }) ? 'maybe' : null);
  const maybes = [];
  const bin = localBin(name, { cwd: lookup, pathExists: ctx.pathExists, p: path, written, onMaybe: (f) => maybes.push(f) });
  for (const m of maybes) { // (a bin the line may write: judged on what it may hold, and refused when the line mentions a guarded operation)
    const v = checkScriptFile({ kind: 'exec', file: m, candidate: true }, dir, ctx, level);
    if (v) return v;
  }
  const kind = bin ? binKind(bin, ctx, dir) : null;
  if (kind === 'program') {
    const w = writtenTo(ctx.writeFrames, bin, { exists: ctx.pathExists, readText: ctx.readText, ignoreUnmodelled: true });
    return w ? judgeWrittenScript(w, { kind: 'exec', file: bin, candidate: true }, bin, dir, ctx, level) : null;
  }
  if (kind === 'unreadable') return deny(`cannot read node_modules/.bin/${name} (${bin}: missing permission), so whether it is a shell script and what it runs cannot be verified.`);
  if (bin) {
    const own = checkScriptFile({ kind: 'exec', file: bin, candidate: true, asShell: kind === 'open' }, dir, ctx, level);
    return own ?? (kind === 'open' ? interpreterVerdict(bin, dir, ctx, level) : null);
  }
  return !quiet && ctx.budget.pkgBinsDirty && lineMentionsGuarded(ctx) ? deny(`package script: an earlier install on the line may add node_modules/.bin/${name}, and the line mentions a guarded operation, so what it runs cannot be verified. Run the install in a command of its own.`) : null;
}
function runnerBinVerdict(argv, dir, ctx, level, quiet = false, lookup = dir) {
  const name = expandVars(argv[0], ctx);
  return name.includes('/') ? null : binVerdict(name, dir, ctx, level, quiet, lookup);
}

function judgeSqlEscapes(escapes, sf, dir, ctx, level) {
  if (!escapes.length) return null;
  if (level >= MAX_NESTING) return deny(`the input ${sf.file} is nested too deeply (database clients running files that run clients) to verify.`);
  const v = judgeScoped(escapes.join('\n'), dir, ctx, level, sf);
  return v.decision === 'deny' ? deny(`the input ${sf.file} would run a shell command: ${v.reason}`) : null;
}

// Several files that feed ONE shell (`cat a b | bash`): the shell reads their texts one after the other, so they are judged joined, in the
// order the command names them, repeats included (a guarded command split across them is one command). `scan`: the text a rewriting command
// prints from them (in an order we do not know): refused when a guarded word is in the joined text, read in either order.
function checkJoinedScripts(sf, dir, ctx, level) {
  const parts = [];
  const srcs = [];
  // (`pieces`: static text a producer prints between the files, in stream order -- scriptFeedsOf)
  for (const pc of sf.pieces ?? sf.joined.map((file) => ({ file }))) {
    if (Object.hasOwn(pc, 'text')) { parts.push([pc.text]); continue; }
    const w = pc.file;
    const home = w === '~' || w.startsWith('~/') ? ctx.home + w.slice(1) : w;
    if (dir === null && sf.kind !== 'scan' && !path.isAbsolute(home)) return deny(`cannot tell which directory this runs in, so which ${w} runs cannot be verified. Use an absolute path, or chain the cd with &&.`);
    const abs = path.resolve(dir ?? ctx.cwd, home);
    checkDeadline(ctx.budget);
    const text = ctx.readText(abs);
    if (typeof text !== 'string') {
      if (sf.kind === 'shell' && ctx.pathExists(abs)) return deny(`cannot read the script ${w} (missing permission, a directory or larger than 1 MB), so what it runs cannot be verified.`);
      if (sf.kind === 'scan' || sf.kind === 'sql') {
        const head = ctx.readHead(abs);
        if (typeof head === 'string') return deny(`${w} is too large to verify (over 1 MB), so what it runs (or feeds a shell) cannot be known.`);
      }
    }
    // Why: a part the line writes before this command may hold what those writes put there, not what is on disk now (Codex review 3 of #50: `printf 'git pu' > a;
    // printf 'sh origin main' > b; cat a b | bash`): every text it may hold is joined with every text of the others. A content only known at run time is judged as
    // for a single script, and refused when the line mentions a guarded operation (what it adds to the join cannot be read)
    let cands = null;
    // (`own`: the line's own writes the guard places; `any`: also a command that may write anything, eval, a program the guard does not model)
    const own = writtenTo(ctx.writeFrames, abs, { exists: ctx.pathExists, readText: ctx.readText, ignoreUnmodelled: true });
    const wr = own ?? writtenTo(ctx.writeFrames, abs, { exists: ctx.pathExists, readText: ctx.readText, ignoreUnmodelled: sf.startup === true || ctx.ignoreUnmodelled === true });
    if (wr) {
      cands = own ? writtenCandidates(own, typeof text === 'string' ? text : null, (q) => ctx.readText(q)) : null;
      // (a part the line itself rewrites with a text the guard cannot build, `tr X s < src > b.sh`: the stream cannot be rebuilt; Codex recheck of a5c0e5a)
      if (own && cands === null && sf.kind !== 'scan') return deny(`${w} is rewritten earlier on the line with a text that cannot be worked out, and it is fed to one program together with other files, so what runs cannot be verified. Run the files one by one, or write the text out.`);
      if (cands === null) {
        const r = isolatedState(ctx, () => judgeWrittenScript(wr, sf, abs, dir, ctx, level)); // (a fragment: what it changes is not the line's, see R2-B2)
        if (r) return r;
        if (lineMentionsGuarded(ctx)) return deny(`${w} may be written earlier on the line with a text only known at run time, and it is fed to one program together with other files while the line mentions a guarded operation, so what runs cannot be verified. Run the files one by one, or write the text out.`);
      }
    }
    if (cands === null) {
      if (typeof text !== 'string') continue; // missing: it prints nothing
      cands = [text];
    }
    countScript(ctx.budget);
    parts.push(cands);
    srcs.push(abs);
  }
  if (!parts.length) return null;
  const readings = joinedReadings(parts);
  const back = sf.kind === 'scan' ? joinedReadings([...parts].reverse()) : []; // (a rewriting command prints them in an order we do not know)
  if (readings === null || back === null) return deny(`${sf.file} may hold too many texts together (files the line writes first), so what they run when fed to one program cannot be verified. Run the files one by one.`);
  // (one reading is the program the shell runs: what it changes carries on; of several, which one runs is not known, so each is a candidate: see judgeScoped)
  const all = [...new Set([...readings, ...back])].filter(Boolean);
  for (const t of all) {
    const v = judgeJoinedText(t, all.length > 1 ? { ...sf, candidate: true } : sf, srcs, dir, ctx, level);
    if (v) return v;
  }
  return null;
}
function judgeJoinedText(text, sf, srcs, dir, ctx, level) {
  if (sf.kind === 'scan') {
    return GUARDED_WORDS.test(text)
      ? deny(`${sf.file} are read by a command that feeds a shell, and mention a guarded operation, so what the shell runs cannot be verified. Write the command out literally.`)
      : null;
  }
  // Why: the fed text of an interpreter (`cat a b | node`) is one program, judged as program text like a single `node f.mjs`, not as shell commands
  if (sf.kind === 'interp') {
    const why = guardedCommandText(text);
    return why ? deny(`the programs ${sf.file} (fed to an interpreter together) contain a guarded command (${why}); it cannot be verified by the guard. Run the operation directly.`) : null;
  }
  // Why: the client reads the files as ONE stream (a meta-command can start in one and end in the next), so the escapes are read from the joined text
  if (sf.kind === 'sql') return judgeSqlEscapes(sqlShellEscapes(text, { family: sf.family, sources: srcs }), sf, dir, ctx, level);
  if (level >= MAX_NESTING) return deny(`the scripts ${sf.file} are nested too deeply (scripts running scripts) to verify.`);
  const v = judgeScoped(text, dir, ctx, level, sf);
  return v.decision === 'deny' ? deny(`the scripts ${sf.file} would run a blocked command: ${v.reason}`) : null;
}

// The command's own prefix assignments (`F=f.sh bash run.sh`) are in the environment of the shell it starts: the startup files and the
// script that shell runs see them. Seeded into ctx for the duration of `fn` and put back after (the line itself does not keep them).
// A value that is only known at run time makes the variable unknown (refused where it picks a file).
function withPrefixEnv(cmd, ctx, fn) {
  if (ctx.prefixFor === cmd) return fn(); // (already in this command's startup scope: what the startup file set must not be put back)
  const entries = Object.entries(cmd?.env ?? {});
  if (!entries.length) return fn();
  const values = entries.map(([k, w]) => [k, expandVars(w, ctx)]);
  const saved = values.map(([k]) => [k, Object.hasOwn(ctx.vars, k), ctx.vars[k], ctx.unsureVars.has(k), ctx.tainted.has(k)]);
  for (const [k, v] of values) {
    ctx.tainted.delete(k);
    if (DYNAMIC.test(v)) { delete ctx.vars[k]; ctx.unsureVars.add(k); } else { ctx.vars[k] = v; ctx.unsureVars.delete(k); }
  }
  try {
    return fn();
  } finally {
    for (const [k, had, val, wasUnsure, wasTainted] of saved) {
      if (had) ctx.vars[k] = val; else delete ctx.vars[k];
      if (wasUnsure) ctx.unsureVars.add(k); else ctx.unsureVars.delete(k);
      if (wasTainted) ctx.tainted.add(k); else ctx.tainted.delete(k);
    }
  }
}

// The command's own variables, then the startup files the shell it starts reads (their assignments stay), then the script (see the call): everything
// the command's shell changed in variables is put back when it is done.
function withStartupScope(cmd, ctx, fn) {
  const saved = { vars: Object.assign(Object.create(null), ctx.vars), unsure: new Set(ctx.unsureVars), tainted: new Set(ctx.tainted) };
  try {
    return withPrefixEnv(cmd, ctx, () => {
      const outer = ctx.prefixFor;
      ctx.prefixFor = cmd;
      try { return fn(); } finally { ctx.prefixFor = outer; }
    });
  } finally {
    for (const k of Object.keys(ctx.vars)) delete ctx.vars[k];
    Object.assign(ctx.vars, saved.vars);
    ctx.unsureVars.clear();
    for (const k of saved.unsure) ctx.unsureVars.add(k);
    ctx.tainted.clear();
    for (const k of saved.tainted) ctx.tainted.add(k);
  }
}

// Judge `fn` on a copy of the line's state and put every field back afterwards, whatever `fn` changed (vars, taint, branches, config, aliases):
// for a text that is only a FRAGMENT of what the shell reads, so a change it makes is not one the line can rely on or be blamed for.
// (budget is shared on purpose, as in judgeScoped.)
function lineState(ctx) {
  return {
    vars: Object.assign(Object.create(null), ctx.vars), unsureVars: new Set(ctx.unsureVars), tainted: new Set(ctx.tainted), aliasUnsure: new Set(ctx.aliasUnsure),
    gitAliases: Object.assign(Object.create(null), ctx.gitAliases), ghAliases: Object.assign(Object.create(null), ctx.ghAliases),
    branches: new Map([...ctx.branches].map(([d, e]) => [d, { ...e }])), cfgDirty: ctx.cfgDirty, envCfgDirty: ctx.envCfgDirty,
  };
}
function restoreLineState(ctx, saved) {
  for (const k of ['vars', 'gitAliases', 'ghAliases']) { for (const n of Object.keys(ctx[k])) delete ctx[k][n]; Object.assign(ctx[k], saved[k]); }
  for (const k of ['unsureVars', 'tainted', 'aliasUnsure']) { ctx[k].clear(); for (const n of saved[k]) ctx[k].add(n); }
  ctx.branches.clear();
  for (const [d, e] of saved.branches) ctx.branches.set(d, { ...e });
  ctx.cfgDirty = saved.cfgDirty;
  ctx.envCfgDirty = saved.envCfgDirty;
}
function isolatedState(ctx, fn) {
  const saved = {
    vars: Object.assign(Object.create(null), ctx.vars), unsureVars: new Set(ctx.unsureVars), tainted: new Set(ctx.tainted), aliasUnsure: new Set(ctx.aliasUnsure),
    gitAliases: Object.assign(Object.create(null), ctx.gitAliases), ghAliases: Object.assign(Object.create(null), ctx.ghAliases),
    branches: new Map([...ctx.branches].map(([d, e]) => [d, { ...e }])), cfgDirty: ctx.cfgDirty, envCfgDirty: ctx.envCfgDirty,
  };
  try {
    return fn();
  } finally {
    for (const k of ['vars', 'gitAliases', 'ghAliases']) { for (const n of Object.keys(ctx[k])) delete ctx[k][n]; Object.assign(ctx[k], saved[k]); }
    for (const k of ['unsureVars', 'tainted', 'aliasUnsure']) { ctx[k].clear(); for (const n of saved[k]) ctx[k].add(n); }
    ctx.branches.clear();
    for (const [d, e] of saved.branches) ctx.branches.set(d, e);
    ctx.cfgDirty = saved.cfgDirty;
    ctx.envCfgDirty = saved.envCfgDirty;
  }
}

// Why: an earlier command on the line wrote (or may have written) the script about to be judged (cp f.sh n.sh; bash n.sh): judge each content it may
// hold. Static text and the files copied / catted into it are judged like the script; a file a rewriting command computes it from is scanned for
// guarded words; content that only exists at run time (curl -o, a program's output, a missing script after a command we do not model) is
// judged like a script named at run time: refused when the line mentions a guarded operation.
// Does the command line (the whole line, not a script judged inside it) contain a guarded command, with prose masked (git commit -m, gh --body ...; a
// heredoc body that feeds a non-shell is not a command at all)? The detector is the one used for interpreter files, plus the protection / ruleset /
// issue-close shapes of gh and git.
// The line as the guard reads it: every command's words without the values of prose flags (commit -m, --body ...). A heredoc body is not part of it.
// (a `git ... commit` command: the only one whose clustered flags -qm, -am, -qam are read as -m)
const isCommit = (argv) => baseName(argv[0] ?? '') === 'git' && argv.slice(1).includes('commit');
function maskedLine(ctx) {
  ctx.lineMasked ??= simpleCommands(ctx.lineText).filter((c) => c.argv.length).map((c) => [c.argv[0], ...dataLessArgs(c.argv.slice(1), isCommit(c.argv))].join(' ')).join('\n');
  return ctx.lineMasked;
}
// ... a guarded command, or (strictly) a guarded word: the masked line as written and with its quotes and escapes stripped
// (t11: a JavaScript method call -- `mounts.rw.push(x)`, `_.merge(a, b)` in a `node -e` program -- is no git subcommand: the name follows a dot that is part of the same word, with something to its
// left (`x.push(`). A bare `push(` or `.push(` is not excluded: in zsh `push(N)` is a glob with a qualifier that names the file `push`.)
const JS_METHOD_CALL = /[\w$\])]\.(?:push|merge)\(/gi;
const mentionsGuardedWord = (text) => GUARDED_WORDS.test(text.replace(JS_METHOD_CALL, '('));
function lineMentionsGuarded(ctx) {
  const m = maskedLine(ctx);
  return lineHoldsGuardedCommand(ctx) || mentionsGuardedWord(m) || mentionsGuardedWord(m.replace(/['"`\\]/g, ''));
}

function lineHoldsGuardedCommand(ctx) {
  if (ctx.lineHolds === undefined) {
    ctx.lineHolds = false;
    for (const c of simpleCommands(ctx.lineText)) {
      if (!c.argv.length) continue;
      const args = dataLessArgs(c.argv.slice(1), isCommit(c.argv));
      const text = [c.argv[0], ...args].join(' ');
      // (a push whose destination merely STARTS with main / master counts too: printf '%.19s' can cut a longer word down to it)
      if (guardedCommandText(text) || /git\s+(?:-\S+\s+)*push\b[^;&|\n]*\b(?:main|master)/i.test(text) || (['git', 'gh'].includes(baseName(c.argv[0])) && /(?:^|\s)(?:protection|ruleset|rulesets)(?=\s|$)|issue\s+close/i.test(text))) { ctx.lineHolds = true; break; }
    }
  }
  return ctx.lineHolds;
}

function judgeWrittenScript(w, sf, abs, dir, ctx, level) {
  // a source or a text judged clean once in this state is not judged again for the next script it may reach (a write whose target is only known at run time
  // reaches every script on the line, and the scripts it was copied from are the same files each time)
  const state = stateFingerprint(ctx, dir, level);
  const done = (ctx.budget.writtenOk ??= new Set());
  const once = (key, judge) => {
    const k = `${sf.kind}\u0000${key}\u0000${state}`;
    if (done.has(k)) return null;
    const r = judge();
    if (!r) done.add(k);
    return r;
  };
  for (const t of w.texts) {
    for (const v of new Set([t, expandVars(t, ctx)])) {
      const r = once(`T${v}`, () => judgeScriptText(v, sf, abs, dir, ctx, level));
      if (r) return r;
    }
  }
  for (const [list, kind] of [[w.files, sf.kind], [w.scans, 'scan']]) {
    for (const file of list) {
      const r = once(`F${kind}\u0000${file}`, () => checkScriptFile({ kind, file, candidate: true, sourced: sf.sourced, noWrites: true }, dir, ctx, level));
      if (r) return r;
    }
  }
  // the whole text several writes build together (appends, cat A B): no piece holds what the file runs
  for (const text of w.joined) {
    for (const v of new Set([text, expandVars(text, ctx)])) {
      const r = once(`T${v}`, () => judgeScriptText(v, sf, abs, dir, ctx, level));
      if (r) return r;
    }
  }
  if (w.pieces) return deny(`the script ${sf.file} is built from pieces at run time (several writes on the line put its text together, and one of them cannot be read), so what it runs cannot be verified. Write the file out in one piece.`);
  // text the line itself wrote but we cannot compute exactly (printf %.4s, %b, an escape we cannot read, echo dialects) is agent-written, not data
  if (w.authored) return deny(`the script ${sf.file} is written by this line with text that cannot be worked out exactly (a printf / echo conversion or escape), so what it runs cannot be verified. Write the file out in plain text.`);
  // an inline program that writes the script: judged by its own text (string concatenation joined)
  for (const prog of w.programs) {
    for (const v of flattenProgram(prog)) {
      const why = guardedCommandText(v);
      if (why || GUARDED_WORDS.test(v)) return deny(`the script ${sf.file} is written by an inline program that mentions a guarded operation${why ? ` (${why})` : ''}, so what it runs cannot be verified. Write the file out literally.`);
    }
  }
  // content only known at run time matters when the line (prose such as a commit message masked) mentions a guarded operation
  if (w.unknown && lineMentionsGuarded(ctx)) {
    return deny(`the script ${sf.file} may have been written by an earlier command on the line (its content is only known at run time) and the line mentions a guarded operation, so what it runs cannot be verified. Write the file out literally.`);
  }
  return null;
}

// (Inside it a missing file is not "something the line may have created": that verdict does not depend on the line; the line's own WRITES still count.)
// Why: the real home's startup files (~/.bash_profile, ~/.zshenv ...) are not named by any word of the line, and what they run does not
// depend on it. They are judged as an evaluation of their own (the line's variable state, but the guarded words of the FILE's text,
// not of the line, decide whether a run-time name in it is refused) and the verdict is kept for the whole evaluation, so a line with
// many shells reads each file once. An explicit one (BASH_ENV=, ZDOTDIR=, HOME=, --rcfile) is judged in the line's context instead.
// The variables the line has set before that shell starts (and its own prefix, `NVM_DIR=d bash -l`) are inherited: a file that sources
// "$NVM_DIR/nvm.sh" runs d/nvm.sh, and a value that is unknown makes that name unknown (refused). The memo is keyed on that state.
// The startup files a shell reads (startupFilesOf), in the order it reads them: the first denial, else null.
function judgeStartupList(list, c, dir, ctx, level) {
  for (const st of list) {
    // the real home's file (no word on the line names it) is judged on its own, once: see implicitStartupVerdict
    if (st.implicit) {
      const v = implicitStartupVerdict(st, ctx, c, dir);
      if (v) return v;
      continue;
    }
    // the shell sees the command's own prefix variables (`F=f.sh BASH_ENV=rc bash -c :` where rc sources "$F")
    const v = withPrefixEnv(c, ctx, () => {
      // a clean verdict is reused only in the very same state (it depends on the variables, branches and config the line has set so far, and on
      // what the line may have written), never for a run-time name
      const key = st.ambiguous ? null : `${st.file}\u0000${unmodelledBefore(ctx.writeFrames)}\u0000${stateFingerprint(ctx, dir, level)}`;
      if (key !== null) {
        if (ctx.budget.startupOk.has(key)) {
          // Why: a sourced startup file (BASH_ENV=rc) leaves its variables, branch and config behind for the script that follows: a memo hit replays them (same state in, same state out)
          const fx = ctx.budget.startupFx?.get(key);
          if (fx) restoreLineState(ctx, fx);
          return null;
        }
        ctx.budget.startupOk.add(key); // marked first, so a startup file that starts shells itself is not judged again and again (a denial ends the evaluation)
      }
      const verdict = checkScriptFile(st, dir, ctx, level);
      if (key !== null && !verdict && st.sourced) (ctx.budget.startupFx ??= new Map()).set(key, lineState(ctx));
      return verdict;
    });
    if (v) return v;
  }
  return null;
}

function implicitStartupVerdict(st, ctx, cmd, dir) {
  const vars = Object.assign(Object.create(null), ctx.vars);
  const unsure = new Set(ctx.unsureVars);
  for (const [k, v] of Object.entries({ ...ctx.vars, ...Object.fromEntries(Object.entries(cmd?.env ?? {}).map(([k, w]) => [k, expandVars(w, ctx)])) })) {
    if (DYNAMIC.test(v)) { delete vars[k]; unsure.add(k); } else { vars[k] = v; unsure.delete(k); }
  }
  const rec = { kind: 'shell', file: st.file, startup: true };
  const fresh = {
    ...ctx, ignoreUnmodelled: true, fullText: '', vars, unsureVars: unsure, tainted: new Set(ctx.tainted), aliasUnsure: new Set(ctx.aliasUnsure),
    gitAliases: { ...ctx.gitAliases }, ghAliases: { ...ctx.ghAliases }, branches: new Map(ctx.branches),
  };
  // the shell starts where the command runs (`cd sub && NVM_DIR=d bash -l`); an unknown directory (null) makes a relative name in the file unknowable
  const key = `${st.file}\u0000${stateFingerprint(fresh, dir, 0)}`;
  const memo = (ctx.budget.implicitStartup ??= new Map());
  // The file runs in the same repository as the line: a branch it switches, config it changes and aliases it defines are real, so what the
  // judgement changed in its copy is carried back into the line's state (the memo keeps it with the verdict: same state in, same state out).
  const carry = (r) => {
    for (const [d, e] of r.branches) if (ctx.branches.get(d) !== e) ctx.branches.set(d, e);
    if (r.cfgDirty) ctx.cfgDirty = true;
    Object.assign(ctx.gitAliases, r.git);
    Object.assign(ctx.ghAliases, r.gh);
    for (const n of r.unsure) ctx.aliasUnsure.add(n);
    return r.verdict;
  };
  // a verdict that leaned on "a missing script may have been created by a command we do not model" is reused only while that is as true as it was
  const flag = unmodelledBefore(ctx.writeFrames);
  const known = memo.get(key);
  if (known && (!known.sens || known.flag === flag)) return carry(known);
  const seen0 = ctx.budget.unmodelledSeen ?? 0;
  const pending = { verdict: null, branches: new Map(), cfgDirty: false, git: {}, gh: {}, unsure: [], sens: false, flag };
  memo.set(key, pending); // marked first: a startup file that starts shells itself finds this entry, not itself again
  const text = ctx.readText(path.resolve(ctx.home, st.file.replace(/^~\/?/, '')));
  fresh.fullText = typeof text === 'string' ? text : '';
  const v = checkScriptFile(rec, dir, fresh, 0);
  const done = {
    verdict: v, branches: new Map(fresh.branches), cfgDirty: fresh.cfgDirty, git: { ...fresh.gitAliases }, gh: { ...fresh.ghAliases }, unsure: [...fresh.aliasUnsure],
    sens: (ctx.budget.unmodelledSeen ?? 0) !== seen0, flag,
  };
  memo.set(key, done);
  return carry(done);
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
function judgeScoped(text, dir, ctx, level, sf, child = false) {
  if (text.length > MAX_LINE_CHARS) return judgeLongText(text);
  // Why (#81 Codex R1-B1): the names a text assigns (assignedOf) and the words it mentions (the dynamic-script fallback) are those of EVERY text being judged, the script's own among them
  const scopes = (ctx.scopeTexts ??= []);
  scopes.push(text);
  try {
    return judgeScopedIn(text, dir, ctx, level, sf, child);
  } finally {
    scopes.pop();
  }
}
function judgeScopedIn(text, dir, ctx, level, sf, child) {
  if (sf.sourced && !sf.candidate) return evalString(text, dir, ctx, level + 1);
  const saved = Object.assign(Object.create(null), ctx.vars);
  const savedTaint = new Set(ctx.tainted);
  const savedUnsure = new Set(ctx.unsureVars);
  const spec = sf.candidate ? { branches: new Map(ctx.branches), git: { ...ctx.gitAliases }, gh: { ...ctx.ghAliases } } : null;
  try {
    return evalString(text, dir, ctx, level + 1, child);
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

// Why: `bash ${A:--c ./ev.sh}`: a default word in an option position of a shell or interpreter is read again as each reading of it (see spliceLines); the line each makes is judged like a literal one
function checkSplices(c, dir, ctx, level) {
  const r = spliceLines(spliceText(c));
  if (r.over) return deny('a default or alternative word (${X:-w}) in this command may be an option, and its readings cannot be worked out exactly (a quote, backslash, backtick or $( ) near it, or too many), so what the command runs cannot be verified. Write the options literally.');
  for (const line of r.lines) {
    if (level >= MAX_NESTING) return deny('a default word in an option position is nested too deeply to verify.');
    const v = judgeScoped(line, dir, ctx, level, { kind: 'shell', candidate: true }); // (one of several readings: what it changes is uncertain)
    if (v.decision === 'deny') return deny(`a default word in this command may be an option; read as \`${line}\` it would run a blocked command: ${v.reason}`);
  }
  return null;
}

// A word before the script expands at run time (`X=+n; bash $X f.sh`, `bash $(..) f.sh`, `source $X`, `bash *.sh`), so which
// word the shell runs is unknown. Judge every word that could be it (see script-candidates.mjs) like a named script. A
// word that is still unknown (`$UNSET`) cannot be judged: denied when the line mentions a guarded operation, as for a
// script named at run time.
// the words a `${X:=w}` / `${X=w}` anywhere on the line (this text, or the line it came from) may have assigned: a later $X may be any of them.
// Kept with the text it was worked out from: a nested context copies the fields of its parent but judges other text (a startup file).
// (the line itself, ctx.lineText, was always read here and still is -- Defensive (mutation check): no test tells it from the judged texts, it is kept so no reading the line gave is lost)
// Why (#81 Codex R1-B1): a script the guard opens assigns names of its own (`F=ok.sh; G=${F/ok/run}; bash $G`), which the outer line knows nothing about: the texts judged on the way (the line, then each
// script or text one level down, see judgeScoped) all count. Only ever more readings than the line alone gave, never fewer.
const judgedTexts = (ctx) => [ctx.fullText, ...(ctx.scopeTexts ?? [])].filter((t, i, a) => typeof t === 'string' && a.indexOf(t) === i); // (not lineText: a startup file is judged on its own text, not with the whole line as context)
const textsOf = (ctx) => [ctx.lineText, ...judgedTexts(ctx)].filter((t, i, a) => typeof t === 'string' && a.indexOf(t) === i);
const assignedOf = (ctx) => {
  const texts = textsOf(ctx);
  const memo = (ctx.budget.assignedMemo ??= new Map()); // (a text read again at every level: parsed once. Defensive (mutation check): speed only, the verdict is the same without it)
  const out = new Map();
  for (const t of texts) {
    let r = memo.get(t);
    if (!r) { r = assigningDefaults(t); memo.set(t, r); }
    for (const [n, ws] of r) out.set(n, [...new Set([...(out.get(n) ?? []), ...ws])]);
  }
  return out;
};

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
  const lines = execLinesOf(sf, expand, assignedOf(ctx));
  if (lines.over) return deny('too many readings of the program word (a default or assigned word) to judge, so what it runs cannot be verified. Write the command out.');
  for (const line of lines) {
    if (level >= MAX_NESTING) return deny('the command line held in a variable is nested too deeply to verify.');
    const v = judgeScoped(line, dir, ctx, level, { kind: 'shell', candidate: true }); // (one of several readings: what it changes is uncertain)
    if (v.decision === 'deny') return deny(`the command line ${sf.words[0]} expands to would run a blocked command: ${v.reason}`);
  }
  // a file the line writes before this command is among the names a glob matches (cp f.sh n.sh; bash n*.sh)
  const readDir = (d) => {
    const r = ctx.readDir(d);
    if (!Array.isArray(r)) return r;
    const extra = writtenNamesIn(ctx.writeFrames, d);
    return extra.length ? [...r, ...extra] : r;
  };
  const c = scriptCandidates(sf, { expand, dirs: [here], joinPath: (d, r) => path.resolve(d, r), readDir, ifs: ctx.vars.IFS, assigned: assignedOf(ctx) });
  if (c.over) return deny('too many words, a glob matching too many files, or glob syntax that cannot be resolved could be the script this command runs, so it cannot be verified. Name the script file.');
  if (c.dynamic && judgedTexts(ctx).some((x) => GUARDED_WORDS.test(x))) {
    return deny('which word is the script this command runs is only known at run time ($VAR / $(...) / a glob) and the line mentions a guarded operation, so it cannot be verified. Name the file and write the options literally.');
  }
  for (const file of c.files) {
    const v = checkScriptFile({ kind: sf.kind, family: sf.family, file, candidate: true, sourced: sf.sourced }, dir, ctx, level);
    if (v) return v;
  }
  return null;
}

// ---- entry point ----------------------------------------------------------------------------------------

// (flowStart / inFlow: the first command that may run conditionally or repeatedly, see line-writes.mjs)

// A command followed by | or & ran in a subshell (a pipeline stage / background job): what it assigned or changed is lost.
const ranInSubshell = (cmds, i) => cmds[i]?.sep === '|' || cmds[i + 1]?.sep === '|' || cmds[i + 1]?.sep === '&';
const VALUE_BINDERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'unset', 'let', 'printf', 'select']);
const STATE_GIT = new Set(['checkout', 'switch', 'branch', 'rebase', 'symbolic-ref', 'worktree', 'config']);

// Collects every assignment on the line BEFORE any command is judged. A name assigned more than once, or assigned
// where it may not run (after && / ||, in a pipeline, a subshell, an if / loop / case), is unsure for the whole line.
function collectAssignments(cmds, ctx, topLevelLocal = false, level = 0, text = null) {
  const counts = new Map();
  const implicit = new Set();
  const bump = (k, n) => { if (pinsAt(ctx, level)?.has(k)) return; counts.set(k, (counts.get(k) ?? (k in ctx.vars || ctx.unsureVars.has(k) ? 1 : 0)) + n); };
  const from = flowStart(cmds);
  for (const [i, c] of cmds.entries()) {
    const n = mayNotRun(cmds, from, i) || c.depth > 0 || c.sep === '&&' || c.sep === '||' || ranInSubshell(cmds, i) ? 2 : 1;
    // Why (#56, a live bypass on main): `for f in run.sh; do bash $f; done` ran run.sh while the guard read `bash $f` as a value from the environment. A loop
    // variable takes each word of the list in turn (or the positional parameters): it is set on the line, more than once.
    // A list that is one run-time word (`for p in $(lsof -t …)`) gives the name one value only known at run time, like `P=$(lsof -t …)` (see computedLoopWord;
    // the walk records it): counted once, so the value is judged where it lands (a script, a directory, a ref) instead of refusing every command it reaches.
    // Once even where the loop may not run (an empty list, `false && for …`): an unknown value already stands for any value, the one held before included.
    if (c.argv[0] === 'for' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.argv[1] ?? '')) bump(c.argv[1], computedLoopWord(c) === null ? 2 : 1);
    // builtins that bind a variable without a NAME=value word: its value is whatever was read / parsed at run time
    if (c.argv.length && VALUE_BINDERS.has(baseName(c.argv[0]))) {
      for (const a of c.argv.slice(1)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(a);
        if (m) bump(m[1], 2);
      }
    }
    for (const k of implicitBindsOf(c)) implicit.add(k); // (`read` sets REPLY, `getopts` OPTARG, `[[ =~ ]]` MATCH, `k[0]=`, `$_` …: see implicitBindsOf)
    for (const k of Object.keys(c.env)) if (!sameValue(ctx, k, c.env[k])) bump(k, n);
    if (c.argv.length && VAR_BUILTINS.includes(baseName(c.argv[0]))) {
      // `declare -n X=F` makes X a NAMEREF: $X reads $F at run time, while the text says "F". Unknown, like a binder.
      // Why: -L / -R / -Z / -i change the value the text gives (width cut, arithmetic): unknown too. -l / -u are applied where the value is recorded; declared
      // without a value they apply to what is assigned (or already held) later, which is not followed: unknown. `local` outside a function fails in bash
      // (the name keeps the value it had, e.g. from the environment), so it assigns nothing we can rely on.
      const d = declAttrs(c.argv);
      const odd = d.unknown;
      const localHere = topLevelLocal && baseName(c.argv[0]) === 'local';
      for (const [k, v] of d.assigns) if (odd || localHere || !sameValue(ctx, k, applyTransform(v, d.transform))) bump(k, odd || localHere ? 2 : n);
      for (const k of d.bare) if (odd || d.transform !== null || localHere) bump(k, 2);
    }
  }
  // (only the ones the line assigns or reads: an unsure name nobody uses changes nothing. `$_` / `status` / RANDOM …, which every command sets, only when
  // the line assigns them: `$_` in a ruby / perl program word is that program's)
  // Why (#74): zsh reads `$B:r` / `$B[1,6]` (an unbraced name and a modifier or subscript) as another word than the one expandVars gives (`B=run.sh.x; bash $B:r` runs run.sh).
  // A name the line assigns and reads so is only known at run time wherever it is used, like one assigned twice; what is built from it is unsure too (unsureVarReachingCommand).
  for (const k of zshModifiedNames(cmds.flatMap((c) => [...c.argv, ...Object.values(c.env), ...(c.redirects ?? []).map((r) => r.target ?? '')]))) if (counts.has(k) || k in ctx.vars) { bump(k, 2); (ctx.zshNames ??= new Set()).add(k); }
  if (implicit.size) { const reads = namesReadOn(cmds); for (const k of implicit) if (counts.has(k) || k in ctx.vars || (reads.has(k) && !SHELL_SET_NAMES.includes(k))) bump(k, 2); }
  for (const [k, n] of counts) if (n > 1) { delete ctx.vars[k]; ctx.unsureVars.add(k); }
  // Why (#81 security follow-up, on main too): the parser reads `$((n=7))` as an assignment but not `$(( n = 7 ))`, `((n++))`, `while ((n++ < 7))`, `$[n=7]`, a `[[ x -eq n=7 ]]` operand, a subscript
  // (`${a[n=7]}`, `a[n=7]=x`) or a substring offset (`${x:n=3:1}`), and not an append (`n+=7`, `export n+=7`): `n=2; [[ n=7 -eq 7 ]]; bash s$n.sh` ran s7.sh while the guard read s2.sh. A name
  // such text assigns is unsure, whether or not the line gave it a value (see arithAssignedNames); one that assigns through a name (`(( $m = 7 ))`) may set any name, as an indirect expansion does.
  const ar = typeof text === 'string' ? arithAssignedNames(text, cmds) : null;
  if (ar) for (const k of ar.names) { delete ctx.vars[k]; ctx.unsureVars.add(k); }
  // Why (#56, a live bypass on main): `F=ok.sh; export $N=run.sh; bash $F` ran run.sh when N held F, while the guard judged ok.sh. A binder whose
  // NAME is only known at run time (export / declare / local / typeset / readonly, read, mapfile, getopts, unset, let, select, printf -v) may set
  // any variable: every name the line assigns or reads is unknown from here on.
  // (#56, Codex review of 8b86e2b: zsh `${(P)N::=main}` assigns the variable N names, a bash `${!N…}` reads or sets through it: the same, on main too)
  if (ar?.dynamic || cmds.some(bindsRunTimeName) || cmds.some((c) => indirectExpansion(c, cmds)) || (cmds.heredocSpans ?? []).some?.((s) => !s[2]) && (typeof text !== "string" || indirectExpansionOnLine(text, cmds))) for (const k of [...Object.keys(ctx.vars), ...namesReadOn(cmds)]) { delete ctx.vars[k]; ctx.unsureVars.add(k); }
}
const zshModifiedReason = (n) => `$${n} is followed by \`:\` and a letter or by \`[\` (\`$${n}:r\`, \`$${n}[1,6]\`): zsh reads that as a modifier or a subscript and applies it to the value, so the word it makes is only known at run time. Write the word out, or brace the name (\`\${${n}}:r\`) when the text after it is meant literally.`;
// A zsh parameter expansion with flags (`${(P)N::=x}` assigns the variable N names) or a bash indirect one (`${!N}`), anywhere in a command's words.
// (#56 replay of 96848c2: judged on the command's own text, single-quoted parts blanked — a `node -e '…${(x)}…'` program is no expansion; its words, quotes
// removed, when the text is not there or the line has an unquoted heredoc, whose body expands and is not in the command's text: then the line's whole
// text being judged is looked at (the line, or the script the guard opened: not ctx.fullText, which is the outer line — `bash run.sh` hid a body in
// run.sh), unquoted bodies as written; security review of 5188c68)
const indirectExpansion = (c, cmds) => (typeof c.raw === 'string' && c.raw && !(cmds?.heredocSpans ?? []).some?.((s) => !s[2]) ? indirectExpansionOnLine(c.raw, null) : argvIndirect(c));
const argvIndirect = (c) => [...c.argv, ...Object.values(c.env ?? {}), ...(c.redirects ?? []).map((r) => r.target ?? '')].some((w) => INDIRECT_EXPANSION.test(String(w)));
// A command that binds a variable whose name is only known at run time (see collectAssignments).
function bindsRunTimeName(c) {
  if (!c.argv.length) return false;
  const nm = baseName(c.argv[0]);
  const words = c.argv.slice(1);
  if (VAR_BUILTINS.includes(nm)) return words.some((w) => DYNAMIC.test(w.includes('=') ? w.slice(0, w.indexOf('=')) : w));
  if (ZSH_NAME_BINDERS.has(nm) || (nm === 'print' && words.some((w) => /^-[A-Za-z]*v/.test(w)))) return true; // (zsh binders whose operands are not read: any name, see ZSH_NAME_BINDERS)
  if (!VALUE_BINDERS.has(nm)) return false;
  if (nm === 'printf' && !words.some((w) => /^-[A-Za-z]*v/.test(w))) return false;
  return words.some((w) => DYNAMIC.test(w));
}
// Every `$NAME` / `${NAME…}` the line's words, prefixes and redirections read.
function namesReadOn(cmds) {
  const out = new Set();
  for (const c of cmds) {
    for (const w of [...c.argv, ...Object.values(c.env ?? {}), ...(c.redirects ?? []).map((r) => r.target ?? '')]) {
      for (const m of String(w).matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
    }
  }
  return out;
}

// Why (#56 replay): `for p in $(lsof -t -i :4000); do ps -p $p; done` was refused once loop variables stopped being read as environment values (about 660
// lines in 21 days: ps, kill, gh pr view, git log, cp). The single list word, a command substitution, is one value only known at run time, the
// same as `P=$(lsof -t -i :4000)`, and is judged the same way wherever it lands. Null for any other list: literal words are read one by one (judgeReadings),
// and several words of which some are computed, a variable (`L=run.sh; for f in $L`: its value is known, and splits), `for f; do` (the positional
// parameters) or a list with quotes or globs around the expansion stay refused. Where the value lands it is judged like `F=$(cmd)` today: a script picked
// by it is refused only when the line mentions a guarded operation (scriptFileOf), the same known limit as `bash $(ls *.sh)`.
// #81: "a single command-substitution word" is what the PARSER says the word is (c.subWords: one substitution covers the whole word, however deep its parentheses, quotes and
// nested substitutions go), not a pattern over the text. A list that is a split variable (`F=$(cmd); for f in ${=F}`) stays refused, as test/guard-false-positives-56 documents.
function computedLoopWord(c) {
  const argv = c.argv;
  if (argv[0] !== 'for' || argv[2] !== 'in' || argv.length !== 4) return null;
  return c.subWords?.has(argv[3]) ? argv[3] : null;
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
// (-a / allexport only exports later assignments: whether an earlier one reaches a command is already unknown to the checks that care, GIT_DIR / GH_REPO)
const SAFE_SET_ARG = /^(?:[-+][euxvfCoa]+|pipefail|errexit|nounset|xtrace|verbose|noglob|noclobber|allexport|--)$/;
const isStateHazard = (c) => {
  if (!c.argv.length) return false;
  const nm = baseName(c.argv[0]);
  return STATE_HAZARD_CMDS.has(nm) || (nm === 'set' && c.argv.slice(1).some((a) => !SAFE_SET_ARG.test(a)));
};
// (the names of builtins and shells that run a string as shell code in the current shell, or whose string may define what the line later calls; `declare` and the like keep the old answer too)
// Defensive (mutation check): dropping `eval` here is still caught by the parser's `fns` list and the eval / trap gates in onceAssignedNames.
// Defensive (mutation check): dropping `trap` here is still caught by the eval / trap gates in onceAssignedNames and the parser's `fns` list.
const EVALUATES_HERE = new Set(['eval', 'source', '.', 'trap', 'alias', 'unalias', 'builtin', 'command', 'exec', 'fc', 'let', '((', 'mapfile', 'readarray', 'complete', 'bind', 'coproc', 'declare', 'typeset', 'local', 'readonly', 'integer', 'float',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'functions', 'autoload', 'zmodload', 'emulate', 'setopt', 'shopt', 'enable', 'hash', 'printf']);
// Defensive (mutation check): a dynamic head counted as data is still caught by the eval / trap gates in onceAssignedNames and the parser's `fns` list.
const readsOnlyData = (c) => dataOnly(c) || (c.argv.length > 0 && !DYNAMIC.test(c.argv[0]) && !EVALUATES_HERE.has(baseName(c.argv[0])) && !(baseName(c.argv[0]) === 'export' && c.argv.some((w) => w.includes('['))));
const FUNCTION_DEF = /(?:^|[\s;&|(){])(?:function\s+[^\s(){};&|<>]+|[A-Za-z_][\w.:-]*\s*\(\s*\))/;
// `source` / `.` run a file in THIS shell: it may cd, check out a branch or reassign any variable.
const SOURCING = ['source', '.'];
// Why: only unquoted text defines a function: `create function f(uuid)` in a psql -c, `fn()` in a node -e program or a commit message is data. That holds only when every command on the line is
// one that never evaluates its words in the current shell (external programs and plain builtins below); anything else (eval, a shell, source, trap, mapfile -C, complete -C, bind -x, fc, let / (( )),
// export / declare / printf -v with a subscript, a name known only at run time, an assignment to PROMPT_COMMAND ...) reads quoted text as code, and so does a heredoc (an apostrophe in its body would unbalance the quotes).
const DATA_COMMANDS = new Set(['git', 'gh', 'node', 'nodejs', 'python', 'python3', 'deno', 'bun', 'ruby', 'perl', 'cat', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'jq', 'psql', 'mysql', 'sqlite3', 'npm', 'npx', 'pnpm', 'yarn', 'supabase', 'curl', 'wget', 'ls', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'diff', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'find', 'date', 'sleep', 'cd', 'pwd', 'true', 'false', 'rsync', 'tar', 'ln', 'chmod', 'open', 'tsc', 'vitest',
  // (#56 replay: `npx tsx s.mjs` after `cat > s.mjs <<'EOF'` holding `process.cwd()` made the directory unknown: external programs, like the ones above)
  'tsx', 'ts-node', 'bunx', 'pnpx', 'playwright', 'eslint', 'prettier', 'stat', 'basename', 'dirname', 'realpath', 'readlink', 'cmp', 'du',
  'shasum', 'sha256sum', 'md5', 'file', 'lsof', 'ps', 'zip', 'unzip', 'gzip',
  // (shell keywords and test builtins the parser emits as commands: they run no quoted text; `grep "function base" f; for f in *.mjs; do …` was refused)
  'for', 'do', 'if', 'then', 'elif', 'else', 'while', 'until', 'case', 'select', '!', ':', 'test', '[', 'break', 'continue']);
const dataOnly = (c) => {
  if (!c.argv.length) return !Object.keys(c.env ?? {}).some((k) => /^(?:PROMPT_COMMAND|PS[0-4]|BASH_ENV|ENV|IFS|PATH|CDPATH)$/.test(k));
  const nm = baseName(c.argv[0]);
  if (nm === 'export') return !c.argv.some((w) => w.includes('['));
  return DATA_COMMANDS.has(nm) && !(nm === 'printf' && c.argv.some((w) => /^-[a-zA-Z]*v/.test(w)));
};
// (null when the quoting cannot be trusted: a comment (an apostrophe in it opens no quote), `$'..'` (its \' does not close), an unterminated quote: the caller then keeps the hazard)
function unquotedText(s) {
  let out = '';
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    // (an unquoted `(` that is not at the start of a command is a zsh glob qualifier / ksh pattern list (`ls *(e:'..':)`, `/(e:..:)`, `~(`, `)(`, `'x'(`): it runs quoted text in this shell)
    if (ch === '(' && i > 0 && !/[\s;&|(){$]/.test(s[i - 1])) return null;
    if ((ch === '#' && (i === 0 || /[\s;&|(){]/.test(s[i - 1]))) || (ch === '$' && s[i + 1] === "'")) return null;
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      out += "''"; i = j + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return null;
      const body = s.slice(i, j + 1);
      out += /\$[({]|`/.test(body) ? body : '""'; i = j + 1; continue;
    }
    out += ch; i++;
  }
  return out;
}
// Why (#56): a heredoc body is the input of the command it is attached to, and every command here only reads it as data (`cat > fix.mjs <<'EOF'` with a
// `function rep(a, b)` in the JavaScript): its text is blanked out, at the places the parser read it from, before looking for a definition. Its `$(...)` run in
// subshells (a function defined there is gone when it ends) and are commands of their own in `cmds`, judged by dataOnly like the rest. A body the parser could
// not locate in the line (read out of backticks or another text, no terminator) keeps the old answer: a heredoc is a hazard.
// #81 t8: the parser lists the functions the text really defines (cmds.fns: `f()`, `function f`, zsh `f g ()`, also in an eval string or a script it unwraps), so a `name()` it did not list sits in
// text that is not shell code here: the argument of an external program (`docker exec db psql -c "select now()"`). Only a command that reads its words as code IN THIS SHELL can make such text
// a definition (EVALUATES_HERE: eval, source, trap, alias, a shell ... and a name known only at run time); with one of those on the line the old answer stands.
function definesFunction(str, cmds) {
  if (!FUNCTION_DEF.test(str)) return false;
  // Defensive (mutation check): without the parser's real function definitions the unquotedText scan still refuses a text that defines a function.
  if (cmds.fns instanceof Set ? cmds.fns.size > 0 || !cmds.every(readsOnlyData) : !cmds.every(dataOnly)) return true;
  const text = withoutHeredocBodies(str, cmds);
  if (text === null) return true;
  const u = unquotedText(text);
  return u === null || FUNCTION_DEF.test(u);
}
// The line with every heredoc body blanked out (same length, newlines kept), or null when a body could not be located (see heredocSpans in shell-parse.mjs).
function withoutHeredocBodies(str, cmds) {
  if (!/<</.test(str)) return str;
  const spans = cmds.heredocSpans;
  if (!Array.isArray(spans)) return null;
  let out = '';
  let at = 0;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a < at || b > str.length) return null; // (spans that overlap or run past the text: not ours to trust)
    out += str.slice(at, a) + str.slice(a, b).replace(/[^\n]/g, ' ');
    at = b;
  }
  return out + str.slice(at);
}

// An unsure variable (assigned more than once, or where it may not run) that reaches a command whose effect may depend on
// the value — anything outside UNSURE_OK, a path or dynamic command name, or the command name itself — directly (argv,
// env prefix, a redirect such as `<<< "$F"`) or through a pipe (`echo "$F" | xargs git push`: every stage of a pipeline
// with a sensitive stage counts). Returns the variable's name, or null.
// Why: a redirect that only sends OUTPUT somewhere (`awk ... > "$out"`, superpowers' task-brief) hands the command nothing to read: the shell opens the file, the
// command never sees the name. Where it writes is the write frame's business (a word known only at run time may be any file: see line-writes.mjs). A redirect the
// command reads from (`<`, `<<<`, `<>`, `<&`) still counts, and so does a duplication (`>&WORD`): `0>&"$fd"` hands a READABLE descriptor (`4< payload.sh`)
// to stdin (Codex review 3 of #50).
const OUTPUT_ONLY_OPS = new Set(['>', '>>', '>|', '&>', '&>>']);
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
  // Why: a cd / pushd / popd handed an unsure value goes to a directory the walk below cannot name, exactly like `cd "$(cmd)"`: an unsure name is never in ctx.vars, so
  // nextDir reads `$D` as written and the directory is unknown (null) from there on; whatever needs it (a bare push, a relative script) is refused there.
  // (superpowers' sdd-workspace ends with `cd -- "$dir" && pwd`, `dir` set in an if)
  const sensitive = (c) => {
    const head = c.argv[0];
    if (DIR_CHANGERS.includes(head)) return false;
    return !UNSURE_OK.has(baseName(head)) || head.includes('/') || DYNAMIC.test(head) || unsureVarUsed([head], ctx) !== null;
  };
  const words = (c) => [...c.argv, ...Object.values(c.env), ...(c.redirects ?? []).filter((r) => !OUTPUT_ONLY_OPS.has(r.op)).map((r) => r.target ?? '')];
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

// The subshell marks (grp, see shell-parse.mjs) can tell where a subshell ends: the parse finished and trusts its marks, every command carries them, and the commands
// of each subshell come one after the other (a heredoc body the parser finishes later, after commands outside its subshell, would make one end too early).
function subshellsTrusted(cmds) {
  if (cmds.truncated || cmds.ctlBroken || !cmds.every((c) => Array.isArray(c.grp))) return false;
  const ended = new Set();
  let prev = [];
  for (const c of cmds) {
    for (const id of prev) if (!c.grp.includes(id)) ended.add(id);
    if (c.grp.some((id) => ended.has(id))) return false;
    prev = c.grp;
  }
  return true;
}

// ---- #56: a variable assigned once, where the assignment may not run ------------------------------------------------------------
// Why: `cd /wt && F=src/a.ts; sed -n 1,9p $F`, `if …; then S=/x; fi; node a.mjs $S`, `for f in a b; do F=/tmp/$f; node a.mjs $F; done` were refused (about
// 1,600 lines in 21 days of transcripts) because F "may not be assigned". With ONE assignment of F on the line, every use after it sees one of two values: the
// assigned text (the assignment ran) or the value the line started with (it did not). Both cases are judged, each as a whole line ("readings"): F pinned to its
// text, and F never assigned (an unknown value, as for any variable the line does not set). The line is allowed only when every reading is; a guarded use
// (`git push origin $B`, `bash $F`, `xargs` fed $F) is then judged on the real text in the first reading and as an unknown value in the second, exactly as
// the rest of the guard judges those. Uniform readings cover the real run only when the uses cannot see different values within one run, so a name qualifies
// only when: it has exactly one assignment, a bare `F=value` (not a prefix, not in $( ), a pipeline stage or a background job); nothing else on the line can bind
// it (no read / declare / export / printf -v / for / arithmetic / ${F:=…} / eval / source / function definitions / aliases or traps, no command named at run
// time); its value does not read itself; and every use comes after the assignment, in the subshells it is in, and outside unquoted heredoc bodies (those expand
// when their command runs, which may come before). Anything else keeps the denial. At most 4 names (16 readings) per line.
const MAX_READINGS = 64;
const varWordRe = (k) => new RegExp(`(?<![A-Za-z0-9_])${k}(?![A-Za-z0-9_])`, 'g');
const bindWordRe = (k) => new RegExp(`(?<![A-Za-z0-9_]|\\$|\\$\\{)${k}(?![A-Za-z0-9_])`); // (the name, not a `$k` / `${k` read of it)
// #81: literal loop text beyond LOOP_WORD_IN: what the parser unquoted. No `$` or backtick (an expansion), brace or backslash, and no leading `=` (zsh expands `=cmd`).
// (A value is substituted as written and never read again, so quotes, `;&|<>` and the like in it do no harm; `eval "$c"` re-reads it exactly as the shell would.) An UNQUOTED word with a character zsh may read as a pattern (`^ # ~ ( ) |`, parser: not in litWords) is not text: refused, as is `~user`. A leading `~/` is the home
// directory like anywhere else on the line, only when the header holds no quote or backslash (a quoted `"~/x"` is the literal text, and the parser's word does not say which it was).
// Not here: `*?[` globs (LOOP_WORD_IN, judged as candidates where the word lands).
// (The `$` test is defence in depth: a word with `$` is routed to the expand reading (`expand` in onceAssignedNames), which loopWordAt refuses unless it works out to plain text.)
const LOOP_TEXT = /^(?!=)[^$\x60{}\\]*$/;
function loopTextWord(w, site) {
  if (!LOOP_TEXT.test(w)) return false;
  if (w === '~' || w.startsWith('~/')) return !/['"\\]/.test(String(site.raw ?? "'"));
  // (An unquoted `~user`, `^x` or `*.sh~x` is never in litWords. The pattern test is defence in depth for a script position: scriptFileOf reads such a word as a glob that cannot be resolved and refuses it.)
  return site.litWords?.has(w) === true || !/[\^#~()|]/.test(w);
}
// A loop word the readings follow: literal text (globs included) and `$NAME` / `${NAME}`; what it is worked out to must be literal text (LOOP_WORD).
// (not a name followed by `[` or `:`: zsh reads `$B[1,6]` as a subscript and `$B:r` as a modifier, where this guard would read text; nor a word that starts
// with `=`: zsh expands `=cmd` to the path of a command. The name takes every letter that follows: `$BB:r` must not read as `$B` + `B:r`)
const LOOP_WORD = /^[A-Za-z0-9_@%+=:,./*?[\]-]+$/;
const LOOP_WORD_IN = /^(?!=)(?:[A-Za-z0-9_@%+=:,./*?[\]-]|\$[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_[:])|\$\{[A-Za-z_][A-Za-z0-9_]*\}(?![\[:]))+$/;
// names a shell, git, gh, an interpreter or this guard read for themselves (where they act is not only where the line expands them): never read
const SPECIAL_NAMES = /^(?:PATH|IFS|HOME|CDPATH|ENV|BASH_ENV|ZDOTDIR|PWD|OLDPWD|SHELL|SHELLOPTS|BASHOPTS|POSIXLY_CORRECT|PS\d|PROMPT_COMMAND|FPATH|MAILPATH|EDITOR|VISUAL|PAGER|TMOUT|HISTFILE|GIT\w*|GH_\w*|BASH\w*|ZSH\w*|LD_\w*|DYLD_\w*|NODE_\w*|NPM_\w*|PYTHON\w*|PERL\w*|RUBY\w*|PIPELINE_\w*|CLAUDE\w*|path|cdpath|fpath|manpath|mailpath|psvar|prompt\w*|precmd\w*|preexec\w*|chpwd\w*|periodic\w*|zshaddhistory\w*|zshexit\w*)$/;
// #81: the scan in onceAssignedNames counts a bare mention of a name as a possible assignment. These three tell a mention that is provably not one.
// awk's `-v NAME=value`: the mention follows `-v ` and the same command segment (up to a ; & | or newline) holds the word awk, so NAME= is awk's.
// Anything else keeps being counted (`sort -v f=1`, `awk … && f=x`, `f=x` after the awk command all stay).
// (The `-v` and awk-word tests are defence in depth: another layer already holds a real `-v NAME=` binder, `declare -v f=x` is a binder site the parser sees
// (sites.length !== 1), and every other `-v NAME=` is an argument word. They keep the skip to the one command whose `-v` is known to be awk's.)
function isAwkVar(text, i) {
  if (!/(?:^|\s)-v\s+$/.test(text.slice(Math.max(0, i - 40), i))) return false;
  const before = text.slice(0, i);
  const seg = before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('&'), before.lastIndexOf('|'), before.lastIndexOf('\n')) + 1);
  return /(?:^|\s)(?:awk|gawk|mawk|nawk)\s/.test(seg);
}
// A name read inside `$(( … ))`. The body must look like arithmetic (operators, numbers, names, parentheses: no `;`, quote, backtick, command
// substitution, and no two words side by side, which is how `read n` or `echo n` would look inside a `$((cmd); …)` that is really a subshell), and the
// name must not be assigned, incremented or indexed there (`n=`, `n+=`, `n<<=`, `n**=`, `n++`, `++n`, `n[0]=`).
const ARITH_ASSIGN_AFTER = /^\s*(?:(?:\*\*|&&|\|\||\^\^|<<|>>|[-+*/%&|^])?=(?!=)|\+\+|--|\[)/;
function enclosingArith(text, i) {
  const open = text.lastIndexOf('$((', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open + 3; j < text.length; j++) {
    const c = text[j];
    if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; else return text[j + 1] === ')' && j >= i ? text.slice(open + 3, j) : null; }
  }
  return null;
}
// (The body and enclosure tests are defence in depth: ARITH_ASSIGN_AFTER and the test for `++` / `--` before the name catch every assignment form, and a binder
// that takes the name as a word (`read n`) is a site the parser sees. They keep the skip to text that really is arithmetic.)
function isArithRead(text, i, len) {
  const body = enclosingArith(text, i);
  if (body === null) return false;
  if (!/^[\w\s+\-*/%&|^<>=!?:,()~.${}[\]]*$/.test(body) || /\w\s+\w/.test(body) || /\$\((?!\()/.test(body)) return false;
  if (ARITH_ASSIGN_AFTER.test(text.slice(i + len)) || /(?:\+\+|--)\s*$/.test(text.slice(0, i))) return false;
  return true;
}
// A bare word of the loop's own list that spells the loop's name (`for f in b c d e f`): the words are what the readings follow, so it is no assignment.
// The header found in the text must be the site's own (the same words), so quoted text that looks like a header never hides a later `read f`.
function isLoopListWord(text, i, k, site) {
  if (site.argv[0] !== 'for' || !/\s$/.test(text.slice(i - 1, i)) || !/^(?:\s|;|$)/.test(text.slice(i + k.length, i + k.length + 1))) return false;
  const head = new RegExp(`(?:^|[\\s;&|(){])for\\s+${k}\\s+in\\s+([^;\\n]*)`).exec(text);
  if (!head) return false;
  const start = head.index + head[0].length - head[1].length;
  if (i < start || i >= start + head[1].length) return false;
  // (defence in depth: quoted text is blanked by withoutLiteralText, and every `for NAME` in the text counts as an assignment, so a second header makes the count 2)
  const words = head[1].trim().split(/\s+/);
  const mine = site.argv.slice(3);
  return words.length === mine.length && words.every((w, x) => w === mine[x]);
}
// Why (#81 t8): `PSQL=/usr/bin/psql; for f in a b; do $PSQL -At -c "select 1" $f; done` and `S=/x; for n in 1 2; do $S/run.sh $S/m$n.sql; done` switched the readings off for the whole line,
// because the command word is only known at run time. The word is read only when it is plain text and `$NAME` / `${NAME}` (no quote or backslash around the command, no modifier or subscript),
// and each name is given by the line itself as literal text: assigned once, before, in the same subshells (a bare `NAME=value`), or by a reading (each of its values literal, none "not set").
// The resolved first word is then checked like a word written out: not a builtin that binds a name, sources, evals or changes the shell (BIND_HEADS).
const HEAD_IN = /^(?!=)(?:[A-Za-z0-9_@%+=:,./-]|\$[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_[:])|\$\{[A-Za-z_][A-Za-z0-9_]*\}(?![\[:]))+$/;
const HEAD_VALUE = /^[A-Za-z0-9_@%+=:,./ -]*$/;
const BIND_HEADS = new Set([...SOURCING, 'eval', ...VAR_BUILTINS, ...VALUE_BINDERS, ...STATE_HAZARD_CMDS, 'set', 'builtin', 'command', 'exec', 'coproc', 'fc', 'let', '((', 'for', 'select', 'vared', 'zparseopts', 'print', 'compdef', 'noglob', 'time', 'nohup', 'env', 'xargs']);
function headResolves(c, cmds, ctx, out, text) {
  const head = c.argv[0];
  if (!HEAD_IN.test(head)) return false;
  // (the command word as written, after the keywords and prefix assignments that may come first in the segment: it is the head itself or the head in double quotes, so no single quote or backslash is in it)
  const toks = String(c.raw ?? '').trim().split(/\s+/);
  const wordAt = toks.findIndex((t) => t === head || t === `"${head}"`);
  if (wordAt < 0 || !toks.slice(0, wordAt).every((t) => /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|do|then|else|elif|if|while|until|\{|\(|!|&&|\|\||time)$/.test(t))) return false;
  if (head.includes('/')) return true; // (a program by path is never a builtin)
  const at = cmds.indexOf(c);
  const valuesOf = (k) => {
    const o = out.find((x) => x.k === k);
    const site = cmds.findIndex((x) => !x.argv.length && Object.hasOwn(x.env ?? {}, k));
    if (o) {
      const vals = o.modes.map((m) => (m === 'set' ? (site >= 0 ? cmds[site].env[k] : null) : typeof m === 'object' && !m.expand ? m.val : null));
      return vals.every((v) => typeof v === 'string' && HEAD_VALUE.test(v)) ? vals : null;
    }
    if (ctx.unsureVars.has(k) || ctx.tainted.has(k) || SPECIAL_NAMES.test(k)) return null;
    if (site < 0) return Object.hasOwn(ctx.vars, k) && HEAD_VALUE.test(ctx.vars[k]) ? [ctx.vars[k]] : null; // (given by an earlier line)
    const mine = [...text.matchAll(varWordRe(k))].filter((m) => !/\$\{?$/.test(text.slice(Math.max(0, m.index - 2), m.index)));
    const x = cmds[site];
    if (mine.length !== 1 || text[mine[0].index + k.length] !== '=' || site > at || x.depth > 0 || ranInSubshell(cmds, site) || !Array.isArray(x.grp) || !Array.isArray(c.grp) || x.grp.some((id, j) => c.grp[j] !== id)) return null;
    return HEAD_VALUE.test(x.env[k]) ? [x.env[k]] : null;
  };
  let words = [head];
  for (const k of new Set([...head.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))) {
    const vals = valuesOf(k);
    if (!vals) return false;
    words = words.flatMap((w) => [...new Set(vals)].map((v) => w.replace(new RegExp(`\\$(?:\\{${k}\\}|${k}(?![A-Za-z0-9_]))`, 'g'), () => v)));
    if (words.length > 16) return false;
  }
  return words.every((w) => {
    const nm = baseName(w.trim().split(/\s+/)[0] ?? '');
    return nm !== '' && !BIND_HEADS.has(nm) && !bindsRunTimeName({ ...c, argv: [nm, ...c.argv.slice(1)] });
  });
}
function onceAssignedNames(cmds, ctx, str) {
  if (ctx.tainted.size || cmds.truncated || cmds.dynamicOther || definesFunction(str, cmds) || cmds.some(isStateHazard) || !subshellsTrusted(cmds) || indirectExpansionOnLine(str, cmds)) return [];
  const heads = []; // (#81 t8: the commands named by a variable; each is resolved below, once the readings are known, and judged as the command it names)
  for (const c of cmds) {
    if (!c.argv.length) continue;
    const nm = baseName(c.argv[0]);
    if (DYNAMIC.test(c.argv[0])) { heads.push(c); continue; }
    if (SOURCING.includes(nm) || nm === 'eval' || bindsRunTimeName(c)) return [];
    // Why (#56 replay): only a binder whose NAME is only known at run time may set any name (`export $X=1`, `read $V`); a value that expands
    // (`export PATH=/x:$PATH`, the first command of many lines) names its target. printf binds only with -v.
    if (VAR_BUILTINS.includes(nm)) {
      if (declAttrs(c.argv).unknown || c.argv.slice(1).some((w) => DYNAMIC.test(w.includes('=') ? w.slice(0, w.indexOf('=')) : w))) return [];
    } else if (VALUE_BINDERS.has(nm) && (nm !== 'printf' || c.argv.some((w) => /^-[A-Za-z]*v/.test(w)))) {
      if (c.argv.slice(1).some((w) => DYNAMIC.test(w))) return [];
    }
  }
  const ar = arithAssignedNames(str, cmds); // (an arithmetic can assign a name the text scan below does not show. Defence in depth for the skip of ar.names and ar.dynamic below: the mention scan already refuses a name whose assignment it sees, and collectAssignments made the names unsure)
  if (ar.dynamic) return [];
  const spans = /<</.test(str) ? cmds.heredocSpans : [];
  if (!Array.isArray(spans)) return [];
  const blank = withoutHeredocBodies(str, cmds);
  const text = blank === null ? null : withoutLiteralText(blank, { dqData: true });
  if (text === null) return [];
  const live = spans.filter(([, , quoted]) => !quoted).map(([a, b]) => str.slice(a, b)); // (unquoted bodies: they expand when their command runs)
  const mentions = (c, k) => {
    const re = new RegExp(`\\$\\{?${k}(?![A-Za-z0-9_])`);
    return [...c.argv, ...Object.values(c.env ?? {}), ...(c.redirects ?? []).map((r) => r.target ?? '')].some((w) => re.test(String(w)));
  };
  const out = [];
  const modified = zshModifiedNames(cmds.flatMap((c) => [...c.argv, ...Object.values(c.env ?? {}), ...(c.redirects ?? []).map((r) => r.target ?? '')])); // (#74: `$k:r` / `$k[1]` is not the value a reading gives k)
  for (const k of ctx.unsureVars) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || SPECIAL_NAMES.test(k) || modified.has(k) || ar.names.has(k)) continue;
    const sites = [];
    for (const [i, c] of cmds.entries()) {
      const nm = c.argv.length ? baseName(c.argv[0]) : '';
      // (a binder's word binds k when it names k itself: `$k` / `${k…}` there is a value it reads, `printf '%s' $p` without -v binds nothing; #56 replay)
      const binder = VAR_BUILTINS.includes(nm) || (VALUE_BINDERS.has(nm) && (nm !== 'printf' || c.argv.some((w) => /^-[A-Za-z]*v/.test(w)))) || nm === 'for' || nm === 'select';
      if (Object.hasOwn(c.env ?? {}, k) || (binder && c.argv.slice(1).some((a) => bindWordRe(k).test(a))) || implicitBindsOf(c).includes(k)) sites.push(i);
    }
    // #81 t6: a name that only `for` loops one after another bind (`for n in 1 2; do …; done; for n in 3 4; do …; done`) takes every word of every list (below)
    const isForSite = (c) => c.argv[0] === 'for' && c.argv[1] === k && c.argv[2] === 'in' && c.argv.length > 3;
    // (defence in depth for the all-`for` test: loopsInSequence below counts the `for k in` headers, and a binder site is not one, so it refuses the line too)
    if (sites.length === 0 || (sites.length > 1 && !sites.every((i) => isForSite(cmds[i])))) continue;
    const s = sites[0];
    const site = cmds[s];
    // (every site, not only the first: defence in depth for the later ones, whose bad word the union of the words finds at every use anyway)
    if (sites.some((i) => cmds[i].depth > 0 || ranInSubshell(cmds, i))) continue;
    // (every loop in the same subshell as the first: a loop in `( … )` or a pipe stage mixed with one outside it is not read. Defence in depth for the pipe / background loop,
    // which markClosedOut marks as conditional, so the readings below also hold the unset name; the subshell loop is the case this stops: its value is lost outside it)
    if (sites.some((i) => !Array.isArray(cmds[i].grp) || cmds[i].grp.length !== site.grp?.length || cmds[i].grp.some((id, j) => id !== site.grp[j]))) continue;
    // the values it can take: a bare assignment's text (or none: it did not run), or each word of a `for k in …` list
    let modes;
    if (!site.argv.length) {
      if (new RegExp(`\\$\\{?${k}(?![A-Za-z0-9_])`).test(String(site.env[k]))) continue; // (its value reads itself)
      modes = ['set', 'skip'];
    } else if (isForSite(site)) {
      // (each word as written: a glob stands for the files it matches, judged as candidates where the word lands; a word that splits or brace-expands is not read)
      // Why (#56 replay): `B=app/x && for f in $B/a.ts $B/b.ts` and `for f in "app/[id]/page.tsx"` were refused. A word may also hold `[…]` (a glob class, judged like
      // `*`) and `$NAME` / `${NAME}`: such a word is worked out when the walk reaches the `for` (loopWordAt), with what is known there. Not when the header holds a
      // single quote or a backslash (`'$B'` is the text $B, which the argv no longer shows), nor where IFS may be set (ifsMayBeSet: it changes how the value splits).
      // #81: a word may also be any other literal text the parser has unquoted (a space, parentheses, a `#` or `^`, empty: loopTextWord), and a word that is one command substitution
      // (site.subWords): its value is only known at run time and is judged where it lands, as `for p in $(…)` alone is (computedLoopWord); the literal words beside it are read one by one.
      // #81 t6: with several loops the readings are every word of every list (deduplicated), and the unset name when any loop may not run. A use anywhere (in a loop's body,
      // between the loops, after them) sees a word of one of the lists or the value the name had before, so each is covered; a bad word in ANY list is found at every use
      // (the same as before for one loop: a union of one). Nothing here depends on which loop a use is in, so a nested loop would be read soundly too; it stays refused (below).
      const seen = new Map();
      let mayNot = false;
      let bad = false;
      for (const si of sites) {
        const lp = cmds[si];
        const words = lp.argv.slice(3);
        const computed = (w) => lp.subWords?.has(w) === true;
        const textual = (w) => !computed(w) && !LOOP_WORD_IN.test(w) && loopTextWord(w, lp);
        if (!words.every((w) => computed(w) || LOOP_WORD_IN.test(w) || textual(w))) { bad = true; break; }
        const expand = words.some((w) => w.includes('$') && !computed(w));
        if (expand && (/['\\]/.test(String(lp.raw ?? "'")) || ifsMayBeSet(ctx) || words.some((w) => [...w.matchAll(/\$\{?(\w+)/g)].some((x) => x[1] === k)))) { bad = true; break; }
        for (const w of words) {
          const m = w.includes('$') && !computed(w) ? { val: w, expand: true } : { val: w };
          seen.set((m.expand ? 'x' : 'v') + w, m);
        }
        // (#56, Codex review of 8b86e2b: `false && for b in agent/x; do :; done; git push origin $b` pushes the value b had before. Where the loop may not run, or a
        // word is a glob that may match nothing, the name may also keep that value: one more reading, the name not set by the line)
        // (the `for` itself carries its own loop mark, so mayNotRun cannot tell; after any earlier loop mark it may sit in an outer loop that runs no time.
        // For a later loop of the same name that look-back would always find the earlier loop: a loop opened between them is judged by the first loop's look-back and the readings above)
        const ctl = lp.ctl;
        if (!ctl || cmds.ctlBroken || cmds.truncated || ctl.cond || ctl.fn || ctl.trap || lp.sep === '&&' || lp.sep === '||' || (si === s && cmds.slice(0, s).some((c) => !c.ctl || c.ctl.loop)) || words.some((w) => /[*?[]/.test(w))) mayNot = true;
      }
      if (bad) continue;
      // loops one after another, none inside another (a nested loop that reuses the name keeps the denial): between two headers every loop opened is closed
      // (defence in depth: the readings above are sound for a nested loop too; this keeps the refusal that was asked for. A miscount can only refuse more, or read a nested loop soundly.)
      if (sites.length > 1 && !loopsInSequence(text, k, sites.length)) continue;
      modes = [...seen.values()];
      if (mayNot) modes.push('skip');
    } else continue;
    if (live.some((b) => varWordRe(k).test(b))) continue;
    // every mention in the text the shell reads: one assignment, the rest plain references (no ${k:=…} / ${k=…}, no k[…], no other bare word k)
    let assigns = 0;
    let odd = false;
    for (const m of text.matchAll(varWordRe(k))) {
      const before = text.slice(Math.max(0, m.index - 2), m.index);
      const after = text.slice(m.index + k.length, m.index + k.length + 2);
      if (before.endsWith('${')) { if (/^(?::?=|::)/.test(after) || after[0] === '[') odd = true; continue; } // (zsh `${k::=x}` assigns too)
      if (before.endsWith('$')) { if (after[0] === '[') odd = true; continue; }
      // (a name right after - . / is part of an option or a path, `ps -p $p`, `cd /tmp/p`: no assignment can start there)
      // (nor right after a backslash: `\s` / `\n` in a regex, or `\n=x` outside quotes, is text or one word that starts with the backslash. #81)
      if (/--\s*$/.test(text.slice(Math.max(0, m.index - 40), m.index)) && enclosingArith(text, m.index) !== null) { odd = true; continue; } // ($((--n)) decrements; the `-` below is a path or an option otherwise)
      if (/[-./\\]$/.test(before)) continue;
      if (after[0] === '=' && isAwkVar(text, m.index)) continue; // (awk's `-v NAME=value` sets awk's variable, not the shell's. #81)
      if (isArithRead(text, m.index, k.length)) continue; // (a read inside $(( )); an assignment operator there is not skipped. #81)
      if (isLoopListWord(text, m.index, k, site)) continue; // (`for f in b c f`: a word of the list. #81)
      if (after[0] === '=') { assigns++; continue; }
      if (/(?:^|[\s;&|(){])for\s+$/.test(text.slice(Math.max(0, m.index - 8), m.index)) && site.argv[0] === 'for') { assigns++; continue; } // (the loop's own name)
      odd = true;
    }
    if (odd || assigns !== sites.length) continue;
    let ok = true;
    for (const [i, c] of cmds.entries()) {
      if (sites.includes(i) || !mentions(c, k)) continue;
      if (i < s || !Array.isArray(c.grp) || site.grp.some((id, j) => c.grp[j] !== id)) { ok = false; break; }
    }
    if (ok) out.push({ k, modes });
  }
  // #81 t8: a command named by a variable can bind a name or run code in this shell (`X=read; $X f`, `X=eval`) when it is one of those; it is read only when every name in its word
  // has literal text (one value, or each value of a reading) and no value names such a builtin (a head with a `/` is a program by path, whatever the names hold)
  if (heads.length && !heads.every((c) => headResolves(c, cmds, ctx, out, text))) return [];
  // #81 t5: asked for only when the product is over the cap (judgeReadings): which names can be read one group at a time
  out.split = () => independentReadings(cmds, str, out);
  return out;
}
// #81 t5: the readings of names that cannot meet are counted by SUM (each name's own values with the others at their first), not multiplied. Names meet when one command reads
// both (also a `for` header, an assignment and the names its value is built from); a command is then judged on its own words and nothing else only when the line holds no
// command that could run a script or change the state the others are judged in (a script may read any name the line has set; a write may be the script a later command runs;
// cd and git / gh state). So every command of the line must be a bare assignment or a plain tool named without a path that the guard does not open as a script: a builtin
// that only reads or tests (UNSURE_OK) or a tool that only runs a program elsewhere (OPAQUE_TOOLS: docker, npm, ps …). Anything else gives null: the product, as before.
// Null also when a name is not plainly a group member of its own; the groups come as arrays of indexes into `names`.
// (t11: not npm / npx: since t9 they open and run package scripts, which read any name the line exported -- see the pmCall test below)
const OPAQUE_TOOLS = new Set(['docker', 'supabase', 'psql', 'ps', 'lsof', 'pgrep', 'pidof', 'kill', 'rm', 'mkdir', 'touch', 'cp', 'mv', 'du', 'df', 'file', 'shasum', 'diff', 'cmp', 'uname', 'whoami', 'hostname', 'id', 'wait']);
function independentReadings(cmds, str, names) {
  for (const c of cmds) {
    if (!c.argv.length) continue;
    const head = c.argv[0];
    if (typeof head !== 'string' || DYNAMIC.test(head) || head.includes('/') || !(UNSURE_OK.has(head) || OPAQUE_TOOLS.has(head))) return null;
    if (VAR_BUILTINS.includes(head) || VALUE_BINDERS.has(head)) continue; // (a binder is a site of the name it binds: it joins the group below)
    if (pmCall(c.argv) || c.viaRunner) return null; // (a package manager runs scripts that read the line's names)
    if (splicesOptions(c.argv) || scriptFileOf(c.argv, c.raw, str) !== null) return null; // (defence in depth: none of these names opens a script; the readings of a script are never split)
  }
  const parent = names.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const reads = names.map(({ k }) => new RegExp(`\\$\\{?${k}(?![A-Za-z0-9_])`));
  const bare = names.map(({ k }) => varWordRe(k));
  for (const c of cmds) {
    const text = [c.raw ?? '', ...c.argv, ...Object.values(c.env ?? {}), ...(c.redirects ?? []).map((r) => r.target ?? '')].join('\n');
    // (a name read as `$k` / `${k…}`; as a bare word only where the shell reads a bare word as a name -- arithmetic, `[[ ]]`, `let`, a subscript -- or binds it: a `for` / binder word, a prefix assignment.
    // Elsewhere a bare `p` is a flag (`ps -p`), not the name.)
    const nm = c.argv.length ? c.argv[0] : '';
    const bareOk = /\(\(|\[|\blet\b/.test(text);
    const binds = nm === 'for' || nm === 'select' || VAR_BUILTINS.includes(nm) || VALUE_BINDERS.has(nm);
    let first = -1;
    for (let i = 0; i < names.length; i++) {
      const { k } = names[i];
      if (!reads[i].test(text) && !(bareOk && bare[i].test(text)) && !(binds && c.argv.slice(1).some((a) => bare[i].test(a))) && !Object.hasOwn(c.env ?? {}, k) && !implicitBindsOf(c).includes(k)) continue;
      if (first < 0) first = i; else parent[find(i)] = find(first);
    }
  }
  const groups = new Map();
  for (let i = 0; i < names.length; i++) { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); }
  return [...groups.values()];
}
// #81 t6: the `for NAME in` headers in the (quote-blanked) text are `count` in number and each one's loop is closed before the next opens
function loopsInSequence(text, k, count) {
  const heads = [...text.matchAll(new RegExp(`(?:^|[\\s;&|(){])for\\s+${k}\\s+in(?=\\s)`, 'g'))].map((m) => m.index + m[0].indexOf('for'));
  if (heads.length !== count) return false;
  const opens = /(?:^|[\s;&|(){])(?:for|while|until|select|repeat|foreach)(?=\s|$)/g;
  const closes = /(?:^|[\s;&|(){])done(?=[\s;&|(){}]|$)/g;
  for (let j = 0; j + 1 < heads.length; j++) {
    const seg = text.slice(heads[j] - 1 < 0 ? 0 : heads[j] - 1, heads[j + 1]);
    if ((seg.match(opens) ?? []).length !== (seg.match(closes) ?? []).length) return false;
  }
  return true;
}
// A reading's loop word that holds `$NAME` gets its value where the `for` runs (every use of the loop name comes after it): the names it reads must be known
// there and give literal text, else the reading is refused. Null when the value is set.
function loopWordAt(k, ctx) {
  const v = expandVars(ctx.pins.get(k).val, ctx);
  if (v.includes('$') || !LOOP_WORD.test(v)) return deny(`$${k} takes a loop word built from a variable whose value is not known here (or is not plain text), so its value at run time cannot be verified. Rewrite: write the loop words out.`);
  ctx.vars[k] = v;
  return null;
}
// Judges the line once per reading of the names (each assignment ran, or did not); the first denial wins. Null when there is nothing to read.
// #81: also for a script the guard opened (evalString's `child`: a shell of its own), whose text is read like a line of its own: a loop in the script, a name it assigns once.
// (The line's own names reach it as they are: a name the script assigns once is then judged both ways too, so a collision with the line's loop name (`for n in 1 2; do bash brief.sh $n; done`
// with `n=$2` in brief.sh) is read by the same readings. A name the line exports reaches the script, one it does not export may not; the script is judged as if all did, the stricter way.)
// What the script leaves behind for the text that ran it is the union of its readings: a branch, an alias or a config the readings leave differently is unknown, as for a candidate script
// (defence in depth: a name that reaches a git command is refused as unsure in the reading where its assignment did not run, so the readings do not leave different states in practice).
function judgeReadings(str, startDir, ctx, level, names, saved) {
  if (pinsAt(ctx, level) || names.length === 0) return null;
  // each reading is one mode per name. Names that cannot meet (independentReadings) are read a group at a time, the others at their first mode: the sum of the groups' sizes
  // (each at most the cap, the sum too) instead of their product; else every combination of all of them, at most the cap
  let plan = null;
  const product = (idx) => idx.reduce((n, i) => n * names[i].modes.length, 1);
  const all = names.map((_, i) => i);
  if (product(all) > MAX_READINGS) {
    const groups = names.split?.();
    // (the per-group test is defence in depth: a group over the cap makes the sum over the cap too)
    if (!groups || groups.length < 2 || groups.some((g) => product(g) > MAX_READINGS) || groups.reduce((n, g) => n + product(g), 1 - groups.length) > MAX_READINGS) return null;
    plan = [];
    groups.forEach((g, gi) => {
      for (let r = gi === 0 ? 0 : 1; r < product(g); r++) {
        const pick = names.map(() => 0);
        let rest = r;
        for (const i of g) { pick[i] = rest % names[i].modes.length; rest = Math.floor(rest / names[i].modes.length); }
        plan.push(pick);
      }
    });
  }
  const total = plan ? plan.length : product(all);
  const outer = [ctx.pins, ctx.pinsLevel];
  let dirty = false;
  let envDirty = false;
  const moved = new Set(); // (directories whose branch some reading left different from the start; alias keys likewise: see below)
  const redefined = new Set();
  try {
    for (let r = 0; r < total; r++) {
      checkDeadline(ctx.budget);
      countReading(ctx.budget); // (the readings of the whole evaluation, nested scripts included, share one allowance)
      restoreLineState(ctx, saved);
      ctx.pinsLevel = level;
      ctx.pins = new Map();
      let rest = r;
      for (const [x, { k, modes }] of names.entries()) {
        const m = plan ? modes[plan[r][x]] : modes[rest % modes.length];
        rest = Math.floor(rest / modes.length);
        ctx.pins.set(k, m);
        if (typeof m === 'object') ctx.vars[k] = m.val; // (a loop variable: every use comes after the `for`, so it holds the word from the start)
      }
      const v = evalString(str, startDir, ctx, level);
      if (v.decision === 'deny') return v;
      dirty ||= ctx.cfgDirty;
      envDirty ||= ctx.envCfgDirty;
      // (t4 state-union, security review: the end state of EVERY reading is compared with the start, not only the last one's: a branch or alias an earlier reading changed
      // and the last did not would stay known. The readings are alternatives, so whatever any of them changed is unknown afterwards.)
      for (const d of new Set([...saved.branches.keys(), ...ctx.branches.keys()])) {
        const a = saved.branches.get(d);
        const b = ctx.branches.get(d);
        if (a?.name !== b?.name || a?.trackMain !== b?.trackMain) moved.add(d);
      }
      for (const [kind, now] of [['git', ctx.gitAliases], ['gh', ctx.ghAliases]]) {
        const was = saved[kind === 'git' ? 'gitAliases' : 'ghAliases'];
        for (const n of new Set([...Object.keys(was), ...Object.keys(now)])) if (was[n] !== now[n]) redefined.add(`${kind}:${n}`);
      }
    }
    if (level > 0 && total > 1) {
      // (config is only ever set; a branch or alias that differs from the state the script started with, in any reading, may or may not have changed)
      // (the alias part is defence in depth: the candidate-script comparison (spec.git vs ctx.gitAliases) makes a redefined alias unsure as well)
      ctx.cfgDirty = dirty;
      ctx.envCfgDirty = envDirty;
      for (const d of moved) ctx.branches.set(d, { name: null, trackMain: false });
      for (const a of redefined) ctx.aliasUnsure.add(a);
    }
    return allowed();
  } finally {
    [ctx.pins, ctx.pinsLevel] = outer;
  }
}

function evalString(str, startDir, ctx, level, child = false) {
  checkDeadline(ctx.budget);
  if (level > MAX_NESTING) return deny('pipeline job start / alias is nested too deeply to verify.');
  const cmds = simpleCommands(str, { env: ctx.env, bashState: ctx.bashState, expired: () => ctx.budget.now() > ctx.budget.deadline }); // a scan that outlasts the deadline gives up: truncated, so denied
  // Truncated means part of the line was never looked at, so nothing on it can be called harmless (`g''it push` after
  // 500 `true;` must not slip through on a word match).
  if (cmds.truncated) return deny('command too complex to verify (the parser gave up). Split it into simpler commands.');
  if (cmds.dynamic && GUARDED_WORDS.test(str)) {
    return deny('the command that runs is only known at run time ($VAR / $(...) / piped into a shell) and the line mentions a guarded operation, so it cannot be verified. Rewrite: write the command out literally (`git push origin agent/x`, not `$G push` or `... | sh`); if the guarded words are only text (a commit message, a PR body), put that text in a file (`git commit -F msg.txt`, `gh pr create --body-file body.md`).');
  }
  // A variable whose value is not certain (see collectAssignments) denies the line when it reaches git / gh, a command
  // that runs code, cd / pushd / popd or a command name: the checks below read the expanded text.
  const saved = (level === 0 || child) && !pinsAt(ctx, level) ? lineState(ctx) : null; // (the state before this line's assignments: each reading starts from it)
  collectAssignments(cmds, ctx, !definesFunction(str, cmds), level, str);
  if (ctx.unsureVars.size || ctx.tainted.size) {
    const unsure = unsureVarReachingCommand(cmds, ctx);
    if (unsure !== null) {
      const read = saved && judgeReadings(str, startDir, ctx, level, onceAssignedNames(cmds, ctx, str), saved);
      if (read) return read;
      if (ctx.zshNames?.has(unsure)) return deny(zshModifiedReason(unsure));
      return deny(`$${unsure} is assigned more than once (or where it may not run) on this line, so its value at run time cannot be verified. Rewrite: assign it once, as the first command of the line (\`${unsure}=value; …\`), or write the value out where it is used.`);
    }
  }
  let dir = startDir;
  const cdp = cdpathMaybe(cmds, ctx);
  const from = flowStart(cmds);
  let uncertain = false; // an earlier cd / branch change may not have taken effect for the commands that follow
  const forgetState = () => { dir = null; for (const e of ctx.branches.values()) e.name = null; };
  // sticky: a later `cd /abs` does not make it known again (`alias cd=true; cd /safe`, a DEBUG trap that cds back)
  const hazard = definesFunction(str, cmds) || cmds.some(isStateHazard);
  // the files this command list writes, for every script judged while it runs (see line-writes.mjs); `dirAt`: where each command runs
  const dirAt = new Map();
  const cdDirs = cdTargets(cmds, startDir, ctx);
  const frame = newWriteFrame(cmds, {
    text: str,
    expand: (w) => {
      let e = expandVars(w, ctx).replace(/^\$\{?HOME\}?(?=\/|$)/, ctx.home);
      if (e === '~' || e.startsWith('~/')) e = ctx.home + e.slice(1);
      return /[$`*?[{]/.test(e) || e.startsWith('~') ? null : e; // ({a,b}: zsh writes both for a redirect, and the parser leaves the word of one unexpanded)
    },
    // (a command that has not run yet could be in any directory the line cds to: every one of them, and the bare word)
    locate: (e, idx) => {
      if (path.isAbsolute(e)) return [path.resolve(e)];
      if (!dirAt.has(idx)) return [...cdDirs.map((d) => path.resolve(d, e)), e];
      const d = dirAt.get(idx);
      return d ? [path.resolve(d, e)] : [e];
    },
    isAbs: path.isAbsolute, p: path, ci: process.platform === 'win32' || process.platform === 'darwin',
    real: (q) => realLocation(ctx.realpath, q),
    readText: (q) => ctx.readText(q), // (an awk program file is read to see what it writes)
    stamp: (idx) => (dirAt.has(idx) ? `S${dirAt.get(idx)}` : ''), // (locate() answers differently once the command's directory is known)
    tick: () => checkDeadline(ctx.budget),
  });
  ctx.writeFrames.push(frame);
  // the subshells open at the command being walked, outermost first: { id, dir, uncertain } as they were when it started (null: marks not trusted, see subshellsTrusted)
  const subs = subshellsTrusted(cmds) ? [] : null;
  try {
  for (const [i, c] of cmds.entries()) {
    checkDeadline(ctx.budget); // a lookup (branch, labels) can take seconds; the evaluation as a whole may not
    const argv = c.argv;
    if (subs) {
      // Why: a cd inside a subshell ($( ), ( ), backticks, <( )) moves that subshell only: when it ends, the line goes on in the directory it had when the subshell
      // started, whatever the commands are named (superpowers' task-brief finds its helper with `$(cd "$(dirname "$0")" && pwd)` and then goes on where it was).
      // A branch switched in it is the repository's, so it stays switched, or unknown when the switch may not have run.
      let k = 0;
      while (k < subs.length && k < c.grp.length && subs[k].id === c.grp[k]) k++;
      if (k < subs.length) {
        if (uncertain) for (const e of ctx.branches.values()) e.name = null;
        dir = subs[k].dir;
        uncertain = subs[k].uncertain;
        subs.length = k;
      }
      for (; k < c.grp.length; k++) subs.push({ id: c.grp[k], dir, uncertain });
    }
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
    frame.i = i;
    dirAt.set(i, dir);
    if (!argv.length) { recordAssigned(c, ctx, level); continue; } // a bare `NAME=value`
    const name = baseName(argv[0]);
    let verdict = null;
    if (VAR_BUILTINS.includes(name)) {
      const d = declAttrs(argv);
      for (const [k, v] of d.assigns) {
        // (a value that still holds a `$` is not worked out: the case change would apply to what it expands to)
        if (d.transform && DYNAMIC.test(v)) { delete ctx.vars[k]; ctx.unsureVars.add(k); } else setVar(ctx, k, applyTransform(v, d.transform), level);
      }
    } else if (name === 'for' && pinsAt(ctx, level)?.get(argv[1])?.expand) verdict = loopWordAt(argv[1], ctx);
    else if (name === 'for' && computedLoopWord(c) !== null) setVar(ctx, argv[1], computedLoopWord(c), level);
    else if (name === 'cd' || name === 'pushd' || name === 'popd') dir = nextDir(dir, name, argv, ctx, cdp, c.env ?? {});
    else if (name === 'git' || name === 'gh') {
      const unsure = unsureVarUsed([...argv.slice(1), ...Object.values(c.env)], ctx);
      if (unsure !== null && ctx.zshNames?.has(unsure)) verdict = deny(zshModifiedReason(unsure));
      else if (unsure !== null) verdict = deny(`$${unsure} was assigned more than once on this line, so its value (and what this ${name} command does with it) cannot be verified. Assign it once, or write the value out.`);
      else verdict = name === 'git' ? checkGit(argv, c.env, dir, ctx, c.raw ?? '') : checkGh(argv, c.env, dir, ctx, c.raw ?? '');
    }
    else {
      for (const inner of jobStartCommands(argv, ctx) ?? []) {
        // Why (#58 round 3): the job runs in THIS command's environment, so its prefix (`GH_REPO=o/chat … job start m -- gh pr merge 8`) names the
        // merge's repository exactly as it would for the merge typed directly.
        const v = withPrefixEnv(c, ctx, () => evalString(inner, dir, ctx, level + 1));
        if (v.decision === 'deny') { verdict = v; break; }
      }
      if (!verdict && HTTP_TOOLS.has(name)) verdict = checkHttpTool(argv, dir, ctx, name);
      if (!verdict) verdict = withPrefixEnv(c, ctx, () => repoMergeCommandVerdict(argv, dir, ctx)); // (#58; with its prefix: `npm_config_prefix=/chat npm run merge …`)
      // (npm exec NAME / npx NAME: the parser unwraps them to `NAME …`, marked viaRunner. NAME is a bin, never a script, but it is judged as the merge script when it carries that name: `npx npm run NAME`)
      if (!verdict && c.viaRunner) verdict = withPrefixEnv(c, ctx, () => repoMergeCommandVerdict(['npx', 'npm', 'run', argv[0]], dir, ctx));
      if (!verdict && c.viaRunner) {
        verdict = runnerBinVerdict(argv, dir, ctx, level);
        // (R1-B6: `npx --prefix sub tool`: the bin may come from the prefix's node_modules/.bin; it still runs in the working directory)
        for (const pfx of c.runnerDirs ?? []) {
          if (verdict) break;
          const w = expandVars(pfx, ctx);
          if (w === '' || /[$`*?[{]/.test(w)) { // (a directory only known at run time: the bin may be in any place, as for `bash $D/tool`)
            if (lineMentionsGuarded(ctx)) verdict = deny('package script: the script (or directory) `' + argv.slice(0, 4).join(' ') + '` runs is only known at run time and the line mentions a guarded operation, so what it runs cannot be verified. Name the script.');
            continue;
          }
          if (dir === null) continue;
          verdict = runnerBinVerdict(argv, dir, ctx, level, false, path.resolve(dir, w === '~' || w.startsWith('~/') ? path.join(ctx.home ?? '', w.slice(1)) : w));
        }
      }
      // (a bare command name in a package script: node_modules/.bin/NAME of the package's directory or above it comes first on the PATH; none there = an ordinary command)
      if (!verdict && !c.viaRunner && (typeof ctx.scriptBinDir === 'string' || (c.binPath && dir !== null))) verdict = runnerBinVerdict(argv, typeof ctx.scriptBinDir === 'string' ? (dir ?? ctx.scriptBinDir) : dir, ctx, level, true, typeof ctx.scriptBinDir === 'string' ? ctx.scriptBinDir : dir); // (R1-B6: looked up from the package's bin directory, run where the script is)
      if (!verdict) verdict = withPrefixEnv(c, ctx, () => packageScriptVerdict(argv, dir, ctx, level)); // (#81 t9: `npm run NAME` runs the text package.json holds for NAME)
      if (!verdict) {
        // a string or program text the parser cannot unwrap (node -e, osascript, make CMD=...) that carries a guarded command
        const why = catchAllReason(argv);
        if (why) verdict = deny(`${name} was given a string that contains a guarded command (${why}). Run the operation directly so it can be checked.`);
      }
      if (!verdict && splicesOptions(argv)) verdict = checkSplices(c, dir, ctx, level);
      const sf = verdict ? null : scriptFileOf(argv, c.raw, str);
      if (sf && (name === 'source' || name === '.')) sf.sourced = true;
      const withPath = (rec) => { if (sourcePathSearch(rec, c.argv, cmds)) { rec.ambiguous = true; rec.words ??= [rec.file]; rec.pathSearch = true; } if (rec.words?.some(isEqualsWord) || rec.pathSearch) rec.pathValues = pathValuesOf(c, cmds, { env: ctx.env, inherited: (n) => knownValues(ctx, n) }); return rec; }; // (zsh `=tool`: the PATH directories to look in)
      if (sf) withPath(sf);
      // a shell runs its startup files (BASH_ENV, ENV, ZDOTDIR/.zshenv ...) BEFORE the script it was given, so they are judged first, in the
      // order the shell reads them, and what they change (a branch switch) is what the script and the feeds are then judged against
      const startupList = startupFilesOf(c, cmds, { env: ctx.env, inherited: (n) => knownValues(ctx, n), exec: sf?.kind === 'exec' });
      // Why: BASH_ENV / ENV are sourced by the shell that then runs the script, so the variables they set are in the script's environment (judged as sourced, inside
      // withStartupScope: the prefix first, then the file, then the script); the line itself keeps none of it
      const judgeRest = () => {
      if (!verdict) verdict = judgeStartupList(startupList.map((st) => (st.implicit ? st : { ...st, sourced: true })), c, dir, ctx, level);
      if (!verdict && sf) {
        // (a program run by path is judged with the command that runs it: its shebang may name a shell, which reads startup files of its own)
        const outer = ctx.execCmd;
        ctx.execCmd = sf.kind === 'exec' ? { c, cmds } : null;
        try {
          verdict = withPrefixEnv(c, ctx, () => checkScriptFile(sf, dir, ctx, level));
        } finally {
          ctx.execCmd = outer;
        }
      }
      // script text that reaches a shell without being named (`bash < f.sh`, `cat f.sh | bash`, `eval "$(cat f.sh)"`): its files are judged like `bash f.sh`
      // Several files feeding one program (review R2-B2): the JOINED record is the program the shell really reads, so it is judged first, from the
      // state the line is in, and its changes carry on; each fragment is then judged on an isolated copy (a fragment's branch switch is commented
      // out or cut in two by its neighbours in the real text, so it must not change what the other fragments are judged against)
      if (!verdict) {
        const feeds = scriptFeedsOf(c, str, (w) => expandVars(w, ctx));
        const joined = feeds.some((fd) => fd.joined);
        const ordered = joined ? [...feeds.filter((fd) => fd.joined), ...feeds.filter((fd) => !fd.joined)] : feeds;
        for (const fd of ordered) {
          withPath(fd);
          const judge = () => withPrefixEnv(c, ctx, () => checkScriptFile(fd, dir, ctx, level));
          verdict = joined && !fd.joined ? isolatedState(ctx, judge) : judge();
          if (verdict) break;
        }
      }
      };
      if (startupList.some((st) => !st.implicit)) withStartupScope(c, ctx, judgeRest); else judgeRest();
    }
    if (verdict && verdict.decision === 'deny') return verdict;
    markPackageState(ctx.budget, [argv], { dirs: dir === null ? null : [dir], expand: (w) => expandVars(w, ctx), home: ctx.home, p: path }); // (what this command may change, for the package scripts after it)
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
  } finally {
    // what the list wrote is still true for the commands after the one that ran it
    const done = ctx.writeFrames.pop();
    const caller = ctx.writeFrames[ctx.writeFrames.length - 1];
    if (caller && done) caller.recs.push(...exportRecords(done, caller.i, caller.recs));
  }
}

// Text too long to parse inside the time budget is judged by what it mentions once quotes and escapes are removed.
function judgeLongText(text) {
  return GUARDED_WORDS.test(text.replace(/['"`\\]/g, '')) ? deny('this text is too long to verify and mentions a guarded operation. Split it into simpler commands.') : allowed();
}

// Why: "${BASH:-bash}" is rewritten to bash while no text judged so far can bind BASH (see simpleCommands); a text that binds it and is judged after a rewrite makes the verdict stale, so the whole
// line is judged again with the rewrite off. (A denial stands: the second pass only adds readings.)
export function evaluateGitCommand(command, opts = {}) {
  const state = { bound: false, rewrote: false };
  const first = evaluateGitOnce(command, opts, state);
  if (first.decision === 'deny' || !(state.bound && state.rewrote)) return first;
  return evaluateGitOnce(command, opts, { bound: true, rewrote: false, carry: state.budget }); // (the second pass spends what the first left: every cap still ends in a denial; only the startup-file memo starts empty)
}
function evaluateGitOnce(command, {
  cwd,
  home = os.homedir(),
  currentBranch = () => null,
  pushDestination = () => null,
  issueLabels = () => { throw new Error('no issue label lookup is available'); },
  readText = defaultReadText,
  readHead = defaultReadHead,
  pathExists = existsSync,
  lexists = pathExists === existsSync ? defaultLexists : () => false, // (a caller that fakes pathExists gets no real-disk lstat)
  readDir = defaultReadDir,
  realpath = realpathSync.native, // symlinks followed when a write and a script are compared (tests fake it)
  now = Date.now, // injectable clock (tests)
  env = {}, // the hook process's environment (BASH_ENV / ENV / ZDOTDIR name startup files the shells run); {} keeps tests hermetic
  nodePrefix, // #89 t3: where this node binary's npm keeps its global configuration (<nodePrefix>/etc/npmrc); undefined: from process.execPath, null: none (tests)
  ownerGo = null, // #58: { mode(dir), mergeTemplates(dir), approvedHead(pr, head) } (git-wiring.mjs ownerGoWiring); null = no direct-merge check
} = {}, bashState) {
  const text = typeof command === 'string' ? command : String(command ?? '');
  if (text.length > MAX_LINE_CHARS) return judgeLongText(text);
  const base = cwd || process.cwd();
  const ctx = {
    cwd: base, home, nodePrefix, currentBranch, pushDestination, issueLabels, ownerGo, readText, pathExists, lexists, readDir, readHead, realpath, env, budget: bashState?.carry ? { ...bashState.carry, startupOk: new Set(), startupFx: undefined } : newEvalBudget(now), fullText: text, lineText: text,
    vars: Object.create(null), unsureVars: new Set(), tainted: new Set(), aliasUnsure: new Set(), gitAliases: Object.create(null), ghAliases: Object.create(null),
    branches: new Map(), cfgDirty: false, envCfgDirty: false, writeFrames: [], bashState,
  };
  if (bashState) bashState.budget = ctx.budget;
  // Why: a hook that throws or times out is allowed by Claude Code, so a limit hit (GuardLimit) and ANY other exception (a
  // readText that throws, a stack overflow) end here as a denial that names the cause.
  try {
    return evalString(text, path.resolve(base), ctx, 0);
  } catch (err) {
    if (err instanceof GuardLimit) return deny(err.message);
    return deny(`internal error while checking this command (${err instanceof Error ? err.message : String(err)}), so it cannot be verified.`);
  }
}

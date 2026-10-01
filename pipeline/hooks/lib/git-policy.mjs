// Why: agents and the owner share one GitHub identity, so this evaluator is the local barrier against an agent
// approving or merging its own work. It decides, for one Bash command line, whether any hidden simple command
// (see shell-parse.mjs) pushes to main/master, force-pushes, admin-merges, edits protection/rulesets/repo
// settings, adds an owner-only approval label, removes a guard label, or closes a pause/rollback issue.
// Pure on purpose (branch and label lookups are injected) so tests and jobs.mjs can share it.
// Policy: anything we cannot verify is denied (unknown branch, lookup failure, truncated parse). Beyond the
// published table it also covers the same-intent routes (gh api label/issue/merge endpoints, `--label` on create,
// graphql mutations, `--input` bodies) because "use the API instead" is the first thing a blocked agent tries.
// Residual (documented): label approval is protected against accidental and casual misuse, not an agent that
// writes its own API client; aliases, git config (remote.*.push, push.default) and xargs-appended args are not seen.
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleCommands } from './shell-parse.mjs';

const PROTECTED_BRANCHES = ['main', 'master'];
const APPROVAL_LABELS = ['human-approved', 'test-change-approved'];
const GUARD_LABELS = ['needs-human', 'pipeline-blocked', 'awaiting-review', 'pipeline-pause', 'pipeline-rollback'];
const HOLD_LABELS = ['pipeline-pause', 'pipeline-rollback'];
const ALL_LABELS = [...APPROVAL_LABELS, ...GUARD_LABELS];
const MAX_JOB_NESTING = 5;
const MAX_INPUT_BYTES = 1_000_000;
const OWNER_ONLY = 'This is reserved for the repository owner.';

const GRAPHQL_DENY = /\b(addLabelsToLabelable|removeLabelsFromLabelable|mergePullRequest|(?:create|update|delete)BranchProtectionRule|(?:create|update|delete)RepositoryRuleset|updateRepository|deleteRepository|updateRef|deleteRef|closeIssue|deleteIssue|transferIssue|updateLabel|deleteLabel)\b/i;
const PUSH_LONG_VALUE = ['repo', 'receive-pack', 'exec', 'push-option', 'recurse-submodules'];
const GIT_GLOBAL_VALUE = ['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'];
const API_LONG_VALUE = ['method', 'field', 'raw-field', 'header', 'input', 'jq', 'template', 'preview', 'hostname', 'cache'];
const VAR_BUILTINS = ['export', 'declare', 'typeset', 'local', 'readonly'];
const DYNAMIC = /[$`]/;
const NAMES_PROTECTED = /(^|[^A-Za-z0-9_-])(main|master)([^A-Za-z0-9_-]|$)/;

const deny = (reason) => ({ decision: 'deny', reason });
const allowed = () => ({ decision: 'allow', reason: '' });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseName = (w) => String(w ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
const isProtectedBranch = (b) => PROTECTED_BRANCHES.includes(b);
const isPrefixOf = (name, full, min = 1) => name.length >= min && full.startsWith(name);
// Label names are case-insensitive on GitHub; a name only counts when it is not part of a longer one.
const labelRe = (name) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, 'i');
const mentionsAny = (text, names) => names.some((n) => labelRe(n).test(text));
const splitLabels = (v) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

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

// ---- directories and variables ----------------------------------------------------------------------------

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
  const re = new RegExp(`^${[...pattern].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : escapeRe(c))).join('')}$`);
  return PROTECTED_BRANCHES.some((b) => re.test(b));
}

function checkRefspec(spec, dir, gitDir, ctx) {
  if (spec.startsWith('+')) return deny(FORCE_REASON);
  const colon = spec.indexOf(':');
  const src = colon < 0 ? spec : spec.slice(0, colon);
  let dst = colon < 0 ? spec : spec.slice(colon + 1);
  if (colon >= 0 && src === '' && dst === '') return deny('`git push <remote> :` pushes every matching branch, including main. Name your branch explicitly.');
  if (dst === '') dst = src; // `src:` is not a destination git accepts; judge it by the source name
  dst = dst.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
  if (DYNAMIC.test(dst)) {
    // `git push origin "$(git branch --show-current)"` is common and means the current branch: accept it only when
    // that branch is known and not protected, and the text does not itself name main/master.
    const b = branchOf(dir, gitDir, ctx);
    if (b === null || isProtectedBranch(b) || NAMES_PROTECTED.test(dst)) {
      return deny(`the destination "${dst}" cannot be resolved here, so it cannot be verified. Write the branch name out: git push -u origin agent/<slug>.`);
    }
    return null;
  }
  if (dst === 'HEAD' || dst === '@') {
    const b = branchOf(dir, gitDir, ctx);
    if (b === null) return deny('cannot determine the current branch for `git push … HEAD`, so it cannot be verified. Name the destination branch explicitly.');
    dst = b;
  }
  if (isProtectedBranch(dst)) return deny(`pushing to ${dst} is blocked. Push an agent/<slug> branch and open a PR; the owner merges.`);
  if (/[*?[]/.test(dst) && globMatchesProtected(dst)) return deny(`the refspec pattern "${spec}" can update main/master. Name your branch explicitly.`);
  return null;
}

function checkPush(args, dir, gitDir, ctx) {
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
    const b = branchOf(dir, gitDir, ctx);
    if (b === null) return deny('cannot determine the current branch (detached HEAD or not a repository), so a push with no refspec cannot be verified. Name the branch: `git push -u origin agent/<slug>`.');
    if (isProtectedBranch(b)) return deny(`this checkout is on ${b}; a push with no refspec would push it. Switch to an agent/<slug> branch.`);
    return null;
  }
  for (const spec of refspecs) {
    const v = checkRefspec(spec, dir, gitDir, ctx);
    if (v) return v;
  }
  return null;
}

function checkGit(argv, env, dir, ctx) {
  let d = dir;
  let gitDir = typeof env.GIT_DIR === 'string' && env.GIT_DIR ? joinDir(d, env.GIT_DIR, ctx) : null;
  let i = 1;
  for (; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-C') { d = joinDir(d, argv[++i], ctx); continue; }
    if (t === '-c') { i++; continue; }
    if (t.startsWith('--git-dir=')) { gitDir = joinDir(d, t.slice('--git-dir='.length), ctx); continue; }
    if (t === '--git-dir') { gitDir = joinDir(d, argv[++i], ctx); continue; }
    if (GIT_GLOBAL_VALUE.includes(t)) { i++; continue; }
    if (t.startsWith('-')) continue; // boolean global option, or --opt=value
    break;
  }
  if (argv[i] !== 'push') return null;
  return checkPush(argv.slice(i + 1), d, gitDir, ctx);
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
function gatherBody(flags, dir, ctx) {
  let text = '';
  let unknown = false;
  const fromFile = (p) => {
    const t = dir === null ? null : ctx.readText(path.resolve(dir, p));
    if (typeof t === 'string') text += `\n${t}`;
    else unknown = true;
  };
  for (const f of flags) {
    if (f.value === null) continue;
    const typed = f.short ? f.name === 'F' : f.name === 'field';
    const raw = f.short ? f.name === 'f' : f.name === 'raw-field';
    if (typed || raw) {
      text += `\n${f.value}`;
      const at = typed ? /^[^=]*=@(.+)$/.exec(f.value) : null;
      if (at) fromFile(at[1]);
    } else if (!f.short && f.name === 'input') {
      if (f.value === '-') { unknown = true; text += `\n${ctx.fullText}`; } else fromFile(f.value);
    }
  }
  return { text, unknown };
}

function normaliseEndpoint(raw) {
  let e = String(raw ?? '').trim().replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, '');
  e = e.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  try { e = decodeURIComponent(e); } catch { /* keep the raw text */ }
  return e;
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
  if (/\/rulesets/i.test(p)) return deny(`${method} to rulesets is blocked. ${OWNER_ONLY}`);
  if (/^repos\/[^/]+\/[^/]+$/i.test(ep)) return deny(`${method} to repository settings is blocked. ${OWNER_ONLY}`);
  if (/\/collaborators/i.test(p)) return deny(`${method} to collaborators is blocked. ${OWNER_ONLY}`);
  if (/\/actions\/permissions/i.test(p)) return deny(`${method} to Actions permissions is blocked. ${OWNER_ONLY}`);

  const body = gatherBody(flags, dir, ctx);
  const haystack = `${rest.join('\n')}\n${body.text}`;
  const approval = mentionsAny(haystack, APPROVAL_LABELS);
  const guard = mentionsAny(haystack, GUARD_LABELS);

  // -- labels: adding approval labels, removing/renaming guard labels, replacing or clearing a whole set
  if (/\/labels(\/|$)/i.test(p)) {
    if (approval && method !== 'DELETE') return deny(`adding or editing an approval label (${APPROVAL_LABELS.join(', ')}) through the API is blocked. ${OWNER_ONLY}`);
    if (guard && ['DELETE', 'PATCH', 'PUT'].includes(method)) return deny(`removing or renaming a guard label (${GUARD_LABELS.join(', ')}) through the API is blocked. ${OWNER_ONLY}`);
    if (/^repos\/[^/]+\/[^/]+\/(issues|pulls)\/[^/]+\/labels$/i.test(ep)) {
      if (method === 'PUT' || method === 'DELETE') return deny('replacing or clearing all labels of an issue/PR can drop guard labels. Add or remove single labels with `gh pr edit`.');
      if (body.unknown) return deny('cannot verify the labels in the request body (--input - / unreadable file); use `gh pr edit --add-label` instead.');
    }
  }

  // -- the issue/PR object itself: labels and state live there too
  const issue = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i.exec(ep);
  if (issue) {
    if (approval) return deny(`setting an approval label through the issue API is blocked. ${OWNER_ONLY}`);
    if (/\blabels\b/i.test(body.text)) return deny('setting `labels` through the issue API replaces the whole label set and can drop guard labels. Use `gh pr edit --add-label`.');
    if (body.unknown) return deny('cannot verify the request body (--input - / unreadable file); use `gh issue edit` instead.');
    if (/state["']?\s*[=:]\s*["']?closed/i.test(body.text)) {
      const placeholder = /[{}:]/.test(issue[1] + issue[2]);
      return checkIssueHold(issue[3], placeholder ? [] : ['-R', `${issue[1]}/${issue[2]}`], dir, ctx, 'close');
    }
  }

  // -- merging or moving main without going through the merge gate
  if (method === 'PUT' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(ep)) return deny(`merging through the API bypasses the merge gate, like --admin. ${OWNER_ONLY}`);
  if (method === 'POST' && /\/merges$/i.test(p)) return deny(`merging branches through the API can move main without a PR. ${OWNER_ONLY}`);
  if (/\/git\/refs\/heads\/(main|master)$/i.test(p)) return deny(`${method} to the main/master ref is a push to main. It is blocked.`);
  if (method === 'POST' && /\/git\/refs$/i.test(p) && /refs\/heads\/(main|master)\b/i.test(haystack)) return deny('creating the main/master ref through the API is blocked.');

  if (/^graphql$/i.test(ep)) {
    const m = GRAPHQL_DENY.exec(haystack);
    if (m) return deny(`the graphql mutation ${m[1]} can merge, relabel, close or reconfigure and is blocked. ${OWNER_ONLY}`);
    if (body.unknown) return deny('cannot verify the graphql body (--input - / unreadable file).');
  }
  return null;
}

function checkGh(argv, env, dir, ctx) {
  const { group, verb, rest } = splitGh(argv.slice(1));
  if (!group) return null;
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
    const adds = flagValues(flags, ['add-label', 'label'], 'l').flatMap(splitLabels);
    const removes = flagValues(flags, ['remove-label']).flatMap(splitLabels);
    const bad = adds.find((l) => APPROVAL_LABELS.includes(l));
    if (bad) return deny(`adding the approval label ${bad} is blocked. ${OWNER_ONLY} Ask the owner to review and add it.`);
    const kept = removes.find((l) => GUARD_LABELS.includes(l));
    if (kept) return deny(`removing the guard label ${kept} is blocked. ${OWNER_ONLY}`);
    return null;
  }

  if (group === 'issue' && ['close', 'delete', 'transfer'].includes(verb)) {
    const { flags, positionals } = parseOpts(rest, { longValue: ['repo', 'comment', 'reason'], shortValue: 'Rcr' });
    if (positionals.length === 0) return null; // gh refuses a missing issue number itself
    return checkIssueHold(positionals[0], repoArgsOf(flags, env), dir, ctx, verb);
  }
  return null;
}

// ---- pipeline job runner --------------------------------------------------------------------------------

const shellQuote = (w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);

// `node …/pipeline.mjs job start NAME [opts] -- CMD…` (or `pipeline job start …`) runs CMD detached; judge CMD itself.
// Returns the command lines to evaluate, or null. The runner may spawn the words as argv (`bash -c 'git push'`
// stays one script word, so re-quote them) or hand the joined text to a shell (`-- "git push origin main"` is one
// word that a shell would split), so both readings are judged and either one can deny.
function jobStartCommands(argv) {
  const first = baseName(argv[0]);
  const isEntry = (w) => /^pipeline(\.mjs)?$/.test(baseName(w));
  if (!isEntry(argv[0]) && !['node', 'nodejs', 'bun', 'npx'].includes(first)) return null;
  const limit = Math.min(argv.length, 8);
  let k = isEntry(argv[0]) ? 0 : 1;
  while (k < limit && !isEntry(argv[k])) k++;
  if (k >= limit || argv[k + 1] !== 'job' || argv[k + 2] !== 'start') return null;
  const dd = argv.indexOf('--', k + 3);
  const cmd = dd >= 0 ? argv.slice(dd + 1) : argv.slice(k + 4); // no `--`: everything after NAME
  return [...new Set([cmd.map(shellQuote).join(' '), cmd.join(' ')])].filter((s) => s.trim());
}

// ---- entry point ----------------------------------------------------------------------------------------

function evalString(str, startDir, ctx, level) {
  if (level > MAX_JOB_NESTING) return deny('pipeline job start is nested too deeply to verify.');
  const cmds = simpleCommands(str);
  if (cmds.truncated && /\b(git|gh|pipeline)\b/i.test(str)) {
    return deny('command too complex to verify (the parser gave up). Split it into simpler commands.');
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
    else if (name === 'git') verdict = checkGit(argv, c.env, dir, ctx);
    else if (name === 'gh') verdict = checkGh(argv, c.env, dir, ctx);
    else {
      for (const inner of jobStartCommands(argv) ?? []) {
        const v = evalString(inner, dir, ctx, level + 1);
        if (v.decision === 'deny') { verdict = v; break; }
      }
    }
    if (verdict && verdict.decision === 'deny') return verdict;
  }
  return allowed();
}

export function evaluateGitCommand(command, {
  cwd,
  home = os.homedir(),
  currentBranch = () => null,
  issueLabels = () => { throw new Error('no issue label lookup is available'); },
  readText = defaultReadText,
} = {}) {
  const text = typeof command === 'string' ? command : String(command ?? '');
  const base = cwd || process.cwd();
  const ctx = { cwd: base, home, currentBranch, issueLabels, readText, fullText: text, vars: Object.create(null) };
  return evalString(text, path.resolve(base), ctx, 0);
}

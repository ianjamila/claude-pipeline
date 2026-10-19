// Package managers: how a command line names the script it runs, and which package.json that is.
// Why (#81 t9): `npm run deploy` was ALLOWED when its package.json script held a guarded command (a push to main, a write to a protected file) -- npm / npx sat in the git guard's OPAQUE_TOOLS and
// scriptFileOf has no reading for `npm run`, so neither guard ever opened a package script. The argv reading below (moved here from git-policy.mjs, where #58 built it for the repo's merge
// command) is shared: git-policy.mjs judges the merge command with it as before, and both guards open the scripts with pmCall / packageScripts.
import nodePath from 'node:path';
import { lstatSync } from 'node:fs';
import { commandName, simpleCommands } from './shell-parse.mjs';

const baseName = (w) => commandName(w);

// Package-manager spellings of one script: `npm --silent run merge`, `npm run-script merge`, `npm rum merge`, `pnpm merge`, `yarn merge` all run
// script "merge". canonPm drops the global options (before the subcommand and between `run` and the script) and maps the aliases to
// `<pm> run <script> …`; an option it does not know is read as a flag without a value. (The value-taking ones it knows are skipped with their value.)
export const PM_RUN_ALIASES = { npm: ['run', 'run-script', 'rum', 'urn'], pnpm: ['run', 'run-script'], yarn: ['run'], bun: ['run'] };
export const PM_VALUE_OPTS = new Set(['--prefix', '--workspace', '-w', '--userconfig', '--globalconfig', '--cache', '--loglevel', '--registry', '--dir', '-C', '--filter', '-F', '--cwd', '--use-yarnrc', '--tag', '--scope', '--otp', '--script-shell']);
export const PM_WRAPPERS = new Set(['npx', 'pnpx', 'bunx', 'corepack', 'exec', 'x', 'dlx']);
export const PM_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'exec', 'dlx', 'x', 'test', 't', 'start', 'stop', 'restart', 'publish', 'pack', 'link', 'unlink', 'init', 'create', 'audit', 'outdated', 'list', 'ls', 'why', 'info', 'view', 'config', 'cache', 'version', 'help', 'login', 'logout', 'whoami', 'ci', 'rebuild', 'prune', 'dedupe', 'store', 'env', 'patch', 'import', 'fetch', 'run']);
// The parts of a package-manager command line: the global options before the subcommand, the subcommand, the options between `run` and the script, and what follows.
// kind: 'run' (`npm run X`, `npm rum X` ...), 'bare' (`yarn X`, `pnpm X`: a script unless it is one of the manager's own commands), 'other' (any other subcommand), 'none' (no subcommand).
export function pmParts(words) {
  const pm = baseName(words[0] ?? '');
  const aliases = Object.hasOwn(PM_RUN_ALIASES, pm) ? PM_RUN_ALIASES[pm] : null;
  if (!aliases) return null;
  const skipOpts = (i) => { while (i < words.length && words[i].startsWith('-') && words[i] !== '--') i += PM_VALUE_OPTS.has(words[i]) ? 2 : 1; return i; };
  const i = skipOpts(1);
  const sub = (words[i] ?? '').toLowerCase();
  if (sub === '' || sub === '--') return { pm, kind: 'none', sub, opts: words.slice(1, i), rest: words.slice(i) };
  if (aliases.includes(sub)) {
    const j = skipOpts(i + 1);
    return { pm, kind: 'run', sub, opts: [...words.slice(1, i), ...words.slice(i + 1, j)], rest: words.slice(j) };
  }
  if (pm !== 'npm' && !PM_COMMANDS.has(sub)) return { pm, kind: 'bare', sub, opts: words.slice(1, i), rest: words.slice(i) }; // (`yarn merge`, `pnpm merge`: a script)
  return { pm, kind: 'other', sub, opts: words.slice(1, i), rest: words.slice(i) };
}
export function canonPm(words) {
  const p = pmParts(words);
  if (!p || p.kind === 'none') return words;
  return p.kind === 'other' ? [words[0], ...p.rest] : [words[0], 'run', ...p.rest];
}
// The script a template runs through a package manager ('' when it is not one).
// (canonPm output of a package manager's script call: `<pm> run <script> …`)
export const isPmRun = (c) => c.length > 2 && c[1] === 'run' && Object.hasOwn(PM_RUN_ALIASES, baseName(c[0]));
export const pmScriptOf = (prefix) => { const c = canonPm(prefix); return isPmRun(c) ? c[2] : ''; };
// The words the script itself receives. Why (#58 round 3): npm keeps every option written before `--` for itself (`npm run merge 7 --expect-head=H`
// hands the script only `7`), so for npm only the words AFTER `--` count; yarn and pnpm forward the words after the script name.
export const pmForwarded = (c) => (baseName(c[0]) === 'npm' ? (c.indexOf('--', 3) < 0 ? [] : c.slice(c.indexOf('--', 3) + 1)) : c.slice(3).filter((w) => w !== '--'));
// Subcommands that cannot run a repo script (read-only queries, installs): `npm view merge version` names the word `merge` and is no merge.
// (an unknown subcommand, `run`, `exec`, `x`, `dlx`, `explore`, `test`, `start` … stay judged as before)
export const PM_NO_SCRIPT = new Set(['view', 'v', 'info', 'show', 'ls', 'll', 'la', 'list', 'outdated', 'help', 'help-search', 'search', 's', 'find', 'why', 'explain', 'config', 'whoami', 'bin', 'root', 'prefix', 'ping', 'audit', 'fund', 'docs', 'home', 'repo', 'bugs',
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade']);
export const PM_BOOL_OPTS = new Set(['--silent', '-s', '--quiet', '-q', '--no-color', '--json', '--no-progress', '--no-audit', '--no-fund', '-g', '--global']);
// (only options it knows may precede the subcommand: an unknown one could take the next word as its value and leave the real subcommand behind it)
export function pmCannotRunScript(words) {
  if (!Object.hasOwn(PM_RUN_ALIASES, baseName(words[0] ?? ''))) return false;
  let i = 1;
  while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
    if (PM_VALUE_OPTS.has(words[i])) i += 2;
    else if (PM_BOOL_OPTS.has(words[i])) i += 1;
    else return false;
  }
  return PM_NO_SCRIPT.has(String(words[i] ?? '').toLowerCase());
}


// ---- package scripts ---------------------------------------------------------------------------------------------------

// What a package-manager command line runs. words: the command line's words, variables already expanded as far as the guard can.
// Allowlists that fail closed (#81 t9, security review): a subcommand that runs NO script must be on NO_SCRIPT[pm] by its exact name; every other subcommand is assumed to run scripts --
// the named script and its hooks (`run`), the manager's lifecycle chain (`test`, `install`, `publish` ...), or, for a subcommand not known here (`npm ins`, `npm isnt`, a typo, an
// abbreviation), every lifecycle script and every word of the line as a script name. An option the parser does not know before the subcommand, or before an argument it would take as a
// script argument, may take the next word as its value: `unresolved`, refused. Returns null when nothing can run, else
// { pm, sub, names, gate, main, extra, dir, workspace, mover, dynamic, dirDynamic, unresolved, bin, execText, startDefault, installGroup }:
//   names: the scripts the manager runs, in order; gate: at least one must exist; main: the script the user named, which receives `extra`; dir: the --prefix / -C / --dir / --cwd value
//   workspace: a workspace selection (-w, --workspaces, --filter, -r, `yarn workspace`): the script may be in any workspace package; mover: the option that was used (--userconfig, --globalconfig, --script-shell, --node-options), else false
//   bin: a bare yarn / pnpm / bun name, which falls back to node_modules/.bin/<name> when no script has it; execText: the command `npm exec -c` / `pnpm -r exec` runs
const hooks = (n) => [`pre${n}`, n, `post${n}`];
const INSTALL = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const PACK = ['prepack', 'preprepare', 'prepare', 'postprepare', 'postpack'];
const PUBLISH = ['prepublish', 'prepublishOnly', ...PACK, 'prepublish', 'publish', 'postpublish'];
const VERSION = hooks('version');
const TEST = hooks('test');
const START = hooks('start');
const STOP = hooks('stop');
const RESTART = [...hooks('restart'), ...STOP, ...START];
const UNION = [...new Set([...INSTALL, ...PUBLISH, ...VERSION, ...TEST, ...RESTART])];
const GROUPS = {
  npm: [[/^(?:i|in|ins|inst|insta|instal|install|isnt|isnta|isntal|isntall|add|ci|clean-install|ic|install-clean|isntall-clean|rebuild|rb|update|up|upgrade|udpate|dedupe|ddp|find-dupes|link|ln|prune|uninstall|un|unlink|remove|rm|r)$/, INSTALL],
    [/^(?:it|cit|install-test|install-ci-test|isntall-test)$/, [...INSTALL, ...TEST]], [/^pack$/, PACK], [/^publish$/, PUBLISH], [/^(?:version|verison)$/, VERSION]],
  other: [[/^(?:install|i|add|remove|rm|uninstall|un|update|up|upgrade|upgrade-interactive|link|ln|unlink|rebuild|rb|prune|dedupe|import|deploy|patch-commit|patch)$/, INSTALL], [/^pack$/, PACK], [/^publish$/, PUBLISH], [/^version$/, VERSION]],
};
const LIFECYCLE = { test: TEST, t: TEST, tst: TEST, start: START, stop: STOP, restart: RESTART };
const LIFECYCLE_PMS = { npm: new Set(Object.keys(LIFECYCLE)), pnpm: new Set(Object.keys(LIFECYCLE)), yarn: new Set(Object.keys(LIFECYCLE)), bun: new Set(['start', 'stop', 'restart']) }; // (`bun test` is bun's own runner)
// Subcommands that run no script, by exact name (verified against each manager's documentation; anything else, abbreviations included, is judged or refused).
const NO_SCRIPT = {
  npm: new Set(['view', 'v', 'info', 'show', 'ls', 'list', 'la', 'll', 'outdated', 'help', 'whoami', 'search', 's', 'se', 'find', 'ping', 'doctor', 'prefix', 'root', 'fund', 'explain', 'why', 'query', 'audit', 'cache',
    'owner', 'access', 'dist-tag', 'dist-tags', 'deprecate', 'unpublish', 'token', 'profile', 'team', 'org', 'star', 'stars', 'unstar', 'hook', 'completion', 'docs', 'home', 'repo', 'bugs', 'issues', 'config', 'c', 'get', 'set', 'login', 'adduser', 'logout', 'sbom', 'bin']),
  yarn: new Set(['info', 'why', 'list', 'outdated', 'help', 'config', 'versions', 'bin', 'licenses', 'owner', 'tag', 'cache', 'check', 'whoami', 'team', 'login', 'logout']),
  pnpm: new Set(['list', 'ls', 'll', 'la', 'outdated', 'why', 'view', 'info', 'show', 'v', 'help', 'config', 'c', 'get', 'set', 'root', 'bin', 'store', 'whoami', 'audit', 'licenses', 'ping', 'search', 'doctor', 'env', 'setup', 'completion']),
  bun: new Set(['pm', 'upgrade', 'outdated', 'why', 'info', 'test', 'build', 'init', 'completions', 'repl']),
};
const EXEC_SUBS = new Set(['exec', 'x', 'dlx']);
const DIR_OPTS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const WORKSPACE_OPT = /^(?:-w|-ws|--workspaces?|--filter|-F|--filter-prod|-r|--recursive|--include-workspace-root|--workspace-root)$/;
// Configuration keys that change what runs a script (the shell, the node options, the directory ...). One list for both places npm reads them: a key in a .npmrc / .yarnrc / bunfig file (rcRefusal) and the command line
// (npm accepts every config key as an option). The workspace selectors are on the list for the files, but the command line reads and follows them (WORKSPACE_OPT), so they are no CLI mover.
export const RC_REFUSED = new Set(['script-shell', 'node-options', 'workspaces', 'workspace', 'include-workspace-root', 'globalconfig', 'userconfig', 'shell', 'onload-script']);
const CLI_MOVERS = [...RC_REFUSED].filter((k) => !/^(?:workspaces?|include-workspace-root)$/.test(k));
// Is the option `key` (`--name`, the value cut off) one of them, in any spelling npm reads: the case and `_` / `-` are free (`--SCRIPT_SHELL`), `--no-NAME` sets it too, and nopt reads a unique abbreviation of a name
// it knows as that name (`--script-sh`): a name the guard's tables do not know is tried as a prefix of each mover (any, not only a unique one: fail closed). `known`: the tables know the name (--global is a prefix of --globalconfig but is its own option).
function cliMover(key, known) {
  if (!key.startsWith('--')) return false;
  const n = key.slice(2).toLowerCase().replace(/_/g, '-');
  if (CLI_MOVERS.includes(n) || (n.startsWith('no-') && CLI_MOVERS.includes(n.slice(3)))) return true;
  return !known && n.length >= 2 && CLI_MOVERS.some((m) => m.startsWith(n));
}
// --ignore-scripts: the hooks are dropped only for a value that is certainly true (nopt reads an empty value, 0, null and false as false, anything else as true; when in doubt the hooks are judged)
const ignoreFrom = (eq, w, next) => (eq > 0 ? /^(?:true|1)$/i.test(w.slice(eq + 1)) : !/^(?:false|0)$/i.test(next ?? ''));
const RUN_TIME = /[$`]/;
const GLOBAL_OPT = /^(?:-[a-zA-Z]*g[a-zA-Z]*|--global(?:=(?!false$|0$).*)?)$/i;
// `npm explore` (and its unique abbreviations: npm reads `expl` as ambiguous with explain) runs a command in node_modules/PKG. A scoped name is two path parts.
const EXPLORE_SUB = /^explo(?:r(?:e)?)?$/;
const EXPLORE_PKG = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;
// Options by how they take their value. A value option takes the next word unless it is written `--name=value`; an option that is on neither list may be either: unresolved.
const VALUE_NPM = new Set([...PM_VALUE_OPTS, '--node-options', '--omit', '--include', '--access', '--before', '--audit-level', '--install-strategy', '--lockfile-version', '--logs-dir', '--cafile', '--proxy', '--https-proxy', '--noproxy', '--user-agent', '--reporter', '--workspace-concurrency']);
const VALUE_OTHER = new Set([...VALUE_NPM].filter((o) => o !== '-w'));
const BOOL_LONG = new Set(['silent', 'quiet', 'color', 'no-color', 'json', 'progress', 'no-progress', 'audit', 'no-audit', 'fund', 'no-fund', 'global', 'if-present', 'ignore-scripts', 'no-ignore-scripts', 'workspaces',
  'include-workspace-root', 'recursive', 'workspace-root', 'verbose', 'force', 'yes', 'offline', 'prefer-offline', 'prefer-online', 'production', 'dev', 'save', 'no-save', 'save-dev', 'save-exact', 'save-optional', 'save-prod',
  'legacy-peer-deps', 'strict-peer-deps', 'package-lock', 'no-package-lock', 'package-lock-only', 'dry-run', 'parseable', 'long', 'link', 'unicode', 'engine-strict', 'foreground-scripts', 'update-notifier', 'no-update-notifier',
  'frozen-lockfile', 'prefer-frozen-lockfile', 'shamefully-hoist', 'fix-lockfile', 'stream', 'parallel', 'sequential', 'bail', 'no-bail', 'report-summary', 'optional', 'no-optional', 'allow-same-version', 'git-tag-version',
  'sign-git-tag', 'ignore-engines', 'ignore-platform', 'ignore-optional', 'non-interactive', 'pure-lockfile', 'immutable', 'immutable-cache', 'check-cache', 'version', 'help', 'registry-only', 'no-lockfile', 'ci', 'ws',
  'prefer-dedupe', 'omit-lockfile-registry-resolved', 'node-gyp', 'dev-only', 'depth', 'also', 'unsafe-perm', 'no-git-tag-version', 'no-audit-level', 'access-token', 'verify-store-integrity', 'lockfile-only', 'resolution-only']);
const SHORT_BOOL = /^-(?:[sqdgfylpDSEOPBhvVnaWL]+|ws|r)$/;
// 'value' | 'bool' | 'unknown' for one option word (a word that starts with `-`, not `--`)
function optKind(w, pm) {
  const vals = pm === 'npm' ? VALUE_NPM : VALUE_OTHER;
  if (w.startsWith('--')) {
    const eq = w.indexOf('=');
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (eq > 0) return 'bool'; // (the value is attached: it takes no other word)
    if (vals.has(name)) return 'value';
    const bare = name.slice(2);
    return BOOL_LONG.has(bare) || (bare.startsWith('no-') && BOOL_LONG.has(bare.slice(3))) ? 'bool' : 'unknown';
  }
  if (vals.has(w)) return 'value';
  return SHORT_BOOL.test(w) ? 'bool' : 'unknown';
}
// Reads the options at words[i...] up to the first word that is not one (or `--`), recording what they mean in st; returns the index after them.
function scanOpts(words, i, pm, st) {
  while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
    const w = words[i];
    const kind = optKind(w, pm);
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    const key = eq > 0 ? w.slice(0, eq) : w;
    const hasNext = i + 1 < words.length;
    if (DIR_OPTS.has(key)) st.dir = eq > 0 ? w.slice(eq + 1) : words[i + 1] ?? '';
    if (cliMover(key, optKind(key, pm) !== 'unknown')) st.mover = key;
    if (WORKSPACE_OPT.test(key)) st.workspace = true;
    if (GLOBAL_OPT.test(w) || (key === '--location' && (eq > 0 ? w.slice(eq + 1) : words[i + 1]) === 'global')) st.global = true;
    if (key === '--ignore-scripts') st.ignore = ignoreFrom(eq, w, words[i + 1]);
    if (key === '--no-ignore-scripts') st.ignore = false;
    if (kind === 'unknown') st.unknown.push(w);
    i += kind === 'value' && eq < 0 && hasNext ? 2 : 1;
  }
  return i;
}
export function pmCall(allWords) {
  const words = baseName(allWords[0] ?? '') === 'corepack' ? allWords.slice(1) : allWords; // (`corepack pnpm ship`)
  const pm = baseName(words[0] ?? '');
  if (!Object.hasOwn(PM_RUN_ALIASES, pm)) return null;
  const st = { dir: null, workspace: false, mover: false, ignore: false, global: false, unknown: [] };
  let i = scanOpts(words, 1, pm, st);
  if (words[i] === '--') i++; // (`npm -- run x`: the words after `--` are positional, the first is the subcommand)
  const sub = (words[i] ?? '').toLowerCase();
  const rest = words.slice(i + 1);
  const call = { pm, sub, names: [], gate: [], main: null, extra: [], dir: null, workspace: false, mover: false, dynamic: false, dirDynamic: false, unresolved: null, bin: null, execText: null, explore: null, startDefault: false, installGroup: false };
  const finish = () => {
    call.dir = st.dir; call.workspace ||= st.workspace; call.mover ||= st.mover;
    call.dirDynamic = call.dir !== null && RUN_TIME.test(call.dir);
    call.dynamic = call.names.some((n) => RUN_TIME.test(n)) || (call.main !== null && RUN_TIME.test(call.main)) || RUN_TIME.test(sub);
    if (st.unknown.length && !call.unresolved) call.unresolved = `the option \`${st.unknown[0]}\` is not known to the guard and may take the next word as its value, so which subcommand or script \`${words.slice(0, 5).join(' ')}\` runs cannot be verified. Write the option as --name=value, or put it after the script name.`;
    // --ignore-scripts: the install, pack, publish and version families run nothing; `run`, `test`, `start` ... still run their own script, without its pre / post hooks
    if (st.ignore) {
      if (call.main === null && !call.execText) return null;
      const own = (n) => !/^(?:pre|post)/.test(n) || n === call.main;
      call.names = call.names.filter(own);
      call.gate = call.gate.filter(own);
    }
    return call;
  };
  const setNames = (list) => { call.names = [...new Set(list)]; call.gate = call.names; };
  // the words after a script name: npm keeps the options written before `--` for itself and hands the script the other words; the rest forward everything
  const scriptArgs = (after) => {
    if (pm !== 'npm') { call.extra = after.filter((w) => w !== '--'); return; }
    const out = [];
    let k = 0;
    for (; k < after.length && after[k] !== '--'; k++) {
      const w = after[k];
      if (!w.startsWith('-')) { out.push(w); continue; }
      const kind = optKind(w, pm);
      const eq = w.startsWith('--') ? w.indexOf('=') : -1;
      const key = eq > 0 ? w.slice(0, eq) : w;
      if (DIR_OPTS.has(key)) st.dir = eq > 0 ? w.slice(eq + 1) : after[k + 1] ?? '';
      if (cliMover(key, optKind(key, pm) !== 'unknown')) st.mover = key;
      if (WORKSPACE_OPT.test(key)) st.workspace = true;
      if (key === '--ignore-scripts') st.ignore = ignoreFrom(eq, w, after[k + 1]);
      if (key === '--no-ignore-scripts') st.ignore = false;
      if (kind === 'value' && eq < 0) k++;
      else if (kind === 'unknown' && eq < 0 && after[k + 1] !== undefined && !after[k + 1].startsWith('-') && !call.unresolved) call.unresolved = `the option \`${w}\` is not known to the guard and may take the next word (\`${after[k + 1]}\`) as its value, so what \`${words.slice(0, 5).join(' ')}\` hands the script cannot be verified. Write it as --name=value.`;
    }
    call.extra = [...out, ...after.slice(k + 1)];
  };
  // the options after a subcommand that is not a script call: --ignore-scripts, a directory or a workspace option still matter
  const scanRest = () => { // (an option it does not know is of no consequence here: the subcommand is already fixed)
    const keep = st.unknown;
    st.unknown = [];
    for (let k = 0; k < rest.length && rest[k] !== '--';) k = rest[k].startsWith('-') ? scanOpts(rest, k, pm, st) : k + 1;
    st.unknown = keep;
  };
  const aliases = PM_RUN_ALIASES[pm];
  if (sub === '') {
    if (pm === 'yarn') { setNames(INSTALL); call.installGroup = true; return finish(); } // (`yarn` alone installs)
    return null;
  }
  if (aliases.includes(sub) || (pm !== 'npm' && !NO_SCRIPT[pm].has(sub) && !PM_COMMANDS.has(sub) && !LIFECYCLE_PMS[pm].has(sub))) {
    // run NAME / bare NAME (yarn, pnpm, bun)
    let r = aliases.includes(sub) ? rest : [words[i], ...rest];
    const group = aliases.includes(sub) ? null : GROUPS.other.find(([re]) => re.test(sub)); // (`pnpm deploy`, `pnpm patch`: a manager command that is also a possible script name)
    const j = scanOpts(r, 0, pm, st);
    r = r.slice(j);
    if (r[0] === '--') r = r.slice(1);
    // yarn: `yarn workspace NAME [run] script ARGS` / `yarn workspaces [foreach OPTS] run script ARGS` -- the script gets ARGS (R1-B5). A form this does not read: every word after may be the script
    if (!aliases.includes(sub) && /^workspaces?$/.test(sub)) {
      st.workspace = true;
      let w = rest.slice(scanOpts(rest, 0, pm, st));
      let known = false;
      if (sub === 'workspace') { w = w.slice(1); known = true; } // (NAME)
      else if (w[0] === 'foreach') w = w.slice(scanOpts(w, 1, pm, st));
      w = w.slice(scanOpts(w, 0, pm, st));
      if (w[0] === 'run') { w = w.slice(1); w = w.slice(scanOpts(w, 0, pm, st)); known = true; }
      if (w[0] === '--') w = w.slice(1);
      if (known && w.length) {
        call.main = w[0];
        setNames(hooks(w[0]));
        call.gate = [w[0]];
        scriptArgs(w.slice(1));
        return finish();
      }
      const cand = rest.filter((x) => !x.startsWith('-'));
      if (!cand.length) return null;
      setNames(cand.flatMap(hooks));
      call.gate = cand;
      return finish();
    }
    if (!r.length) return null; // `npm run` lists the scripts
    call.main = r[0];
    call.gate = [r[0]];
    setNames(hooks(r[0]));
    call.gate = [r[0]];
    if (!aliases.includes(sub) || pm !== 'npm') call.bin = r[0]; // (yarn / bun `run NAME` and a bare name fall back to node_modules/.bin; npm and pnpm `run` do not)
    if (group) { setNames([...call.names, ...group[1]]); call.gate = [r[0], ...group[1]]; call.installGroup = group[1] === INSTALL; }
    scriptArgs(r.slice(1));
    // (`pnpm --foo bar run x`: an option the parser reads as boolean may have hidden the real subcommand)
    if (!aliases.includes(sub) && r.slice(1).some((w) => aliases.includes(w)) && !call.unresolved) call.unresolved = `\`${words.slice(0, 5).join(' ')}\` names the script \`${r[0]}\` and also the word \`run\`, so which of them the manager runs cannot be verified. Write the options as --name=value.`;
    return finish();
  }
  if (NO_SCRIPT[pm].has(sub)) {
    if (sub === 'audit' && rest.includes('fix')) { scanRest(); setNames(INSTALL); call.installGroup = true; return finish(); }
    return st.unknown.length ? finish() : null; // (an unknown option before the subcommand may have taken it as its value)
  }
  if (LIFECYCLE_PMS[pm].has(sub)) {
    const chain = LIFECYCLE[sub];
    call.main = sub === 't' || sub === 'tst' ? 'test' : sub;
    setNames(chain);
    call.startDefault = chain === START || chain === RESTART;
    scriptArgs(rest);
    return finish();
  }
  const groups = pm === 'npm' ? GROUPS.npm : GROUPS.other;
  const g = groups.find(([re]) => re.test(sub));
  if (g) { scanRest(); setNames(g[1]); call.installGroup = g[1] === INSTALL || g[1].includes('install'); return finish(); }
  // `npm explore PKG -- CMD...`: CMD (the words joined by single spaces, as npm does) runs through the script shell in node_modules/PKG of the project. No command: an interactive shell, nothing to judge.
  const exploring = pm === 'npm' && EXPLORE_SUB.test(sub);
  if (exploring) {
    let pkg = null;
    const cmd = [];
    let loose = null;
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k];
      if (w === '--') { for (const x of rest.slice(k + 1)) { if (pkg === null) pkg = x; else cmd.push(x); } break; }
      if (w.startsWith('-')) {
        const kind = optKind(w, pm);
        if (kind === 'value' && !w.includes('=')) k++;
        else if (kind === 'unknown' && !loose) loose = w; // (an option the tables do not know may take the next word as its value, which shifts which word is the package)
        continue;
      }
      if (pkg === null) pkg = w; else cmd.push(w);
    }
    call.explore = pkg;
    call.execText = cmd.join(' ').trim() ? cmd.join(' ') : null;
    if (call.execText) {
      const said = words.slice(0, 5).join(' ');
      if (pkg === null || !EXPLORE_PKG.test(pkg) || pkg.split('/').some((x) => /^\.+$/.test(x))) call.unresolved = `the package directory \`${pkg}\` that \`${said}\` runs its command in is not a plain package name (a variable, a glob, \`..\` or a path), so which directory and which program it runs cannot be verified. Name the package.`;
      else if (loose) call.unresolved = `the option \`${loose}\` is not known to the guard and may take the next word as its value, so which word of \`${said}\` is the package and which is the command cannot be verified. Write it as --name=value.`;
    }
  }
  // exec forms the parser did not unwrap (options between `pnpm` and `exec`): the command is judged as a line of its own
  if (EXEC_SUBS.has(sub)) {
    let k = 0;
    let text = null;
    for (; k < rest.length; k++) {
      const w = rest[k];
      if (w === '-c' || w === '--call') { text = rest[k + 1] ?? ''; break; }
      if (w.startsWith('--call=')) { text = w.slice(7); break; }
      if (w === '--') { k++; break; }
      if (!w.startsWith('-')) break;
      if (optKind(w, pm) === 'value' || w === '-p' || w === '--package') k++;
    }
    call.execText = text ?? rest.slice(k).map(shellQuote).join(' ');
    if (!call.execText.trim()) call.execText = null;
  }
  // any other subcommand: unknown to the guard, so every lifecycle script and every word as a script name may run
  scanRest();
  if (exploring && call.execText && st.global && !call.unresolved) call.unresolved = `\`${words.slice(0, 5).join(' ')}\` runs its command in the global node_modules, whose place (the global prefix) the guard cannot verify. Run it by hand outside the guard's reach.`;
  setNames([...UNION, ...(exploring ? [] : rest.filter((w) => !w.startsWith('-')).flatMap(hooks))]); // (explore runs no script: the words after it are not script names)
  call.installGroup = true;
  return finish();
}

// Names the line gives to the environment that could point the manager somewhere else (allowlist of FAMILIES, not of dangerous names): anything the package managers read as
// configuration or that names the project a script call starts from.
// (not NODE_OPTIONS, t11: it cannot move package.json or a configuration file, and the program it preloads is one the guards never judge anyway)
const MOVER_NAME = /^(?:npm_|yarn_|pnpm_|bun_|berry_|corepack_|init_cwd$)/i;
export const pmMoverName = (names) => { for (const n of names) if (MOVER_NAME.test(n)) return n; return null; };

// A name exported that is only known at run time (`export $N=x`) can be any of the variables above.
export const NAME_AT_RUN_TIME = /(?:^|[;&|(\s])(?:export|declare|typeset|local|readonly)\s(?:[^;&|\n]*\s)?[^\s=;&|]*[$`][^\s=;&|]*(?=[\s=;&|]|$)/;

// #81 t11: is a variable NAME given at run time to a binder (`export $N=x`) by a command of the line? Only parsed commands count: the text of a `node -e '...'` program or a quoted heredoc body
// (`export async function f(` in a JavaScript string, a template literal's backtick) is data. The text a shell is asked to run (eval, bash -c ...) is read as written.
const NAME_BINDERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
const SHELLS_AND_EVAL = new Set(['eval', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'source', '.']);
export function nameAtRunTimeIn(text) {
  const cmds = simpleCommands(String(text ?? ''));
  if (!cmds || cmds.truncated) return NAME_AT_RUN_TIME.test(String(text ?? '')); // (the parser gave up: read the raw text)
  for (const c of cmds) {
    if (!c.argv?.length) continue;
    if (NAME_BINDERS.has(baseName(c.argv[0])) && NAME_AT_RUN_TIME.test(c.argv.join(' '))) return true;
    if (SHELLS_AND_EVAL.has(baseName(c.argv[0])) && c.argv.slice(1).some((w) => NAME_AT_RUN_TIME.test(w))) return true;
  }
  return false;
}

// What an earlier command of the line does to the files a package manager reads (package.json, the configuration files, node_modules, server.js ...).
// #89 t2: the rule is the one both guards apply to a plain script file (`bash run.sh`): the file is judged as it is, and refused when the line WRITES it ('known': writtenTo places the write, or the command
// names the path) or MAY write it ('maybe': a target only known at run time) while the line mentions a guarded operation. A git command that changes the work tree (checkout, pull, worktree add ...), a bulk
// writer (tar, rsync, patch ...) and a background job are no reason of their own: `git checkout other && bash run.sh` is allowed, so is `git checkout other && npm test`.
// What a script file has no counterpart for stays here:
//   - the manager's own writes (npm pkg set, npm set-script, npm config set, npm init ...): known changes of package.json and the configuration, refused whatever the line says;
//   - a command that creates, removes or renames a marker file (rm -rf node_modules, mv package.json x, touch server.js): a path the command names is known, one only known at run time (`cp $F x.bak`) is maybe;
//   - an install, which adds and replaces node_modules/.bin (pkgBinsDirty).
// A writer of a NAMED file (redirect, cp, mv, sed -i, tee ...) is not here: writtenTo models those and the callers ask it for each file read.
const PM_CHANGE_WORDS = new Set(['pkg', 'set-script', 'init', 'create', 'edit', 'link', 'ln']);
const CONFIG_WRITE_WORDS = new Set(['set', 'delete', 'edit', 'rm', 'remove', 'unset']);
function managerWrites(argv) {
  const words = baseName(argv[0] ?? '') === 'corepack' ? argv.slice(1) : argv;
  const name = baseName(words[0] ?? '');
  if (!Object.hasOwn(PM_RUN_ALIASES, name)) return false;
  const head = words.slice(1, 8);
  return head.some((w) => PM_CHANGE_WORDS.has(w)) || (head.some((w) => w === 'config' || w === 'c') && head.some((w) => CONFIG_WRITE_WORDS.has(w))) || (name === 'yarn' && head[0] === 'set');
}

// Where a word names, from each directory the command may run in: string[] (a glob stays in the text when allowGlob), or null (only known at run time).
const UNKNOWN_HEAD = '\u0000?/';
function placeWord(site, dirs, w, allowGlob) {
  const p = site.p ?? nodePath;
  let t = site.expand ? site.expand(String(w ?? '')) : String(w ?? '');
  if (allowGlob && /[$`]/.test(t) && !t.endsWith('/')) {
    // `$TMPDIR/rac.bak`, `$S/out`: the directory is unknown, the name after it is not. Kept as UNKNOWN_HEAD + the literal components after the last unknown one.
    const parts = t.split('/');
    let last = -1;
    parts.forEach((x, i) => { if (/[$`]/.test(x)) last = i; });
    if (last >= 0 && last < parts.length - 1 && parts.slice(last + 1).every((x) => x && !/[$`]/.test(x))) return [UNKNOWN_HEAD + parts.slice(last + 1).join('/')];
  }
  if (/[$`]/.test(t) || (!allowGlob && /[*?[\]]/.test(t)) || t === '-') return null;
  if (t === '~' || t.startsWith('~/')) { if (!site.home) return null; t = p.join(site.home, t.slice(1)); } else if (t.startsWith('~')) return null;
  if (p.isAbsolute(t)) return [p.resolve(t)];
  return dirs ? dirs.map((d) => p.resolve(d, t)) : null;
}

// #81 t11: the files the manager's decisions rest on, which a command of the line may create, remove or rename before it runs (ONE helper for both guards): a node_modules directory stops the search for a
// package.json, a package.json in a directory on the way up is the project, server.js is `npm start`'s fallback, binding.gyp turns an install into node-gyp, the rc files and pnpm-workspace.yaml set what
// the scripts run with. markerPaths names what a command touches; pkgDirtyFor asks whether it is one of those files in the package's directory or above it.
export const PACKAGE_MARKERS = new Set(['node_modules', 'package.json', 'server.js', 'binding.gyp', '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.bunfig.toml', 'pnpm-workspace.yaml']);
const FS_CHANGERS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'unlink', 'mv', 'cp', 'ln', 'install', 'truncate', 'dd', 'mkfifo', 'shred', 'rename', 'ditto']);
// (options that take the next word, by command: `ln -s` and `cp -r` are flags, `install -d` creates directories, `touch -r REF` and `truncate -s SIZE` take a value)
const FS_VALUE_OPTS = { cp: ['-S', '--suffix'], mv: ['-S', '--suffix'], ln: ['-S', '--suffix'], install: ['-S', '--suffix', '-m', '--mode', '-o', '-g'], mkdir: ['-m', '--mode'], mkfifo: ['-m', '--mode'], touch: ['-d', '--date', '-r', '--reference', '-t'], truncate: ['-s', '--size', '-r', '--reference'], dd: [] };
// string[] of the paths (a glob stays in the text; UNKNOWN_HEAD + the literal tail when only the directory is unknown), with a `null` for each one only known at run time; undefined when the command is none of these.
// The array's `gone` is the set of those the command removes or moves away (rm, rmdir, unlink, the source of mv): a node_modules folder only matters when it goes (one that appears hides the package.json above it, which was judged anyway).
function markerPaths(words, site) {
  const name = baseName(words[0] ?? '');
  if (!FS_CHANGERS.has(name)) return undefined;
  const p = site.p ?? nodePath;
  const dirs = site.dirs ?? null;
  const pos = [];
  let target = null;
  const out = [];
  const gone = new Set();
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { pos.push(...words.slice(i + 1)); break; }
    if (name === 'dd') { if (w.startsWith('of=')) pos.push(w.slice(3)); continue; }
    if (w === '-t' || w === '--target-directory') { target = words[++i] ?? ''; continue; }
    if (w.startsWith('--target-directory=')) { target = w.slice(19); continue; }
    if (/^-t./.test(w) && !w.startsWith('--') && !(name === 'touch' || name === 'rm')) { target = w.slice(2); continue; }
    if (FS_VALUE_OPTS[name]?.includes(w)) { i++; continue; }
    if (w.startsWith('-') && w !== '-') continue;
    pos.push(w);
  }
  const place = (w) => placeWord(site, dirs, w, true);
  const base = (w) => String(w).replace(/\/+$/, '').split('/').pop();
  const add = (list) => { if (list === null) { out.push(null); return; } out.push(...list); };
  const joinTo = (dest, src) => { const d = place(dest); const b = base(site.expand ? site.expand(src) : src); return d === null || /[$`]/.test(b) ? null : d.map((x) => (x.startsWith(UNKNOWN_HEAD) ? x : p.join(x, b))); };
  if (['cp', 'mv', 'ln', 'install', 'ditto', 'rename'].includes(name)) {
    const dest = target ?? pos[pos.length - 1];
    const srcs = target !== null ? pos : pos.slice(0, -1);
    if (dest === undefined) return [null];
    // (a destination written as a directory -- `.`, `..`, `dir/` -- is not created or replaced itself: what lands in it is joinTo's)
    if (!/(?:^|\/)\.{0,2}\/?$/.test(dest)) add(place(dest));
    for (const src of srcs) add(joinTo(dest, src));
    if (name === 'mv' || name === 'rename') for (const src of srcs) { const l = place(src); add(l); for (const x of l ?? []) gone.add(x); } // (the source is gone)
  } else for (const w of pos) { const l = place(w); add(l); if (['rm', 'rmdir', 'unlink', 'shred'].includes(name)) for (const x of l ?? []) gone.add(x); }
  out.gone = gone;
  return out;
}
// which of the marker files does the glob-or-literal path component `first` name?
function componentIsMarker(first) {
  if (PACKAGE_MARKERS.has(first)) return [first];
  if (!/[*?[]/.test(first)) return [];
  let rx;
  try { rx = new RegExp('^' + first.replace(/[.+^$(){}|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); } catch { return [...PACKAGE_MARKERS]; }
  return [...PACKAGE_MARKERS].filter((m) => rx.test(m));
}

// Remembers on the evaluation's shared budget what the commands in `argvs` (in the order they run) did to those files. site: { dirs: string[] | null (where the command runs; null: unknown), expand(word) -> text, home, p (path module) }.
export function markPackageState(budget, argvs, site = {}) {
  for (const a of argvs) {
    if (!a.length) continue;
    if (managerWrites(a)) budget.pkgDirty = true;
    const mp = markerPaths(a, site);
    if (mp !== undefined) {
      const maybe = mp.filter((x) => x === null || x.startsWith(UNKNOWN_HEAD));
      const known = mp.filter((x) => x !== null && !x.startsWith(UNKNOWN_HEAD));
      if (known.length) (budget.pkgMarkers ??= []).push({ paths: known, gone: mp.gone });
      if (maybe.length) (budget.pkgMarkersMaybe ??= []).push(maybe);
      if (mp.some((x) => x === null || x.split('/').includes('node_modules'))) budget.pkgBinsDirty = true; // (a bin may come or go)
    }
    if (pmCall(a)?.installGroup) budget.pkgBinsDirty = true; // (an install adds and replaces node_modules/.bin)
  }
}
// The directories a package-manager call starts from (where its package.json is looked for): the directories it runs in, moved by --prefix / --dir. null: not known.
export function pmStartDirs(call, cwds, home, p = nodePath) {
  if (!Array.isArray(cwds) || cwds.some((c) => typeof c !== 'string')) return null;
  if (call.dirDynamic) return null;
  if (call.dir === null || call.dir === undefined) return cwds;
  const d = call.dir === '~' || call.dir.startsWith('~/') ? p.join(home ?? '', call.dir.slice(1)) : call.dir;
  return cwds.map((c) => p.resolve(c, d));
}
// Did an earlier command of the line run the manager's own write (npm pkg set, npm config set, npm init ...)? It changes package.json or the configuration for every manager call after it.
export const pkgOwnWrite = (budget) => budget.pkgDirty === true;
// Did an earlier command of the line (markPackageState) create, remove or rename a marker file in the package directory of a manager started in one of `starts`, or above it?
// 'known': a path the command names (a glob that matches a marker too); 'maybe': one only known at run time (`cp $F x.bak`, `rm -rf $D/node_modules`): the callers refuse it only when the line mentions a guarded operation.
// env: { pathExists, real(abs) -> abs, p (path module) }
export function pkgMarkersFor(budget, starts, env = {}) {
  const known = budget.pkgMarkers ?? [];
  const maybe = budget.pkgMarkersMaybe ?? [];
  if (!known.length && !maybe.length) return null;
  if (starts === null || starts === undefined) return known.length ? 'known' : 'maybe';
  const p = env.p ?? nodePath;
  const forms = (x) => { const r = env.real ? env.real(x) : x; return r && r !== x ? [x, r] : [x]; };
  const exists = (x) => env.pathExists?.(x) === true;
  for (const { paths, gone } of known) {
    for (const o of paths) {
      for (const s of starts) {
        for (const so of forms(s)) {
          for (let a = so, n = 0; n < MAX_WALK; n++) {
            for (const oo of forms(o)) {
              if (oo === a) return 'known';
              if (oo.startsWith(a === '/' ? '/' : `${a}/`)) {
                const rest = oo.slice(a === '/' ? 1 : a.length + 1);
                const first = rest.split('/')[0];
                const hits = componentIsMarker(first);
                // (a node_modules directory only matters when it goes, and where there is no package.json next to it to be found first: it stops the search there)
                if (hits.some((m) => (m === 'node_modules' ? gone.has(o) && rest === first && !exists(p.join(a, 'package.json')) : true))) return 'known';
              }
            }
            const up = p.dirname(a);
            if (up === a) break;
            a = up;
          }
        }
      }
    }
  }
  for (const paths of maybe) {
    for (const o of paths) {
      if (o === null) return 'maybe';
      // somewhere under a directory only known at run time: a marker (or glob) among the literal components, or a name that is one of the package directory's own ancestors, may be it
      const comps = o.slice(UNKNOWN_HEAD.length).split('/');
      const names = new Set(starts.flatMap((x) => forms(x)).flatMap((x) => x.split('/')).filter(Boolean));
      if (comps.some((c) => componentIsMarker(c).length || names.has(c))) return 'maybe';
    }
  }
  return null;
}

export const shellQuote = (w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`);

const MAX_WORKSPACE_PACKAGES = 256;
const MAX_WALK = 64;
const defaultLexists = (f) => { try { lstatSync(f); return true; } catch { return false; } }; // (a symlink loop or a dangling link exists although existsSync says no)
// Configuration files that change what runs a script (script-shell, node-options, workspaces ... ): a key on this list in a file next to the package or in the home directory makes the scripts unknown.
// (not `prefix`: npm takes the project from the command line's --prefix alone -- @npmcli/config loadLocalPrefix reads the 'cli' source -- so a `prefix=` in a .npmrc, which people set to move their GLOBAL packages, moves nothing here)
const GLOBAL_RCS = ['/etc/npmrc', '/usr/local/etc/npmrc', '/opt/homebrew/etc/npmrc'];
// (the `prefix` key is no mover of the PROJECT -- see above -- but it is where npm looks for the GLOBAL configuration, <prefix>/etc/npmrc, and the one it ships with, <prefix>/lib/node_modules/npm/npmrc)

// Where the scripts are and what they hold, for one evaluation. env: { cwd (null: unknown), home, readText, pathExists, readDir, cache (a Map kept for the whole evaluation),
// written(abs) -> 'known' | 'maybe' | null (does the line write that file before the command?), mentionsGuarded() -> boolean, p (path module), tick() }.
// Returns { refuse: string } | { runs: [{ name, label, text, dir, file }] } | { none: true } (nothing runs: no package.json, no such script). Every give-up is a refusal.
export function packageScripts(call, env) {
  const p = env.p ?? nodePath;
  env.tick?.();
  const cache = env.cache ?? new Map();
  const lexists = env.lexists ?? defaultLexists;
  const exists = (f) => env.pathExists(f) || lexists(f);
  const refuse = (msg) => ({ refuse: `package script: ${msg}` });
  // (`npm explore PKG -- CMD` runs in node_modules/PKG of the project: set once the project is known, below)
  let direct = [];
  const end = (r) => (r.none && direct.length ? { runs: direct } : r.runs && direct.length ? { runs: [...direct, ...r.runs] } : r);
  if (env.cwd === null || env.cwd === undefined) return refuse('cannot tell which directory the package manager runs in, so which package.json it uses cannot be verified. Use an absolute --prefix, or chain the cd with &&.');
  let start = env.cwd;
  if (call.dir !== null) {
    const d = call.dir === '~' || call.dir.startsWith('~/') ? p.join(env.home ?? '', call.dir.slice(1)) : call.dir;
    start = p.resolve(env.cwd, d);
  }
  // (R1-B6: the command runs in the working directory; node_modules/.bin is looked up from the --prefix directory AND, as it is not certain which of them npm puts on the PATH, from the working directory: binDir)
  if (call.execText) {
    const label = `${call.pm} ${call.explore !== null ? 'explore' : 'exec'} command`;
    direct = [{ name: null, label, text: call.execText, dir: env.cwd, file: env.cwd, binDir: start }];
    if (start !== env.cwd) direct.push({ name: null, label: `${label} (bins of the working directory)`, text: call.execText, dir: env.cwd, file: env.cwd, binDir: env.cwd });
  }
  const read = (pj) => {
    if (cache.has(pj)) return cache.get(pj);
    env.tick?.();
    const text = env.readText(pj);
    let rec;
    if (typeof text !== 'string') rec = exists(pj) ? { unreadable: true } : { missing: true };
    else {
      try {
        const j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // (duplicate keys: the last wins, as in npm)
        rec = { scripts: j && typeof j === 'object' && j.scripts && typeof j.scripts === 'object' && !Array.isArray(j.scripts) ? j.scripts : null, workspaces: Array.isArray(j?.workspaces) ? j.workspaces : Array.isArray(j?.workspaces?.packages) ? j.workspaces.packages : null };
      } catch { rec = { invalid: true }; }
    }
    cache.set(pj, rec);
    return rec;
  };
  const unreadable = (pj) => refuse(`cannot read ${pj} (missing permission, a directory or larger than 1 MB), so the scripts it holds cannot be verified.`);
  const invalid = (pj) => refuse(`${pj} is not valid JSON that the guard can read (the manager may read it more tolerantly), so the scripts it holds cannot be verified.`);
  const writtenMsg = (pj) => refuse(`this line writes ${pj} before the package manager reads it, so what its scripts run cannot be verified. Write the file in a command of its own.`);
  // each directory from `start` up: the nearest package.json is the project. npm also stops at a directory that has a node_modules folder (and then finds no package.json: nothing runs).
  const upward = (from) => {
    const nm = call.pm === 'npm';
    const key = `up\u0000${nm}\u0000${from}`;
    if (cache.has(key)) return cache.get(key);
    const walked = [];
    let found = null;
    let atRoot = false;
    let root = from;
    let d = from;
    for (let i = 0; i < MAX_WALK; i++) {
      const pj = p.join(d, 'package.json');
      walked.push(pj);
      env.tick?.();
      // (a package.json the line only MAY write is not the project yet: the one above it is what runs if the write does not happen, and is judged -- the maybe itself is refused below when the line mentions a guarded operation)
      if (exists(pj) || env.written?.(pj) === 'known') { found = { dir: d, file: pj }; break; }
      if (nm && env.pathExists(p.join(d, 'node_modules'))) { atRoot = true; root = d; break; }
      const up = p.dirname(d);
      if (up === d) { atRoot = true; break; }
      d = up;
    }
    const r = { found, walked, complete: found !== null || atRoot, root };
    cache.set(key, r);
    return r;
  };
  const up = upward(start);
  if (call.explore !== null && call.execText) { // (the walk's dir when no package.json: npm's local prefix is then the directory it stopped at, or the working directory)
    const pd = p.join(up.found?.dir ?? up.root, 'node_modules', call.explore);
    direct = [{ name: null, label: `npm explore command (in ${p.relative(env.cwd, pd) || pd})`, text: call.execText, dir: pd, file: pd, pkgDir: pd }];
  }
  for (const pj of up.walked) {
    const w = env.written?.(pj);
    if (w === 'known' || (w === 'maybe' && env.mentionsGuarded?.())) return writtenMsg(pj);
  }
  // (a directory below the project that the line may turn into one -- it writes its package.json, or may -- has its own configuration files: what the line writes to them counts)
  for (const pj of up.walked) {
    const dir = p.dirname(pj);
    if (up.found && dir === up.found.dir) break;
    for (const rc of dirRcFiles(call, dir, p)) {
      const w = env.written?.(rc);
      if (w === 'known' || (w === 'maybe' && env.mentionsGuarded?.())) return refuse(`this line writes ${rc} before the package manager reads it, so what it sets for the scripts cannot be verified. Write it in a command of its own.`);
    }
  }
  if (!up.complete) return refuse(`more than ${MAX_WALK} directories lie above ${start}, so the package.json the manager uses cannot be found.`);
  if (!up.found) return end({ none: true });
  const candidates = [up.found];
  // (R1-B3: every file the workspace search reads -- an ancestor's package.json and pnpm-workspace.yaml, each package's package.json -- is asked what the line writes, as the upward walk's are; a file the line CREATES counts)
  const writtenRefusal = (f) => { const w = env.written?.(f); return w === 'known' || (w === 'maybe' && env.mentionsGuarded?.()) ? writtenMsg(f) : null; };
  if (call.workspace) {
    // every ancestor that names workspaces (the project itself may be one of its packages), then their packages
    const roots = [];
    let d = up.found.dir;
    let reached = false;
    for (let i = 0; i < MAX_WALK; i++) {
      const pj = p.join(d, 'package.json');
      const wr = writtenRefusal(pj) ?? writtenRefusal(p.join(d, 'pnpm-workspace.yaml'));
      if (wr) return wr;
      const rec = exists(pj) ? read(pj) : null;
      if (rec?.unreadable) return unreadable(pj);
      if (rec?.invalid) return invalid(pj);
      if (rec?.workspaces || env.pathExists(p.join(d, 'pnpm-workspace.yaml'))) roots.push(d);
      const parent = p.dirname(d);
      if (parent === d) { reached = true; break; }
      d = parent;
    }
    if (!reached) return refuse('the directory tree is too deep to look for the workspace root.');
    for (const root of roots) {
      const patterns = [];
      const rec = read(p.join(root, 'package.json'));
      if (rec.workspaces) patterns.push(...rec.workspaces);
      const yml = p.join(root, 'pnpm-workspace.yaml');
      if (env.pathExists(yml)) {
        const text = env.readText(yml);
        if (typeof text !== 'string') return unreadable(yml);
        const m = /^packages:[ \t]*\r?\n((?:[ \t]*(?:-[^\n]*)?(?:#[^\n]*)?\r?\n?)*)/m.exec(text);
        const before = patterns.length;
        for (const line of m?.[1].split('\n') ?? []) { const q = /^\s*-\s*['"]?([^'"#\s]+)/.exec(line); if (q) patterns.push(q[1]); }
        if (patterns.length === before) return refuse(`the workspace patterns in ${yml} cannot be read, so the packages a workspace option reaches cannot be listed.`);
      }
      if (!candidates.some((c) => c.dir === root) && env.pathExists(p.join(root, 'package.json'))) candidates.push({ dir: root, file: p.join(root, 'package.json') });
      for (const raw of patterns) {
        if (typeof raw !== 'string') return refuse(`a workspace pattern in ${root} is not text, so the packages it names cannot be listed. Run the script from the package's own directory.`);
        if (raw.startsWith('!')) continue;
        const pat = raw.replace(/^\.\//, '').replace(/\/+$/, '');
        // (t11: only a literal path or a single trailing /* is read, inside the tree: an absolute path, a .. segment, a backslash or an empty pattern leaves the workspace set unknown)
        if (pat === '' || pat.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)|\\|^~/.test(pat)) return refuse(`the workspace pattern \`${raw}\` in ${root} leaves the project directory or is not a plain path, so which packages a workspace option reaches cannot be verified. Run the script from the package's own directory.`);
        let dirs;
        let wildParent = null;
        if (!/[*?[\]{}()!]/.test(pat)) dirs = [p.join(root, pat)];
        else if (/^[^*?[\]{}()!]+\/\*$/.test(pat) || pat === '*') {
          const parent = p.join(root, pat === '*' ? '' : pat.slice(0, -2));
          const names = env.readDir(parent);
          if (names !== null && !Array.isArray(names)) return refuse(`${parent} cannot be listed, so the workspace packages in it cannot be read.`);
          dirs = Array.isArray(names) ? names.map((n) => p.join(parent, n)) : [];
          wildParent = parent;
        } else return refuse(`the workspace pattern \`${raw}\` in ${root} cannot be listed (only directories and \`dir/*\`), so which packages a workspace option reaches cannot be verified. Run the script from the package's own directory.`);
        // (R2-B2: a `dir/*` also matches a directory the line CREATES, which the listing does not hold yet: the package.json it writes at PARENT/NAME for any NAME the line spells out, or for a name only
        // known at run time (a probe name no word can be), counts as the ones in the listed directories do -- the written known / maybe rule. A bulk writer into PARENT matches the probe name too)
        if (wildParent !== null) {
          const listed = new Set(dirs);
          const spelled = [...new Set(env.lineNames?.() ?? [])].filter((n) => !listed.has(p.join(wildParent, n)));
          if (spelled.length > MAX_LINE_NAMES) {
            if (env.mentionsGuarded?.()) return refuse(`the line names more than ${MAX_LINE_NAMES} different words, so which package.json it creates in ${wildParent} (a workspace directory) cannot be verified. Write it in a command of its own.`);
          } else {
            for (const n of [...spelled, '\u0001new']) {
              const wr = writtenRefusal(p.join(wildParent, n, 'package.json'));
              if (wr) return wr;
            }
          }
        }
        for (const dd of dirs) {
          const pj = p.join(dd, 'package.json');
          const wr = writtenRefusal(pj);
          if (wr) return wr;
          if (!env.pathExists(pj) || candidates.some((c) => c.file === pj)) continue;
          if (candidates.length >= MAX_WORKSPACE_PACKAGES) return refuse(`${root} holds more than ${MAX_WORKSPACE_PACKAGES} workspace packages, so the scripts a workspace option reaches cannot all be verified. Run the script from the package's own directory.`);
          candidates.push({ dir: dd, file: pj });
        }
      }
    }
  }
  const runs = [];
  for (const cand of candidates) {
    const rec = read(cand.file);
    if (rec.unreadable) return unreadable(cand.file);
    if (rec.invalid) return invalid(cand.file);
    // configuration that can change the shell, the prefix or the options a script runs with
    for (const rc of rcFiles(call, cand.dir, env, p)) {
      const bad = rcRefusal(rc, env, cache, exists);
      if (bad) return refuse(bad);
    }
    // the global configuration (and the one that comes with npm) sit under the global prefix, which the user's or the project's .npmrc, --prefix or node's own place moves
    const pfx = prefixRcFiles(call, cand.dir, env, p, exists);
    if (pfx.refuse) return refuse(pfx.refuse);
    for (const rc of pfx.files) {
      const bad = rcRefusal(rc, env, cache, exists);
      if (bad) return refuse(bad);
    }
    const scripts = rec.scripts ?? {};
    const present = (n) => Object.hasOwn(scripts, n) && typeof scripts[n] === 'string';
    const add = (n, text) => runs.push({ name: n, label: `${p.relative(env.cwd, cand.file) || 'package.json'} script "${n}"`, text, dir: cand.dir, file: cand.file });
    // the named script must exist: npm stops with "Missing script" before a hook runs. (`npm restart` runs its stop and start scripts when it has no restart script; `yarn workspaces run X`: any word may be it)
    const defaultStart = call.startDefault && !present('start') && env.pathExists(p.join(cand.dir, 'server.js'));
    if (call.installGroup && !present('install') && !present('preinstall') && env.pathExists(p.join(cand.dir, 'binding.gyp'))) return refuse(`${cand.dir} has a binding.gyp and no install script, so the install runs \`node-gyp rebuild\`, which the guard cannot read. Install with --ignore-scripts.`);
    if (!call.gate.some(present) && !defaultStart) continue;
    for (const n of call.names) {
      if (!present(n)) continue;
      add(n, n === call.main && call.extra.length ? `${scripts[n]} ${call.extra.map(shellQuote).join(' ')}` : scripts[n]);
    }
    if (defaultStart) add('start', 'node server.js'); // (npm start without a start script)
  }
  return end(runs.length ? { runs } : { none: true });
}

// The configuration files the manager reads for a package in `dir`.
const dirRcFiles = (call, dir, p) => [p.join(dir, '.npmrc'), ...(call.pm === 'yarn' ? [p.join(dir, '.yarnrc.yml')] : []), ...(call.pm === 'bun' ? [p.join(dir, 'bunfig.toml')] : [])];
function rcFiles(call, dir, env, p) {
  const list = [p.join(dir, '.npmrc')];
  if (env.home) list.push(p.join(env.home, '.npmrc'));
  list.push(...GLOBAL_RCS);
  if (call.pm === 'yarn') { list.push(p.join(dir, '.yarnrc.yml')); if (env.home) list.push(p.join(env.home, '.yarnrc.yml')); }
  if (call.pm === 'bun') { list.push(p.join(dir, 'bunfig.toml')); if (env.home) list.push(p.join(env.home, '.bunfig.toml')); }
  return list;
}
// The global-prefix configuration files. The prefix is read from the user's and the project's .npmrc (npm reads the global config from the prefix the earlier files name -- all of them are tried, a file that is not
// there costs nothing), --prefix and node's own place (env.nodePrefix; the default is where this node binary lives: dirname(dirname(execPath)), on Windows dirname(execPath); null: none).
// A `prefix` the guard cannot work out (a ${VAR} it does not know -- only HOME, and what env.envValue gives --, an unreadable file, an empty value) is a refusal.
function prefixRcFiles(call, dir, env, p, exists) {
  const roots = [];
  const bad = (msg) => ({ files: [], refuse: msg });
  const sources = [p.join(dir, '.npmrc')];
  if (env.home) sources.push(p.join(env.home, '.npmrc'));
  for (const file of sources) {
    if (!exists(file)) continue;
    const text = env.readText(file);
    if (typeof text !== 'string') return bad(`cannot read ${file} (missing permission, a directory or larger than 1 MB), so what it sets for the package manager cannot be verified.`);
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*prefix\s*=(.*)$/i.exec(line);
      if (!m) continue;
      let v = m[1].trim();
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s*[;#].*$/, '');
      v = v.trim();
      // (npm's envReplace: `${NAME}` and `${NAME?}`, NAME free of $ { } ? -- no `-` / `:-` operators, so `${VAR-x}` looks up a variable literally named `VAR-x`. Anything else with `${`, or an escape, is refused)
      if (v.includes('${') || /\\\$/.test(v)) {
        let unknown = /\\\$\{/.test(v);
        if (!unknown) v = v.replace(/\$\{([^${}?]+)\??\}/g, (all, name) => { const val = name === 'HOME' && env.home ? env.home : env.envValue?.(name); if (typeof val !== 'string') unknown = true; return val ?? ''; });
        if (unknown || v.includes('${')) return bad(`${file} sets \`prefix\` with a variable or an escape (${line.trim()}) the guard does not know how npm reads, so where the global npm configuration lies cannot be verified. Write the path out.`);
      }
      if (v === '') return bad(`${file} sets an empty \`prefix\`, so where the global npm configuration lies cannot be verified.`);
      if (v === '~' || v.startsWith('~/')) roots.push(p.join(env.home ?? '', v.slice(1)));
      else if (p.isAbsolute(v)) roots.push(v);
      else return bad(`${file} sets a relative \`prefix\` (${line.trim()}), and the directory npm resolves it against is not something the guard verifies, so where the global npm configuration lies cannot be verified. Write the absolute path.`);
    }
  }
  if (call.dir !== null && call.dir !== undefined) roots.push(p.resolve(env.cwd ?? dir, call.dir === '~' || call.dir.startsWith('~/') ? p.join(env.home ?? '', call.dir.slice(1)) : call.dir));
  const nodePrefix = env.nodePrefix !== undefined ? env.nodePrefix : nodeDefaultPrefix();
  if (nodePrefix) roots.push(nodePrefix);
  const files = [];
  for (const r of new Set(roots)) files.push(p.join(r, 'etc', 'npmrc'), p.join(r, 'lib', 'node_modules', 'npm', 'npmrc'), p.join(r, 'node_modules', 'npm', 'npmrc'));
  return { files, refuse: null };
}
const nodeDefaultPrefix = () => (process.platform === 'win32' ? nodePath.dirname(process.execPath) : nodePath.dirname(nodePath.dirname(process.execPath)));
// (the file's own text is read once per evaluation: the disk does not change while the guard looks. What the LINE writes to it is asked every time: a second manager call comes after
// writes the first one did not see -- `npm test && echo 'script-shell=/x' > .npmrc && npm run lint`)
function rcRefusal(file, env, cache, exists) {
  const w = env.written?.(file);
  if (w === 'known' || (w === 'maybe' && env.mentionsGuarded?.())) return `this line writes ${file} before the package manager reads it, so what it sets for the scripts cannot be verified. Write it in a command of its own.`;
  const key = `rc\u0000${file}`;
  if (cache.has(key)) return cache.get(key);
  let msg = null;
  if (exists(file)) {
    const text = env.readText(file);
    if (typeof text !== 'string') msg = `cannot read ${file} (missing permission, a directory or larger than 1 MB), so what it sets for the package manager cannot be verified.`;
    else {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith(';')) continue;
        const m = file.endsWith('.yml') ? /^(yarnPath|scriptShell)\s*:/.exec(t) : file.endsWith('.toml') ? /^(shell)\s*=/.exec(t) : /^([A-Za-z0-9_@:/.-]+)\s*=/.exec(t);
        const k = m?.[1]?.toLowerCase().replace(/_/g, '-');
        if (k && (file.endsWith('.yml') ? /^(?:yarnpath|scriptshell)$/.test(k) : RC_REFUSED.has(k))) { msg = `${file} sets \`${m[1]}\`, which can change the shell, the directory or the options the scripts run with, so what they run cannot be verified. Remove it, or run the command by hand outside the guard's reach.`; break; }
      }
    }
  }
  cache.set(key, msg);
  return msg;
}

// The shell script a bare command name run through a package runner (npx, npm exec, pnpm exec ...) resolves to: node_modules/.bin/<name> of the nearest directory that has it, or that the line certainly writes.
// A directory where the line only MAY write it (env.written -> 'maybe') does not stop the search -- the bin above it is what runs if the write does not happen -- and is handed to env.onMaybe instead.
export function localBin(name, env) {
  const p = env.p ?? nodePath;
  if (env.cwd === null || env.cwd === undefined || !/^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/.test(name)) return null;
  let d = env.cwd;
  for (let i = 0; i < MAX_WALK; i++) {
    const f = p.join(d, 'node_modules', '.bin', name);
    if (env.pathExists(f)) return f;
    const w = env.written?.(f);
    if (w === 'maybe') env.onMaybe?.(f);
    else if (w) return f;
    const up = p.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// Is a node_modules/.bin file a program (not opened as a shell script) or a shell script (opened)? Decided ONLY by the first bytes, as the system does: the kernel picks the interpreter from
// a `#!` line and nothing else, and a file without one fails execve (ENOEXEC) and is run by `sh` (npm / npx spawn bins through the script shell). So the extension (.js ...) and the
// place a link leads to are never a reason. A shebang whose interpreter (after `env`, `env -S`, `--split-string`, its options) is one the guard knows (node nodejs bun deno tsx ts-node python python2 python3[.N] ruby perl php): a program. Any
// other shebang (a shell, awk, make, pwsh, busybox, a name not listed) or none at all: opened as a shell script. Binary content (ELF or Mach-O magic, a NUL byte in the first 512): a program. An unreadable file is not decided here (the caller opens it).
const PROGRAM_INTERPRETERS = /^(?:node|nodejs|bun|deno|tsx|ts-node|python[23]?(?:\.\d+)*|ruby|perl|php)$/;
// The interpreter that really runs may be a file the project controls (the allowlist names it, the project supplies it): a relative path (`#!./node`, `#!node_modules/x/node`, a bare `#!node`, resolved against the
// working directory), an absolute path inside the project, or -- through `env` -- a name that has an entry in a node_modules/.bin of the lookup chain (the managers put those first on the PATH). Each of these is opened as a
// shell script. `site` (binSite): { inside(abs) -> boolean, hasBin(name) -> boolean }; without it nothing is known about the project and only the shebang's own words count.
export function binIsProgram(text, site = null) {
  if (typeof text !== 'string') return false;
  if (text.startsWith('#!')) {
    const tokens = text.slice(2).split(/\r?\n/, 1)[0].trim().split(/\s+/).filter(Boolean);
    const nm = (w) => nodePath.posix.basename(String(w ?? '').replaceAll('\\', '/'));
    const outside = (w) => /^(?:\/|[A-Za-z]:[\\/])/.test(String(w ?? '')) && !(site?.inside?.(String(w)) ?? false); // (absolute, and not in the project)
    if (!outside(tokens[0])) return false;
    let i = 0;
    let viaEnv = false;
    if (nm(tokens[0]) === 'env') {
      viaEnv = true;
      for (i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (/^-[uC]$|^--(?:unset|chdir)$/.test(t)) i++; // options with a value
        else if (/^--split-string=./.test(t)) { tokens[i] = t.slice(15); break; }
        else if (/^-S./.test(t)) { tokens[i] = t.slice(2); break; } // `-Sbash -e`
        else if (!t.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t)) break;
      }
    }
    const prog = nm(tokens[i]);
    if (prog === '') return false; // `#!` with nothing: execve fails and sh runs it
    if (viaEnv) { // (env runs a name from the PATH, a word with a slash as that path)
      if (/[\\/]/.test(tokens[i])) { if (!outside(tokens[i])) return false; } else if (site?.hasBin?.(prog)) return false;
    }
    return PROGRAM_INTERPRETERS.test(prog); // (an allowlist: awk, make, pwsh, busybox applets and any name not listed are read by a shell or by a language the guard does not model, so the file is opened)
  }
  return text.slice(0, 512).includes('\u0000') || text.startsWith('\u007fELF') || text.startsWith('��');
}

// What binIsProgram needs to know about the project for the bin node_modules/.bin/NAME found at `bin` and run in `runDir`: the project is its package directory and the directory it runs in; the bins that come first on the
// PATH are every node_modules/.bin from either of them upward. exists: file test.
export function binSite(bin, runDir, exists, p = nodePath) {
  const roots = [p.dirname(p.dirname(p.dirname(bin))), runDir].filter((x) => typeof x === 'string');
  return {
    inside: (abs) => roots.some((r) => abs === r || abs.startsWith(r === '/' ? '/' : `${r}/`)),
    hasBin: (name) => findBin(name) !== null,
    findBin,
    resolve: (w) => (runDir ? p.resolve(runDir, w) : null),
  };
  function findBin(name) {
    for (const r of roots) {
      for (let d = r, n = 0; n < MAX_WALK; n++) {
        const f = p.join(d, 'node_modules', '.bin', name);
        if (exists(f)) return f;
        const up = p.dirname(d);
        if (up === d) break;
        d = up;
      }
    }
    return null;
  }
}

// R2-B1: the file that really runs a bin (with the bin as its argument) when its shebang names one the project controls -- the same cases binIsProgram turns away from "program": an absolute path inside the
// project, a relative path (resolved in the directory the bin runs in), or -- through `env` -- a name with an entry in a node_modules/.bin of the lookup chain. null: none (a program, or an interpreter outside
// the project), or one that cannot be placed (an `env` name that is not a bin there: the relative word is not a file the guard can find). The caller judges that file as it judges a bin (opened as a shell script unless
// it is itself a program), the bin's own text as well; a loop or a chain deeper than MAX_BIN_INTERPRETERS is refused.
export const MAX_BIN_INTERPRETERS = 4;
const MAX_LINE_NAMES = 64;
// The names a command line spells out (every word, split at separators and slashes): the directories it may create.
export const lineNames = (text) => String(text ?? '').split(/[\s'"`$()<>|&;=,:{}[\]*?\\/]+/).filter((n) => n && n !== '.' && n !== '..');
export function binInterpreter(text, site = null) {
  if (typeof text !== 'string' || !text.startsWith('#!') || !site) return null;
  const tokens = text.slice(2).split(/\r?\n/, 1)[0].trim().split(/\s+/).filter(Boolean);
  const nm = (w) => nodePath.posix.basename(String(w ?? '').replaceAll('\\', '/'));
  const isAbs = (w) => /^(?:\/|[A-Za-z]:[\\/])/.test(String(w ?? ''));
  const place = (w) => (isAbs(w) ? (site.inside?.(String(w)) ? String(w) : null) : (site.resolve?.(String(w)) ?? null));
  if (!tokens.length) return null;
  if (nm(tokens[0]) !== 'env' || !(isAbs(tokens[0]) && !site.inside?.(tokens[0]))) return place(tokens[0]); // (a project's own file named env is the interpreter itself)
  let i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^-[uC]$|^--(?:unset|chdir)$/.test(t)) i++;
    else if (/^--split-string=./.test(t)) { tokens[i] = t.slice(15); break; }
    else if (/^-S./.test(t)) { tokens[i] = t.slice(2); break; }
    else if (!t.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t)) break;
  }
  const w = tokens[i];
  if (w === undefined || nm(w) === '') return null;
  if (/[\\/]/.test(w)) return place(w);
  return site.findBin?.(nm(w)) ?? null;
}

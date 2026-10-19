// Package managers: how a command line names the script it runs, and which package.json that is.
// Why (#81 t9): `npm run deploy` was ALLOWED when its package.json script held a guarded command (a push to main, a write to a protected file) -- npm / npx sat in the git guard's OPAQUE_TOOLS and
// scriptFileOf has no reading for `npm run`, so neither guard ever opened a package script. The argv reading below (moved here from git-policy.mjs, where #58 built it for the repo's merge
// command) is shared: git-policy.mjs judges the merge command with it as before, and both guards open the scripts with pmCall / packageScripts.
import nodePath from 'node:path';
import { commandName } from './shell-parse.mjs';

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

// What a script call runs. words: the command line's words, variables already expanded as far as the guard can. Returns null when the line runs no package script (`npm install`, `npm run` alone, a
// manager's own command), else { pm, names, main, extra, dir, workspace, mover, dynamic }:
//   names: the scripts the manager runs, in order (`pre<name>`, <name>, `post<name>`; `npm restart` runs its stop and start scripts too); main: the one the user named, which receives `extra`
//   dir: the directory option's value (--prefix / -C / --dir / --cwd), or null; workspace: a workspace selection (-w, --workspaces, --filter, -r, `yarn workspace`) -- the script may be in any workspace package
//   mover: a global option that points the manager at other configuration (--userconfig, --globalconfig); dynamic: a name or directory only known at run time
// Why every spelling: the callers were wrong once for each of them. (npm keeps every option written before `--` for itself, so only the words after it reach the script: pmForwarded.)
const LIFECYCLE = { test: ['test'], t: ['test'], tst: ['test'], start: ['start'], stop: ['stop'], restart: ['restart', 'stop', 'start'] };
const LIFECYCLE_PMS = { npm: new Set(Object.keys(LIFECYCLE)), pnpm: new Set(Object.keys(LIFECYCLE)), yarn: new Set(Object.keys(LIFECYCLE)), bun: new Set(['start', 'stop', 'restart']) }; // (`bun test` is bun's own runner)
const DIR_OPTS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const WORKSPACE_OPT = /^(?:-w|-ws|--workspaces?|--filter|-F|--filter-prod|-r|--recursive|--include-workspace-root|--workspace-root)(?:=.*)?$/;
const MOVER_OPT = /^(?:--userconfig|--globalconfig)(?:=.*)?$/;
const RUN_TIME = /[$`]/;
const hooks = (n) => [`pre${n}`, n, `post${n}`];
export function pmCall(allWords) {
  const words = baseName(allWords[0] ?? '') === 'corepack' ? allWords.slice(1) : allWords; // (`corepack pnpm ship`)
  const p = pmParts(words);
  if (!p || p.kind === 'none') return null;
  const call = { pm: p.pm, names: [], gate: [], main: null, extra: [], dir: null, workspace: false, mover: false, dynamic: false, dirDynamic: false };
  let scriptWords = null; // the words from the script name on
  if (p.kind === 'run' || p.kind === 'bare') {
    scriptWords = p.rest[0] === '--' ? p.rest.slice(1) : p.rest;
    // yarn: `yarn workspace NAME script` / `yarn workspaces run script` -- every word after may be the script
    if (p.kind === 'bare' && /^workspaces?$/i.test(scriptWords[0] ?? '')) {
      call.workspace = true;
      const cand = scriptWords.slice(1).filter((w) => !w.startsWith('-'));
      call.names = [...new Set(cand.flatMap((n) => hooks(n)))];
      call.gate = cand;
      if (!cand.length) return null;
    } else {
      if (!scriptWords.length) return null; // `npm run` lists the scripts
      call.main = scriptWords[0];
      call.gate = [scriptWords[0]];
      call.names = hooks(scriptWords[0]);
      call.extra = pmForwarded([words[0], 'run', ...scriptWords]);
    }
  } else if (p.kind === 'other' && LIFECYCLE_PMS[p.pm]?.has(p.sub)) {
    const chain = LIFECYCLE[p.sub];
    call.main = chain[0];
    call.gate = chain.flatMap(hooks);
    call.names = chain.flatMap(hooks);
    scriptWords = ['', ...p.rest.slice(1)];
    call.extra = pmForwarded([words[0], 'run', chain[0], ...p.rest.slice(1)]);
  } else return null;
  // location options: before the subcommand, between `run` and the script and, for npm (it keeps every option written before `--` for itself), after the script name
  const region = [...p.opts];
  if (p.pm === 'npm' && scriptWords) {
    const stop = scriptWords.indexOf('--');
    region.push(...scriptWords.slice(1, stop < 0 ? undefined : stop));
  }
  for (let i = 0; i < region.length; i++) {
    const w = region[i];
    const eq = w.indexOf('=');
    const key = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w;
    if (DIR_OPTS.has(key)) { call.dir = eq > 0 && w.startsWith('--') ? w.slice(eq + 1) : region[++i] ?? ''; continue; }
    if (MOVER_OPT.test(w)) call.mover = true;
    if (WORKSPACE_OPT.test(w)) call.workspace = true;
    if (PM_VALUE_OPTS.has(w) && eq < 0) i++;
  }
  call.dirDynamic = call.dir !== null && RUN_TIME.test(call.dir);
  call.dynamic = call.names.some((n) => RUN_TIME.test(n)) || (call.main !== null && RUN_TIME.test(call.main));
  return call;
}

// A setting the line gives that points the manager at another package.json, another prefix or another configuration (npm_config_prefix=/x, INIT_CWD, PNPM_*, YARN_CWD ...): the script that runs is
// then not the one the current directory shows. (#58 reads any npm_config_* the same way for the merge command; the harmless ones -- npm_config_loglevel, npm_config_yes -- stay allowed here.)
const MOVER_NAME = /^(?:npm_config_(?:prefix|local_prefix|global_prefix|userconfig|globalconfig|workspaces?|workspaces_update|include_workspace_root|script_shell|dir|cwd|location|global|package|call|shell|node_options)|init_cwd|npm_package_json|npm_execpath|npm_node_execpath|(?:yarn|pnpm|bun|berry)_.*)$/i;
export const pmMoverName = (names) => { for (const n of names) if (MOVER_NAME.test(n)) return n; return null; };

export const shellQuote = (w) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`);

// The packages a root names under `workspaces` (npm, yarn) or pnpm-workspace.yaml: literal directories and one-level `dir/*` patterns. A pattern the listing cannot follow (`**`, `{a,b}`) is a refusal.
const MAX_WORKSPACE_PACKAGES = 256;
const MAX_PACKAGE_JSON_CHARS = 1_000_000;
const MAX_WALK = 64;

// Where the scripts are and what they hold, for one evaluation. env: { cwd (null: unknown), home, readText, pathExists, readDir, cache (a Map kept for the whole evaluation),
// written(abs) -> 'known' | 'maybe' | null (does the line write that file before the command?), mentionsGuarded() -> boolean, p (path module), tick() }.
// Returns { refuse: string } | { runs: [{ label, text, dir, file }] } | { none: true } (nothing runs: no package.json, no such script).
export function packageScripts(call, env) {
  const p = env.p ?? nodePath;
  env.tick?.();
  const cache = env.cache ?? new Map();
  const refuse = (msg) => ({ refuse: `package script: ${msg}` });
  if (env.cwd === null || env.cwd === undefined) return refuse('cannot tell which directory the package manager runs in, so which package.json it uses cannot be verified. Use an absolute --prefix, or chain the cd with &&.');
  let start = env.cwd;
  if (call.dir !== null) {
    const d = call.dir === '~' || call.dir.startsWith('~/') ? p.join(env.home ?? '', call.dir.slice(1)) : call.dir;
    start = p.resolve(env.cwd, d);
  }
  const read = (pj) => {
    if (cache.has(pj)) return cache.get(pj);
    env.tick?.();
    const text = env.readText(pj);
    let rec;
    if (typeof text !== 'string') rec = env.pathExists(pj) ? { unreadable: true } : { missing: true };
    else {
      try {
        const j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        rec = { scripts: j && typeof j === 'object' && j.scripts && typeof j.scripts === 'object' && !Array.isArray(j.scripts) ? j.scripts : null, workspaces: Array.isArray(j?.workspaces) ? j.workspaces : Array.isArray(j?.workspaces?.packages) ? j.workspaces.packages : null };
      } catch { rec = { invalid: true }; } // (npm refuses a package.json that is not JSON before it runs anything)
    }
    cache.set(pj, rec);
    return rec;
  };
  const unreadable = (pj) => refuse(`cannot read ${pj} (missing permission, a directory or larger than 1 MB), so the scripts it holds cannot be verified.`);
  const writtenMsg = (pj) => refuse(`this line writes ${pj} before the package manager reads it, so what its scripts run cannot be verified. Write the file in a command of its own.`);
  // each directory from `start` up: the nearest package.json is the project (npm's rule)
  const upward = (from) => {
    const key = `up\u0000${from}`;
    if (cache.has(key)) return cache.get(key);
    const out = [];
    let found = null;
    let d = from;
    for (let i = 0; i < MAX_WALK; i++) {
      const pj = p.join(d, 'package.json');
      out.push(pj);
      env.tick?.();
      if (env.pathExists(pj) || env.written?.(pj)) { found = { dir: d, file: pj }; break; }
      const up = p.dirname(d);
      if (up === d) break;
      d = up;
    }
    const r = { found, walked: out };
    cache.set(key, r);
    return r;
  };
  const up = upward(start);
  for (const pj of up.walked) {
    const w = env.written?.(pj);
    if (w === 'known' || (w === 'maybe' && env.mentionsGuarded?.())) return writtenMsg(pj);
  }
  if (!up.found) return { none: true };
  const candidates = [up.found];
  if (call.workspace) {
    // every ancestor that names workspaces (the project itself may be one of its packages), then their packages
    const roots = [];
    let d = up.found.dir;
    for (let i = 0; i < MAX_WALK; i++) {
      const pj = p.join(d, 'package.json');
      const rec = env.pathExists(pj) ? read(pj) : null;
      if (rec?.unreadable) return unreadable(pj);
      if (rec?.workspaces || env.pathExists(p.join(d, 'pnpm-workspace.yaml'))) roots.push(d);
      const parent = p.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    for (const root of roots) {
      const patterns = [];
      const rec = read(p.join(root, 'package.json'));
      if (rec.workspaces) patterns.push(...rec.workspaces);
      const yml = p.join(root, 'pnpm-workspace.yaml');
      if (env.pathExists(yml)) {
        const text = env.readText(yml);
        if (typeof text !== 'string') return unreadable(yml);
        const m = /^packages:[ \t]*\r?\n((?:[ \t]*(?:-[^\n]*)?(?:#[^\n]*)?\r?\n?)*)/m.exec(text);
        for (const line of m?.[1].split('\n') ?? []) { const q = /^\s*-\s*['"]?([^'"#\s]+)/.exec(line); if (q) patterns.push(q[1]); }
      }
      if (!candidates.some((c) => c.dir === root) && env.pathExists(p.join(root, 'package.json'))) candidates.push({ dir: root, file: p.join(root, 'package.json') });
      for (const raw of patterns) {
        if (typeof raw !== 'string') return refuse(`a workspace pattern in ${root} is not text, so the packages it names cannot be listed. Run the script from the package's own directory.`);
        if (raw.startsWith('!')) continue;
        const pat = raw.replace(/^\.\//, '').replace(/\/+$/, '');
        let dirs;
        if (!/[*?[\]{}()!]/.test(pat)) dirs = [p.join(root, pat)];
        else if (/^[^*?[\]{}()!]+\/\*$/.test(pat) || pat === '*') {
          const parent = p.join(root, pat === '*' ? '' : pat.slice(0, -2));
          const names = env.readDir(parent);
          dirs = Array.isArray(names) ? names.map((n) => p.join(parent, n)) : [];
        } else return refuse(`the workspace pattern \`${raw}\` in ${root} cannot be listed (only directories and \`dir/*\`), so which packages a workspace option reaches cannot be verified. Run the script from the package's own directory.`);
        for (const dd of dirs) {
          const pj = p.join(dd, 'package.json');
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
    if (!rec.scripts) continue;
    const present = (n) => Object.hasOwn(rec.scripts, n) && typeof rec.scripts[n] === 'string';
    // the named script must exist: npm stops with "Missing script" before a hook runs. (`npm restart` runs its stop and start scripts when it has no restart script; `yarn workspaces run X`: any word may be it)
    if (!call.gate.some(present)) continue;
    for (const n of call.names) {
      if (!present(n)) continue;
      const text = n === call.main && call.extra.length ? `${rec.scripts[n]} ${call.extra.map(shellQuote).join(' ')}` : rec.scripts[n];
      runs.push({ label: `${p.relative(env.cwd, cand.file) || 'package.json'} script "${n}"`, text, dir: cand.dir, file: cand.file });
    }
  }
  return runs.length ? { runs } : { none: true };
}

// The shell script a bare command name run through a package runner (npx, npm exec, pnpm exec ...) resolves to: node_modules/.bin/<name> of the nearest directory that has it.
export function localBin(name, env) {
  const p = env.p ?? nodePath;
  if (env.cwd === null || env.cwd === undefined || !/^[A-Za-z0-9_@][A-Za-z0-9_.@-]*$/.test(name)) return null;
  let d = env.cwd;
  for (let i = 0; i < MAX_WALK; i++) {
    const f = p.join(d, 'node_modules', '.bin', name);
    if (env.pathExists(f)) return f;
    const up = p.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}


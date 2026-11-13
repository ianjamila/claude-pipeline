// #261 (click-to-approve, PR A), plan Rev 6 B5: which hooks could still answer or alter the AskUserQuestion dialog.
// A click only counts when the answer came from a human (owner-go-click.mjs reads the transcript for that), but a hook that runs on the dialog (PreToolUse updatedInput, a PermissionRequest
// handler) answers it WITHOUT a human, and a later edit of such a hook could start to. So every handler on those two events whose matcher can match AskUserQuestion must be one of:
//   - installed pipeline code (its real script path is inside <home>/.claude/pipeline/): trusted, or
//   - listed by the owner in <home>/.claude/pipeline-state/owner-go/dialog-hooks.json ({ v: 1, hooks: [{ command, scriptPath, sha256 }] }) with today's bytes.
// Anything else (an unlisted or changed handler, a command that does not resolve to ONE script, a settings / plugin / skill file that exists but cannot be read) refuses the click: the owner types.
// `hookLayersSha256` fingerprints the list of the ACCOUNT-wide layers (issue time vs click time: a hook added between the two voids the ask). The PROJECT layer (settings, skills, agents, commands of the folder
// the session was launched in, CLAUDE_PROJECT_DIR, and of the working directory) is inventoried and must pass the same trust check on both sides, but is left out of the fingerprint: the issuing command's root
// and the click hook's cwd are different folders by construction, and a fingerprint over them would void every ask (R1-F2).
// Never throws: a failure is an `errors[]` entry (=> ok: false).
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { accountHome, transcriptConfigDirs } from '../../lib/paths.mjs';
import { insideClaudeCode } from '../../lib/owner-only.mjs';
import { ownerGoDir, realDirChain } from './owner-go.mjs';
import { readFrontmatter } from './frontmatter.mjs';

export const DIALOG_HOOKS_FILE = 'dialog-hooks.json';
export const OWNER_GO_STATE_REL = '.claude/pipeline-state/owner-go';
const DIALOG_TOOL = 'AskUserQuestion';
const DIALOG_EVENTS = Object.freeze(['PreToolUse', 'PermissionRequest']);
// Events a frontmatter `hooks:` block may name without touching the dialog (a block naming only these is no handler; anything else is read as one).
const OTHER_EVENTS = Object.freeze(['PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'PreCompact', 'PostCompact']);
const INTERPRETERS = Object.freeze(['node', 'sh', 'bash', 'zsh']);
// A bare path whose file is one of these is not "the script" (the real script is an argument we do not hash): unresolvable.
const NOT_A_SCRIPT = /^(?:node|nodejs|sh|bash|zsh|dash|fish|env|python[0-9.]*|perl|ruby|deno|bun|npx|npm|pnpm|yarn|osascript|php|cmd|powershell|pwsh)(?:\.exe|\.cmd|\.bat)?$/i;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const HOME_MARK = '\u0001HOME\u0001'; // stands for the home folder while a command is split into words
const ROOT_MARK = '\u0002'; // stands for the plugin install path (CLAUDE_PLUGIN_ROOT) while a command is split into words
const SHELL_CHARS = '|&;<>()`\\*?[]{}!#$';
const OPEN_READ = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const OPEN_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- reading files --------------------------------------------------------------------------------------------------------------------

// { state: 'none' } (does not exist) | { state: 'bad', why } | { state: 'ok', bytes }. Symlinks are followed (the two account config dirs share settings through links); a regular file is required.
function readBytes(file) {
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? { state: 'none' } : { state: 'bad', why: `cannot be read (${err?.code ?? 'error'})` };
  }
  if (!st.isFile()) return { state: 'bad', why: 'is not a regular file' };
  if (st.size > MAX_FILE_BYTES) return { state: 'bad', why: 'is too large' };
  try {
    const fd = openSync(file, OPEN_READ);
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile()) return { state: 'bad', why: 'is not a regular file' };
      const buf = Buffer.alloc(fst.size);
      let off = 0;
      while (off < fst.size) {
        const n = readSync(fd, buf, off, fst.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      return { state: 'ok', bytes: buf.subarray(0, off) };
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return { state: 'bad', why: `cannot be read (${err?.code ?? 'error'})` };
  }
}

function readJson(file) {
  const r = readBytes(file);
  if (r.state !== 'ok') return r;
  try {
    return { state: 'ok', value: JSON.parse(r.bytes.toString('utf8')) };
  } catch {
    return { state: 'bad', why: 'is not valid JSON' };
  }
}

// ---- matchers and commands ------------------------------------------------------------------------------------------------------------

// Claude Code tests a matcher as an anchored regular expression against the tool name; absent, "" and "*" match every tool. An invalid pattern counts as a match (fail closed).
export function matcherMatchesDialog(matcher, tool = DIALOG_TOOL) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return true;
  }
}

// (Windows) Claude Code runs a command hook on Windows under Git Bash, where an unquoted backslash is an escape the shell removes: words() therefore refuses a backslash on EVERY platform (unquoted or inside
// double quotes), and a Windows path is written with forward slashes (`node C:/Users/me/x.mjs`) or in single quotes. Only a drive-letter path counts as absolute there (UNC is refused, below) (a rooted `\x` or a
// drive-relative `C:x` is ambiguous: refused). The already-split target is then normalised to native separators (scriptTarget), so it matches the path the file is opened by.
const isWin = (platform) => platform === 'win32';
const pathOf = (platform) => (isWin(platform) ? path.win32 : path);
// A UNC / `//server` path is refused (#269: reading a network share to fingerprint it can leak credentials and the bytes can change between hash and run).
const isAbsoluteOn = (p, platform) => (isWin(platform) ? /^[A-Za-z]:[\\/]/.test(p) && path.win32.isAbsolute(p) : path.isAbsolute(p));

// Words of a simple command line: whitespace separates, '...' and "..." group. Anything a shell would interpret (pipes, redirects, substitutions, globs, escapes, variables other than a leading HOME) -> null.
// `rootRisky`: the plugin install path would be split or expanded by a shell when written unquoted, so an unquoted ROOT_MARK is refused.
function words(text, rootRisky = false) {
  const out = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '$' || c === '`' || c === '\\') return null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (c === '\n' || c === '\r') return null;
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    if (SHELL_CHARS.includes(c) || (rootRisky && c === ROOT_MARK)) return null;
    cur += c;
    has = true;
  }
  if (quote !== null) return null;
  if (has) out.push(cur);
  return out;
}

// The one script a hook command runs: `node|sh|bash|zsh <abs path> [args]` or `<abs path> [args]`, with a leading ~ / $HOME / ${HOME} expanded. -> the path, or null (unresolvable: sh -c, npx, inline code,
// pipes, env prefixes, a relative path, a missing file, an interpreter named as the script). `pluginRoot` expands ${CLAUDE_PLUGIN_ROOT} for a plugin's hooks.json.
export function resolveCommand(command, opts = {}) {
  const target = commandTarget(command, opts);
  return target !== null && isFile(target) ? target : null;
}

// resolveCommand without the look at the file: the script path the command names, or null. (Pure, so the Windows forms can be tested on any machine through `platform`.)
export function commandTarget(command, { home, pluginRoot = null, platform = process.platform } = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) return null; // (#269 R28) a control character could pose as the home / plugin-root markers below: refused
  let text = command.trim();
  // (the install path never passes the shell-word rules: its own separators are the platform's, while anything the author typed after the variable still does; it goes in after the split, like the home folder)
  if (pluginRoot) text = text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT(?![A-Za-z0-9_])/g, () => ROOT_MARK);
  text = text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => HOME_MARK).replace(/(^|[\s"'])~(?=\/)/g, (_m, lead) => lead + HOME_MARK);
  const w = words(text, !!pluginRoot && /[\s*?[\]{}!#$`&;<>()|'"]/.test(pluginRoot)); // (a $ left after the expansions above is not a home reference: words() refuses it)
  return scriptTarget(w, home, platform, pluginRoot, true);
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

// The script path a list of words names (see resolveCommand), or null; the file itself is not looked at. A Windows path is normalised (one separator form, so `~/x` + a backslash home gives the same string as path.join).
export function scriptTarget(w, home, platform = process.platform, pluginRoot = null, marked = false) {
  if (!w || w.length === 0) return null;
  const P = pathOf(platform);
  // (#269 R28) a word that holds a control character other than through the markers commandTarget put in (an `args` word, or a marker with no plugin root) is refused, never substituted
  const MARKED = marked ? /\u0001HOME\u0001|\u0002/g : /(?!)/g; // only commandTarget's own words carry markers; `args` words never do
  if (w.some((s) => typeof s !== 'string' || /[\u0000-\u001f\u007f]/.test(s.replace(MARKED, '')) || (!pluginRoot && s.includes(ROOT_MARK)))) return null;
  const real = (s) => s.replaceAll(HOME_MARK, home).replaceAll(ROOT_MARK, pluginRoot);
  let target;
  if (INTERPRETERS.includes(w[0])) {
    if (w.length < 2) return null;
    target = real(w[1]);
  } else {
    target = real(w[0]);
    if (NOT_A_SCRIPT.test(P.basename(target))) return null;
  }
  if (!isAbsoluteOn(target, platform)) return null;
  return isWin(platform) ? path.win32.normalize(target) : target;
}

// The script a list of words runs (see resolveCommand), or null.
function scriptOf(w, home, platform = process.platform) {
  const target = scriptTarget(w, home, platform);
  return target !== null && isFile(target) ? target : null;
}

// (R1-F3) A handler of the form { command, args: [...] }: the command must be an interpreter (a bare name, or an absolute path of one) and args[0] the ONE script it runs, ahead of that script's own arguments.
// Any other non-empty args shape (a program with arguments, a non-string argument, a command that already holds spaces) resolves to nothing: its arguments are code we do not hash.
function resolveHandler(h, { home, pluginRoot, platform = process.platform }) {
  const args = h.args;
  if (args === undefined || args === null || (Array.isArray(args) && args.length === 0)) return resolveCommand(h.command, { home, pluginRoot, platform });
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && a !== '') || typeof h.command !== 'string') return null;
  const cmd = h.command.trim();
  const P = pathOf(platform);
  const interpreter = (name) => INTERPRETERS.includes(isWin(platform) ? name.replace(/\.exe$/i, '').toLowerCase() : name);
  if (!(INTERPRETERS.includes(cmd) || (isAbsoluteOn(cmd, platform) && interpreter(P.basename(cmd)) && !/\s/.test(cmd)))) return null;
  // (R2-F8) an argument vector is not shell-expanded: `~` and $HOME in args[0] would reach the interpreter as literal text (a path relative to the hook's working folder), so only a literal path counts.
  if (/^~(?:\/|$)|\$\{?HOME\b/.test(args[0])) return null;
  const expanded = pluginRoot ? args[0].replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT(?![A-Za-z0-9_])/g, () => pluginRoot) : args[0];
  if (/[$`]/.test(expanded)) return null;
  return scriptOf(['node', expanded], home, platform);
}

// ---- collecting the handlers ----------------------------------------------------------------------------------------------------------

const defaultManaged = () => (process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
  : process.platform === 'win32' ? ['C:/Program Files/ClaudeCode/managed-settings.json'] : ['/etc/claude-code/managed-settings.json']);

// The handlers of one `hooks` object ({ PreToolUse: [{ matcher, hooks: [{ type, command }] }], ... }) for the two dialog events.
function fromHooksObject(hooksObj, source, ctx, errors, pluginRoot = null) {
  const out = [];
  if (hooksObj === undefined || hooksObj === null) return out;
  if (!isObj(hooksObj)) { errors.push({ source, why: 'the "hooks" value is not an object' }); return out; }
  for (const event of DIALOG_EVENTS) {
    const groups = hooksObj[event];
    if (groups === undefined || groups === null) continue;
    if (!Array.isArray(groups)) { errors.push({ source, why: `"hooks.${event}" is not a list` }); continue; }
    for (const g of groups) {
      if (!isObj(g) || (g.hooks !== undefined && !Array.isArray(g.hooks))) { errors.push({ source, why: `a "hooks.${event}" entry is malformed` }); continue; }
      if (typeof g.matcher !== 'string' && g.matcher !== undefined && g.matcher !== null) { errors.push({ source, why: `a "hooks.${event}" matcher is not a string` }); continue; }
      if (!matcherMatchesDialog(g.matcher)) continue;
      const matcher = typeof g.matcher === 'string' ? g.matcher : '';
      for (const h of g.hooks ?? []) {
        if (!isObj(h)) { errors.push({ source, why: `a "hooks.${event}" handler is malformed` }); continue; }
        if (h.type !== undefined && h.type !== 'command') {
          out.push({ source, event, matcher, command: `(${String(h.type)} hook)`, scriptPath: null, scriptSha256: null, trusted: false });
          continue;
        }
        if (typeof h.command !== 'string') { errors.push({ source, why: `a "hooks.${event}" handler has no command` }); continue; }
        const noArgs = h.args === undefined || h.args === null || (Array.isArray(h.args) && h.args.length === 0);
        const args = noArgs ? null : Array.isArray(h.args) ? h.args.map((a) => String(a)) : [`(unusable args: ${JSON.stringify(h.args).slice(0, 80)})`];
        const scriptPath = resolveHandler(h, { home: ctx.home, pluginRoot });
        let scriptSha256 = null;
        let real = null;
        if (scriptPath !== null) {
          const b = readBytes(scriptPath);
          if (b.state === 'ok') {
            scriptSha256 = sha256(b.bytes);
            try { real = realpathSync(scriptPath); } catch { real = null; }
          }
        }
        const resolved = scriptSha256 !== null && real !== null;
        out.push({
          source, event, matcher, command: h.command, args, scriptPath: resolved ? scriptPath : null, scriptSha256: resolved ? scriptSha256 : null,
          trusted: resolved && ctx.pipelineReal !== null && (real === ctx.pipelineReal || real.startsWith(`${ctx.pipelineReal}${path.sep}`)),
        });
      }
    }
  }
  return out;
}

// The `hooks:` block of a skill / agent / command file's YAML front matter, read by the recognizer the guard uses (frontmatter.mjs). Without a YAML reader: a block naming only events that are not dialog
// events is no handler; any other `hooks:` key, and any top-level construct that could be one in disguise (a quoted key with escapes, a flow mapping, a complex key, a merge key), is ONE unresolvable
// handler (fail closed).
function fromFrontmatter(file, errors) {
  const r = readBytes(file);
  if (r.state === 'none') return [];
  if (r.state === 'bad') { errors.push({ source: file, why: r.why }); return []; }
  const fm = readFrontmatter(r.bytes.toString('utf8'));
  if (fm === null) return [];
  const unresolvable = { source: file, event: 'PreToolUse', matcher: '', command: '(frontmatter hooks)', args: null, scriptPath: null, scriptSha256: null, trusted: false };
  if (fm.failClosed) return [unresolvable];
  for (const block of fm.hooks) {
    if (block.rest !== '') return [unresolvable];
    const children = block.children.filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
    const indentOf = (l) => /^\s*/.exec(l)[0].length;
    const top = Math.min(...children.map(indentOf));
    const events = children.filter((l) => indentOf(l) === top).map((l) => /^\s*["']?([A-Za-z]+)["']?\s*:\s*(?:#.*)?$/.exec(l)?.[1] ?? null);
    if (!(children.length > 0 && events.every((e) => e !== null && OTHER_EVENTS.includes(e)))) return [unresolvable];
  }
  return [];
}

// The md files below `dir` (any depth up to 4): a command or an agent may sit in a namespace folder.
// (R2-F5) a walk that stops at the depth or file cap is an errors[] entry (not ok), like every other source that cannot be read in full.
const markdownFiles = (dir, errors, depth = 0, out = []) => {
  let names = [];
  try { names = readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1)); } catch { return out; }
  for (const d of names) {
    if (out.length >= 2000) { if (!out.capped) { out.capped = true; errors.push({ source: dir, why: 'too many files (more than 2000): the rest is not read' }); } break; }
    const p = path.join(dir, d.name);
    let st = d;
    if (d.isSymbolicLink()) { try { st = statSync(p); } catch { continue; } }
    if (st.isDirectory()) {
      if (depth < 4) markdownFiles(p, errors, depth + 1, out);
      else errors.push({ source: p, why: 'folders nested too deep (more than 4 below a commands or agents folder): not read' });
    } else if (d.name.endsWith('.md')) out.push(p);
  }
  return out;
};
// The files whose front matter Claude Code reads under one component root (a config dir, a project's dot-claude folder, a plugin's install path): skills/*/SKILL.md, agents/**.md, commands/**.md.
const componentFiles = (dir, errors) => {
  const out = [];
  try {
    for (const n of readdirSync(path.join(dir, 'skills')).sort()) out.push(path.join(dir, 'skills', n, 'SKILL.md'));
  } catch { /* no skills folder */ }
  out.push(...markdownFiles(path.join(dir, 'agents'), errors), ...markdownFiles(path.join(dir, 'commands'), errors));
  return out;
};
// The component locations a plugin manifest names (strings or lists of strings; `skills` are folders of skill folders, agents and commands are md files or folders of them): -> { files, odd } (odd: a form not followed).
function manifestComponents(manifest, installPath, errors) {
  const files = [];
  let odd = null;
  for (const key of ['skills', 'agents', 'commands']) {
    const v = manifest[key];
    if (v === undefined || v === null) continue;
    const list = typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
    if (list === null) { odd = `its "${key}" entry is not a path or a list of paths`; continue; }
    for (const rel of list) {
      const p = path.resolve(installPath, rel);
      let st = null;
      try { st = statSync(p); } catch { continue; }
      if (st.isFile()) files.push(p);
      else if (key === 'skills') {
        files.push(path.join(p, 'SKILL.md'));
        try { for (const n of readdirSync(p).sort()) files.push(path.join(p, n, 'SKILL.md')); } catch { /* unreadable: no skills */ }
      } else files.push(...markdownFiles(p, errors));
    }
  }
  return { files, odd };
}

// Every handler on PreToolUse / PermissionRequest that can match AskUserQuestion, from every place Claude Code reads hooks. -> { ok, handlers, errors }. `errors` holds { source, why }.
// `cwd` and `projectDirs` name project folders (their dot-claude folders are the project layer; CLAUDE_PROJECT_DIR of the hook's environment belongs in `projectDirs`, R1-F2). Each handler carries `layer`:
// 'account' (user config dirs, managed settings, plugins an account-wide layer enables) or 'project'.
export function dialogHandlers({ home = accountHome(), cwd = null, projectDirs = [], managedPaths = defaultManaged() } = {}) {
  const errors = [];
  const handlers = [];
  let pipelineReal = null;
  try { pipelineReal = realpathSync(path.join(home, '.claude', 'pipeline')); } catch { /* not installed here: nothing is trusted */ }
  const ctx = { home, pipelineReal };
  const configDirs = transcriptConfigDirs({ home });
  const projectDirList = [...new Set([cwd, ...(Array.isArray(projectDirs) ? projectDirs : [])].filter((d) => typeof d === 'string' && d !== '' && path.isAbsolute(d)).map((d) => path.join(d, '.claude')))].sort();
  const tag = (list, layer) => list.map((h) => ({ ...h, layer }));

  const settingsFiles = [
    ...configDirs.flatMap((d) => [path.join(d, 'settings.json'), path.join(d, 'settings.local.json')]).map((file) => ({ file, layer: 'account' })),
    ...projectDirList.flatMap((d) => [path.join(d, 'settings.json'), path.join(d, 'settings.local.json')]).map((file) => ({ file, layer: 'project' })),
    ...managedPaths.map((file) => ({ file, layer: 'account' })),
  ];
  const enabled = new Set();
  const enabledByAccount = new Set();
  for (const { file, layer } of settingsFiles) {
    const r = readJson(file);
    if (r.state === 'none') continue;
    if (r.state === 'bad') { errors.push({ source: file, why: r.why }); continue; }
    if (!isObj(r.value)) { errors.push({ source: file, why: 'is not a JSON object' }); continue; }
    handlers.push(...tag(fromHooksObject(r.value.hooks, file, ctx, errors), layer));
    if (isObj(r.value.enabledPlugins)) for (const [name, on] of Object.entries(r.value.enabledPlugins)) if (on === true) { enabled.add(name); if (layer === 'account') enabledByAccount.add(name); }
  }

  // enabled plugins (enabled in ANY layer counts: a layer that switches one off cannot be trusted to be the one Claude Code obeys) -> their install paths -> hooks/hooks.json, the manifest, and (R1-B3) the
  // front matter of their skills, agents and commands
  if (enabled.size > 0) {
    const installs = new Map(); // install path -> 'account' (an account-wide layer enables the plugin) | 'project' (only a project layer does)
    for (const d of configDirs) {
      const file = path.join(d, 'plugins', 'installed_plugins.json');
      const r = readJson(file);
      if (r.state === 'none') continue;
      if (r.state === 'bad') { errors.push({ source: file, why: r.why }); continue; }
      if (!isObj(r.value) || !isObj(r.value.plugins)) { errors.push({ source: file, why: 'is not an installed-plugins list' }); continue; }
      for (const name of enabled) {
        const entries = r.value.plugins[name];
        if (entries === undefined) continue;
        if (!Array.isArray(entries)) { errors.push({ source: file, why: `the entry for ${name} is not a list` }); continue; }
        for (const e of entries) if (isObj(e) && typeof e.installPath === 'string' && path.isAbsolute(e.installPath) && installs.get(e.installPath) !== 'account') installs.set(e.installPath, enabledByAccount.has(name) ? 'account' : 'project');
      }
    }
    for (const installPath of [...installs.keys()].sort()) {
      const layer = installs.get(installPath);
      const hooksFile = path.join(installPath, 'hooks', 'hooks.json');
      const r = readJson(hooksFile);
      if (r.state === 'bad') errors.push({ source: hooksFile, why: r.why });
      else if (r.state === 'ok') {
        if (!isObj(r.value)) errors.push({ source: hooksFile, why: 'is not a JSON object' });
        else handlers.push(...tag(fromHooksObject(r.value.hooks ?? r.value, hooksFile, ctx, errors, installPath), layer));
      }
      const manifest = path.join(installPath, '.claude-plugin', 'plugin.json');
      const m = readJson(manifest);
      if (m.state === 'bad') errors.push({ source: manifest, why: m.why });
      else if (m.state === 'ok' && isObj(m.value) && m.value.hooks !== undefined && m.value.hooks !== null) {
        // a manifest that names hooks by path or list is not followed here: fail closed
        if (isObj(m.value.hooks)) handlers.push(...tag(fromHooksObject(m.value.hooks, manifest, ctx, errors, installPath), layer));
        else handlers.push({ source: manifest, event: 'PreToolUse', matcher: '', command: '(plugin manifest hooks)', args: null, scriptPath: null, scriptSha256: null, trusted: false, layer });
      }
      const components = new Set(componentFiles(installPath, errors));
      if (m.state === 'ok' && isObj(m.value)) {
        const named = manifestComponents(m.value, installPath, errors);
        for (const x of named.files) components.add(x);
        if (named.odd) errors.push({ source: manifest, why: named.odd });
      }
      for (const file of [...components].sort()) handlers.push(...tag(fromFrontmatter(file, errors), layer));
    }
  }

  for (const [dir, layer] of [...configDirs.map((d) => [d, 'account']), ...projectDirList.map((d) => [d, 'project'])]) {
    for (const file of componentFiles(dir, errors)) handlers.push(...tag(fromFrontmatter(file, errors), layer));
  }

  return { ok: errors.length === 0, handlers, errors };
}

// ---- the approved list ------------------------------------------------------------------------------------------------------------------

export const dialogHooksFile = (home = accountHome()) => path.join(ownerGoDir(home), DIALOG_HOOKS_FILE);

// { ok: true, hooks, approvedAt } (a missing file or folder is an empty list) | { ok: false, why }.
export function readApprovedList({ home = accountHome() } = {}) {
  const file = dialogHooksFile(home);
  let p = home;
  for (const part of OWNER_GO_STATE_REL.split('/')) {
    p = path.join(p, part);
    try {
      if (!lstatSync(p).isDirectory()) return { ok: false, why: `${p} is not a real folder` };
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: true, hooks: [], approvedAt: null };
      return { ok: false, why: `${p} cannot be read` };
    }
  }
  try {
    if (!lstatSync(file).isFile()) return { ok: false, why: `${file} is not a regular file` };
  } catch (err) {
    return err?.code === 'ENOENT' ? { ok: true, hooks: [], approvedAt: null } : { ok: false, why: `${file} cannot be read` };
  }
  const r = readJson(file);
  if (r.state !== 'ok') return { ok: false, why: `${file} ${r.why ?? 'cannot be read'}` };
  const v = r.value;
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.hooks)) return { ok: false, why: `${file} is not a version 1 dialog-hooks list` };
  const hooks = [];
  for (const h of v.hooks) {
    if (!isObj(h) || typeof h.command !== 'string' || typeof h.scriptPath !== 'string' || !/^[0-9a-f]{64}$/.test(h.sha256 ?? '') || (h.args !== undefined && !(Array.isArray(h.args) && h.args.every((a) => typeof a === 'string')))) return { ok: false, why: `${file} has a malformed entry` };
    hooks.push({ command: h.command, scriptPath: h.scriptPath, sha256: h.sha256, ...(h.args === undefined ? {} : { args: h.args }) });
  }
  return { ok: true, hooks, approvedAt: typeof v.approvedAt === 'string' ? v.approvedAt : null };
}

// ---- the check --------------------------------------------------------------------------------------------------------------------------

// A path shown to the owner: the home folder as `~` and forward slashes (on Windows both separators and letter case are alike, so the prefix test ignores them).
export function tilde(p, home, platform = process.platform) {
  if (typeof p !== 'string' || !home) return p;
  if (!isWin(platform)) return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  const fwd = (x) => x.replaceAll('\\', '/');
  const h = fwd(home).replace(/\/+$/, '');
  const q = fwd(p);
  return q.toLowerCase() === h.toLowerCase() || q.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${q.slice(h.length)}` : p;
}
const matcherText = (h) => (h.matcher === '' ? '*' : h.matcher);
const describe = (h, home) => `${h.scriptPath ? tilde(h.scriptPath, home) : h.command} (${h.event} ${matcherText(h)})`;

const byJson = (a, b) => { const x = JSON.stringify(a); const y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; };
// sha256 over the sorted { source, event, matcher, command, args, scriptSha256 } list of the account-wide layers: any added, removed, re-pointed or edited handler (arguments included) changes it.
// The project layer is not in it (R1-F2: the issuing command and the click hook see different project folders); it is judged by checkDialogHooks on every side instead.
export const fingerprint = (handlers) => sha256(JSON.stringify(handlers
  .filter((h) => h.layer !== 'project')
  .map((h) => ({ source: h.source, event: h.event, matcher: h.matcher, command: h.command, args: h.args ?? null, scriptSha256: h.scriptSha256 }))
  .sort(byJson)));
const sameArgs = (x, y) => JSON.stringify(x ?? []) === JSON.stringify(y ?? []);

// -> { ok, hookLayersSha256, reason, offenders, handlers, approvedAt }. ok only when every source read, every untrusted handler resolves to one script and is listed with today's bytes.
export function checkDialogHooks({ home = accountHome(), cwd = null, projectDirs = [], managedPaths } = {}) {
  const found = dialogHandlers({ home, cwd, projectDirs, ...(managedPaths ? { managedPaths } : {}) });
  const list = readApprovedList({ home });
  const hookLayersSha256 = fingerprint(found.handlers);
  const offenders = [];
  for (const e of found.errors) offenders.push({ kind: 'unreadable', source: e.source, why: e.why, text: `dialog hook source ${tilde(e.source, home)} ${e.why}` });
  if (!list.ok) offenders.push({ kind: 'list', source: dialogHooksFile(home), why: list.why, text: `the approved dialog-hook list is unusable: ${list.why}` });
  for (const h of found.handlers) {
    if (h.trusted) continue;
    if (h.scriptPath === null) {
      offenders.push({ kind: 'unresolvable', ...h, text: `unresolvable dialog hook ${h.command} (${h.event} ${matcherText(h)}) in ${tilde(h.source, home)}` });
      continue;
    }
    const listed = list.ok ? list.hooks.filter((x) => x.command === h.command && x.scriptPath === h.scriptPath && sameArgs(x.args, h.args)) : [];
    if (listed.length === 0) offenders.push({ kind: 'unlisted', ...h, text: `unlisted dialog hook ${describe(h, home)}` });
    else if (!listed.some((x) => x.sha256 === h.scriptSha256)) offenders.push({ kind: 'changed', ...h, text: `changed dialog hook ${describe(h, home)}: its bytes differ from the approved list` });
  }
  const ok = offenders.length === 0;
  return { ok, hookLayersSha256, reason: ok ? null : offenders[0].text, offenders, handlers: found.handlers, approvedAt: list.ok ? list.approvedAt : null };
}

// The default for owner-go-click.mjs `recordClick({ hookCheck })`: the hook input's cwd is the project the dialog ran in.
export const hookCheck = ({ home, input, env = process.env } = {}) => {
  const r = checkDialogHooks({ home: home ?? accountHome(), cwd: typeof input?.cwd === 'string' ? input.cwd : null, projectDirs: [env?.CLAUDE_PROJECT_DIR] });
  return { ok: r.ok, hookLayersSha256: r.hookLayersSha256, reason: r.reason };
};

// ---- approving --------------------------------------------------------------------------------------------------------------------------

// Writes the list from what is installed now. Refuses (nothing written) when any source cannot be read or any untrusted handler does not resolve to one script.
// Also refuses (nothing written, `refused: true`) inside Claude Code: an agent must not approve its own hooks (#273; the owner's admin switch lifts it). `ctx.hasClaudeCodeAncestor` is the process-tree test seam.
// -> { ok: true, file, hooks, approvedAt } | { ok: false, reason, offenders, refused? }
export function approveDialogHooks({ home = accountHome(), cwd = null, projectDirs = [], now = Date.now, managedPaths, env = process.env, ctx = {} } = {}) {
  const inside = insideClaudeCode(env, ctx);
  if (inside) return { ok: false, reason: `refused: approving the dialog hooks decides which hooks may sit on the approval dialog, so it does not run inside a Claude Code session (${inside}); run it in your own terminal`, offenders: [], refused: true };
  const found = dialogHandlers({ home, cwd, projectDirs, ...(managedPaths ? { managedPaths } : {}) });
  const bad = [
    ...found.errors.map((e) => ({ kind: 'unreadable', text: `dialog hook source ${tilde(e.source, home)} ${e.why}` })),
    ...found.handlers.filter((h) => !h.trusted && h.scriptPath === null)
      .map((h) => ({ kind: 'unresolvable', text: `${h.command} (${h.event} ${matcherText(h)}) in ${tilde(h.source, home)} does not resolve to one script` })),
  ];
  if (bad.length > 0) return { ok: false, reason: `not listed: ${bad.map((b) => b.text).join('; ')}`, offenders: bad };
  const hooks = [];
  const seen = new Set();
  for (const h of found.handlers) {
    if (h.trusted) continue;
    const key = `${h.command}\n${h.scriptPath}\n${h.scriptSha256}\n${JSON.stringify(h.args ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hooks.push({ command: h.command, scriptPath: h.scriptPath, sha256: h.scriptSha256, ...(h.args ? { args: h.args } : {}) });
  }
  hooks.sort(byJson);
  if (!realDirChain(home, OWNER_GO_STATE_REL)) return { ok: false, reason: `${path.join(home, ...OWNER_GO_STATE_REL.split('/'))} is not a real folder`, offenders: [] };
  const file = dialogHooksFile(home);
  const approvedAt = new Date(now()).toISOString();
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(tmp, OPEN_EXCL, 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ v: 1, approvedAt, hooks }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* not created or already gone */ }
    return { ok: false, reason: `could not write ${file} (${err?.code ?? 'error'})`, offenders: [] };
  }
  return { ok: true, file, hooks, approvedAt };
}

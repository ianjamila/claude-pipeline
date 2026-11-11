// #261 (click-to-approve, PR A), plan Rev 6 B5: which hooks could still answer or alter the AskUserQuestion dialog.
// A click only counts when the answer came from a human (owner-go-click.mjs reads the transcript for that), but a hook that runs on the dialog (PreToolUse updatedInput, a PermissionRequest
// handler) answers it WITHOUT a human, and a later edit of such a hook could start to. So every handler on those two events whose matcher can match AskUserQuestion must be one of:
//   - installed pipeline code (its real script path is inside <home>/.claude/pipeline/): trusted, or
//   - listed by the owner in <home>/.claude/pipeline-state/owner-go/dialog-hooks.json ({ v: 1, hooks: [{ command, scriptPath, sha256 }] }) with today's bytes.
// Anything else (an unlisted or changed handler, a command that does not resolve to ONE script, a settings / plugin / skill file that exists but cannot be read) refuses the click: the owner types.
// `hookLayersSha256` fingerprints the whole list (issue time vs click time: a hook added between the two voids the ask).
// Never throws: a failure is an `errors[]` entry (=> ok: false).
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { accountHome, transcriptConfigDirs } from '../../lib/paths.mjs';
import { ownerGoDir, realDirChain } from './owner-go.mjs';

export const DIALOG_HOOKS_FILE = 'dialog-hooks.json';
export const OWNER_GO_STATE_REL = '.claude/pipeline-state/owner-go';
const DIALOG_TOOL = 'AskUserQuestion';
const DIALOG_EVENTS = Object.freeze(['PreToolUse', 'PermissionRequest']);
// Events a frontmatter `hooks:` block may name without touching the dialog (a block naming only these is no handler; anything else is read as one).
const OTHER_EVENTS = Object.freeze(['PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'PreCompact', 'PostCompact']);
const INTERPRETERS = Object.freeze(['node', 'sh', 'bash', 'zsh']);
// A bare path whose file is one of these is not "the script" (the real script is an argument we do not hash): unresolvable.
const NOT_A_SCRIPT = /^(?:node|nodejs|sh|bash|zsh|dash|fish|env|python[0-9.]*|perl|ruby|deno|bun|npx|npm|pnpm|yarn|osascript|php)$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const HOME_MARK = '\u0001HOME\u0001'; // stands for the home folder while a command is split into words
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

// Words of a simple command line: whitespace separates, '...' and "..." group. Anything a shell would interpret (pipes, redirects, substitutions, globs, escapes, variables other than a leading HOME) -> null.
function words(text) {
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
    if (SHELL_CHARS.includes(c)) return null;
    cur += c;
    has = true;
  }
  if (quote !== null) return null;
  if (has) out.push(cur);
  return out;
}

// The one script a hook command runs: `node|sh|bash|zsh <abs path> [args]` or `<abs path> [args]`, with a leading ~ / $HOME / ${HOME} expanded. -> the path, or null (unresolvable: sh -c, npx, inline code,
// pipes, env prefixes, a relative path, a missing file, an interpreter named as the script). `pluginRoot` expands ${CLAUDE_PLUGIN_ROOT} for a plugin's hooks.json.
export function resolveCommand(command, { home, pluginRoot = null } = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  let text = command.trim();
  if (pluginRoot) text = text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT(?![A-Za-z0-9_])/g, () => pluginRoot);
  text = text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => HOME_MARK).replace(/(^|[\s"'])~(?=\/)/g, (_m, lead) => lead + HOME_MARK);
  const w = words(text); // (a $ left after the expansions above is not a home reference: words() refuses it)
  if (!w || w.length === 0) return null;
  const real = (s) => s.replaceAll(HOME_MARK, home);
  let target;
  if (INTERPRETERS.includes(w[0])) {
    if (w.length < 2) return null;
    target = real(w[1]);
  } else {
    target = real(w[0]);
    if (NOT_A_SCRIPT.test(path.basename(target))) return null;
  }
  if (!path.isAbsolute(target)) return null;
  try {
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  return target;
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
        const scriptPath = resolveCommand(h.command, { home: ctx.home, pluginRoot });
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
          source, event, matcher, command: h.command, scriptPath: resolved ? scriptPath : null, scriptSha256: resolved ? scriptSha256 : null,
          trusted: resolved && ctx.pipelineReal !== null && (real === ctx.pipelineReal || real.startsWith(`${ctx.pipelineReal}${path.sep}`)),
        });
      }
    }
  }
  return out;
}

// The `hooks:` block of a skill / agent file's YAML frontmatter. Without a YAML reader: a block naming only events that are not dialog events is no handler; any other `hooks:` key is ONE
// unresolvable handler (fail closed).
function fromFrontmatter(file, errors) {
  const r = readBytes(file);
  if (r.state === 'none') return [];
  if (r.state === 'bad') { errors.push({ source: file, why: r.why }); return []; }
  const text = r.bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(text)) return [];
  const lines = text.split(/\r?\n/).slice(1);
  const end = lines.findIndex((l) => /^(?:---|\.\.\.)[ \t]*$/.test(l));
  const fm = end === -1 ? lines : lines.slice(0, end);
  const at = fm.findIndex((l) => /^["']?hooks["']?[ \t]*:/.test(l));
  if (at === -1) return [];
  const rest = fm[at].replace(/^["']?hooks["']?[ \t]*:/, '').replace(/#.*$/, '').trim();
  const unresolvable = { source: file, event: 'PreToolUse', matcher: '', command: '(frontmatter hooks)', scriptPath: null, scriptSha256: null, trusted: false };
  if (rest !== '') return [unresolvable];
  const children = [];
  for (const l of fm.slice(at + 1)) {
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    children.push(l);
  }
  const indentOf = (l) => /^\s*/.exec(l)[0].length;
  const top = Math.min(...children.map(indentOf));
  const events = children.filter((l) => indentOf(l) === top).map((l) => /^\s*["']?([A-Za-z]+)["']?\s*:\s*(?:#.*)?$/.exec(l)?.[1] ?? null);
  if (children.length > 0 && events.every((e) => e !== null && OTHER_EVENTS.includes(e))) return [];
  return [unresolvable];
}

const skillAndAgentFiles = (dir) => {
  const out = [];
  try {
    for (const n of readdirSync(path.join(dir, 'skills')).sort()) out.push(path.join(dir, 'skills', n, 'SKILL.md'));
  } catch { /* no skills folder */ }
  try {
    for (const n of readdirSync(path.join(dir, 'agents')).sort()) if (n.endsWith('.md')) out.push(path.join(dir, 'agents', n));
  } catch { /* no agents folder */ }
  return out;
};

// Every handler on PreToolUse / PermissionRequest that can match AskUserQuestion, from every place Claude Code reads hooks. -> { ok, handlers, errors }. `errors` holds { source, why }.
export function dialogHandlers({ home = accountHome(), cwd = null, managedPaths = defaultManaged() } = {}) {
  const errors = [];
  const handlers = [];
  let pipelineReal = null;
  try { pipelineReal = realpathSync(path.join(home, '.claude', 'pipeline')); } catch { /* not installed here: nothing is trusted */ }
  const ctx = { home, pipelineReal };
  const configDirs = transcriptConfigDirs({ home });
  const projectDir = typeof cwd === 'string' && cwd !== '' ? path.join(cwd, '.claude') : null;

  const settingsFiles = [
    ...configDirs.flatMap((d) => [path.join(d, 'settings.json'), path.join(d, 'settings.local.json')]),
    ...(projectDir ? [path.join(projectDir, 'settings.json'), path.join(projectDir, 'settings.local.json')] : []),
    ...managedPaths,
  ];
  const enabled = new Set();
  for (const file of settingsFiles) {
    const r = readJson(file);
    if (r.state === 'none') continue;
    if (r.state === 'bad') { errors.push({ source: file, why: r.why }); continue; }
    if (!isObj(r.value)) { errors.push({ source: file, why: 'is not a JSON object' }); continue; }
    handlers.push(...fromHooksObject(r.value.hooks, file, ctx, errors));
    if (isObj(r.value.enabledPlugins)) for (const [name, on] of Object.entries(r.value.enabledPlugins)) if (on === true) enabled.add(name);
  }

  // enabled plugins (enabled in ANY layer counts: a layer that switches one off cannot be trusted to be the one Claude Code obeys) -> their install paths -> hooks/hooks.json
  if (enabled.size > 0) {
    const installs = new Set();
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
        for (const e of entries) if (isObj(e) && typeof e.installPath === 'string' && path.isAbsolute(e.installPath)) installs.add(e.installPath);
      }
    }
    for (const installPath of [...installs].sort()) {
      const hooksFile = path.join(installPath, 'hooks', 'hooks.json');
      const r = readJson(hooksFile);
      if (r.state === 'bad') errors.push({ source: hooksFile, why: r.why });
      else if (r.state === 'ok') {
        if (!isObj(r.value)) errors.push({ source: hooksFile, why: 'is not a JSON object' });
        else handlers.push(...fromHooksObject(r.value.hooks ?? r.value, hooksFile, ctx, errors, installPath));
      }
      const manifest = path.join(installPath, '.claude-plugin', 'plugin.json');
      const m = readJson(manifest);
      if (m.state === 'bad') errors.push({ source: manifest, why: m.why });
      else if (m.state === 'ok' && isObj(m.value) && m.value.hooks !== undefined && m.value.hooks !== null) {
        // a manifest that names hooks by path or list is not followed here: fail closed
        if (isObj(m.value.hooks)) handlers.push(...fromHooksObject(m.value.hooks, manifest, ctx, errors, installPath));
        else handlers.push({ source: manifest, event: 'PreToolUse', matcher: '', command: '(plugin manifest hooks)', scriptPath: null, scriptSha256: null, trusted: false });
      }
    }
  }

  for (const dir of [...configDirs, ...(projectDir ? [projectDir] : [])]) {
    for (const file of skillAndAgentFiles(dir)) handlers.push(...fromFrontmatter(file, errors));
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
    if (!isObj(h) || typeof h.command !== 'string' || typeof h.scriptPath !== 'string' || !/^[0-9a-f]{64}$/.test(h.sha256 ?? '')) return { ok: false, why: `${file} has a malformed entry` };
    hooks.push({ command: h.command, scriptPath: h.scriptPath, sha256: h.sha256 });
  }
  return { ok: true, hooks, approvedAt: typeof v.approvedAt === 'string' ? v.approvedAt : null };
}

// ---- the check --------------------------------------------------------------------------------------------------------------------------

const tilde = (p, home) => (typeof p === 'string' && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
const matcherText = (h) => (h.matcher === '' ? '*' : h.matcher);
const describe = (h, home) => `${h.scriptPath ? tilde(h.scriptPath, home) : h.command} (${h.event} ${matcherText(h)})`;

const byJson = (a, b) => { const x = JSON.stringify(a); const y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; };
// sha256 over the sorted { source, event, matcher, command, scriptSha256 } list: any added, removed, re-pointed or edited handler changes it.
export const fingerprint = (handlers) => sha256(JSON.stringify(handlers
  .map((h) => ({ source: h.source, event: h.event, matcher: h.matcher, command: h.command, scriptSha256: h.scriptSha256 }))
  .sort(byJson)));

// -> { ok, hookLayersSha256, reason, offenders, handlers, approvedAt }. ok only when every source read, every untrusted handler resolves to one script and is listed with today's bytes.
export function checkDialogHooks({ home = accountHome(), cwd = null, managedPaths } = {}) {
  const found = dialogHandlers({ home, cwd, ...(managedPaths ? { managedPaths } : {}) });
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
    const listed = list.ok ? list.hooks.filter((x) => x.command === h.command && x.scriptPath === h.scriptPath) : [];
    if (listed.length === 0) offenders.push({ kind: 'unlisted', ...h, text: `unlisted dialog hook ${describe(h, home)}` });
    else if (!listed.some((x) => x.sha256 === h.scriptSha256)) offenders.push({ kind: 'changed', ...h, text: `changed dialog hook ${describe(h, home)}: its bytes differ from the approved list` });
  }
  const ok = offenders.length === 0;
  return { ok, hookLayersSha256, reason: ok ? null : offenders[0].text, offenders, handlers: found.handlers, approvedAt: list.ok ? list.approvedAt : null };
}

// The default for owner-go-click.mjs `recordClick({ hookCheck })`: the hook input's cwd is the project the dialog ran in.
export const hookCheck = ({ home, input } = {}) => {
  const r = checkDialogHooks({ home: home ?? accountHome(), cwd: typeof input?.cwd === 'string' ? input.cwd : null });
  return { ok: r.ok, hookLayersSha256: r.hookLayersSha256, reason: r.reason };
};

// ---- approving --------------------------------------------------------------------------------------------------------------------------

// Writes the list from what is installed now. Refuses (nothing written) when any source cannot be read or any untrusted handler does not resolve to one script.
// -> { ok: true, file, hooks, approvedAt } | { ok: false, reason, offenders }
export function approveDialogHooks({ home = accountHome(), cwd = null, now = Date.now, managedPaths } = {}) {
  const found = dialogHandlers({ home, cwd, ...(managedPaths ? { managedPaths } : {}) });
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
    const key = `${h.command}\n${h.scriptPath}\n${h.scriptSha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hooks.push({ command: h.command, scriptPath: h.scriptPath, sha256: h.scriptSha256 });
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

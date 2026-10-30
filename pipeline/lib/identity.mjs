// Why: a version label is only worth printing if it says what the files ARE. `base+sha7` alone did not: the
// installer copied working-tree files and stamped HEAD, and a hand-edited install kept its label. This module is the
// one place that decides identity, from evidence: an installed copy is hashed against its own INSTALLED.json, a
// checkout is compared with HEAD's blobs (and with origin/main, locally, no fetch). The stamp carries what could not be
// proven as suffixes: .modified (files differ from the manifest or are gone), .incomplete (an install that did not
// finish), .unverified (not a clean, published checkout), and `+unknown` when no sha is known.
// Git calls are isolated from the caller's GIT_DIR & co. and bounded by timeouts; nothing here fetches or writes.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';
import * as I from './installer.mjs';

// A caller's GIT_DIR & co. would point git at some other repo than the one being identified. The second line is what
// would let the environment rewrite git's configuration or transport rules behind a call's back (upstream.mjs builds
// its fully isolated git on this same list).
export const GIT_SCRUB = Object.fromEntries(
  [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
    'GIT_TEMPLATE_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_ALLOW_PROTOCOL', 'GIT_SSL_NO_VERIFY', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND',
  ].map((k) => [k, undefined]),
);
export const gitIn = (root, args, extra = {}) => run('git', ['-C', root, ...args], { env: GIT_SCRUB, timeoutMs: 20000, ...extra });

export function gitHead(root) {
  const r = run('git', ['-C', root, 'rev-parse', 'HEAD'], { env: GIT_SCRUB, timeoutMs: 10000 });
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// Whether `root` is the top of its git work tree. An installed copy under ~/.claude can sit inside an unrelated repo
// (dotfiles); stamping that repo's sha would be a lie.
function isToplevel(root) {
  const r = gitIn(root, ['rev-parse', '--show-toplevel'], { timeoutMs: 10000 });
  return r.code === 0 && real(r.stdout.trim()) === real(root);
}

// Are these files exactly what HEAD holds? One `git ls-tree -r HEAD` plus one `git hash-object --stdin-paths` (which
// applies .gitattributes filters, so a Windows checkout's line endings do not read as edits). `files` are absolute
// paths. Returns { head, state, differing }:
//   state 'no-git'       not a checkout / git unavailable (head null)
//   state 'unverifiable' git ran but the comparison could not be made
//   state 'clean'        every file is HEAD's blob
//   state 'dirty'        differing = root-relative POSIX paths not in HEAD, with another blob, or deleted (`deleted`)
// A path in `files` that is not a regular file on disk (gone, an empty directory, a dangling symlink) is deleted. With
// { scope: 'install' } so is any file HEAD holds that the installer would copy (I.installableSourcePaths) and that is
// not in `files`: without that a source file deleted from the working tree is never looked at and the remainder passes
// as HEAD.
export function fileProvenance(root, files, { requireToplevel = false, scope = null } = {}) {
  const head = gitHead(root);
  if (!head) return { head: null, state: 'no-git', differing: [], deleted: [] };
  if (requireToplevel && !isToplevel(root)) return { head: null, state: 'no-git', differing: [], deleted: [] };
  const relOf = (abs) => path.relative(root, abs).split(path.sep).join('/');
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const all = files.map((abs) => ({ abs, rel: relOf(abs) })).sort(byRel);
  // A listed path counts only when a regular file (or a symlink to one) sits there - what the installer's walker counts.
  // An empty directory or a dangling symlink in its place is as gone as a deleted file, and cannot be hashed.
  const planned = all.filter((f) => I.isFile(f.abs));
  const deleted = all.filter((f) => !I.isFile(f.abs)).map((f) => f.rel);
  const paths = planned.map((f) => f.rel);
  const tree = gitIn(root, ['ls-tree', '-r', '-z', 'HEAD']);
  if (tree.code !== 0) return { head, state: 'unverifiable', differing: [], deleted };
  const headBlobs = I.parseLsTree(tree.stdout);
  if (scope === 'install') {
    const have = new Set(all.map((f) => f.rel));
    for (const rel of I.installableSourcePaths(headBlobs.keys())) {
      // Not in the plan = not installed, whatever occupies the path (an empty directory, a dangling symlink, a file the
      // plan did not walk): the install would not carry HEAD's file.
      if (!have.has(rel)) deleted.push(rel);
    }
    deleted.sort();
  }
  // (absolute paths on stdin: hash-object resolves relative ones from the repo top, not from -C)
  const hashed = planned.length === 0 ? { code: 0, stdout: '' } : gitIn(root, ['hash-object', '--stdin-paths'], { input: `${planned.map((f) => f.abs).join('\n')}\n` });
  const hashes = hashed.stdout.split(/\r?\n/).filter(Boolean);
  if (hashed.code !== 0 || hashes.length !== paths.length) return { head, state: 'unverifiable', differing: [], deleted };
  const differing = [...I.pathsDifferingFromHead(paths, headBlobs, hashes), ...deleted].sort();
  return { head, state: differing.length === 0 ? 'clean' : 'dirty', differing, deleted };
}

// Is HEAD contained in the local origin/main? Local ref only (no fetch); no such ref means false.
export function headOnMain(root) {
  return gitIn(root, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { timeoutMs: 10000 }).code === 0;
}

// ---- stamps ---------------------------------------------------------------------------------------------------

export function formatStamp(base, sha, flags = []) {
  return `${base}+${sha ? sha.slice(0, 7) : 'unknown'}${flags.map((f) => `.${f}`).join('')}`;
}

// 'base+sha7.flag.flag' -> { base, sha, flags }; sha is null for `unknown`. Anything else (a hand-made label, a
// stamp from before this scheme with extra text) -> null.
export function parseStamp(text) {
  const m = /^([^+\s]+)\+(unknown|[0-9a-f]{7,64})((?:\.[a-z]+)*)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { base: m[1], sha: m[2] === 'unknown' ? null : m[2], flags: m[3] === '' ? [] : m[3].slice(1).split('.') };
}

// ---- an installed copy -----------------------------------------------------------------------------------------

// Identity of what is installed in `home`, from <home>/pipeline/INSTALLED.json and the files on disk. null when
// nothing usable is installed there. `modified` = manifest files whose bytes differ, `missing` = gone, `extra` = files
// in the installer's own units (pipeline/, the four agents, the three skills) that the manifest does not list; an
// added file changes what runs, so it makes the stamp .modified like an edit does. `scanError` = directories that could
// not be listed, so extras there are unknown; it makes the stamp .modified too (never clean on an unfinished look).
export function installedIdentity(home) {
  const { manifest } = I.readManifest(home);
  if (!manifest) return null;
  const modified = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const file = I.fromRel(home, rel);
    if (!I.lexists(file)) { missing.push(rel); continue; }
    let actual = null;
    try { actual = I.sha256File(file); } catch { /* unreadable counts as modified */ }
    if (actual !== expected) modified.push(rel);
  }
  // Extras are only listed, never hashed, so an unreadable file cannot hide the rest. A directory that cannot be listed,
  // or a scan that throws, leaves what is in it unknown: reported as `scanError` and the stamp is .modified.
  let extra = [];
  let scanError = [];
  try {
    ({ extra, unreadable: scanError } = I.scanExtraInstalledFiles(home, manifest));
  } catch { scanError = ['(installed files could not be scanned)']; }
  const base = String(manifest.version ?? 'unknown');
  const sourceSha = typeof manifest.sourceSha === 'string' && manifest.sourceSha ? manifest.sourceSha : null;
  const complete = I.manifestComplete(manifest);
  const sourceDirty = manifest.sourceDirty === true;
  const flags = [];
  if (modified.length > 0 || missing.length > 0 || extra.length > 0 || scanError.length > 0) flags.push('modified');
  if (!complete) flags.push('incomplete');
  if (sourceDirty) flags.push('unverified');
  return {
    kind: 'installed', base, sourceSha, sha7: sourceSha ? sourceSha.slice(0, 7) : null,
    complete, sourceDirty, modified, missing, extra, scanError, stamp: formatStamp(base, sourceSha, flags),
  };
}

// ---- a checkout ------------------------------------------------------------------------------------------------

// Identity of the git checkout at `root` for the given absolute file paths (the files the stamp is vouching for).
// `root/VERSION` supplies the base and is compared with HEAD as well. provenance = every file is HEAD's blob;
// onMain = HEAD is in the local origin/main. Either missing makes the stamp `.unverified`. A file in `files` that is
// deleted from the working tree (and, with { scope: 'install' }, any installable HEAD file that is) breaks provenance
// and is listed in `missing`.
export function checkoutIdentity(root, files, { scope = null } = {}) {
  let base = 'unknown';
  const versionFile = path.join(root, 'VERSION');
  try { base = fs.readFileSync(versionFile, 'utf8').trim() || 'unknown'; } catch { /* unknown */ }
  const all = I.lexists(versionFile) && !files.includes(versionFile) ? [...files, versionFile] : files;
  const prov = fileProvenance(root, all, { requireToplevel: true, scope });
  const provenance = prov.state === 'clean';
  const onMain = prov.head ? headOnMain(root) : false;
  const sourceSha = prov.head;
  return {
    kind: 'checkout', base, sourceSha, sha7: sourceSha ? sourceSha.slice(0, 7) : null,
    provenance, onMain, modified: prov.differing.filter((p) => !prov.deleted.includes(p)), missing: prov.deleted,
    stamp: formatStamp(base, sourceSha, provenance && onMain ? [] : ['unverified']),
  };
}

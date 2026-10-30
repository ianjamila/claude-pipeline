// Copies the CI-side pipeline code into a project (<repo>/scripts/pipeline/) so the project's own CI runs
// without the global install, and `--check` proves the project copy is still byte-identical to this checkout.
// Why byte-for-byte: CI executes the project copy as its trust anchor, so any divergence (an edit, a stale copy) must be
// visible as drift rather than silently becoming the new rules.
// Source paths are relative to this file only (<commandsDir>/../lib etc.), so the same code works from the git
// checkout (pipeline/ is a child of the repo root) and from the installed copy under ~/.claude/pipeline/.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, UsageError, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { checkoutIdentity, formatStamp, installedIdentity, parseStamp } from '../lib/identity.mjs';
import { repoRoot } from '../lib/repo.mjs';

export const meta = {
  summary: 'copy the CI-side scripts into a project (scripts/pipeline/); --check reports drift',
  usage: 'pipeline vendor --repo DIR [--check]',
};

const LIBS = ['proc', 'paths', 'yaml', 'config', 'glob', 'diff', 'git', 'hardstops', 'risk', 'integrity', 'locks', 'guard-provenance', 'review-marker', 'resolution'];
const ENTRIES = ['ci-guard', 'ci-guards-run', 'smoke', 'supabase-local'];
// Entries an earlier vendor copied and this one no longer does. A leftover scripts/pipeline/<name>.mjs is removed by vendor (that
// exact file only) and is drift for --check.
const RETIRED_ENTRIES = ['stop-verify'];
const DEST = ['scripts', 'pipeline'];
const VERSION_FILE = 'VERSION';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const posix = (...parts) => parts.join('/');

// Everything that depends on where this file lives, in one place.
function layout() {
  const commandsDir = dirname(fileURLToPath(import.meta.url));
  const pipelineDir = resolve(commandsDir, '..');
  const versionDir = [resolve(commandsDir, '..', '..'), pipelineDir].find((d) => existsSync(join(d, VERSION_FILE))) ?? null;
  return {
    libDir: join(pipelineDir, 'lib'),
    templatesDir: join(pipelineDir, 'templates', 'scripts', 'pipeline'),
    vendorDir: join(pipelineDir, 'vendor'),
    pipelineDir,
    versionDir,
  };
}

// The identity stamped into scripts/pipeline/VERSION comes from where vendor runs (lib/identity.mjs): an installed
// copy is hashed against its own INSTALLED.json, a checkout is compared with HEAD and the local origin/main over
// exactly the files vendor copies. A label that cannot be proven carries .modified / .incomplete / .unverified or
// +unknown instead of passing for a clean build. Returns { base, stamp }.
function vendorIdentity({ versionDir, pipelineDir }, items) {
  if (existsSync(join(pipelineDir, 'INSTALLED.json'))) {
    const id = installedIdentity(resolve(pipelineDir, '..'));
    if (id) return { base: id.base, stamp: id.stamp };
    let base = 'unknown';
    try { base = readFileSync(join(pipelineDir, VERSION_FILE), 'utf8').trim() || 'unknown'; } catch { /* unknown */ }
    return { base, stamp: formatStamp(base, null, ['unverified']) };
  }
  if (!versionDir) return { base: 'unknown', stamp: formatStamp('unknown', null, ['unverified']) };
  const id = checkoutIdentity(versionDir, items.map((i) => i.src));
  return { base: id.base, stamp: id.stamp };
}

// [{ rel (inside scripts/pipeline), src }] for every copied file; VERSION is generated, so it is not in the list.
function manifest(l) {
  return [
    ...ENTRIES.map((n) => ({ rel: `${n}.mjs`, src: join(l.templatesDir, `${n}.mjs`) })),
    ...LIBS.map((n) => ({ rel: posix('lib', `${n}.mjs`), src: join(l.libDir, `${n}.mjs`) })),
    { rel: posix('vendor', 'js-yaml.mjs'), src: join(l.vendorDir, 'js-yaml.mjs') },
  ];
}

const repoRel = (rel) => posix(...DEST, rel);

// Project settings files that may still run the removed Stop hook. Warn only: the project's settings are never edited here.
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];
function stopVerifyWarnings(root) {
  const out = [];
  for (const name of SETTINGS_FILES) {
    try {
      const settings = JSON.parse(readFileSync(join(root, '.claude', name), 'utf8'));
      if (!JSON.stringify(settings?.hooks?.Stop ?? null).includes('stop-verify')) continue;
      out.push(`.claude/${name} still has a hook that runs scripts/pipeline/stop-verify.mjs, which vendor removes (the Stop hook is retired): remove that Stop hook entry from .claude/${name}, or every stop will try to run a missing file`);
    } catch { /* missing, unreadable or not JSON: nothing to say */ }
  }
  return out;
}
// The retired entries still lying in <repo>/scripts/pipeline (a file or a symlink; a directory under that name is not ours).
function retiredFiles(target) {
  const found = [];
  for (const n of RETIRED_ENTRIES) {
    const dest = join(target, `${n}.mjs`);
    let st;
    try { st = lstatSync(dest); } catch { continue; }
    if (st.isFile() || st.isSymbolicLink()) found.push({ rel: `${n}.mjs`, dest });
  }
  return found;
}

// Content drift of a project's scripts/pipeline/ from the code this pipeline would vendor: [{ file, reason }] for every
// file that is missing, whose bytes differ, or that is a retired entry still lying there (empty = identical). Only bytes
// count: the VERSION stamp's +sha moves with every pipeline commit and says nothing about the copied code. Takes the repo
// root from the caller and runs no git.
export function vendorDrift(root, items = manifest(layout())) {
  const target = join(root, ...DEST);
  const drift = [];
  for (const it of items) {
    const dest = join(target, it.rel);
    if (!existsSync(dest)) drift.push({ file: repoRel(it.rel), reason: 'missing' });
    else if (sha256(dest) !== sha256(it.src)) drift.push({ file: repoRel(it.rel), reason: 'differs' });
  }
  for (const f of retiredFiles(target)) drift.push({ file: repoRel(f.rel), reason: 'retired' });
  return drift;
}

// Why a project's VERSION stamp proves nothing about the vendored code, or null when it is a clean, sha-bearing one.
function stampWarning(text) {
  const p = parseStamp(text);
  if (!p) return `${repoRel(VERSION_FILE)} (${JSON.stringify(text)}) is not a version stamp`;
  const problems = [];
  if (!p.sha) problems.push('no source sha');
  for (const f of p.flags) if (['unverified', 'modified', 'incomplete'].includes(f)) problems.push(`.${f}`);
  if (problems.length === 0) return null;
  return `${repoRel(VERSION_FILE)} is stamped ${text} (${problems.join(', ')}): it does not prove which pipeline commit these files came from; run \`pipeline vendor\` from a clean, published checkout or install to restamp`;
}

// What a project's .gitattributes must say so that vendored bytes survive a checkout: with Git for Windows' default
// autocrlf=true every vendored .mjs would be rewritten to CRLF and `vendor --check` (a byte comparison) would report
// drift; the POSIX shim must stay LF or `sh` chokes on it.
const ATTRIBUTES = ['scripts/pipeline/** -text', 'scripts/verify text eol=lf'];
const ATTRIBUTES_NOTE = '# claude-pipeline: vendored scripts are byte-exact (vendor --check); the POSIX shim must keep LF endings';
const attributeLines = (text) => new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean));

// Appends whichever ATTRIBUTES lines are missing (idempotent: a second run changes nothing). Returns what it added.
function ensureAttributes(root) {
  const file = join(root, '.gitattributes');
  const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = attributeLines(have);
  const missing = ATTRIBUTES.filter((l) => !present.has(l));
  if (missing.length === 0) return [];
  const eol = have.includes('\r\n') ? '\r\n' : '\n';
  const head = have === '' || have.endsWith('\n') ? '' : eol;
  const note = present.has(ATTRIBUTES_NOTE) ? [] : [ATTRIBUTES_NOTE];
  writeFileSync(file, `${have}${head}${[...note, ...missing].join(eol)}${eol}`);
  return missing;
}

export async function run(argv) {
  const { values } = parseCommandArgs(argv, { repo: { type: 'string' }, check: { type: 'boolean' } }, { allowPositionals: false });
  const dir = requireOption(values, 'repo');
  let root;
  try {
    root = repoRoot(resolve(dir));
  } catch {
    throw new UsageError(`not a git repository: ${dir}`);
  }
  const l = layout();
  const items = manifest(l);
  for (const it of items) {
    if (!existsSync(it.src)) throw new Error(`pipeline source file is missing: ${it.src}`);
  }
  const target = join(root, ...DEST);
  const { base, stamp: version } = vendorIdentity(l, items);
  const allFiles = [...items.map((i) => repoRel(i.rel)), repoRel(VERSION_FILE)];

  if (values.check) {
    const drift = vendorDrift(root, items);
    // The +sha moves with every pipeline commit and says nothing about the copied code, so only the base version counts.
    const vfile = join(target, VERSION_FILE);
    if (!existsSync(vfile)) drift.push({ file: repoRel(VERSION_FILE), reason: 'missing' });
    else {
      const have = readFileSync(vfile, 'utf8').trim().split('+')[0];
      if (have !== base) drift.push({ file: repoRel(VERSION_FILE), reason: `version ${have} != pipeline ${base}` });
    }
    const stopWarnings = stopVerifyWarnings(root);
    if (drift.length > 0) return { exitCode: EXIT.FAILED, output: { ok: false, drift, ...(stopWarnings.length ? { warnings: stopWarnings } : {}) } };
    const gaFile = join(root, '.gitattributes');
    const present = attributeLines(existsSync(gaFile) ? readFileSync(gaFile, 'utf8') : '');
    const unpinned = ATTRIBUTES.filter((l) => !present.has(l));
    const stamp = readFileSync(vfile, 'utf8').trim();
    const warnings = [
      ...stopWarnings,
      ...(unpinned.length ? [`.gitattributes lacks ${unpinned.map((l) => JSON.stringify(l)).join(', ')}: with autocrlf a Windows checkout rewrites the vendored files and this check reports drift; run \`pipeline vendor\` to add it`] : []),
      ...[stampWarning(stamp)].filter(Boolean),
    ];
    return { exitCode: EXIT.OK, output: { ok: true, files: allFiles, version: stamp, ...(warnings.length ? { warnings } : {}) } };
  }

  for (const it of items) {
    const dest = join(target, it.rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(it.src, dest);
  }
  // Only the named retired files, nothing else in the project.
  const removed = retiredFiles(target).map((f) => { unlinkSync(f.dest); return repoRel(f.rel); });
  writeFileSync(join(target, VERSION_FILE), `${version}\n`);
  const attributesAdded = ensureAttributes(root);
  const warnings = stopVerifyWarnings(root);
  return { exitCode: EXIT.OK, output: { ok: true, files: allFiles, version, gitattributes: attributesAdded, removed, ...(warnings.length ? { warnings } : {}) } };
}


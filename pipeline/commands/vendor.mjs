// Copies the CI-side pipeline code into a project (<repo>/scripts/pipeline/) so the project's own CI and Stop hook run
// without the global install, and `--check` proves the project copy is still byte-identical to this checkout.
// Why byte-for-byte: CI executes the project copy as its trust anchor, so any divergence (an edit, a stale copy) must be
// visible as drift rather than silently becoming the new rules.
// Source paths are relative to this file only (<commandsDir>/../lib etc.), so the same code works from the git
// checkout (pipeline/ is a child of the repo root) and from the installed copy under ~/.claude/pipeline/.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, UsageError, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { git } from '../lib/git.mjs';
import { repoRoot } from '../lib/repo.mjs';

export const meta = {
  summary: 'copy the CI-side scripts into a project (scripts/pipeline/); --check reports drift',
  usage: 'pipeline vendor --repo DIR [--check]',
};

const LIBS = ['proc', 'paths', 'yaml', 'config', 'glob', 'diff', 'git', 'hardstops', 'risk', 'integrity', 'locks'];
const ENTRIES = ['ci-guard', 'ci-guards-run', 'stop-verify', 'smoke', 'supabase-local'];
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

// Base version from VERSION, else INSTALLED.json (what `pipeline version` falls back to for an installed copy).
function baseVersion({ versionDir, pipelineDir }) {
  if (versionDir) return readFileSync(join(versionDir, VERSION_FILE), 'utf8').trim();
  try {
    return String(JSON.parse(readFileSync(join(pipelineDir, 'INSTALLED.json'), 'utf8')).version);
  } catch {
    return 'unknown';
  }
}

// Short sha of THIS pipeline checkout. Only trusted when the git root is exactly the directory holding VERSION:
// an installed copy under ~/.claude/pipeline can sit inside an unrelated git repo (dotfiles), and stamping that
// repo's sha would be a lie, so it says "unknown" instead.
function pipelineSha({ versionDir }) {
  if (!versionDir) return 'unknown';
  try {
    const top = git(['rev-parse', '--show-toplevel'], { cwd: versionDir }).trim();
    if (realpathSync(top) !== realpathSync(versionDir)) return 'unknown';
    return git(['rev-parse', '--short', 'HEAD'], { cwd: versionDir }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
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
  const version = `${baseVersion(l)}+${pipelineSha(l)}`;
  const allFiles = [...items.map((i) => repoRel(i.rel)), repoRel(VERSION_FILE)];

  if (values.check) {
    const drift = [];
    for (const it of items) {
      const dest = join(target, it.rel);
      if (!existsSync(dest)) drift.push({ file: repoRel(it.rel), reason: 'missing' });
      else if (sha256(dest) !== sha256(it.src)) drift.push({ file: repoRel(it.rel), reason: 'differs' });
    }
    // The +sha moves with every pipeline commit and says nothing about the copied code, so only the base version counts.
    const vfile = join(target, VERSION_FILE);
    if (!existsSync(vfile)) drift.push({ file: repoRel(VERSION_FILE), reason: 'missing' });
    else {
      const have = readFileSync(vfile, 'utf8').trim().split('+')[0];
      const want = version.split('+')[0];
      if (have !== want) drift.push({ file: repoRel(VERSION_FILE), reason: `version ${have} != pipeline ${want}` });
    }
    if (drift.length > 0) return { exitCode: EXIT.FAILED, output: { ok: false, drift } };
    const gaFile = join(root, '.gitattributes');
    const present = attributeLines(existsSync(gaFile) ? readFileSync(gaFile, 'utf8') : '');
    const unpinned = ATTRIBUTES.filter((l) => !present.has(l));
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true, files: allFiles, version: readFileSync(vfile, 'utf8').trim(),
        ...(unpinned.length ? { warnings: [`.gitattributes lacks ${unpinned.map((l) => JSON.stringify(l)).join(', ')}: with autocrlf a Windows checkout rewrites the vendored files and this check reports drift; run \`pipeline vendor\` to add it`] } : {}),
      },
    };
  }

  for (const it of items) {
    const dest = join(target, it.rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(it.src, dest);
  }
  writeFileSync(join(target, VERSION_FILE), `${version}\n`);
  const attributesAdded = ensureAttributes(root);
  return { exitCode: EXIT.OK, output: { ok: true, files: allFiles, version, gitattributes: attributesAdded } };
}


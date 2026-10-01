// The only way the pipeline reads git. Three jobs: PR diffs for hard-stop/integrity checks, a content hash that proves
// the code that was reviewed is the code being merged, and a working-tree fingerprint that binds a verify report to
// one exact tree. Because those outputs feed trust decisions, git() forces the config that shapes its output (a user's
// diff.noprefix or core.quotePath must not change what the parser sees) and LC_ALL=C (stderr is matched by text).
// Reads go through proc.run, so output is decoded as UTF-8: invalid UTF-8 inside a diffed text file is not byte-exact.
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.mjs';
import { parseUnifiedDiff } from './diff.mjs';

export class GitError extends Error {
  constructor({ args, code, stderr }) {
    super(`git ${args.join(' ')} failed (exit ${code})${stderr && stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

const FORCED_CONFIG = [
  '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.renames=true', '-c', 'color.ui=false', '-c', 'core.autocrlf=false',
];
// GIT_OPTIONAL_LOCKS=0: these are reads; they must never fight a concurrent git for the index lock.
const GIT_ENV = { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

// Runs git with forced config and returns stdout untouched (callers trim what they need to).
export function git(args, { cwd, run: runFn = run, input } = {}) {
  const r = runFn('git', [...FORCED_CONFIG, ...args], { cwd, env: GIT_ENV, input });
  if (r.code !== 0) throw new GitError({ args, code: r.code, stderr: r.stderr });
  return r.stdout;
}

// A ref that starts with `-` would be read by git as an option (`--output=<file>` writes files), and an empty ref
// turns `<ref>:<path>` into "the index". Refuse both before git sees them. 129 is git's own usage-error code.
function assertRef(ref, args) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) {
    throw new GitError({ args, code: 129, stderr: `refusing unsafe ref ${JSON.stringify(ref)}` });
  }
  return ref;
}

// Runs git and maps one exit code to `null` (the caller's "answer is no", e.g. grep found nothing); anything else throws.
function gitOrNull(args, expectedCode, o) {
  try {
    return git(args, o);
  } catch (e) {
    if (e instanceof GitError && e.code === expectedCode) return null;
    throw e;
  }
}

export function mergeBase(a, b, o) {
  const args = ['merge-base', assertRef(a, ['merge-base', a, b]), assertRef(b, ['merge-base', a, b])];
  const out = gitOrNull(args, 1, o); // exit 1 and no stderr: the two histories share no commit
  if (out === null) throw new GitError({ args, code: 1, stderr: `no common ancestor between ${a} and ${b}` });
  return out.trim();
}

export const headSha = (o) => git(['rev-parse', 'HEAD'], o).trim();

// `HEAD` when detached. Reads the full ref instead of using --short/--abbrev-ref, which print `heads/x` when a tag
// has the same name as the branch.
export function currentBranch(o) {
  const ref = gitOrNull(['symbolic-ref', '-q', 'HEAD'], 1, o); // exit 1 with -q: HEAD is not a symbolic ref
  return ref === null ? 'HEAD' : ref.trim().replace(/^refs\/heads\//, '');
}

export const isClean = (o) => git(['status', '--porcelain=v1', '-uall'], o) === '';

export const revParse = (ref, o) => git(['rev-parse', '--verify', assertRef(ref, ['rev-parse', '--verify', ref])], o).trim();

// What the branch changes relative to where it forked: the diff is taken from the merge-base, not from `base`'s tip,
// so commits that landed on base after the fork never show up as the branch deleting them.
export function diffFiles(base, head, o) {
  const mb = mergeBase(base, head, o);
  const text = git([
    'diff', '-M', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/',
    `${mb}..${assertRef(head, ['diff', head])}`,
  ], o);
  return parseUnifiedDiff(text);
}

const MISSING_PATH = /does not exist|exists on disk, but not in/;

// File content at a ref, or null when the path is not in that tree. A bad ref still throws: treating a typo'd ref as
// "file absent" would let an integrity check pass vacuously.
export function showFile(ref, path, o) {
  try {
    return git(['show', `${assertRef(ref, ['show', ref])}:${path}`], o);
  } catch (e) {
    if (e instanceof GitError && e.code === 128 && MISSING_PATH.test(e.stderr)) return null;
    throw e;
  }
}

// Does `fixedString` occur anywhere in the tree at `ref`? (-F: literal text, never a regex.)
export function grepAtRef(ref, fixedString, o) {
  // git splits a -F pattern on newlines and ORs the pieces, which would turn "a\nb" into "a or b" without a word.
  if (fixedString.includes('\n')) throw new TypeError('grepAtRef: fixedString must be a single line');
  const hit = gitOrNull(['grep', '-F', '-q', '-e', fixedString, assertRef(ref, ['grep', ref]), '--'], 1, o);
  return hit !== null;
}

// Committer time in epoch ms. `^{commit}` peels annotated tags, which `git show` would otherwise print as a tag first.
export function commitTime(sha, o) {
  const out = git(['show', '-s', '--format=%ct', `${assertRef(sha, ['show', sha])}^{commit}`], o).trim();
  const seconds = Number(out);
  if (!/^\d+$/.test(out)) throw new GitError({ args: ['show', '-s', '--format=%ct', sha], code: 0, stderr: `unexpected commit time: ${out}` });
  return seconds * 1000;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
// `index <old>..<new> [mode]`. Content lines start with + - or space and binary payload lines cannot contain a space,
// so a line starting `index ` is always this header.
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/;

// Makes a diff independent of where in the file, and on top of which base, the change sits:
// `@@ -a,b +c,d @@ <function context>` becomes `@@`, and the `index` blob ids are dropped. Both move whenever the base
// edits the same file (verified: hunk header AND index line change), so keeping either would defeat the point.
// Split on \n by hand: a regex `^` with /m also matches after U+2028/U+2029/\r inside content, which would let a
// crafted content line be rewritten.
function normaliseDiff(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (HUNK_HEADER.test(line)) out.push('@@');
    else if (!INDEX_LINE.test(line)) out.push(line);
  }
  return out.join('\n');
}

// sha256 of the changes the branch makes (-U0, binary-safe), insensitive to pure line shifts from a base update and
// sensitive to every byte of changed content, whitespace included. `exclude` paths (e.g. an agent log the pipeline
// itself appends to) are left out. Pathspecs are anchored at the repo root so cwd cannot narrow what is hashed.
export function contentHash(base, head, { exclude = [], ...o } = {}) {
  const mb = mergeBase(base, head, o);
  const text = git([
    'diff', '-U0', '--binary', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/',
    `${mb}..${assertRef(head, ['diff', head])}`, '--', ':/', ...exclude.map((p) => `:(top,exclude)${p}`),
  ], o);
  return createHash('sha256').update(normaliseDiff(text)).digest('hex');
}

// Streams the file so a large untracked artifact does not have to fit in memory.
function sha256OfFile(abs) {
  const h = createHash('sha256');
  const fd = openSync(abs, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

// Untracked entries are normally files; `ls-files --others` also reports symlinks (which may dangle) and nested repos
// (as `dir/`), neither of which readFile would survive. Tagged so they cannot collide with a plain file digest.
function digestEntry(abs) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return `symlink:${createHash('sha256').update(readlinkSync(abs)).digest('hex')}`;
  if (st.isDirectory()) return 'dir:';
  return sha256OfFile(abs);
}

// sha256 of HEAD + every tracked change vs HEAD (staged or not) + every untracked, non-ignored file with its bytes.
// Equal fingerprints mean the same tree; a verify report that carries one is bound to exactly that tree.
export function treeFingerprint(o) {
  const hash = createHash('sha256');
  hash.update(headSha(o));
  hash.update('\0');
  hash.update(git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'], o));
  hash.update('\0');
  const top = git(['rev-parse', '--show-toplevel'], o).trim();
  // `-- :/` + --full-name: every untracked file in the repo, named from the root, whatever the cwd.
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', ':/'], o)
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const rel of untracked) {
    hash.update(rel);
    hash.update('\0');
    hash.update(digestEntry(join(top, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

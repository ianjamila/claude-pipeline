// The only way the pipeline reads git. Three jobs: PR diffs for hard-stop/integrity checks, a content hash that proves
// the code that was reviewed is the code being merged, and a working-tree fingerprint that binds a verify report to
// one exact tree. Because those outputs feed trust decisions, git() pins everything that could change them: the config
// that shapes diff output (a user's diff.noprefix or core.quotePath must not change what the parser sees), LC_ALL=C
// (stderr is matched by text), and the GIT_* variables that would silently point git at a different repository.
// Fail closed: a git that did not run, was killed or timed out is an error, never an answer ("no match", "no such
// file", "detached"). Only git's own documented answers (see gitOrNull, showFile) are mapped to false/null/'HEAD'.
// Reads go through proc.run, so output is decoded as UTF-8: invalid UTF-8 inside a diffed text-looking file is not
// byte-exact (binary files are: --binary emits ASCII).
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.mjs';
import { parseUnifiedDiff } from './diff.mjs';

// Upper bound for a git call that talks to a remote (fetch, push, ls-remote): a hung one inside a lock cannot be reclaimed.
export const NETWORK_TIMEOUT_MS = 120_000;

export class GitError extends Error {
  constructor({ args, code, stderr }) {
    super(`git ${args.join(' ')} failed (exit ${code})${stderr && stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    this.name = 'GitError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

// interHunkContext/algorithm/indentHeuristic decide where git cuts hunks and which of several equal diffs it prints, so
// leaving them to user config would let the same change hash differently on two machines.
const FORCED_CONFIG = [
  '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.renames=true', '-c', 'color.ui=false',
  '-c', 'diff.interHunkContext=0', '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=true',
];
// core.autocrlf is deliberately NOT forced for status / working-tree reads / `diff HEAD`: with Git for Windows' default
// (autocrlf=true) a CRLF working file is the same content as its LF blob, and forcing false would make isClean() false
// and move treeFingerprint after merely touching such a file. Commit-to-commit diffs read blobs only, but pin it there
// anyway so their bytes cannot depend on a user's setting.
const STABLE_CONFIG = ['-c', 'core.autocrlf=false'];
// GIT_OPTIONAL_LOCKS=0: these are reads; they must never fight a concurrent git for the index lock.
const GIT_ENV = { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
// Variables that make git operate on some other repository than `cwd` (a hook or wrapper leaves them behind).
// An undefined value removes the variable from the child's environment (proc.run merges over process.env).
const SCRUBBED_ENV = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
].map((k) => [k, undefined]));

// Runs git with forced config; returns the raw result unless the process did not finish on its own. `env` is the
// one way to point git elsewhere on purpose (e.g. GIT_CEILING_DIRECTORIES in a test).
// `timeoutMs` bounds a call that can hang on the network (fetch, push); a timeout is a GitError like any other.
function exec(args, { cwd, run: runFn = run, input, env, timeoutMs } = {}) {
  const r = runFn('git', [...FORCED_CONFIG, ...args], { cwd, env: { ...SCRUBBED_ENV, ...GIT_ENV, ...env }, input, ...(timeoutMs ? { timeoutMs } : {}) });
  const abnormal = r.timedOut ? 'timed out' : r.signal ? `terminated by signal ${r.signal}` : null;
  if (abnormal) {
    throw new GitError({ args, code: r.code, stderr: [abnormal, (r.stderr ?? '').trim()].filter(Boolean).join(': ') });
  }
  return r;
}

// Returns stdout untouched (callers trim what they need to); throws GitError on any non-zero exit.
export function git(args, o) {
  const r = exec(args, o);
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

// Runs git and maps git's own "no" to `null` (grep found nothing, HEAD is not a symbolic ref, no merge base). That
// answer is exactly `expectedCode` with NOTHING on stderr. proc.run reports a spawn failure (missing git, missing cwd)
// as code 1 with the error text on stderr, and a killed child as code 1 and an empty stderr plus `signal`; both are
// told apart here, so only a real answer from a git that ran is ever swallowed. Everything else throws.
function gitOrNull(args, expectedCode, o) {
  const r = exec(args, o); // throws for signals and timeouts
  if (r.code === 0) return r.stdout;
  if (r.code === expectedCode && (r.stderr ?? '').trim() === '') return null;
  throw new GitError({ args, code: r.code, stderr: r.stderr });
}

export function mergeBase(a, b, o) {
  const args = ['merge-base', assertRef(a, ['merge-base', a, b]), assertRef(b, ['merge-base', a, b])];
  const out = gitOrNull(args, 1, o); // exit 1 and no stderr: the two histories share no commit
  if (out === null) throw new GitError({ args, code: 1, stderr: `no common ancestor between ${a} and ${b}` });
  return out.trim();
}

// Is `a` an ancestor of (or equal to) `b`? git's exit 1 (with nothing on stderr) is the answer "no"; a commit git does
// not know (exit 128) still throws, so a missing object can never read as "no".
export const isAncestor = (a, b, o) => gitOrNull(['merge-base', '--is-ancestor', assertRef(a, ['merge-base', a, b]), assertRef(b, ['merge-base', a, b])], 1, o) !== null;

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
// --text: a NUL byte in a comment, or a `*.ts -diff` line in .gitattributes, makes git print "Binary files differ" and
// no lines at all, which would hide an added `.skip` or a deleted test from every check built on this. --no-textconv /
// --no-ext-diff: a repo-configured converter or external diff tool must not rewrite what we parse (or run at all).
export function diffFiles(base, head, o) {
  const mb = mergeBase(base, head, o);
  const text = git([
    ...STABLE_CONFIG, 'diff', '-M', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--src-prefix=a/', '--dst-prefix=b/',
    `${mb}..${assertRef(head, ['diff', head])}`,
  ], o);
  return parseUnifiedDiff(text);
}

// Tree modes of every change diffFiles reports, from `git diff --raw -z` with the SAME options, base and head: a 100% rename
// has no `mode` line in the unified diff, so a symlink (120000) or submodule (160000) that merely MOVES is invisible there.
// -> [{ oldMode, newMode, status, oldPath, newPath }] (a path is null on the side that does not exist).
export function diffModes(base, head, o) {
  const mb = mergeBase(base, head, o);
  const text = git([
    ...STABLE_CONFIG, 'diff', '-M', '--raw', '-z', '--no-abbrev', '--no-color', '--no-ext-diff', '--no-textconv',
    `${mb}..${assertRef(head, ['diff', head])}`,
  ], o);
  const parts = text.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const m = /^:(\d+) (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]);
    if (!m) {
      if (parts[i] === '') { i++; continue; }
      throw new GitError({ args: ['diff', '--raw', '-z'], code: 0, stderr: `unexpected raw diff entry: ${parts[i]}` });
    }
    const two = m[3] === 'R' || m[3] === 'C';
    const first = parts[i + 1];
    const second = two ? parts[i + 2] : first;
    if (first === undefined || second === undefined) throw new GitError({ args: ['diff', '--raw', '-z'], code: 0, stderr: 'truncated raw diff' });
    out.push({ oldMode: m[1], newMode: m[2], status: m[3], oldPath: m[3] === 'A' ? null : first, newPath: m[3] === 'D' ? null : second });
    i += two ? 3 : 2;
  }
  return out;
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
// What is left per hunk is the change plus its context lines, which is what pins an edit to its location.
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

// sha256 proving "the code that was reviewed is the code being merged" without breaking on a routine base update.
// The input is `git diff --unified=3 --binary <merge-base>..<head>`, normalised, so the hash COVERS:
//   - every added/removed line, byte for byte (whitespace and CRLF included), and 3 unchanged lines of context on each
//     side of every change (nearby changes merge into one hunk, as git does);
//   - file paths, add/delete/rename/mode changes, and the full content of binary files (--binary: ASCII base85).
// and does NOT cover (so these never move the hash): line numbers, the function name git prints after `@@`, and the
// `index <blob>..<blob>` ids. Hence:
//   - an identical edit moved to a different place changes the hash, because its context changes;
//   - a base update that edits the same file MORE than 3 lines from every hunk leaves the hash alone (the line shift is
//     invisible), while one that edits a line WITHIN 3 lines of a hunk changes it. That is accepted on purpose: the
//     reviewed hunk now sits in different surroundings, so the safe answer is "re-review";
//   - blind spots: moving a change between two places with identical 3-line context, and invalid UTF-8 inside a
//     text-looking file (proc.run decodes UTF-8) both go unnoticed.
// No --text here, unlike diffFiles: --text turns binary files into raw bytes, which the UTF-8 decode would collapse
// (0xFE and 0xFD both become U+FFFD), whereas --binary alone keeps NUL and `-diff` files byte-exact.
// `exclude` paths (e.g. an agent log the pipeline itself appends to) are left out: each is a literal repo-root-relative
// path (`:(top,exclude,literal)`), so `*.js` is not a glob and `docs/x.md` does not match `sub/docs/x.md`. Pathspecs
// are anchored at the repo root so cwd cannot narrow what is hashed.
export function contentHash(base, head, { exclude = [], ...o } = {}) {
  const mb = mergeBase(base, head, o);
  const text = git([
    ...STABLE_CONFIG, 'diff', '--unified=3', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
    `${mb}..${assertRef(head, ['diff', head])}`, '--', ':/', ...exclude.map((p) => `:(top,exclude,literal)${p}`),
  ], o);
  return createHash('sha256').update(normaliseDiff(text)).digest('hex');
}

// `origin/<branch>` is what a PR will be merged into; a repo without that remote ref (a fresh clone of a local fixture,
// a test) falls back to the local branch. Any other git failure is not swallowed.
export function reviewBaseRef(branch, o) {
  const remote = `origin/${branch}`;
  try {
    revParse(remote, o);
    return remote;
  } catch (err) {
    if (err instanceof GitError) return branch;
    throw err;
  }
}

// THE content hash of "the code that was reviewed": what HEAD changes relative to where it forked from the PR base,
// minus the agent log the pipeline itself appends to. The review loop (round coverage, review-complete) and the final
// gate / merge both call this, so they cannot disagree about whether a review is current.
//
// `head` (default 'HEAD') and `baseSha` (default: the resolved review base ref) let a caller hash an arbitrary commit
// that is only present as objects (a PR head fetched, not checked out) against an explicit base; this stays the one
// definition, so `ship inbox` / `ship resume` agree byte for byte with the review loop and the final gate.
export function reviewContentHash({ branch, agentLog, head = 'HEAD', baseSha } = {}, o) {
  return contentHash(baseSha ?? reviewBaseRef(branch, o), head, { ...o, exclude: agentLog ? [agentLog] : [] });
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
  // No --text: --binary already makes NUL and `-diff` files exact and compact (the `index` blob ids stay in this diff, so
  // even a lossy decode could not hide a change), where --text would dump whole binaries as raw text. --no-textconv:
  // a configured converter must not decide what counts as a change.
  hash.update(git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-textconv'], o));
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

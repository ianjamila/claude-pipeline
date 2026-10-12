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

export const headSha = (o) => git(['rev-parse', 'HEAD'], o).trim();

// `HEAD` when detached. Reads the full ref instead of using --short/--abbrev-ref, which print `heads/x` when a tag
// has the same name as the branch.
export function currentBranch(o) {
  const ref = gitOrNull(['symbolic-ref', '-q', 'HEAD'], 1, o); // exit 1 with -q: HEAD is not a symbolic ref
  return ref === null ? 'HEAD' : ref.trim().replace(/^refs\/heads\//, '');
}

export const isClean = (o) => git(['status', '--porcelain=v1', '-uall'], o) === '';

export const revParse = (ref, o) => git(['rev-parse', '--verify', assertRef(ref, ['rev-parse', '--verify', ref])], o).trim();

// A binary change is left out of the --text diff (see diffFiles) only when it is BOTH big and in a document/media/archive
// format from this list. The size alone must not decide: a source file with one NUL byte is "binary" to git too, and
// skipping it would hide its lines from every check. Matched on the extension (lower case) of every path of the change.
export const LARGE_BINARY_BYTES = 4 * 1024 * 1024; // the larger blob of the change; diffFiles' option largeBinaryBytes overrides it (tests)
// Many files each under that limit can still add up past proc.run's buffer. So the listed-format binary changes LEFT in the
// text diff are also capped in total (bytes git could print for them: old blob + new blob each); beyond it the largest go
// first. Option largeBinaryTotalBytes overrides it (tests).
export const LARGE_BINARY_TOTAL_BYTES = 32 * 1024 * 1024;
const BINARY_FORMAT_EXTENSIONS = new Set([
  'xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'numbers', 'pdf', 'doc', 'docx', 'ppt', 'pptx',
  'zip', '7z', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'ico',
  'mp3', 'mp4', 'm4a', 'mov', 'webm', 'wav', 'ogg', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'sqlite3', 'db', 'mdb', 'accdb', 'parquet',
]);
const isBinaryFormat = (p) => {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_FORMAT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};
// A change between plain files only: a symlink or submodule entry is never skipped, whatever it is called.
const PLAIN_MODES = new Set(['000000', '100644', '100755']);

// Which changes of from..to to keep OUT of a text diff (--text, or --binary in contentHash / reviewPatch), plus git's own order
// of every change (path -> position) so the result can be put back in that order. Asks git, WITHOUT --text, which changes it calls binary (--numstat -z prints "-\t-"
// for them; a rename is "-\t-\t\0old\0new\0"), then keeps those that are big and in a listed document format. A byte-identical
// move prints no content either way, so it is never skipped. Blob sizes come from one cat-file call. Entries come back as
// rawChanges plus `size` (the larger blob) and `printed` (old + new blob, what the text diff would print for the change). Anything unclear (a blob
// git cannot size) leaves the change in the diff: today's behaviour, never a hidden file.
function largeBinaryChanges(from, to, o) {
  const numstat = git([
    ...STABLE_CONFIG, 'diff', '-M', '--numstat', '-z', '--no-color', '--no-ext-diff', '--no-textconv',
    `${from}..${assertRef(to, ['diff', to])}`,
  ], o).split('\0');
  const binary = new Set();
  for (let i = 0; i < numstat.length; ) {
    const m = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(numstat[i]);
    if (!m) {
      if (numstat[i] === '') { i++; continue; }
      throw new GitError({ args: ['diff', '--numstat', '-z'], code: 0, stderr: `unexpected numstat entry: ${numstat[i]}` });
    }
    const renamed = m[3] === '';
    const key = renamed ? numstat[i + 2] : m[3]; // where the change lives: the new path for a rename
    if (key === undefined) throw new GitError({ args: ['diff', '--numstat', '-z'], code: 0, stderr: 'truncated numstat' });
    if (m[1] === '-' && m[2] === '-') binary.add(key);
    i += renamed ? 3 : 1;
  }
  if (binary.size === 0) return { skipped: [], order: new Map() };

  const changes = rawChanges(from, to, o);
  const order = new Map(changes.map((c, i) => [c.newPath ?? c.oldPath, i]));
  // A literal exclude pathspec also matches everything UNDER the path, so a change whose path becomes (or was) a directory of
  // another change in the range is never skipped: skipping "data.xlsx" would hide "data.xlsx/payload.js" with it.
  const everyPath = changes.flatMap((c) => [c.oldPath, c.newPath]).filter(Boolean);
  const hasDescendant = (c) => [c.oldPath, c.newPath].filter(Boolean).some((p) => everyPath.some((q) => q.startsWith(`${p}/`)));
  const candidates = changes.filter((c) => binary.has(c.newPath ?? c.oldPath)
    && ['A', 'D', 'M', 'R'].includes(c.status) && PLAIN_MODES.has(c.oldMode) && PLAIN_MODES.has(c.newMode)
    && c.oldId !== c.newId
    && [c.oldPath, c.newPath].filter(Boolean).every(isBinaryFormat)
    && !hasDescendant(c));
  if (candidates.length === 0) return { skipped: [], order };

  const ids = [...new Set(candidates.flatMap((c) => [c.oldId, c.newId]).filter((id) => !/^0+$/.test(id)))];
  const sizes = new Map();
  for (const line of git(['cat-file', '--batch-check'], { ...o, input: `${ids.join('\n')}\n` }).split('\n')) {
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    if (m) sizes.set(m[1], Number(m[2]));
  }
  const limit = o?.largeBinaryBytes ?? LARGE_BINARY_BYTES;
  const budget = o?.largeBinaryTotalBytes ?? LARGE_BINARY_TOTAL_BYTES;
  const sized = candidates.map((c) => {
    const [before, after] = [sizes.get(c.oldId) ?? 0, sizes.get(c.newId) ?? 0];
    return { ...c, size: Math.max(before, after), printed: before + after };
  });
  const skipped = sized.filter((c) => c.size > limit);
  // What is left may still add up to too much: take the largest out first (name order breaks ties) until it fits.
  const rest = sized.filter((c) => c.size <= limit).sort((a, b) => b.printed - a.printed || ((a.newPath ?? a.oldPath) < (b.newPath ?? b.oldPath) ? -1 : 1));
  let total = rest.reduce((n, c) => n + c.printed, 0);
  for (const c of rest) {
    if (total <= budget) break;
    skipped.push(c);
    total -= c.printed;
  }
  return { skipped, order };
}

// Literal, repo-root pathspecs that leave the given changes (old and new path) out of a diff, as in contentHash: a name like
// "a*.xlsx", or the cwd, cannot change what is excluded.
const excludeSpecs = (changes) => changes.flatMap((c) => [c.oldPath, c.newPath]).filter(Boolean).map((p) => `:(top,exclude,literal)${p}`);

// What the branch changes relative to where it forked: the diff is taken from the merge-base, not from `base`'s tip,
// so commits that landed on base after the fork never show up as the branch deleting them.
// --text: a NUL byte in a comment, or a `*.ts -diff` line in .gitattributes, makes git print "Binary files differ" and
// no lines at all, which would hide an added `.skip` or a deleted test from every check built on this. --no-textconv /
// --no-ext-diff: a repo-configured converter or external diff tool must not rewrite what we parse (or run at all).
// The price of --text is that a binary file is printed byte for byte: a PR deleting a few hundred MB of spreadsheets made a
// diff bigger than proc.run's buffer (ENOBUFS) and every check built on it crashed. So a change git calls binary whose
// larger blob is over LARGE_BINARY_BYTES, and whose paths (both, for a rename) all have a listed binary-format extension,
// is not printed: it comes back path-only, in the shape parseUnifiedDiff gives a binary change plus `skippedLargeBinary:
// true`. The path rules still see its paths; there are simply no lines to read. Everything else keeps --text however big it
// is, so a NUL byte in a source file cannot be used to hide it.
export function diffFiles(base, head, o) {
  const mb = mergeBase(base, head, o);
  const range = `${mb}..${assertRef(head, ['diff', head])}`;
  const { skipped, order } = largeBinaryChanges(mb, head, o);
  const exclude = excludeSpecs(skipped);
  const text = git([
    ...STABLE_CONFIG, 'diff', '-M', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--src-prefix=a/', '--dst-prefix=b/',
    range, ...(exclude.length > 0 ? ['--', ':/', ...exclude] : []),
  ], o);
  const files = parseUnifiedDiff(text);
  if (skipped.length === 0) return files;
  for (const c of skipped) {
    files.push({
      oldPath: c.oldPath, newPath: c.newPath, path: c.status === 'D' ? c.oldPath : c.newPath, status: c.status,
      similarity: c.status === 'R' ? c.score : null, binary: true, added: [], removed: [], skippedLargeBinary: true,
    });
  }
  // Back into git's own order, so adding the entries never moves the others. A finite rank: a path git did not list sorts
  // last instead of putting NaN into the comparator.
  const rank = (f) => order.get(f.path) ?? order.size;
  return files.sort((a, b) => rank(a) - rank(b));
}

// One entry per change of `git diff -M --raw -z --no-abbrev` for from..to, with the SAME options as diffFiles.
// -> [{ oldMode, newMode, oldId, newId, status, score, oldPath, newPath }] (a path is null on the side that does not exist;
// score is a rename's similarity, null for the rest).
function rawChanges(from, to, o) {
  const text = git([
    ...STABLE_CONFIG, 'diff', '-M', '--raw', '-z', '--no-abbrev', '--no-color', '--no-ext-diff', '--no-textconv',
    `${from}..${assertRef(to, ['diff', to])}`,
  ], o);
  const parts = text.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(parts[i]);
    if (!m) {
      if (parts[i] === '') { i++; continue; }
      throw new GitError({ args: ['diff', '--raw', '-z'], code: 0, stderr: `unexpected raw diff entry: ${parts[i]}` });
    }
    const two = m[5] === 'R' || m[5] === 'C';
    const first = parts[i + 1];
    const second = two ? parts[i + 2] : first;
    if (first === undefined || second === undefined) throw new GitError({ args: ['diff', '--raw', '-z'], code: 0, stderr: 'truncated raw diff' });
    out.push({
      oldMode: m[1], newMode: m[2], oldId: m[3], newId: m[4], status: m[5], score: m[6] === '' ? null : Number(m[6]),
      oldPath: m[5] === 'A' ? null : first, newPath: m[5] === 'D' ? null : second,
    });
    i += two ? 3 : 2;
  }
  return out;
}

// Tree modes of every change diffFiles reports, from `git diff --raw -z` with the SAME options, base and head: a 100% rename
// has no `mode` line in the unified diff, so a symlink (120000) or submodule (160000) that merely MOVES is invisible there.
// -> [{ oldMode, newMode, status, oldPath, newPath }] (a path is null on the side that does not exist).
export function diffModes(base, head, o) {
  const mb = mergeBase(base, head, o);
  return rawChanges(mb, head, o).map(({ oldMode, newMode, status, oldPath, newPath }) => ({ oldMode, newMode, status, oldPath, newPath }));
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
// The one exception is a large binary document (see diffFiles): --binary would print its whole content again (base85, a
// quarter bigger) and overflow the buffer, so it is left out of the diff and one line stands in for it, carrying the
// status, both paths, both modes and both blob ids. A blob id IS a hash of the content, so the hash still moves whenever such a file's
// bytes change. Without any such file the input is exactly the normalised diff, as before.
// `exclude` paths (e.g. an agent log the pipeline itself appends to) are left out: each is a literal repo-root-relative
// path (`:(top,exclude,literal)`), so `*.js` is not a glob and `docs/x.md` does not match `sub/docs/x.md`. Pathspecs
// are anchored at the repo root so cwd cannot narrow what is hashed.
export function contentHash(base, head, { exclude = [], ...o } = {}) {
  const mb = mergeBase(base, head, o);
  const { skipped } = largeBinaryChanges(mb, head, o);
  const text = git([
    ...STABLE_CONFIG, 'diff', '--unified=3', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
    `${mb}..${assertRef(head, ['diff', head])}`, '--', ':/', ...exclude.map((p) => `:(top,exclude,literal)${p}`), ...excludeSpecs(skipped),
  ], o);
  const diff = normaliseDiff(text);
  const stoodIn = skipped.filter((c) => !exclude.includes(c.newPath ?? c.oldPath)); // an excluded path never counts
  if (stoodIn.length === 0) return createHash('sha256').update(diff).digest('hex');
  // One JSON array per change (a path may hold any character but NUL), sorted. The modes are in it: a chmod +x alone changes
  // nothing else about a skipped file. The diff's length prefix and the NUL tag make
  // this input impossible to mistake for a plain diff (those start with "diff --git"), whatever the diff contains.
  const lines = stoodIn.map((c) => JSON.stringify([c.status, c.oldPath, c.newPath, c.oldMode, c.newMode, c.oldId, c.newId])).sort();
  return createHash('sha256').update(`large-binary\0${diff.length}\0${diff}\n${lines.join('\n')}\n`).digest('hex');
}

// The patch a review packet carries: `git diff --binary from..to`, minus the large binary documents (see diffFiles), which
// would overflow the buffer; the caller names them in the packet instead. -> { patch, skipped: [{ status, oldPath, newPath,
// size }] } (size = the larger blob, in bytes), sorted by path.
export function reviewPatch(from, to, o) {
  const { skipped } = largeBinaryChanges(from, to, o);
  const patch = git([
    'diff', '--binary', '--no-color', '--no-ext-diff', `${from}..${assertRef(to, ['diff', to])}`,
    ...(skipped.length > 0 ? ['--', ':/', ...excludeSpecs(skipped)] : []),
  ], o);
  const names = skipped.map(({ status, oldPath, newPath, size }) => ({ status, oldPath, newPath, size }));
  names.sort((a, b) => ((a.newPath ?? a.oldPath) < (b.newPath ?? b.oldPath) ? -1 : 1));
  return { patch, skipped: names };
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
export function reviewContentHash({ branch, agentLog } = {}, o) {
  return contentHash(reviewBaseRef(branch, o), 'HEAD', { ...o, exclude: agentLog ? [agentLog] : [] });
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

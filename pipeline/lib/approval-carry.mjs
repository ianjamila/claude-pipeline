// Why: the owner's chat "merge" is bound to one PR head (H0). When the only thing that happened since is GitHub's
// "Update branch" - merges of main into the branch - the owner's words still describe the code they approved, so the
// approval may travel from H0 to the new head. This file is the PROOF of that, and nothing else: given the authenticated
// base commit and PR head, it says whether the first-parent chain H0 -> ... -> head is nothing but clean, GitHub-made merges
// of the protected branch, or refuses with a code and one plain-English sentence. It reads; it never fetches, never writes
// to the real repository and never throws (anything unexpected is a refusal). Design: the 2026-11-05 merge-survives-main plan
// (3.B, R1/R3/R4/R7/R8, R11, R14, F4/F5/F6/F9/F10, C4).
//
// Every git process runs in a THROWAWAY BARE repository made per call in a private directory under the Claude home, whose
// objects/info/alternates points at the real repository's object directory (so the real objects are readable and every object
// the trial merges write lands in the throwaway repo, which is deleted in `finally`). The environment is built from scratch
// (isolatedGitEnv: PATH and the Windows keep-list only, plus fixed values), the repository is made with an empty template, and
// the merge settings are the same pinned ones the review-base trial merges use. So nothing the caller or the real repository
// configured - GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS, .git/config merge drivers, .git/info/attributes, a template hook,
// core.attributesFile, replace refs - can change a verdict. In-tree .gitattributes are CONTENT (they travel with the PR), so
// those are scanned and the carry refuses when one could change how a merge is made (a `merge` attribute in any form,
// `binary`, an [attr] macro, a symlink in place of the file).
import fs from 'node:fs';
import path from 'node:path';
import { git, historyIntegrityProblems, MERGE_CONFIG } from './git.mjs';
import { accountHome } from './paths.mjs';
import { removeTree } from './private-tmp.mjs';
import { run } from './proc.mjs';
import { isolatedGitArgs, isolatedGitEnv, makeIsoDir } from './upstream.mjs';

// A carry covers at most this many main-only updates (first-parent steps) and so walks MAX_UPDATES + 1 commits, head included.
export const CARRY_MAX_UPDATES = 10;
// The shortest head prefix a carry may resolve (a 48-bit prefix is too easy to collide on; plan F3/C4).
export const CARRY_MIN_PREFIX = 16;
export const GITHUB_COMMITTER_EMAIL = 'noreply@github.com';

const FULL_SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 60_000;
const short = (sha) => String(sha).slice(0, 12);

class Refusal extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}
const refuse = (code, reason) => {
  throw new Refusal(code, reason);
};

// ---- pure helpers --------------------------------------------------------------------------------------------------

// Which walked commit does the recorded prefix name? `walked` = the full shas of head and its first-parent ancestors (head
// first). Resolution is by the walked chain ONLY (never by ref name or rev-parse, which could pick another commit):
// -> { kind: 'exact', sha } (head itself), { kind: 'found', sha } (exactly one ancestor), { kind: 'none' }, or
// { kind: 'ambiguous', matches } (two or more walked commits share the prefix, head included: fail closed).
export function matchCarryPrefix({ head, walked, prefix }) {
  const matches = walked.filter((sha) => sha.startsWith(prefix));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: matches[0] === head ? 'exact' : 'found', sha: matches[0] };
}

// Does the text of a .gitattributes file contain anything that could change how a merge is made? -> null, or a phrase.
// Every whitespace-separated token of every non-comment line is looked at (a quoted pattern may hold spaces, so the pattern is
// not singled out; a pattern that is literally `merge` is a false refusal, which is fine): `merge`, `-merge`, `!merge`,
// `merge=<driver>` and the same four for `binary` (the built-in macro that unsets merge) are refused, and so is any `[attr]` line (a
// macro can set merge under another name).
export function gitattributesProblem(text) {
  if (text.includes('\0')) return 'it contains a NUL byte';
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[attr]')) return 'it defines an attribute macro ([attr])';
    for (const token of line.split(/\s+/)) {
      if (/^[-!]?merge(?:=.*)?$/.test(token)) return `it sets the merge attribute (${token})`;
      if (/^[-!]?binary(?:=.*)?$/.test(token)) return `it uses the binary macro (${token}), which unsets merge`;
    }
  }
  return null;
}

// `git --version` output -> does this git have `merge-tree --write-tree` (2.38)? An unreadable version is "no".
export function mergeTreeWriteSupported(versionText) {
  const m = /^git version (\d+)\.(\d+)/.exec(String(versionText).trim());
  return m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38));
}

// ---- the throwaway git ---------------------------------------------------------------------------------------------

// The whole environment of every git process of a carry. Exported for tests. `source` is only the environment the allowlist is
// read from (PATH, the Windows keep-list); nothing else of it is passed on.
export function carryGitEnv({ isoDir, gitDir, source = process.env, platform = process.platform }) {
  const { LANG, ...base } = isolatedGitEnv({ isoDir, source, platform });
  void LANG;
  return {
    ...base,
    HOME: isoDir,
    XDG_CONFIG_HOME: isoDir,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', // a partial clone's missing object is a refusal here, never a fetch
    LC_ALL: 'C',
    ...(gitDir ? { GIT_DIR: gitDir } : {}),
  };
}

const MISSING = /not a valid object|not a (?:tree|blob|commit) object|unable to read|missing|bad object|could not (?:read|parse|access)|invalid object|not found|does not exist|cannot read|promisor/i;
const FETCH_HINT = 'run `git fetch origin` as its own step, then retry';

function failure(r, what) {
  const text = String(r.stderr ?? '').trim().split('\n')[0];
  if (MISSING.test(text)) refuse('missing-object', `${what}: git does not have an object it needs (${text.slice(0, 120)}); ${FETCH_HINT}`);
  refuse('git-failed', `${what}: git failed (exit ${r.code}${text ? `: ${text.slice(0, 120)}` : ''})`);
}

// Makes the throwaway repo (inside an iso directory under the Claude home) and returns { cg, exists, isoDir }.
// cg(args, { input }) -> the raw run result of git with the pinned environment, in the throwaway repo.
function makeThrowaway({ home, objectsDir }) {
  const isoDir = makeIsoDir(home);
  try {
    const gitDir = path.join(isoDir, 'carry.git');
    const template = path.join(isoDir, 'empty-template');
    fs.mkdirSync(template);
    const args = (rest) => [...isolatedGitArgs({ isoDir }), ...MERGE_CONFIG, ...rest];
    const init = run('git', args(['init', '-q', '--bare', `--template=${template}`, gitDir]), {
      cwd: isoDir, env: carryGitEnv({ isoDir }), replaceEnv: true, timeoutMs: GIT_TIMEOUT_MS,
    });
    if (init.code !== 0) failure(init, 'making the scratch repository');
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${objectsDir.replaceAll('\\', '/')}\n`);
    const env = carryGitEnv({ isoDir, gitDir });
    const cg = (rest, { input } = {}) => run('git', args(rest), { cwd: isoDir, env, replaceEnv: true, timeoutMs: GIT_TIMEOUT_MS, input });
    return { isoDir, cg };
  } catch (err) {
    removeTree(isoDir);
    throw err;
  }
}

// ---- the proof -----------------------------------------------------------------------------------------------------

// -> { ok: true, from: <H0 full sha>, steps: [{ merge, parent2 }] } (oldest step first; [] when `head` itself carries the prefix)
//  | { ok: false, code, reason }
// codes: bad-input, prefix-short, history-unsafe, git-unsupported, missing-object, not-found, ambiguous, not-merge, octopus,
//        foreign-merge, not-github-made, attributes-unsafe, no-merge-base, conflict, tree-mismatch, git-failed, error.
// `baseRefOid` / `head`: the full shas GitHub reports for the PR (the caller read them once); `prefix`: the recorded head prefix
// (16-40 lowercase hex); `commitInfo(sha)` (may be async) -> { verified, committerEmail } as GitHub reports for that commit.
export async function carriesApproval({ root, baseRefOid, head, prefix, commitInfo, home } = {}) {
  let isoDir = null;
  try {
    if (typeof prefix !== 'string' || !/^[0-9a-f]+$/.test(prefix) || prefix.length > 40) refuse('bad-input', 'the recorded head prefix is not lowercase hex');
    if (prefix.length < CARRY_MIN_PREFIX) refuse('prefix-short', `the recorded head prefix has ${prefix.length} characters; a carried approval needs at least ${CARRY_MIN_PREFIX}`);
    if (typeof head !== 'string' || !FULL_SHA.test(head)) refuse('bad-input', 'the PR head is not a full 40-character commit id');
    if (typeof baseRefOid !== 'string' || !FULL_SHA.test(baseRefOid)) refuse('bad-input', 'the base branch commit is not a full 40-character commit id');
    if (typeof root !== 'string' || root === '' || typeof commitInfo !== 'function') refuse('bad-input', 'the carry check was not given a repository and a commit lookup');

    const o = { cwd: root };
    const unsafe = historyIntegrityProblems(o);
    if (unsafe.length) refuse('history-unsafe', unsafe.join('; '));
    if (head.startsWith(prefix)) return { ok: true, from: head, steps: [] };

    const objectsDir = path.resolve(root, git(['rev-parse', '--git-path', 'objects'], o).trim());
    if (!fs.statSync(objectsDir).isDirectory()) refuse('error', 'the repository object directory could not be found');

    const made = makeThrowaway({ home: home ?? accountHome(), objectsDir });
    isoDir = made.isoDir;
    const { cg } = made;

    if (!mergeTreeWriteSupported(cg(['--version']).stdout)) {
      refuse('git-unsupported', 'this git is older than 2.38 (it has no `merge-tree --write-tree`), so a main-only update cannot be proven');
    }

    const must = (rest, what, { ok = [0] } = {}) => {
      const r = cg(rest);
      if (!ok.includes(r.code)) failure(r, what);
      return r;
    };
    const have = (sha) => {
      const r = cg(['cat-file', '-e', sha]);
      if (r.code === 0) return true;
      if (r.code === 1 && String(r.stderr ?? '').trim() === '') return false;
      return failure(r, `looking for commit ${short(sha)}`);
    };
    const need = (sha, what) => {
      if (!have(sha)) refuse('missing-object', `${what} (${short(sha)}) is not in this repository; ${FETCH_HINT}`);
    };
    need(baseRefOid, 'the base branch commit');
    need(head, 'the PR head');

    // F5: the walk is the only resolution of the prefix.
    const rows = must(['rev-list', '--first-parent', '--parents', '-n', String(CARRY_MAX_UPDATES + 1), head], 'walking the PR branch history').stdout
      .split('\n').filter((l) => l !== '').map((l) => l.split(' '));
    if (rows.some((row) => row.length === 0 || !row.every((s) => FULL_SHA.test(s))) || rows[0]?.[0] !== head) refuse('git-failed', 'git printed an unexpected history for the PR head');
    const walked = rows.map((row) => row[0]);
    const hit = matchCarryPrefix({ head, walked, prefix });
    if (hit.kind === 'none') refuse('not-found', `no commit on the PR branch's own history (the last ${CARRY_MAX_UPDATES} updates) starts with ${prefix}: the approved head is not in it`);
    if (hit.kind === 'ambiguous') refuse('ambiguous', `${hit.matches.length} commits on the PR branch's history start with ${prefix}`);
    const index = walked.indexOf(hit.sha);

    // Attribute scan, memoised per commit.
    const attrMemo = new Map();
    const blobMemo = new Map();
    const attributesOf = (commit) => {
      if (attrMemo.has(commit)) return attrMemo.get(commit);
      const listing = must(['ls-tree', '-r', '-t', '-z', commit], `reading the files of ${short(commit)}`).stdout;
      let problem = null;
      for (const entry of listing.split('\0')) {
        if (entry === '') continue;
        const m = /^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]*)$/.exec(entry);
        if (!m) { problem = `${short(commit)} lists a file git printed in an unexpected way`; break; }
        const [, mode, type, oid, file] = m;
        if (path.posix.basename(file).toLowerCase() !== '.gitattributes') continue;
        if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
          problem = `${file} in ${short(commit)} is a ${type === 'blob' ? 'symbolic link' : type} (mode ${mode}), not a plain file`;
          break;
        }
        if (!blobMemo.has(oid)) blobMemo.set(oid, gitattributesProblem(must(['cat-file', 'blob', oid], `reading ${file} in ${short(commit)}`).stdout));
        const why = blobMemo.get(oid);
        if (why) { problem = `${file} in ${short(commit)}: ${why}`; break; }
      }
      attrMemo.set(commit, problem);
      return problem;
    };

    const steps = [];
    for (let i = index - 1; i >= 0; i -= 1) {
      const prev = walked[i + 1];
      const merge = walked[i];
      const parents = rows[i].slice(1);
      if (parents.length === 1) refuse('not-merge', `${short(merge)} is not a merge of the base branch: it is an ordinary commit after the approved head`);
      if (parents.length > 2) refuse('octopus', `${short(merge)} merges ${parents.length} branches at once`);
      if (parents.length !== 2) refuse('not-merge', `${short(merge)} has no parents`);
      const [first, parent2] = parents;
      if (first !== prev) refuse('git-failed', `${short(merge)} does not continue from ${short(prev)}`);
      need(parent2, `a commit merged into ${short(merge)}`);
      const inBase = cg(['merge-base', '--is-ancestor', parent2, baseRefOid]);
      if (inBase.code === 1 && String(inBase.stderr ?? '').trim() === '') refuse('foreign-merge', `${short(merge)} merges ${short(parent2)}, which is not on the base branch`);
      if (inBase.code !== 0) failure(inBase, `checking that ${short(parent2)} is on the base branch`);

      const bases = must(['merge-base', '--all', prev, parent2], `finding the common ancestor of ${short(prev)} and ${short(parent2)}`, { ok: [0, 1] });
      const baseShas = bases.stdout.split('\n').filter((l) => l !== '');
      if (baseShas.length === 0 || !baseShas.every((s) => FULL_SHA.test(s))) refuse('no-merge-base', `${short(prev)} and ${short(parent2)} share no history`);
      for (const commit of [...baseShas, prev, parent2]) {
        const problem = attributesOf(commit);
        if (problem) refuse('attributes-unsafe', `${problem}; a merge cannot be proven clean while it can change how git merges (merge ${short(merge)})`);
      }

      const trial = cg(['merge-tree', '--write-tree', prev, parent2]);
      if (trial.code === 1) refuse('conflict', `${short(merge)} is not a clean merge: merging ${short(parent2)} into ${short(prev)} conflicts, so someone resolved it by hand`);
      if (trial.code !== 0) failure(trial, `trial merge for ${short(merge)}`);
      const trialTree = trial.stdout.split('\n')[0].trim();
      if (!FULL_SHA.test(trialTree)) refuse('git-failed', `the trial merge for ${short(merge)} printed no tree id`);
      const actual = must(['rev-parse', '--verify', `${merge}^{tree}`], `reading the tree of ${short(merge)}`).stdout.trim();
      if (trialTree !== actual) refuse('tree-mismatch', `${short(merge)} contains more than a clean merge of ${short(parent2)} into ${short(prev)} (its files differ from the merge git makes itself)`);

      let info;
      try {
        info = await commitInfo(merge);
      } catch (err) {
        refuse('not-github-made', `could not confirm that GitHub made merge ${short(merge)} (${String(err?.message ?? err).split('\n')[0].slice(0, 120)})`);
      }
      if (!info || info.verified !== true || String(info.committerEmail ?? '').toLowerCase() !== GITHUB_COMMITTER_EMAIL) {
        refuse('not-github-made', `merge ${short(merge)} was not made by GitHub (not signed by GitHub as ${GITHUB_COMMITTER_EMAIL}): it may have been made on someone's machine`);
      }
      steps.push({ merge, parent2 });
    }
    return { ok: true, from: hit.sha, steps };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code, reason: err.message };
    return { ok: false, code: 'error', reason: `the carry check could not run: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}` };
  } finally {
    if (isoDir) removeTree(isoDir);
  }
}

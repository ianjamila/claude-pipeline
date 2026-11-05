// review.docs_exempt_paths: may the commits made AFTER the last review round skip another round? ONE answer, used by both
// `review-complete` and the final gate's review check, so the two cannot disagree. The review loop's rule is that the last round's
// content hash must equal the current one; this adds exactly one exception: a clean, proven review, followed only by commits that
// ADD lines to ordinary documents the project listed (exact paths) at the reviewed head. Nothing else is relaxed: the unresolved
// items, the Fable pass, the owner's extra-round grants and the verify/CI evidence are judged as they always were by the callers.
//
// Everything below must hold, else `{ exempt: false, files: [], reason }` (reason names the file that forces a round when one does):
//  * the feature is on: review.docs_exempt_paths in the config AT THE REVIEWED HEAD (not HEAD, so a commit cannot widen its own
//    exemption; .claude/pipeline.yml can never be listed, so the two agree) is non-empty, and every entry is eligible again here
//    (config.mjs#docsExemptProblem), whether or not anything validated that file: a document, no hard-stop path, not a test glob,
//    not on hard_stops.paths / review.arbiter_always_paths / risk.high_risk_paths (the reviewed head's lists and HEAD's, both);
//  * the last round is valid on its own content (reviewValidFor with its own hash: nothing unresolved, no Fable pass owed), AND that
//    hash is really the hash of its toHead (contentHash of toHead against the base, agent log excluded). reviewValidFor alone would
//    compare the round's hash with itself, so a stale or hand-edited toHead would pass;
//  * toHead is an ancestor of HEAD, no merge commit lies between them, and the merge base with the base branch is the same for both.
//    Rehashing the old head is NOT enough for the last two: contentHash recomputes the merge base from the head it is given, so it
//    would still match after a main merge that discards an upstream change. A merge since the round always takes a round (the
//    existing baseOnly / resolutionOnly paths deal with it);
//  * toHead..HEAD changes at least one file, and every file, by BOTH rename sides, is listed, is a regular (100644) non-binary text
//    file, and is only added to: no edited or removed line, no deletion, no rename, no mode change, no symlink or submodule;
//  * every ADDED line is a strict ledger row (LEDGER_ROW below): a four-digit number, the migration's name, a date, a PR number and
//    an empty note, nothing else. The added rows are the last lines of the file (nothing after them), their numbers strictly
//    increase and continue above the last row of the reviewed file, and each names a migration file (<number>_<name>.sql, a regular
//    file in a directory called migrations) that exists in the REVIEWED head's tree. So a row carries no free text, and the only
//    word in it that is not fixed was already reviewed as a file name. A row with a note, or any other line, needs a round.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { DEFAULTS, docsExemptProblem } from './config.mjs';
import { isAgentInstructionPath } from './doc-paths.mjs';
import { contentHash, diffFiles, diffModes, git, isAncestor, mergeBase, revParse, reviewBaseRef, showFile } from './git.mjs';
import { reviewValidFor } from './triage.mjs';
import { parseYaml } from './yaml.mjs';

const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const REGULAR = '100644';
const SHOWN = 5;
const oneLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

// | 0240 | `name` | 2026-11-05 | #1234 | |   The Note column must be empty: a row with a note takes a round.
const LEDGER_ROW = /^\| (\d{4}) \| `([a-z0-9_]{1,63})` \| \d{4}-\d{2}-\d{2} \| #\d{1,6} \| \|$/;
const ROW_NUMBER = /^\| (\d{4}) \| /;
const quote = (text) => JSON.stringify(String(text).slice(0, 60));

// ---- @-imports: an instruction file that pulls a listed document in --------------------------------------------------------------------
// CLAUDE.md and its kin may `@path` other files, which are then read as instructions (Claude Code follows them up to 5 hops). A listed
// document that is imported steers the agent like an instruction file, yet its added lines would skip review. The scan reads the REVIEWED
// head's tree (instruction files cannot change after it: an unlisted file forces a round, and an instruction file can never be listed).
// It over-matches on purpose (tokens in code spans, any case, both the importer's own and its target's directory), and fails closed:
// whatever cannot be read or followed (a link that cycles, dangles or ends outside the repo, an oversized file) is "not exempt".
const MAX_HOPS = 5;
const MAX_READS = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOKENS = 5000;
const MAX_LINK_FOLLOWS = 40;
const REGULAR_MODES = new Set(['100644', '100755']);
// `@path`: at the start of a line or after a character that cannot end a word (whitespace, a bracket, a quote, markup).
const IMPORT_TOKEN = /(?:^|[^A-Za-z0-9.\-/@\\])@((?:[^\s\\]|\\ )+)/gm;
const TRAILING_PUNCTUATION = /[)\]}>"'`.,;:!?*_~|]+$/;
const lc = (s) => s.toLowerCase();
class Unjudgeable extends Error {}

// Every file in the tree at `toHead`: { entries: path -> { mode, oid }, lower: lowercased path -> [paths] }. The lowercase index is how a
// case-insensitive file system (macOS, Windows) would resolve a name.
function readTree(toHead, o) {
  const entries = new Map();
  const lower = new Map();
  for (const raw of git(['ls-tree', '-r', '-z', '--full-tree', toHead], o).split('\0')) {
    const m = /^(\d+) (?:blob|commit) ([0-9a-f]+)\t(.+)$/s.exec(raw);
    if (!m) continue;
    entries.set(m[3], { mode: m[1], oid: m[2] });
    lower.set(lc(m[3]), [...(lower.get(lc(m[3])) ?? []), m[3]]);
  }
  return { entries, lower };
}

// File names of the regular files directly in a directory called migrations. Read on demand.
function migrationNames(tree) {
  const names = new Set();
  for (const [p, e] of tree.entries) {
    const parts = p.split('/');
    if (REGULAR_MODES.has(e.mode) && parts.length >= 2 && parts.at(-2) === 'migrations' && parts.at(-1).endsWith('.sql')) names.add(parts.at(-1));
  }
  return names;
}

// Walks `rel` (a posix path from the repo root, `.` and `..` allowed) through the tree, following a symlink at every segment, directories
// included. -> { path: canonical tree path | null (nothing there), entry } | { outside: true } (a plain path that leaves the repo) | throws
// Unjudgeable (a link that cycles, dangles, is absolute or ends outside the repo; ambiguous names).
function resolveInTree(tree, rel, readBlob) {
  let segs = rel.split('/').filter((s) => s !== '' && s !== '.');
  let done = [];
  let follows = 0;
  while (segs.length > 0) {
    const next = segs.shift();
    if (next === '..') {
      if (done.length === 0) {
        if (follows > 0) throw new Unjudgeable('a symlink leads out of the repository');
        return { outside: true };
      }
      done.pop();
      continue;
    }
    const at = [...done, next].join('/');
    const hits = tree.lower.get(lc(at));
    if (hits === undefined) { done.push(next); continue; } // a directory, or nothing
    if (hits.length > 1) throw new Unjudgeable(`${at} is ambiguous (two names that differ only in case)`);
    const real = hits[0];
    const entry = tree.entries.get(real);
    if (entry.mode !== '120000') { done.push(real.split('/').at(-1)); continue; }
    if (++follows > MAX_LINK_FOLLOWS) throw new Unjudgeable(`symlinks at ${real} cycle`);
    const target = readBlob(entry.oid, real);
    if (target === '' || target.includes('\0')) throw new Unjudgeable(`${real} is a symlink with an unreadable target`);
    if (target.startsWith('/')) throw new Unjudgeable(`${real} is a symlink to an absolute path`);
    segs = [...target.split('/'), ...segs];
    // `done` is the directory that holds the link, unchanged: the target is relative to it.
  }
  const full = done.join('/');
  const hit = tree.lower.get(lc(full));
  if (hit === undefined) {
    if (follows > 0) throw new Unjudgeable(`a symlink on the way to ${full === '' ? rel : full} dangles`);
    return { path: null, entry: null };
  }
  if (hit.length > 1) throw new Unjudgeable(`${full} is ambiguous (two names that differ only in case)`);
  return { path: hit[0], entry: tree.entries.get(hit[0]) };
}

// The paths an `@token` may stand for, as written (escaped spaces undone; trailing punctuation and a #fragment cut off in turn).
function candidatesOf(token) {
  const raw = token.replace(/\\ /g, ' ');
  const out = new Set();
  for (const t of [raw, raw.replace(TRAILING_PUNCTUATION, '')]) {
    for (const c of [t, t.split('#')[0]]) if (c !== '') out.add(c);
  }
  return [...out];
}

// Does any instruction file of the reviewed head import (directly or by up to 5 hops) a document of `listed`? -> a reason | null.
function importProblem({ toHead, root, listed, tree, home, o }) {
  const listedLower = new Set(listed.map(lc));
  let reads = 0;
  const readBlob = (oid, path) => {
    if (++reads > MAX_READS) throw new Unjudgeable('too many files to read');
    let text;
    try {
      text = git(['cat-file', 'blob', oid], { ...o, maxBuffer: MAX_FILE_BYTES });
    } catch {
      throw new Unjudgeable(`${path} is too large or cannot be read`);
    }
    return text;
  };
  let rootReal = root;
  try { rootReal = realpathSync(root); } catch { /* the root as given */ }
  const roots = [...new Set([root, rootReal].map((r) => posix.normalize(r.replace(/\\/g, '/')).replace(/\/$/, '')))];

  const seen = new Set();
  const queue = [];
  const enqueue = (path, canonical, depth) => {
    if (seen.has(lc(canonical))) return;
    seen.add(lc(canonical));
    queue.push({ path, canonical, depth });
  };

  // The instruction files are the roots. One that is itself a link is followed; one that ends in a listed document makes that document
  // an instruction file, which it may never be.
  for (const p of tree.entries.keys()) {
    if (!isAgentInstructionPath(p)) continue;
    let r;
    try {
      r = resolveInTree(tree, p, readBlob);
    } catch (e) {
      if (!(e instanceof Unjudgeable)) throw e;
      return `${p} cannot be judged: ${e.message}`;
    }
    if (r.outside || r.path === null) return `${p} is a symlink that dangles or leads out of the repository (symlink targets cannot be judged)`;
    if (REGULAR_MODES.has(r.entry.mode) === false) continue;
    if (listedLower.has(lc(r.path))) return `${p} is read as an instruction file but is a symlink to ${r.path}, a listed document`;
    enqueue(p, r.path, 0);
  }

  const hit = (importer, lexical, canonical) => {
    const direct = !lexical.startsWith('..') && listedLower.has(lc(lexical));
    if (!direct && !(canonical !== null && listedLower.has(lc(canonical)))) return null;
    return `${importer} imports ${lexical}${direct ? '' : ` (a symlink to ${canonical})`}, a listed document: an imported document steers the agents like an instruction file`;
  };
  for (let i = 0; i < queue.length; i++) {
    const { path, canonical, depth } = queue[i];
    const text = readBlob(tree.entries.get(canonical).oid, path);
    let tokens = 0;
    for (const m of text.matchAll(IMPORT_TOKEN)) {
      if (++tokens > MAX_TOKENS) return `${path} cannot be judged: too many @ tokens`;
      for (const written of candidatesOf(m[1])) {
        // Where the token may point, as paths from the repo root: the importer's directory as it was reached and as it really is.
        const rels = [];
        let absolute = null;
        if (written.startsWith('~/')) {
          if (!home) return `${path} imports ${written}, and HOME is unknown: it cannot be judged`;
          absolute = `${home.replace(/\/$/, '')}/${written.slice(2)}`;
        } else if (written.startsWith('/')) {
          absolute = written;
        }
        if (absolute !== null) {
          const target = posix.normalize(absolute);
          const base = roots.find((r) => target === r || target.startsWith(`${r}/`));
          if (!base) continue; // outside the repo: it cannot be a listed document
          rels.push(target.slice(base.length + 1));
        } else {
          for (const dir of new Set([posix.dirname(path), posix.dirname(canonical)])) rels.push(`${dir === '.' ? '' : `${dir}/`}${written}`);
        }
        for (const rel of rels) {
          const lexical = posix.normalize(rel);
          const direct = hit(path, lexical, null);
          if (direct) return direct;
          let r;
          try {
            r = resolveInTree(tree, rel, readBlob);
          } catch (e) {
            if (!(e instanceof Unjudgeable)) throw e;
            return `${path} imports ${written}, which cannot be judged: ${e.message}`;
          }
          if (r.outside) continue;
          const found = hit(path, lexical, r.path);
          if (found) return found;
          if (r.path !== null && REGULAR_MODES.has(r.entry.mode) && depth < MAX_HOPS) enqueue(r.path, r.path, depth + 1);
        }
      }
    }
  }
  return null;
}

// A reviewed file with no final newline: appending a line rewrites its last line, which git reports as one removed and one added line.
// Both blobs say so exactly (HEAD is the reviewed text plus a newline plus more). Still a round, but with the real reason.
function newlineProblem(reviewed, head) {
  if (typeof reviewed !== 'string' || typeof head !== 'string' || reviewed === '' || reviewed.endsWith('\n')) return null;
  if (!head.startsWith(`${reviewed}\n`)) return null;
  return 'the reviewed version has no final newline, so appending a line rewrote its last line (git sees an edited line); that needs a review round, and the file should end in a newline';
}

// Why the lines this file ADDS are not ledger rows laid out as the exemption allows, or null. `reviewed`: the file at the reviewed head
// (null when it is new), `head`: the file at HEAD. The diff has no removed line here, so the added lines are the only change.
function rowsProblem(file, f, reviewed, head, migrations) {
  const added = f.added ?? [];
  if (added.length === 0) return null;
  const lines = String(head).split('\n');
  if (lines.pop() !== '') return `${file}: the file does not end in a newline`;
  const bad = added.find((l) => !LEDGER_ROW.test(String(l.text)));
  if (bad) return `${file} line ${bad.line}: ${quote(bad.text)} is not a ledger row (| NNNN | \`name\` | YYYY-MM-DD | #PR | |); any other added line needs a review round`;
  const first = lines.length - added.length + 1;
  const off = added.find((l, i) => l.line !== first + i);
  if (off) return `${file} line ${off.line}: added rows must be the last lines of the file, with nothing after them`;
  let previous = null;
  for (const l of String(reviewed ?? '').split('\n').reverse()) {
    const m = ROW_NUMBER.exec(l);
    if (m) { previous = m[1]; break; }
  }
  for (const l of added) {
    const [, number, name] = LEDGER_ROW.exec(l.text);
    if (previous !== null && number <= previous) return `${file} line ${l.line}: row ${number} does not come after row ${previous}: row numbers must strictly increase, above the last row of the reviewed file`;
    previous = number;
    if (!migrations().has(`${number}_${name}.sql`)) return `${file} line ${l.line}: no regular file ${number}_${name}.sql in a migrations directory at the reviewed head (a row for a migration that is not there needs a review round)`;
  }
  return null;
}

const stringsOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const pathsOf = (f) => [...new Set([f.oldPath, f.newPath, f.path].filter((p) => typeof p === 'string'))];

// Why this one changed file is not an addition to a regular text file, or null.
function fileProblem(f, mode) {
  if (f.status !== 'A' && f.status !== 'M') return `status ${f.status} (only adding to a file is exempt: no deletion, rename or copy)`;
  if (f.binary === true) return 'binary';
  if (f.symlink === true || f.gitlink === true) return 'a symlink or submodule';
  if (Array.isArray(f.removed) ? f.removed.length > 0 : f.removed !== undefined) return 'a line was edited or removed (only added lines are exempt)';
  if ((f.added ?? []).some((l) => String(l?.text).includes('\0'))) return 'binary (NUL byte)';
  if (!mode) return 'its file mode could not be read';
  if (mode.newMode !== REGULAR || (f.status === 'M' && mode.oldMode !== REGULAR)) return `file mode ${mode.oldMode} -> ${mode.newMode} (only a regular 100644 file is exempt, and its mode may not change)`;
  return null;
}

/**
 * state: the review state. `config`: the validated config at HEAD. `hash`: the current content hash (64 hex).
 * -> { exempt: true, files: [paths], reviewedHead } | { exempt: false, files: [], reason, off? } (off: the feature is not configured, so the caller
 * should not mention it).
 */
export function docsExemptFrom(state, { root, config, hash, home }) {
  try {
    return decide(state, { root, config, hash, home });
  } catch (err) {
    return { exempt: false, files: [], reason: `the docs-only exemption could not be checked: ${oneLine(err)}` };
  }
}

function decide(state, { root, config, hash, home }) {
  const no = (reason, extra = {}) => ({ exempt: false, files: [], reason, ...extra });
  const o = { cwd: root };
  const last = state?.rounds?.at(-1);
  if (!last) return no('no review round has run');
  if (!HASH.test(String(hash))) return no('no current content hash');
  if (!HASH.test(String(last.contentHashAtToHead)) || !SHA.test(String(last.toHead))) return no('the last review round records no full head and content hash');
  const toHead = last.toHead;

  // The reviewed head's config decides whether, and for which paths. A missing or unreadable file is "off".
  let reviewed = null;
  try {
    const text = showFile(toHead, '.claude/pipeline.yml', o);
    reviewed = text === null ? null : parseYaml(text);
  } catch {
    reviewed = null;
  }
  const listed = reviewed?.review?.docs_exempt_paths;
  if (listed === undefined || (Array.isArray(listed) && listed.length === 0) || reviewed === null) {
    return no('review.docs_exempt_paths is empty at the reviewed head: every commit after the last round needs a round', { off: true });
  }
  if (!Array.isArray(listed)) return no('review.docs_exempt_paths at the reviewed head is not an array');

  // Eligibility again, against the protected lists of the reviewed head AND of HEAD (the strictest of both).
  const both = (...keys) => [...stringsOf(keys.reduce((v, k) => v?.[k], reviewed)), ...stringsOf(keys.reduce((v, k) => v?.[k], config))];
  const lists = [
    ['integrity.test_globs', [...DEFAULTS.integrity.test_globs, ...both('integrity', 'test_globs')]],
    ['hard_stops.paths', both('hard_stops', 'paths')],
    ['review.arbiter_always_paths', both('review', 'arbiter_always_paths')],
    ['risk.high_risk_paths', both('risk', 'high_risk_paths')],
  ];
  for (const p of listed) {
    const why = docsExemptProblem(p, lists);
    if (why) return no(`review.docs_exempt_paths entry ${JSON.stringify(p)} ${why}`);
  }
  const allowed = new Set(listed);

  if (!reviewValidFor(state, last.contentHashAtToHead)) {
    return no('the last review round is not clean (an item is unresolved, a Fable pass is owed, or accepted fixes still need a round)');
  }

  const branch = config?.default_branch ?? DEFAULTS.default_branch;
  const base = reviewBaseRef(branch, o);
  const agentLog = config?.agent_log ?? DEFAULTS.agent_log;
  const exclude = typeof agentLog === 'string' && agentLog !== '' ? [agentLog] : [];
  if (revParse(`${toHead}^{commit}`, o) !== toHead) return no(`the reviewed head ${toHead.slice(0, 12)} is not a commit`);
  if (!isAncestor(toHead, 'HEAD', o)) return no(`the reviewed head ${toHead.slice(0, 12)} is not an ancestor of HEAD: the history was rewritten, so a new round is needed`);
  const merges = git(['rev-list', '--merges', `${toHead}..HEAD`], o).split('\n').filter(Boolean);
  if (merges.length > 0) return no(`a merge commit (${merges[0].slice(0, 12)}) came after the reviewed head ${toHead.slice(0, 12)}: a merge always needs its own round`);
  if (mergeBase(base, 'HEAD', o) !== mergeBase(base, toHead, o)) return no(`the merge base with ${branch} moved since the reviewed head ${toHead.slice(0, 12)}`);
  if (contentHash(base, toHead, { ...o, exclude }) !== last.contentHashAtToHead) {
    return no(`the last round's content hash is not the hash of its head ${toHead.slice(0, 12)}: the round cannot be tied to that commit`);
  }

  const files = diffFiles(toHead, 'HEAD', o);
  if (files.length === 0) return no(`no file changed since the reviewed head ${toHead.slice(0, 12)}`);
  let treeMemo = null;
  const tree = () => (treeMemo ??= readTree(toHead, o));
  let importWhy;
  try {
    importWhy = importProblem({ toHead, root, listed, tree: tree(), home: home === undefined ? homedir() : home, o });
  } catch (e) {
    if (!(e instanceof Unjudgeable)) throw e;
    importWhy = e.message;
  }
  if (importWhy) return no(importWhy);
  const modes = new Map(diffModes(toHead, 'HEAD', o).map((m) => [m.newPath ?? m.oldPath, m]));
  const problems = [];
  const changed = new Set();
  let names = null;
  const migrations = () => (names ??= migrationNames(tree()));
  for (const f of files) {
    const paths = pathsOf(f);
    const unlisted = paths.filter((p) => !allowed.has(p));
    if (unlisted.length > 0) {
      problems.push(`${unlisted.join(', ')} is not in review.docs_exempt_paths: it needs a review round`);
      continue;
    }
    const file = f.newPath ?? f.path;
    let why = fileProblem(f, modes.get(f.newPath ?? f.oldPath ?? f.path));
    if (why && f.status === 'M') why = newlineProblem(showFile(toHead, file, o), showFile('HEAD', file, o)) ?? why;
    if (why) problems.push(`${paths.join(' -> ')}: ${why}`);
    else {
      const rows = rowsProblem(file, f, f.status === 'A' ? null : showFile(toHead, file, o), showFile('HEAD', file, o), migrations);
      if (rows) problems.push(rows);
    }
    for (const p of paths) changed.add(p);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, SHOWN).join('; ');
    return no(`${shown}${problems.length > SHOWN ? `; and ${problems.length - SHOWN} more` : ''}`);
  }
  return { exempt: true, files: [...changed].sort(), reason: null, reviewedHead: toHead };
}

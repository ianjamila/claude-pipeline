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
//    file, and is only added to: no edited or removed line, no deletion, no rename, no mode change, no symlink or submodule.
import { DEFAULTS, docsExemptProblem } from './config.mjs';
import { contentHash, diffFiles, diffModes, git, isAncestor, mergeBase, revParse, reviewBaseRef, showFile } from './git.mjs';
import { reviewValidFor } from './triage.mjs';
import { parseYaml } from './yaml.mjs';

const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const REGULAR = '100644';
const SHOWN = 5;
const oneLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

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
export function docsExemptFrom(state, { root, config, hash }) {
  try {
    return decide(state, { root, config, hash });
  } catch (err) {
    return { exempt: false, files: [], reason: `the docs-only exemption could not be checked: ${oneLine(err)}` };
  }
}

function decide(state, { root, config, hash }) {
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
  const modes = new Map(diffModes(toHead, 'HEAD', o).map((m) => [m.newPath ?? m.oldPath, m]));
  const problems = [];
  const changed = new Set();
  for (const f of files) {
    const paths = pathsOf(f);
    const unlisted = paths.filter((p) => !allowed.has(p));
    if (unlisted.length > 0) {
      problems.push(`${unlisted.join(', ')} is not in review.docs_exempt_paths: it needs a review round`);
      continue;
    }
    const why = fileProblem(f, modes.get(f.newPath ?? f.oldPath ?? f.path));
    if (why) problems.push(`${paths.join(' -> ')}: ${why}`);
    for (const p of paths) changed.add(p);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, SHOWN).join('; ');
    return no(`${shown}${problems.length > SHOWN ? `; and ${problems.length - SHOWN} more` : ''}`);
  }
  return { exempt: true, files: [...changed].sort(), reason: null, reviewedHead: toHead };
}

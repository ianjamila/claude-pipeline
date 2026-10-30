// Text-level half of "was this merge conflict resolved only by SELECTING lines the two sides already had?" (the git half is
// git.mjs#resolutionReviewBase). Pure functions, no git: they take blob text and answer yes / no / "cannot tell".
//
// The inputs are three blobs of one conflicted file: the marker blob (git's trial merge with conflict markers left in,
// merge style: no base section), the two sides' blobs (stages 2 and 3 of that merge), and the resolved
// file from the branch head. Everything is compared as byte-exact lines that KEEP their terminators ("a\r\n" and "a\n" are different lines, a
// last line without "\n" keeps its missing terminator), so an editor that rewrites EOLs, trailing spaces or a final newline
// makes the answer "no". Any doubt is "no": the caller treats it as a counted whole-PR round, which is today's behaviour.

// Thrown when a search would take more than its budget of steps; the caller maps it to "ineligible".
export class SearchCap extends Error {
  constructor() {
    super('resolution check exceeded its search budget');
    this.name = 'SearchCap';
  }
}

export const DEFAULT_BUDGET = 200_000;

// The parse and the placement search walk the blocks of a file recursively (one frame per block), so a file with thousands of
// conflict blocks would overflow the stack. Past this many blocks in one file (counted by opening-marker lines, which can only
// over-count) the answer is "cannot tell", the same as an exhausted search budget.
export const MAX_BLOCKS = 1000;

export function makeBudget(steps = DEFAULT_BUDGET) {
  let left = steps;
  return (n = 1) => {
    left -= n;
    if (left < 0) throw new SearchCap();
  };
}

// "a\nb" -> ["a\n", "b"]; "a\n" -> ["a\n"]; "" -> []. Splits on \n only, so \r stays in its line and a regex-style
// line break such as U+2028 never splits a line.
export function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

// Lines git writes around a conflict (merge style, marker size 7). Only the exact shapes: a label never contains a line break.
const OPEN = /^<{7} [^\r\n]*\r?\n$/;
const SEP = /^={7}\r?\n$/;
const CLOSE = /^>{7} [^\r\n]*\r?\n$/;
// Any line that looks like a marker of any style, with or without a terminator: a resolution must not contain one.
const MARKER_LIKE = /^(?:(?:<{7}|>{7}|\|{7})(?: [^\r\n]*)?|={7})\r?\n?$/;
export const isMarkerLine = (line) => MARKER_LIKE.test(line);

// Splits M (marker blob lines) into the lines outside the conflict blocks and the two sides of each block, against S2 / S3 (the
// sides' blobs, stages 2 and 3 of the merge). Two ways, tried in this order:
//
// 1. FAST PATH, for the usual file (and the only one that copes with clean hunks). git writes M from S2 and S3 under a forced
//    merge config: outside the blocks it holds the lines both sides agree on AND the hunks it auto-merged from one side only, so
//    the outside lines of M are not the lines of S2 or S3 and cannot be compared with them. Instead: if every marker-shaped line
//    of M is an exact opening / `=======` / closing line and they come as (open sep close)+ in order, then no content line of M is
//    marker-shaped, so the split into blocks is unique and nothing about it needs guessing. Each side of each block is then PROVEN
//    to come from its blob: its lines occur as one contiguous run of S2 (S3), and the runs of successive blocks follow one
//    another in order (earliest match, searched on from the end of the previous run). Outside lines are not compared with S2 / S3
//    here: they are git's own merge output, and checkSelection requires the branch head to repeat them exactly. Any marker-shaped
//    line that is not part of that sequence (a `=======` content line, a `|||||||` line, an unterminated marker) or any run that
//    is not found skips the fast path.
// 2. EXACT RECONSTRUCTION, for everything else, and for a file without clean hunks: outside lines must be equal in M, S2 and S3;
//    between an opening marker and `=======` the lines must be the next lines of S2, between `=======` and the closing marker
//    the next lines of S3. That reconstruction check is what settles a "=======" line that is content: only a split that rebuilds
//    BOTH side blobs byte for byte is a parse. (With clean hunks in the file it finds no parse, which is a counted round.)
// When a side's blob ends without a newline, git writes one before the next marker; that single added "\n" is accepted on the
// side's last line and the blob's own bytes are what the side's line is.
// The budget is charged for the scan of M and for every position and line the run search looks at.
// -> { outsides: [lines[]] (blocks + 1 of them), blocks: [{ ours: lines[], theirs: lines[] }] } | { reason: 'no-parse' | 'ambiguous' | 'too-many-blocks' }
// The fast path (see parseConflictBlocks). `labels` ({ ours, theirs }: the two arguments the trial merge was run with, which git
// writes after the opening / closing marker, alone or followed by ":<path>") makes the split depend on the labels too: a trio of
// marker-shaped lines already in a file as content cannot carry the commit ids of a merge that contains it, so it is never taken
// for a block (it skips the fast path instead). Without `labels` any label is accepted.
// -> { outsides, blocks } | null (not applicable: use the exact parser)
function fastSplit(M, S2, S3, tick, labels) {
  tick(M.length + 1);
  const labelled = (line, label) => {
    if (!labels) return true;
    const rest = line.slice(8).replace(/\r?\n$/, '');
    return rest === label || rest.startsWith(`${label}:`);
  };
  const spans = []; // [openIndex, sepIndex, closeIndex] per block
  let open = -1;
  let sep = -1;
  for (let i = 0; i < M.length; i++) {
    const line = M[i];
    if (!isMarkerLine(line)) continue;
    if (open < 0 && OPEN.test(line) && labelled(line, labels?.ours)) open = i;
    else if (open >= 0 && sep < 0 && SEP.test(line)) sep = i;
    else if (sep >= 0 && CLOSE.test(line) && labelled(line, labels?.theirs)) { spans.push([open, sep, i]); open = -1; sep = -1; }
    else return null;
  }
  if (open >= 0 || spans.length === 0) return null;

  // The first run of lines `seg` in S at or after `from` (the missing-final-newline rule applies at the blob's last line), as the
  // blob's own lines; null when there is none. -> { at, lines }
  const run = (seg, S, from) => {
    for (let q = from; q + seg.length <= S.length; q++) {
      tick();
      let i = 0;
      for (; i < seg.length; i++) {
        const want = S[q + i];
        if (seg[i] === want) continue;
        const last = q + i === S.length - 1;
        if (!(last && i === seg.length - 1 && !want.endsWith('\n') && seg[i] === `${want}\n`)) break;
      }
      tick(i);
      if (i === seg.length) return { at: q + seg.length, lines: S.slice(q, q + seg.length) };
    }
    return null;
  };

  const outsides = [M.slice(0, spans[0][0])];
  const blocks = [];
  let p2 = 0;
  let p3 = 0;
  for (let b = 0; b < spans.length; b++) {
    const [o, e, c] = spans[b];
    const ours = run(M.slice(o + 1, e), S2, p2);
    const theirs = run(M.slice(e + 1, c), S3, p3);
    if (!ours || !theirs) return null;
    p2 = ours.at;
    p3 = theirs.at;
    blocks.push({ ours: ours.lines, theirs: theirs.lines });
    outsides.push(M.slice(c + 1, b + 1 < spans.length ? spans[b + 1][0] : M.length));
  }
  return { outsides, blocks };
}

export function parseConflictBlocks(markerLines, stage2Lines, stage3Lines, tick = makeBudget(), labels = null) {
  const M = markerLines;
  const S2 = stage2Lines;
  const S3 = stage3Lines;
  const found = [];
  const outsides = [[]];
  const blocks = [];

  // From M[from] on: the ways the side can end at a line accepted by `isEnd`. -> [{ end: index of the end marker, count }]
  const sideEnds = (from, S, p, isEnd) => {
    const ends = [];
    for (let x = from, t = 0; x < M.length; x++, t++) {
      tick();
      const line = M[x];
      if (isEnd(line)) ends.push({ end: x, count: t });
      if (p + t < S.length && line === S[p + t]) continue;
      // git's added newline: the blob's last line has none, the marker blob does.
      if (p + t === S.length - 1 && !S[p + t].endsWith('\n') && line === `${S[p + t]}\n` && x + 1 < M.length && isEnd(M[x + 1])) {
        ends.push({ end: x + 1, count: t + 1 });
      }
      break;
    }
    return ends;
  };

  if (M.reduce((n, l) => n + (OPEN.test(l) ? 1 : 0), 0) > MAX_BLOCKS) return { reason: 'too-many-blocks' };
  const fastParse = fastSplit(M, S2, S3, tick, labels);
  if (fastParse) return fastParse;

  const go = (mi, p2, p3) => {
    let pushed = 0;
    try {
      for (;;) {
        if (found.length >= 2) return;
        if (mi === M.length) {
          if (p2 === S2.length && p3 === S3.length) found.push({ outsides: outsides.map((o) => o.slice()), blocks: blocks.map((b) => ({ ours: b.ours.slice(), theirs: b.theirs.slice() })) });
          return;
        }
        tick();
        const line = M[mi];
        if (OPEN.test(line)) {
          for (const o of sideEnds(mi + 1, S2, p2, (l) => SEP.test(l))) {
            for (const t of sideEnds(o.end + 1, S3, p3, (l) => CLOSE.test(l))) {
              blocks.push({ ours: S2.slice(p2, p2 + o.count), theirs: S3.slice(p3, p3 + t.count) });
              outsides.push([]);
              go(t.end + 1, p2 + o.count, p3 + t.count);
              outsides.pop();
              blocks.pop();
              if (found.length >= 2) return;
            }
          }
        }
        if (p2 < S2.length && p3 < S3.length && line === S2[p2] && line === S3[p3]) {
          outsides.at(-1).push(line);
          pushed++;
          mi++;
          p2++;
          p3++;
          continue;
        }
        return;
      }
    } finally {
      for (let i = 0; i < pushed; i++) outsides.at(-1).pop();
    }
  };
  go(0, 0, 0);
  if (found.length === 0) return { reason: 'no-parse' };
  if (found.length > 1) return { reason: 'ambiguous' };
  return found[0];
}

// line -> ascending positions, for both sides of a block. Charged one step per line.
export function positionMaps(ours, theirs, tick = makeBudget()) {
  tick(ours.length + theirs.length + 1);
  const positions = (side) => {
    const m = new Map();
    side.forEach((l, i) => (m.has(l) ? m.get(l).push(i) : m.set(l, [i])));
    return m;
  };
  return { oursAt: positions(ours), theirsAt: positions(theirs) };
}

// Is R an interleaving of a subsequence of `ours` and a subsequence of `theirs`? Existential: some way to give every line of R
// to one side such that each side's lines keep their order. Greedy would be wrong: ours [a,b], theirs [b,a], R [b,a,b] only
// works as b and a from theirs and the last b from ours (giving the first b to ours strands the a). So this is a layered search over (next ours, next theirs)
// pointers; handing a line to a side always takes that side's EARLIEST matching line, which dominates any later one.
// The cost of a path is the number of lines it takes from `theirs`; the cheapest path gives the most lines of theirs that
// can have been dropped (the number the reviewer is asked to justify), so an identical line is credited to ours.
// `at` is the line -> positions maps of the two sides (positionMaps); a caller that asks about one block many times builds them
// once. Without it they are built here, and charged.
// -> { ok: false } | { ok: true, droppedTheirs }
export function interleave(R, ours, theirs, tick = makeBudget(), at = null) {
  if (R.length > ours.length + theirs.length) return { ok: false };
  const { oursAt, theirsAt } = at ?? positionMaps(ours, theirs, tick);
  // First position >= from in the (ascending) position list of `line`, or -1: a binary search, so one step costs O(log n), not O(n).
  const next = (map, line, from) => {
    const at = map.get(line);
    if (!at) return -1;
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < at.length ? at[lo] : -1;
  };
  const width = theirs.length + 1;
  let layer = new Map([[0, 0]]); // i * width + j -> fewest lines taken from theirs
  for (const line of R) {
    const out = new Map();
    for (const [key, cost] of layer) {
      tick();
      const i = Math.floor(key / width);
      const j = key % width;
      const oi = next(oursAt, line, i);
      if (oi >= 0) {
        const k = (oi + 1) * width + j;
        if (!out.has(k) || out.get(k) > cost) out.set(k, cost);
      }
      const tj = next(theirsAt, line, j);
      if (tj >= 0) {
        const k = i * width + tj + 1;
        if (!out.has(k) || out.get(k) > cost + 1) out.set(k, cost + 1);
      }
    }
    if (out.size === 0) return { ok: false };
    layer = out;
  }
  return { ok: true, droppedTheirs: theirs.length - Math.min(...layer.values()) };
}

// Does `head` equal the marker blob with every conflict block replaced by lines taken from its two sides?
// The budget is charged in proportion to the work: one step per candidate end, per line compared and per line copied, so a
// block of tens of thousands of lines trips it long before the quadratic part of the search has run for any length of time.
// -> { ok: true, droppedTheirs: [n per block] } | { ok: false, reason: 'outside-edit' | 'not-selection' | 'marker-line' }
export function checkSelection(parsed, headLines, tick = makeBudget()) {
  const { outsides, blocks } = parsed;
  const H = headLines;
  const matchesAt = (O, pos) => {
    if (pos < 0 || pos + O.length > H.length) return false;
    for (let i = 0; i < O.length; i++) {
      if (H[pos + i] !== O[i]) { tick(i + 1); return false; }
    }
    tick(Math.max(O.length, 1));
    return true;
  };
  // markersBefore[i] = how many of H[0..i) are marker-like lines, so "does H[p..e) hold a marker line" is O(1).
  tick(H.length + 1);
  const markersBefore = [0];
  for (const line of H) markersBefore.push(markersBefore.at(-1) + (isMarkerLine(line) ? 1 : 0));
  if (!matchesAt(outsides[0], 0)) return { ok: false, reason: 'outside-edit' };

  let sawMarker = false;
  let sawOther = false;
  const bad = new Set();
  const maps = []; // per block, built on first use: the same block is asked about at every candidate end
  const place = (b, p) => {
    if (b === blocks.length) return p === H.length ? [] : null;
    const key = b * (H.length + 1) + p;
    if (bad.has(key)) return null;
    const O = outsides[b + 1];
    const { ours, theirs } = blocks[b];
    const last = b === blocks.length - 1;
    const lo = last ? H.length - O.length : p;
    const hi = last ? lo : Math.min(H.length - O.length, p + ours.length + theirs.length);
    for (let e = Math.max(lo, p); e <= hi; e++) {
      tick();
      if (!matchesAt(O, e)) continue;
      if (markersBefore[e] > markersBefore[p]) { sawMarker = true; continue; }
      tick(e - p + 1);
      const R = H.slice(p, e);
      const got = interleave(R, ours, theirs, tick, (maps[b] ??= positionMaps(ours, theirs, tick)));
      if (!got.ok) { sawOther = true; continue; }
      const rest = place(b + 1, e + O.length);
      if (rest) return [got.droppedTheirs, ...rest];
    }
    bad.add(key);
    return null;
  };
  const dropped = place(0, outsides[0].length);
  if (dropped) return { ok: true, droppedTheirs: dropped };
  if (sawMarker && !sawOther) return { ok: false, reason: 'marker-line' };
  return { ok: false, reason: sawOther || sawMarker ? 'not-selection' : 'outside-edit' };
}

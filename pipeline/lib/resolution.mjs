// Text-level half of "was this merge conflict resolved only by SELECTING lines the two sides already had?" (the git half is
// git.mjs#resolutionReviewBase). Pure functions, no git: they take blob text and answer yes / no / "cannot tell".
//
// The inputs are three blobs of one conflicted file: the marker blob (git's trial merge with conflict markers left in,
// merge style: no base section), the two sides' blobs (stages 2 and 3 of that merge), and the resolved file from the branch
// head. Everything is compared as byte-exact lines that KEEP their terminators ("a\r\n" and "a\n" are different lines, a
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

// Walks M (marker blob lines) against S2 / S3 (the sides' blob lines). Outside lines must be equal in M, S2 and S3; between
// an opening marker and `=======` the lines must be the next lines of S2, between `=======` and the closing marker the next
// lines of S3. That reconstruction check is what settles a "=======" line that is content: only a split that rebuilds BOTH
// side blobs byte for byte is a parse. When a side's blob ends without a newline, git writes one before the next marker; that
// single added "\n" is accepted on the side's last line and the blob's own bytes are what the side's line is.
// -> { outsides: [lines[]] (blocks + 1 of them), blocks: [{ ours: lines[], theirs: lines[] }] } | { reason: 'no-parse' | 'ambiguous' }
export function parseConflictBlocks(markerLines, stage2Lines, stage3Lines, tick = makeBudget()) {
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

// Is R an interleaving of a subsequence of `ours` and a subsequence of `theirs`? Existential: some way to give every line of R
// to one side such that each side's lines keep their order. Greedy would be wrong: ours [a,b], theirs [b,a], R [b,a,b] only
// works as b and a from theirs and the last b from ours (giving the first b to ours strands the a). So this is a layered search over (next ours, next theirs)
// pointers; handing a line to a side always takes that side's EARLIEST matching line, which dominates any later one.
// The cost of a path is the number of lines it takes from `theirs`; the cheapest path gives the most lines of theirs that
// can have been dropped (the number the reviewer is asked to justify), so an identical line is credited to ours.
// -> { ok: false } | { ok: true, droppedTheirs }
export function interleave(R, ours, theirs, tick = makeBudget()) {
  if (R.length > ours.length + theirs.length) return { ok: false };
  const positions = (side) => {
    const m = new Map();
    side.forEach((l, i) => (m.has(l) ? m.get(l).push(i) : m.set(l, [i])));
    return m;
  };
  const oursAt = positions(ours);
  const theirsAt = positions(theirs);
  const next = (map, line, from) => map.get(line)?.find((i) => i >= from) ?? -1;
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
// -> { ok: true, droppedTheirs: [n per block] } | { ok: false, reason: 'outside-edit' | 'not-selection' | 'marker-line' }
export function checkSelection(parsed, headLines, tick = makeBudget()) {
  const { outsides, blocks } = parsed;
  const H = headLines;
  const matchesAt = (O, pos) => {
    if (pos < 0 || pos + O.length > H.length) return false;
    for (let i = 0; i < O.length; i++) if (H[pos + i] !== O[i]) return false;
    return true;
  };
  if (!matchesAt(outsides[0], 0)) return { ok: false, reason: 'outside-edit' };

  let sawMarker = false;
  let sawOther = false;
  const bad = new Set();
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
      const R = H.slice(p, e);
      if (R.some(isMarkerLine)) { sawMarker = true; continue; }
      const got = interleave(R, ours, theirs, tick);
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

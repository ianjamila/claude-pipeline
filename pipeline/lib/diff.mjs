// Unified-diff parser for `git diff -M --unified=0 --no-color --no-ext-diff <base>...<head>` (default a/ b/ prefixes).
// Why hand-rolled: hard-stop and test-integrity checks need exact statuses, paths and line numbers (deleted tests,
// added `.skip`, edited assertions), and a regex over raw diff text misreads `+++ x` content lines as file headers.
// So the parser counts hunk lines from each `@@` header and only reads headers while outside a hunk.
// Added lines carry NEW-file numbers, removed lines OLD-file numbers. Line text is kept exactly (a CRLF stays in `text`).
// Anything unexpected throws rather than guessing (truncated or overflowing hunks, non-a/ b/ prefixes): a guess
// could let a deleted test slip through unnoticed. Trailing \r is stripped from header lines only, never from content.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const SIMPLE_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
const isOctal = (ch) => ch >= '0' && ch <= '7';
const PREFIX_ERROR = 'unexpected diff path prefix — run git diff with --src-prefix=a/ --dst-prefix=b/';

// "@@ -a,b +c,d @@": a missing count means 1, a count of 0 means no lines on that side.
export function parseHunkHeader(line) {
  const m = HUNK_HEADER.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

// Reads one C-quoted token starting at s[start] === '"'. Escapes yield raw bytes (git quotes non-ASCII as octal
// UTF-8 bytes), so collect bytes and decode once: "caf\303\251" -> café.
function readQuoted(s, start) {
  const bytes = [];
  let i = start + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return { value: Buffer.from(bytes).toString('utf8'), end: i + 1 };
    if (ch !== '\\') {
      const cp = String.fromCodePoint(s.codePointAt(i));
      bytes.push(...Buffer.from(cp, 'utf8'));
      i += cp.length;
    } else if (isOctal(s[i + 1] ?? '')) {
      let j = i + 1;
      let code = 0;
      while (j < i + 4 && isOctal(s[j] ?? '')) code = code * 8 + (s.charCodeAt(j++) - 48);
      bytes.push(code & 0xff);
      i = j;
    } else if (Object.hasOwn(SIMPLE_ESCAPES, s[i + 1])) {
      bytes.push(SIMPLE_ESCAPES[s[i + 1]]);
      i += 2;
    } else {
      throw new Error(`bad escape in quoted path: ${s}`);
    }
  }
  throw new Error(`unterminated quoted path: ${s}`);
}

export function unquoteCPath(s) {
  if (s[0] !== '"') throw new Error(`not a quoted path: ${s}`);
  const { value, end } = readQuoted(s, 0);
  if (end !== s.length) throw new Error(`trailing text after quoted path: ${s}`);
  return value;
}

// A path as written on `rename from/to` and `---`/`+++` lines: C-quoted, or raw (git adds a trailing tab after
// raw paths containing spaces on ---/+++, so drop it; a real tab in a name would have forced quoting).
function readPath(s) {
  return s.startsWith('"') ? readQuoted(s, 0).value : s.replace(/\t$/, '');
}

// Paths are only trustworthy with git's default a/ b/ prefixes; with --no-prefix a top-level `b/` directory
// would be silently mangled, so any other prefix is an error.
function stripPrefix(p, prefix) {
  if (!p.startsWith(prefix)) throw new Error(PREFIX_ERROR);
  return p.slice(prefix.length);
}

// Splits the `a/<old> b/<new>` tail of a `diff --git` line. Plain spaces are NOT quoted by git, so when both
// sides are raw: a non-rename diff has identical sides (cut in the middle); a rename is also described by its
// `rename from/to` lines, which win over this guess.
function splitGitHeader(rest) {
  let a;
  let b;
  if (rest.startsWith('"')) {
    const q = readQuoted(rest, 0);
    a = q.value;
    const tail = rest.slice(q.end + 1);
    b = tail.startsWith('"') ? readQuoted(tail, 0).value : tail;
  } else if (rest.includes(' "')) {
    // Raw paths never contain a quote character, so the first ` "` opens the quoted second path.
    const q = rest.indexOf(' "');
    a = rest.slice(0, q);
    b = readQuoted(rest, q + 1).value;
  } else {
    const mid = (rest.length - 1) / 2;
    const left = rest.slice(0, mid);
    const right = rest.slice(mid + 1);
    if (Number.isInteger(mid) && rest[mid] === ' ' && left.startsWith('a/') && right.startsWith('b/') && left.slice(2) === right.slice(2)) {
      a = left;
      b = right;
    } else {
      const cut = rest.indexOf(' b/');
      a = cut === -1 ? rest : rest.slice(0, cut);
      b = cut === -1 ? rest : rest.slice(cut + 1);
    }
  }
  return { oldPath: stripPrefix(a, 'a/'), newPath: stripPrefix(b, 'b/') };
}

function beginFile(headerLine) {
  const { oldPath, newPath } = splitGitHeader(headerLine.slice('diff --git '.length));
  return {
    headerOld: oldPath, headerNew: newPath, minusPath: null, plusPath: null, renameFrom: null, renameTo: null,
    minusDevNull: false, plusDevNull: false, hasHunks: false, isNew: false, isDeleted: false, similarity: null, binary: false, gitlink: false,
    added: [], removed: [],
  };
}

function finishFile(f) {
  const renamed = f.renameFrom !== null || f.renameTo !== null;
  const status = renamed ? 'R' : f.isNew || f.minusDevNull ? 'A' : f.isDeleted || f.plusDevNull ? 'D' : 'M';
  const oldPath = status === 'A' ? null : (f.renameFrom ?? f.minusPath ?? f.headerOld);
  const newPath = status === 'D' ? null : (f.renameTo ?? f.plusPath ?? f.headerNew);
  const out = {
    oldPath, newPath, path: status === 'D' ? oldPath : newPath, status,
    similarity: status === 'R' ? f.similarity : null, binary: f.binary, added: f.added, removed: f.removed,
  };
  if (f.gitlink) out.gitlink = true; // a submodule (mode 160000) entry; only present when true
  return out;
}

// Applies one `---`/`+++` line (outside a hunk) to the current file.
function applyFileHeader(f, line) {
  const isMinus = line.startsWith('--- ');
  const raw = line.slice(4);
  if (raw === '/dev/null') {
    f[isMinus ? 'minusDevNull' : 'plusDevNull'] = true;
  } else {
    f[isMinus ? 'minusPath' : 'plusPath'] = stripPrefix(readPath(raw), isMinus ? 'a/' : 'b/');
  }
}

export function parseUnifiedDiff(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const done = [];
  let cur = null;
  let hunk = null; // { oldLine, newLine, oldLeft, newLeft }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (hunk) {
      // Inside a hunk every +/-/space line is content, whatever it looks like; counts say when the hunk ends.
      const c = raw[0];
      if (c === '\\') continue; // "\ No newline at end of file" belongs to no side
      if (c === '+' && hunk.newLeft > 0) {
        cur.added.push({ line: hunk.newLine++, text: raw.slice(1) });
        hunk.newLeft--;
      } else if (c === '-' && hunk.oldLeft > 0) {
        cur.removed.push({ line: hunk.oldLine++, text: raw.slice(1) });
        hunk.oldLeft--;
      } else if ((c === ' ' || raw === '' || raw === '\r') && hunk.oldLeft > 0 && hunk.newLeft > 0) {
        // A blank line is a context line whose single space was stripped (with CRLF it arrives as a bare \r).
        hunk.oldLine++; hunk.newLine++; hunk.oldLeft--; hunk.newLeft--;
      } else if (c === '+' || c === '-' || c === ' ' || raw === '' || raw === '\r') {
        throw new Error(`malformed diff: hunk line count overflow at line ${i + 1}: ${raw}`);
      } else {
        throw new Error(`malformed diff: hunk ended early at line ${i + 1}: ${raw}`);
      }
      if (hunk.oldLeft === 0 && hunk.newLeft === 0) hunk = null;
      continue;
    }

    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // header lines may arrive CRLF-converted
    if (line.startsWith('diff --git ')) {
      if (cur) done.push(finishFile(cur));
      cur = beginFile(line);
    } else if (line.startsWith('@@')) {
      const h = parseHunkHeader(line);
      if (!cur) throw new Error(`malformed diff: hunk header before any file header at line ${i + 1}`);
      if (!h) throw new Error(`malformed diff: bad hunk header at line ${i + 1}: ${line}`);
      cur.hasHunks = true;
      if (h.oldCount + h.newCount > 0) hunk = { oldLine: h.oldStart, newLine: h.newStart, oldLeft: h.oldCount, newLeft: h.newCount };
    } else if (!cur) {
      continue; // preamble (e.g. `git show` commit header) before the first file
    } else if (cur.hasHunks && (line[0] === '+' || line[0] === '-' || line[0] === ' ')) {
      // Headers precede hunks, so a +/-/space line after the last hunk filled its counts is surplus content.
      throw new Error(`malformed diff: hunk line count overflow at line ${i + 1}: ${line}`);
    } else if (line.startsWith('new file mode')) {
      cur.isNew = true;
      if (/\b160000\s*$/.test(line)) cur.gitlink = true;
    } else if (line.startsWith('deleted file mode')) {
      cur.isDeleted = true;
      if (/\b160000\s*$/.test(line)) cur.gitlink = true;
    } else if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      if (/\b160000\s*$/.test(line)) cur.gitlink = true;
    } else if (line.startsWith('index ') && /\b160000\s*$/.test(line)) {
      cur.gitlink = true;
    } else if (line.startsWith('similarity index ')) {
      cur.similarity = parseInt(line.slice('similarity index '.length), 10);
    } else if (line.startsWith('rename from ')) {
      cur.renameFrom = readPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      cur.renameTo = readPath(line.slice('rename to '.length));
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      applyFileHeader(cur, line);
    } else if (line === 'GIT binary patch' || (line.startsWith('Binary files ') && line.endsWith(' differ'))) {
      cur.binary = true;
    }
    // Everything else outside a hunk (index, old/new mode, "\ No newline", binary payload) carries nothing we need.
  }

  if (hunk) throw new Error('malformed diff: truncated inside a hunk');
  if (cur) done.push(finishFile(cur));
  return done;
}

export function diffStats(files) {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added.length;
    removed += f.removed.length;
  }
  return { files: files.length, added, removed, changedLines: added + removed };
}

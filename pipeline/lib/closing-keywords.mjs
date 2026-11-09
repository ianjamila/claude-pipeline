// GitHub links (and closes on merge) only the ONE issue that directly follows a closing keyword: "Closes #170, #171" closes
// #170 and leaves #171 open, silently. This finds those lines in a PR body so review-complete can ask for one keyword per
// issue ("Closes #170. Closes #171.") before the PR is handed to the owner.
//
// Keywords are GitHub's own (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, any case, optional colon).
// A reference is #N, owner/repo#N or an issue/pull URL on github.com. Text GitHub does not read for keywords is skipped:
// fenced code blocks (``` or ~~~, any length), inline code spans and HTML comments (single- or multi-line).
// A skipped span reads as a non-separator, so "Fixes #1, `x` #2" is not a list.

const KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
const REF = String.raw`(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)`;
const SEP = String.raw`\s*(?:,|&|\+|\/|\band\b)\s*(?:and\s+)?`;
// keyword, first reference, then one or more "separator + bare reference" (a reference without its own keyword)
const LIST = new RegExp(String.raw`\b(${KEYWORD}):?\s+(${REF})((?:${SEP}${REF}(?![\w/]))+)`, 'gi');
const ONE_REF = new RegExp(REF, 'gi');
// A fence is a run of 3+ backticks or tildes; it is closed only by a run of the same character at least as long, with no
// info string (CommonMark). A backtick fence's info string cannot contain a backtick ("```code``` text" is inline code).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Inline code spans and comments become this NUL character: unlike a space it is not a list separator, so "Fixes #1, `x` #2"
// is not a list; unlike a letter it is not a word character, so "#2<!-- n -->" still ends the reference and "<!-- n -->Closes"
// still starts a keyword at a word boundary. It cannot be part of a keyword or a reference, so hidden text is never read.
const HIDDEN = '\u0000';

// One line, read left to right in CommonMark order: whichever construct opens first wins. A comment opener hides through its
// "-->" (or to the end of the line, leaving the comment open for the following lines); a backtick run hides through the next
// run of exactly the same length (a run with no partner is literal text). Returns the visible text and whether a comment is
// still open at the end of the line.
function hide(line, startInComment) {
  let out = '';
  let i = 0;
  if (startInComment) {
    const end = line.indexOf('-->');
    if (end === -1) return { text: '', inComment: true };
    out = HIDDEN;
    i = end + 3;
  }
  while (i < line.length) {
    if (line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      out += HIDDEN;
      if (end === -1) return { text: out, inComment: true };
      i = end + 3;
    } else if (line[i] === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      let j = i + n;
      let close = -1;
      while (j < line.length) {
        if (line[j] !== '`') { j++; continue; }
        let m = 1;
        while (line[j + m] === '`') m++;
        if (m === n) { close = j; break; }
        j += m;
      }
      if (close === -1) { out += line.slice(i, i + n); i += n; } else { out += HIDDEN; i = close + n; }
    } else {
      out += line[i++];
    }
  }
  return { text: out, inComment: false };
}

// [{ line, keyword, linked, unlinked: [refs] }] for every keyword followed by a list of references; [] for a clean body.
export function multiIssueClosingLines(body) {
  if (typeof body !== 'string' || body === '') return [];
  const found = [];
  let fence = null; // the opening run, e.g. "````"
  let inComment = false; // inside a <!-- ... --> that began on an earlier line
  for (const raw of body.split(/\r?\n/)) {
    const f = raw.match(FENCE);
    if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = null;
      continue;
    }
    if (!inComment && f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      continue;
    }
    const seen = hide(raw, inComment);
    inComment = seen.inComment;
    const line = seen.text;
    for (const m of line.matchAll(LIST)) {
      found.push({ line: raw.trim(), keyword: m[1], linked: m[2], unlinked: m[3].match(ONE_REF) ?? [] });
    }
  }
  return found;
}

// One refusal sentence a person (or the agent) can act on.
export function closingKeywordProblem(found, pr) {
  if (found.length === 0) return null;
  const lines = found.map((f) => {
    const kw = f.keyword[0].toUpperCase() + f.keyword.slice(1).toLowerCase();
    const fixed = [f.linked, ...f.unlinked].map((r) => `${kw} ${r}.`).join(' ');
    return `"${f.line}" closes only ${f.linked} on merge (GitHub links one issue per keyword; ${f.unlinked.join(', ')} would stay open): write "${fixed}"`;
  });
  return `the PR body ${lines.join('; ')}. Update the body (gh pr edit ${pr} --body-file <file>) and run review-complete again; no new review round is needed`;
}

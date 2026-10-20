// The plan file every ship run commits before building (spec 2026-10-19 §2). Pure: no IO. The plan's scope and tasks are
// always re-parsed from the approved git blob (never from event data), so editing the file after approval changes nothing.
import { createHash } from 'node:crypto';
import { matchAny } from './glob.mjs';
import { clip } from './render.mjs';
import { LIMITS } from './run-record.mjs';

export const MAX_PLAN_BYTES = 256 * 1024;
export const MAX_SCOPE_ENTRIES = 500;
export const PLAN_LINE_RE = /^\s*Plan\s+([0-9a-f]{40})\s*(?:·|\|)\s*scope\s+([0-9a-f]{12})\s*$/;
export const PLAN_READY_RE = /📋\s*Ready to approve plan\s+#(\d{1,6})\b/;
const TASK_HEAD = /^### Task ([A-Za-z0-9._-]{1,64}):[ \t]+(\S.*?)\s*$/;
const SCOPE_ITEM = /^ ?[-*]\s+`([^`\n]+)`/;
// CommonMark fences: opener = up to 3 spaces + a run of 3+ backticks or tildes (a backtick info string holds no backtick);
// closer = same character, at least as long, up to 3 spaces, only spaces after. 4+ spaces of indent (or a tab) is code.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// What the owner sees rendered must be what the parser reads: raw HTML and comments are invisible once rendered, so a
// plan holding any (outside fences and inline code spans) is refused. The tag-line test is deliberately wider than
// CommonMark's 0-3 spaces of indent (a list continuation can indent an HTML block further).
const HTML_COMMENT = /<!--/;
// Inline constructs per CommonMark, scanned left to right: whichever construct STARTS first wins. A backslash-escaped ASCII
// punctuation mark is literal; a raw-HTML construct (tag, comment, PI, declaration, CDATA) or autolink that starts first is kept
// verbatim (its backticks pair with nothing); a code span opens at a run of N backticks and closes only at the next run of
// EXACTLY N (an unclosed run is literal). Only closed spans are masked, so everything else still meets the raw-HTML / entity
// checks. The scan runs over one line AND over a whole paragraph-ish block (backticks pair across lines): scanInline returns
// {text, map} where map[k] is the 0-based line, within the scanned text, that produced text[k].
const ATTR = '\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s"\'=<>`]+|\'[^\']*\'|"[^"]*"))?';
const TAG_RE = new RegExp(`<[A-Za-z][A-Za-z0-9-]*(?:${ATTR})*\\s*/?>|</[A-Za-z][A-Za-z0-9-]*\\s*>|<![A-Za-z][^>]*>`, 'y');
const AUTO_RE = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
const PUNCT = /[!-\/:-@[-`{-~]/;
function scanInline(src) {
  const lineAt = new Uint32Array(src.length + 1);
  for (let k = 0, ln = 0; k < src.length; k++) { lineAt[k] = ln; if (src[k] === '\n') ln += 1; }
  let out = '';
  const map = [];
  const emit = (a, b) => { out += src.slice(a, b); for (let k = a; k < b; k++) map.push(lineAt[k]); };
  const none = new Set(); // closers / terminators already known to be absent from the rest of the text
  const endOf = (open, close, from) => {
    if (none.has(close)) return -1;
    const j = src.indexOf(close, from);
    if (j < 0) none.add(close);
    return j < 0 ? -1 : j + close.length;
  };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) { emit(i, i + 2); i += 2; continue; }
    if (c === '<') {
      let end = -1;
      if (src.startsWith('<!--', i)) {
        end = src.startsWith('<!-->', i) ? i + 5 : src.startsWith('<!--->', i) ? i + 6 : endOf('<!--', '-->', i + 4);
      } else if (src.startsWith('<?', i)) end = endOf('<?', '?>', i + 2);
      else if (src.startsWith('<![CDATA[', i)) end = endOf('<![CDATA[', ']]>', i + 9);
      if (end < 0) {
        for (const re of [AUTO_RE, TAG_RE]) {
          re.lastIndex = i;
          const m = re.exec(src);
          if (m) { end = i + m[0].length; break; }
        }
      }
      if (end > i) { emit(i, end); i = end; continue; }
      emit(i, i + 1); i += 1; continue;
    }
    if (c !== '`') { emit(i, i + 1); i += 1; continue; }
    let n = 1;
    while (src[i + n] === '`') n += 1;
    let close = -1;
    if (!none.has(`\`${n}`)) {
      for (let j = i + n; j < src.length;) {
        if (src[j] !== '`') { j += 1; continue; }
        let m = 1;
        while (src[j + m] === '`') m += 1;
        if (m === n) { close = j; break; }
        j += m;
      }
      if (close < 0) none.add(`\`${n}`);
    }
    if (close < 0) { emit(i, i + n); i += n; continue; }
    i = close + n;
  }
  return { text: out, map };
}
// What the owner would not see as written: raw HTML / comments, character references, link titles -> [[kind, line]].
function htmlFindings({ text, map }) {
  const found = [];
  for (const m of text.matchAll(/<!--/g)) found.push(['html', map[m.index]]);
  for (const m of text.matchAll(INLINE_TAG)) if (!AUTOLINK.test(m[0])) found.push(['html', map[m.index]]);
  for (const m of text.matchAll(new RegExp(HTML_REF.source, 'g'))) found.push(['ref', map[m.index]]);
  for (const m of text.matchAll(new RegExp(LINK_TITLE.source, 'g'))) found.push(['title', map[m.index]]);
  return found;
}
const MESSAGES = {
  html: (n) => `raw HTML/comment at line ${n} is hidden when rendered: write it as text or inside a code block`,
  ref: (n) => `HTML character reference at line ${n} renders differently from its bytes: write the character itself`,
  title: (n) => `link title at line ${n} is hidden when rendered`,
};
const HTML_TAG_LINE = /^\s*(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)|<!)/;
// A link reference definition renders as nothing, but its title text would still reach the implementers.
const LINK_DEF = /^\s{0,3}\[[^\]]+\]:\s*\S/;
// Characters that reorder or hide text, plus C0/C1 controls other than tab and newline (\r is normalised away first).
// A BOM at offset 0 is stripped instead of refused.
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\u2060\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u115F\u1160\u3164\uFFA0\u180E\u2061-\u2064\uFFF9-\uFFFB\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
// Renders differently from its bytes: character references, inline tags (autolinks excepted) and link / image titles.
const HTML_REF = /&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;
const INLINE_TAG = /<[A-Za-z/!][^>]*>/g;
const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>$/;
const LINK_TITLE = /\]\([^)]*?\s+(?:"[^"]*"|'[^']*')\s*\)/;
const SCOPE_ASCII = /^[\x21-\x7E]+$/;
// Scope must also be a flat list: no blockquoted or nested items.
const QUOTED_ITEM = /^\s*>[\s>]*[-*+]\s+`/;
// A list item that opens with a backtick must be exactly one single-backtick span (`a``b` renders as a``b, not a).
const ITEM_OPENS_SPAN = /^ ?[-*]\s+`/;
// Setext underlines and thematic breaks also change what heading an entry renders under.
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const NESTED_ITEM = /^(?: {2,}|\t)\s*[-*+]\s+`/;

export class PlanError extends Error {
  constructor(problems) {
    super(`plan: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// Line i is inside a fenced code block (the fence lines count as inside; an unclosed fence runs to the end).
// Only unmasked lines carry headings, so what the owner sees rendered is what the parser reads.
function fenceMask(lines) {
  const mask = [];
  let open = null;
  for (const l of lines) {
    if (open) {
      mask.push(true);
      const c = FENCE_CLOSE.exec(l);
      if (c && c[1][0] === open[0] && c[1].length >= open.length) open = null;
      continue;
    }
    const m = FENCE_OPEN.exec(l);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) { open = m[1]; mask.push(true); continue; }
    mask.push(false);
  }
  return mask;
}

// A section runs to the next `## ` heading, or (stopAtTask) to the first `### Task` heading: task bodies are not Scope.
function sectionLines(lines, mask, title, { stopAtTask = false } = {}) {
  const re = new RegExp(`^## ${title}\\s*$`, 'i');
  const start = lines.findIndex((l, i) => !mask[i] && re.test(l));
  if (start < 0) return null;
  const duplicate = lines.some((l, i) => i > start && !mask[i] && re.test(l));
  const stop = stopAtTask ? /^(?:## |### Task\b)/ : /^## /;
  let end = lines.findIndex((l, i) => i > start && !mask[i] && stop.test(l));
  if (end < 0) end = lines.length;
  return { lines: lines.slice(start + 1, end), mask: mask.slice(start + 1, end), from: start + 1, duplicate };
}

function trimBlank(arr) {
  const out = arr.map((l) => l.replace(/[ \t]+$/, ''));
  while (out.length && out[0] === '') out.shift();
  while (out.length && out.at(-1) === '') out.pop();
  return out;
}

export function scopeProblem(e) {
  if (e.startsWith('/') || /^[A-Za-z]:/.test(e)) return 'absolute paths are not allowed';
  if (e.includes('\\')) return 'use forward slashes';
  if (e.split('/').includes('..')) return '".." is not allowed';
  if (e.startsWith('!')) return 'negated entries are not allowed';
  return null;
}

export function parsePlan(text, { path: ownPath } = {}) {
  if (typeof text !== 'string') throw new PlanError(['the plan is not text']);
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) throw new PlanError([`the plan is larger than ${MAX_PLAN_BYTES} bytes`]);
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const problems = [];
  lines.forEach((l, i) => {
    for (const ch of new Set(l.match(INVISIBLE) ?? [])) problems.push(`invisible character U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} at line ${i + 1}`);
    if (!mask[i] && LINK_DEF.test(l)) problems.push(`link reference definition at line ${i + 1} is hidden when rendered`);
    if (mask[i]) return;
    const found = htmlFindings(scanInline(l));
    if (HTML_TAG_LINE.test(l)) found.push(['html', 0]);
    for (const kind of ['html', 'ref', 'title']) if (found.some((x) => x[0] === kind)) problems.push(MESSAGES[kind](i + 1));
  });
  // Backticks pair across the lines of a paragraph: the same checks over each run of consecutive non-blank, non-fenced lines.
  for (let i = 0; i < lines.length;) {
    if (mask[i] || lines[i].trim() === '') { i += 1; continue; }
    let j = i;
    while (j < lines.length && !mask[j] && lines[j].trim() !== '') j += 1;
    if (j - i > 1) {
      for (const [kind, rel] of htmlFindings(scanInline(lines.slice(i, j).join('\n')))) {
        const msg = MESSAGES[kind](i + rel + 1);
        if (!problems.includes(msg)) problems.push(msg);
      }
    }
    i = j;
  }

  const pe = sectionLines(lines, mask, 'In plain English');
  if (pe?.duplicate) problems.push('duplicate ## In plain English section');
  const plainEnglish = pe ? trimBlank(pe.lines).join('\n') : '';
  if (!plainEnglish) problems.push('missing or empty "## In plain English" section');

  const sc = sectionLines(lines, mask, 'Scope', { stopAtTask: true });
  const scope = [];
  if (!sc) problems.push('missing "## Scope" section');
  else {
    if (sc.duplicate) problems.push('duplicate ## Scope section');
    const flagged = new Set();
    const refuse = (why) => { if (!flagged.has(why)) { flagged.add(why); problems.push(`the "## Scope" section must be a flat list the owner can read as written: ${why}`); } };
    sc.lines.forEach((l, i) => {
      if (sc.mask[i]) return;
      if (ATX_HEADING.test(l)) { problems.push(`heading at line ${sc.from + i + 1} sits inside the "## Scope" section: entries under it render under that heading, so end Scope with a column-0 "## " heading`); return; }
      if (QUOTED_ITEM.test(l)) { refuse('it contains a scope item inside a blockquote'); return; }
      if (NESTED_ITEM.test(l)) { refuse('it contains a nested list item (indented 2+ spaces)'); return; }
      if (SETEXT_UNDERLINE.test(l) || THEMATIC_BREAK.test(l)) { problems.push(`setext underline or thematic break at line ${sc.from + i + 1} sits inside the "## Scope" section: it changes which heading the entries render under`); return; }
      const m = SCOPE_ITEM.exec(l);
      if (!m || l[m[0].length] === '`') {
        if (ITEM_OPENS_SPAN.test(l)) problems.push(`scope item at line ${sc.from + i + 1} must be exactly one single-backtick code span (a longer or unbalanced backtick run renders differently from what is parsed)`);
        return;
      }
      const e = m[1].replace(/^[ \t]+|[ \t]+$/g, '');
      if (!SCOPE_ASCII.test(e)) { problems.push(`scope entry at line ${sc.from + i + 1} must be plain ASCII`); return; }
      const why = scopeProblem(e);
      if (why) problems.push(`scope entry ${JSON.stringify(e)}: ${why}`);
      else if (!scope.includes(e)) scope.push(e);
    });
    if (scope.length === 0) problems.push('the "## Scope" section lists no backticked paths');
    if (scope.length > MAX_SCOPE_ENTRIES) problems.push(`more than ${MAX_SCOPE_ENTRIES} scope entries`);
  }

  const tasks = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = TASK_HEAD.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (mask[j] || !/^#{2,3} /.test(lines[j]))) j++;
    const [id, title] = [m[1], m[2]];
    if (seen.has(id)) problems.push(`duplicate task id ${id}`);
    seen.add(id);
    const body = trimBlank(lines.slice(i + 1, j)).join('\n');
    tasks.push({ id, title: clip(title, LIMITS.title), text: body, spec: clip(body, LIMITS.spec), specSha: sha(`${title}\n${body}`).slice(0, 12) });
    i = j - 1;
  }
  if (tasks.length === 0) problems.push('no "### Task <id>: <title>" headings');
  if (tasks.length > LIMITS.tasks) problems.push(`more than ${LIMITS.tasks} tasks`);
  if (ownPath !== undefined && scope.length && !matchAny(ownPath, scope)) problems.push(`the plan's own path ${ownPath} is not in its Scope: list it, so the owner approves it with the rest`);
  if (problems.length) throw new PlanError(problems);
  return { plainEnglish, scope, tasks };
}

export const scopeDigest = (scope) => sha([...new Set(scope.map(String))].sort().join('\n')).slice(0, 12);

export function outsideScope({ files, scope }) {
  if (!Array.isArray(files)) throw new TypeError('outsideScope: files must be an array of changed files');
  const out = new Set();
  for (const f of files) {
    for (const p of new Set([f.oldPath, f.newPath, f.path].filter((x) => typeof x === 'string' && x !== '' && x !== '/dev/null'))) {
      if (!matchAny(p, scope)) out.add(p);
    }
  }
  return [...out].sort();
}

export const planRequestLines = ({ pr, blob, scopeDigest: d }) => [
  `Plan ${blob} · scope ${d}`,
  `📋 Ready to approve plan #${pr} — say "approve"`,
];

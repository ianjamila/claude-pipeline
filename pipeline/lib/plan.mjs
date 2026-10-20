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
const SCOPE_ITEM = /^\s*[-*]\s+`([^`\n]+)`/;
const FENCE = /^\s*(```|~~~)/;

export class PlanError extends Error {
  constructor(problems) {
    super(`plan: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// Line i is inside a fenced code block (the fence lines themselves count as inside).
function fenceMask(lines) {
  const mask = [];
  let open = null;
  for (const l of lines) {
    const m = FENCE.exec(l);
    if (open) { mask.push(true); if (m && m[1] === open) open = null; continue; }
    if (m) { open = m[1]; mask.push(true); continue; }
    mask.push(false);
  }
  return mask;
}

function sectionLines(lines, mask, title) {
  const re = new RegExp(`^## ${title}\\s*$`, 'i');
  const start = lines.findIndex((l, i) => !mask[i] && re.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && !mask[i] && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { lines: lines.slice(start + 1, end), mask: mask.slice(start + 1, end) };
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
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const problems = [];

  const pe = sectionLines(lines, mask, 'In plain English');
  const plainEnglish = pe ? trimBlank(pe.lines).join('\n') : '';
  if (!plainEnglish) problems.push('missing or empty "## In plain English" section');

  const sc = sectionLines(lines, mask, 'Scope');
  const scope = [];
  if (!sc) problems.push('missing "## Scope" section');
  else {
    sc.lines.forEach((l, i) => {
      if (sc.mask[i]) return;
      const m = SCOPE_ITEM.exec(l);
      if (!m) return;
      const e = m[1].trim();
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
  const out = new Set();
  for (const f of files ?? []) {
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

// Why: the arbiter's ruling is only trusted if Claude Code's own transcript log shows every assistant
// turn ran on the pinned model at the pinned effort — never the model's say-so. This module finds that
// transcript, proves (or disproves) the model/effort, and pulls the ruling JSON out of the verified
// transcript itself. The transcript format is undocumented and unstable, so every unknown shape
// FAILS CLOSED: it adds an error and ok stays false.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- locating transcripts ----------

// Agent ids are hex-ish; refusing anything else keeps a hostile id from escaping the subagents dir.
const AGENT_ID_RE = /^[\w-]+$/;

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function listDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

// Every <projectsDir>/<encoded-cwd>/<session-id>/subagents directory that exists.
function subagentDirs(projectsDir) {
  const dirs = [];
  for (const project of listDir(projectsDir)) {
    const projectDir = path.join(projectsDir, project);
    if (!statOrNull(projectDir)?.isDirectory()) continue;
    for (const session of listDir(projectDir)) {
      const dir = path.join(projectDir, session, 'subagents');
      if (statOrNull(dir)?.isDirectory()) dirs.push(dir);
    }
  }
  return dirs;
}

// Parsed meta only if the file is readable JSON holding a plain object; anything else is "unknown shape".
function readMetaObject(metaPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Newest mtime wins; ties break on path so the choice never depends on directory order.
function newest(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!best || c.mtimeMs > best.mtimeMs || (c.mtimeMs === best.mtimeMs && c.file > best.file)) best = c;
  }
  return best;
}

// A file dated further ahead than this is treated as untrustworthy (a stale copy with a bad clock would
// otherwise always look "newest").
const FUTURE_SKEW_MS = 60e3;

// By agentId (wins if both are given) or by tag. A tag match returns the sibling .jsonl path without
// checking it exists: the meta can appear before the transcript, so callers read it inside try/catch.
export function findSubagentTranscript(opts) {
  if (!isPlainObject(opts)) return null;
  const {
    agentId,
    tag,
    projectsDir = path.join(os.homedir(), '.claude', 'projects'),
    maxAgeMs = 6 * 3600e3,
    now = Date.now(),
  } = opts;
  if (typeof projectsDir !== 'string' || projectsDir === '') return null;
  // NaN would make every age comparison false and silently accept stale or future files.
  if (!Number.isFinite(maxAgeMs) || !Number.isFinite(now)) return null;
  const notFuture = (st) => st.mtimeMs <= now + FUTURE_SKEW_MS;

  if (agentId !== undefined && agentId !== null) {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
    const found = [];
    for (const dir of subagentDirs(projectsDir)) {
      const file = path.join(dir, `agent-${agentId}.jsonl`);
      const st = statOrNull(file);
      if (st?.isFile() && notFuture(st)) found.push({ file, mtimeMs: st.mtimeMs });
    }
    const best = newest(found);
    if (!best) return null;
    const metaFile = best.file.replace(/\.jsonl$/, '.meta.json');
    const hasMeta = statOrNull(metaFile)?.isFile() === true;
    return { jsonlPath: best.file, metaPath: hasMeta ? metaFile : null, meta: hasMeta ? readMetaObject(metaFile) : null };
  }

  if (typeof tag !== 'string' || tag === '') return null;
  const matches = [];
  for (const dir of subagentDirs(projectsDir)) {
    for (const name of listDir(dir)) {
      if (!name.endsWith('.meta.json')) continue;
      const file = path.join(dir, name);
      const st = statOrNull(file);
      if (!st?.isFile() || now - st.mtimeMs > maxAgeMs || !notFuture(st)) continue;
      const meta = readMetaObject(file);
      if (meta && meta.description === tag) matches.push({ file, mtimeMs: st.mtimeMs, meta });
    }
  }
  const best = newest(matches);
  if (!best) return null;
  return { jsonlPath: best.file.replace(/\.meta\.json$/, '.jsonl'), metaPath: best.file, meta: best.meta };
}

// ---------- proving the model ----------

// Text blocks only (thinking / tool_use / tool_result / images carry no prose); a bare string passes through.
function textBlocks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => isPlainObject(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
}

// Counts live in a Map and are copied into a plain object only on return: a model named "__proto__" or
// "constructor" must not hit Object.prototype.
function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

// Claude Code adds reminder and hook-context lines as user lines marked isMeta with no origin. They are
// not input; a line with an origin (another agent's or the coordinator's message) still is.
const isHarnessNote = (line) => line.isMeta === true && !has(line, 'origin');

// A human prompt turn: a user line holding a string or a text block. tool_result-only lines are not.
function isPromptTurn(line) {
  if (isHarnessNote(line)) return false;
  const content = isPlainObject(line.message) ? line.message.content : undefined;
  return typeof content === 'string' || (Array.isArray(content) && content.some((b) => isPlainObject(b) && b.type === 'text'));
}

export function proveModel({ jsonlText, metaText, expectModelPrefix, expectEffort, expectMetaModel = null, expectAgentType = null }) {
  const errors = [];
  const models = new Map();
  const efforts = new Map();
  const asst = []; // { line, n } for every assistant line, in file order
  let firstUserText = null;
  let promptTurns = 0;

  // An empty expectation would "prove" anything, so it is itself a failure.
  const prefixOk = typeof expectModelPrefix === 'string' && expectModelPrefix !== '';
  const effortOk = typeof expectEffort === 'string' && expectEffort !== '';
  if (!prefixOk) errors.push('invalid expectation: expectModelPrefix');
  if (!effortOk) errors.push('invalid expectation: expectEffort');
  const agentTypeGiven = expectAgentType !== null && expectAgentType !== undefined;
  if (agentTypeGiven && (typeof expectAgentType !== 'string' || expectAgentType === '')) {
    errors.push('invalid expectation: expectAgentType');
  }

  if (typeof jsonlText !== 'string') {
    errors.push('transcript text missing');
  } else {
    const rows = jsonlText.split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      const n = i + 1;
      if (rows[i].trim() === '') continue;
      let line;
      try {
        line = JSON.parse(rows[i]);
      } catch {
        line = undefined;
      }
      if (!isPlainObject(line)) {
        errors.push(`unparseable line ${n}`);
        continue;
      }
      if (line.type === 'user') {
        if (firstUserText === null && !isHarnessNote(line)) firstUserText = textBlocks(line.message?.content).join('\n');
        if (isPromptTurn(line)) promptTurns++;
        continue;
      }
      if (line.type !== 'assistant') continue;

      asst.push({ line, n });
      const model = isPlainObject(line.message) ? line.message.model : undefined;
      bump(models, String(model));
      bump(efforts, String(line.effort));

      if (prefixOk && !(typeof model === 'string' && model.startsWith(expectModelPrefix))) {
        errors.push(`unexpected model ${String(model)} on line ${n}`);
      }
      // Anything but an absent or literal-false isApiErrorMessage, any error key, any apiErrorStatus key.
      const flagged = has(line, 'isApiErrorMessage') && line.isApiErrorMessage !== false;
      if (flagged || has(line, 'error') || has(line, 'apiErrorStatus')) {
        const detail = has(line, 'error')
          ? String(line.error)
          : has(line, 'apiErrorStatus')
            ? `apiErrorStatus ${String(line.apiErrorStatus)}`
            : `isApiErrorMessage ${JSON.stringify(line.isApiErrorMessage)}`;
        errors.push(`API error on line ${n}: ${detail}`);
      }
      if (effortOk && line.effort !== expectEffort) {
        errors.push(`unexpected effort ${String(line.effort)} on line ${n}`);
      }
      // null means "no per-turn override"; any real value must agree with the pinned effort too.
      if (effortOk && has(line, 'perTurnEffort') && line.perTurnEffort !== null && line.perTurnEffort !== expectEffort) {
        errors.push(`unexpected perTurnEffort ${String(line.perTurnEffort)} on line ${n}`);
      }
    }
  }

  // A resumed agent (or a message injected mid-run) means the ruling may answer a different input than
  // the one whose digest the first prompt carries.
  if (promptTurns > 1) errors.push('multiple prompts (agent was resumed); ruling cannot be bound to one input');
  if (asst.length === 0) errors.push('no assistant messages');

  // meta.json carries "model" only when the caller passed a per-call override, which beats the agent
  // definition — so any override (even null) is an error unless the caller expects exactly that one.
  if (metaText === undefined || metaText === null) {
    errors.push('meta missing');
  } else {
    let meta;
    try {
      meta = JSON.parse(metaText);
    } catch {
      meta = undefined;
    }
    if (!isPlainObject(meta)) {
      errors.push('unparseable meta');
    } else {
      if (has(meta, 'model') && (expectMetaModel === null || meta.model !== expectMetaModel)) {
        errors.push(`per-call model override present: ${String(meta.model)}`);
      }
      if (agentTypeGiven && typeof expectAgentType === 'string' && expectAgentType !== '' && meta.agentType !== expectAgentType) {
        errors.push(`unexpected agent type ${String(meta.agentType)}`);
      }
    }
  }

  // The final message is every line sharing the LAST assistant message.id (one line per content block);
  // only its last line carries the settled stop_reason. A line with no id cannot be grouped, so it stands alone.
  let finalAssistantText = '';
  let finalStopReason = null;
  if (asst.length > 0) {
    const last = asst[asst.length - 1];
    const id = isPlainObject(last.line.message) ? last.line.message.id : undefined;
    const group = typeof id === 'string' && id !== '' ? asst.filter((a) => a.line.message?.id === id) : [last];
    const closing = group[group.length - 1].line.message;
    finalStopReason = isPlainObject(closing) && closing.stop_reason !== undefined ? closing.stop_reason : null;
    finalAssistantText = group.flatMap((a) => textBlocks(a.line.message?.content)).join('\n');
    if (finalStopReason !== 'end_turn') {
      errors.push(`final message incomplete (stop_reason ${String(finalStopReason)})`);
    } else if (finalAssistantText.trim() === '') {
      errors.push('final message has no text');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    assistantLines: asst.length,
    models: Object.fromEntries(models),
    efforts: Object.fromEntries(efforts),
    firstUserText: firstUserText ?? '',
    finalAssistantText,
    finalStopReason,
  };
}

// ---------- extracting the ruling ----------

// Line-based fence scan: a closing fence must be a line of only backticks, so backticks inside a JSON
// string value can never end a block early. An unclosed fence (truncated output) is not a block.
function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  for (const row of text.split(/\r?\n/)) {
    if (open === null) {
      const m = /^[ \t]*```[ \t]*([^`]*?)[ \t]*$/.exec(row);
      if (m) open = { lang: m[1].split(/\s+/)[0].toLowerCase(), body: [] };
    } else if (/^[ \t]*```[ \t]*$/.test(row)) {
      blocks.push({ lang: open.lang, body: open.body.join('\n') });
      open = null;
    } else {
      open.body.push(row);
    }
  }
  return blocks;
}

// The LAST ```json block, else the last fenced block of any kind, else the whole trimmed text. Once a
// candidate is chosen it must parse: falling through to an earlier block could apply the wrong ruling.
export function extractJsonBlock(text) {
  if (typeof text !== 'string') throw new Error('no JSON found');
  const blocks = fencedBlocks(text);
  let candidate = text.trim();
  if (blocks.length > 0) {
    const lastJson = [...blocks].reverse().find((b) => b.lang === 'json');
    candidate = (lastJson ?? blocks[blocks.length - 1]).body;
  }
  try {
    return JSON.parse(candidate);
  } catch (cause) {
    throw new Error('no JSON found', { cause });
  }
}

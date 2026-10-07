// Why: the arbiter's ruling is only trusted if Claude Code's own transcript log shows every assistant
// turn ran on the pinned model at the pinned effort — never the model's say-so. This module finds that
// transcript, proves (or disproves) the model/effort, and pulls the ruling JSON out of the verified
// transcript itself. The transcript format is undocumented and unstable, so every unknown shape
// FAILS CLOSED: it adds an error and ok stays false.
//
// Completeness: spec R13 wants stop_reason end_turn on the final message. Interactive (entrypoint "cli")
// transcripts keep the streaming snapshot, so a finished final message often still shows stop_reason null;
// only headless runs record "end_turn". So: an explicit stop_reason must be end_turn (max_tokens, refusal, ...
// are failures); a null/absent one is accepted ONLY when the final message is the last line of the
// transcript and carries a parseable JSON answer (the one thing a truncated message cannot do), and the proof
// then reports stopReasonMissing: true. The final line must also hold a text block. Callers still require the
// rulings to validate against every expected id.
//
// Hand-back finals: a background subagent delivers its report through a SubagentHandback tool call, and plain
// text at the end of such a session is NOT delivered. So the final answer is the call's input.message, and it
// counts only when the transcript proves delivery: the call is the only block of the closing line (any other
// tool name, extra block or extra input key is refused), its input matches the wire copy when one is logged,
// and the very next and LAST line is the tool_result acknowledgment (success, toolEndsTurn, same tool_use id).
// Text in earlier blocks of that message was never delivered and is ignored. A hand-back's stop_reason is null
// or tool_use; with null the message must still hold a complete JSON answer. The proof reports finalVia:
// 'text' | 'handback' (null when the final message is not proven).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

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

const HANDBACK_TOOL = 'SubagentHandback';
const blocksOf = (content) => (Array.isArray(content) ? content : []);
const isHandbackCall = (b) => isPlainObject(b) && b.type === 'tool_use' && b.name === HANDBACK_TOOL;

// Why the user line that should acknowledge the hand-back call `id` does not, or null when it does.
function ackProblem(line, id) {
  if (line === null || line.type !== 'user') return 'not a user line';
  const content = isPlainObject(line.message) ? line.message.content : undefined;
  if (!Array.isArray(content) || content.length !== 1 || !isPlainObject(content[0]) || content[0].type !== 'tool_result') {
    return 'message.content is not one tool_result block';
  }
  if (content[0].tool_use_id !== id) return 'tool_result is not for this call';
  if (content[0].is_error === true) return 'tool_result is an error';
  if (!isPlainObject(line.toolUseResult) || line.toolUseResult.success !== true) return 'toolUseResult.success is not true';
  if (line.toolEndsTurn !== true) return 'toolEndsTurn is not true';
  return null;
}

// Judges the closing line of a final message that holds a SubagentHandback call. Pushes an error for every
// broken rule (see the header) and returns the delivered message when the call and its acknowledgment are
// structurally proven, else null. stop_reason and JSON completeness are the caller's.
function checkHandback({ closingEntry, closing, parsed, lastLineN, errors }) {
  const content = isPlainObject(closing) ? closing.content : undefined;
  if (!Array.isArray(content) || content.length !== 1 || !isHandbackCall(content[0])) {
    errors.push('hand-back must be the only content block of the final line');
    return null;
  }
  const call = content[0];
  let ok = true;
  const fail = (msg) => { errors.push(msg); ok = false; };
  if (typeof call.id !== 'string' || call.id === '') fail('hand-back tool_use has no id');
  const input = call.input;
  const inputOk = isPlainObject(input) && Object.keys(input).length === 1 && has(input, 'message') && typeof input.message === 'string' && input.message.trim() !== '';
  if (!inputOk) fail('hand-back input must be {message: <non-empty string>}');
  const wire = closingEntry.line.wireToolInputs;
  if (has(closingEntry.line, 'wireToolInputs')) {
    if (!isPlainObject(wire)) fail('hand-back wireToolInputs is not an object');
    else if (typeof call.id === 'string' && has(wire, call.id) && !isDeepStrictEqual(wire[call.id], input)) fail('hand-back input differs from its wire input');
  }
  const after = parsed.filter((p) => p.n > closingEntry.n);
  if (after.length === 0) {
    fail('hand-back not acknowledged');
  } else {
    const problem = ackProblem(after[0].line, call.id);
    if (problem !== null) fail(`hand-back acknowledgment invalid: ${problem}`);
    if (after.length > 1 || after[after.length - 1].n !== lastLineN) fail('extra lines after the hand-back acknowledgment');
  }
  return ok ? input.message : null;
}

export function proveModel({ jsonlText, metaText, expectModelPrefix, expectEffort, expectMetaModel = null, expectAgentType = null }) {
  const errors = [];
  const models = new Map();
  const efforts = new Map();
  const asst = []; // { line, n } for every assistant line, in file order
  const parsed = []; // { line, n } for every non-blank line (line is null when unparseable), in file order
  let lastLineN = 0; // 1-based number of the last non-blank line of the transcript
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
      lastLineN = n;
      let line;
      try {
        line = JSON.parse(rows[i]);
      } catch {
        line = undefined;
      }
      parsed.push({ line: isPlainObject(line) ? line : null, n });
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
  // its last line is the one judged. A line with no id cannot be grouped, so it stands alone.
  let finalAssistantText = '';
  let finalStopReason = null;
  let stopReasonMissing = false;
  let finalVia = null;
  if (asst.length > 0) {
    const last = asst[asst.length - 1];
    const id = isPlainObject(last.line.message) ? last.line.message.id : undefined;
    const group = typeof id === 'string' && id !== '' ? asst.filter((a) => a.line.message?.id === id) : [last];
    const closingEntry = group[group.length - 1];
    const closing = closingEntry.line.message;
    finalStopReason = isPlainObject(closing) && closing.stop_reason !== undefined ? closing.stop_reason : null;
    const errorsBefore = errors.length;
    // Any SubagentHandback call in the final message makes it a hand-back attempt: it is then judged as one (and
    // fails closed), never as a plain-text answer that happens to sit beside the call.
    const isHandbackAttempt = group.some((a) => blocksOf(a.line.message?.content).some(isHandbackCall));

    if (isHandbackAttempt) {
      const delivered = checkHandback({ closingEntry, closing, parsed, lastLineN, errors });
      // tool_use is the ordinary stop_reason of a tool-call message; null is a streaming snapshot (see header).
      if (finalStopReason !== null && finalStopReason !== 'tool_use') {
        errors.push(`final message incomplete (stop_reason ${String(finalStopReason)})`);
      }
      if (delivered !== null) {
        finalAssistantText = delivered;
        if (finalStopReason === null) {
          stopReasonMissing = true;
          let answer = null;
          try {
            answer = extractJsonBlock(delivered);
          } catch { /* reported below */ }
          if (!isPlainObject(answer)) errors.push('final message has no stop_reason and carries no complete JSON answer (a truncated message cannot be ruled out)');
        }
      }
      if (errors.length === errorsBefore) finalVia = 'handback';
    } else {
      finalAssistantText = group.flatMap((a) => textBlocks(a.line.message?.content)).join('\n');
      // null/absent is a streaming snapshot (see header); any other explicit value is a real non-answer.
      if (finalStopReason !== null && finalStopReason !== 'end_turn') {
        errors.push(`final message incomplete (stop_reason ${String(finalStopReason)})`);
      }
      // The last line must itself carry text: a group ending in tool_use or thinking has not answered yet.
      if (textBlocks(closing?.content).length === 0) {
        errors.push('final message is not a text answer');
      } else if (finalAssistantText.trim() === '') {
        errors.push('final message has no text');
      }
      // No stop_reason: nothing says the message finished, so it must at least be the end of the transcript and hold a
      // complete JSON answer.
      if (finalStopReason === null) {
        stopReasonMissing = true;
        if (closingEntry.n !== lastLineN) errors.push('final message has no stop_reason and is not the last line of the transcript');
        let answer = null;
        try {
          answer = extractJsonBlock(finalAssistantText);
        } catch { /* reported below */ }
        if (!isPlainObject(answer)) errors.push('final message has no stop_reason and carries no complete JSON answer (a truncated message cannot be ruled out)');
      }
      if (errors.length === errorsBefore) finalVia = 'text';
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
    stopReasonMissing,
    finalVia,
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

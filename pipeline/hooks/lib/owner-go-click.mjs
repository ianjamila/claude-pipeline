// #261 (click-to-approve, PR A): the owner's "merge", "extra round" and rulings as a click on a choice dialog (Claude Code's AskUserQuestion) instead of a typed prompt.
// Plan: claude-notes/plans/2026-11-11-click-to-approve.md, Rev 6 (B1-B4). What this file is: the issued ask (a one-time, expiring, supersedable note of the dialog the agent MAY show), the
// recorder that turns a verified click into the SAME record the typed path writes (owner-go.mjs: approval / ruling / extra-round, plus `via: 'ask'`), and the one verifier every consumer
// uses (clickProvenance, called by ownedBy where promptProvenance is for typed prompts).
//
// The trust argument, in one paragraph. A human click leaves a user entry in the session transcript whose permissionDecision is EXACTLY HUMAN_DECISION (decision accept, source user_temporary,
// grantScope once, reasonCode unknown: the whole object, no other key) and whose toolUseResult carries `annotations: {}`; an answer given by a hook (updatedInput / PermissionRequest), by the
// model's own `answers` input, or by a non-interactive run lacks that stamp (spikes s07, s08, s10 of 2026-11-11, test/fixtures/click). The stamp is the whole object, not decision + source,
// because on 2.1.323 a PreToolUse hook answering "ask" with a prefilled `answers` makes Claude Code show the dialog and submit that answer ITSELF after ~1.5-2 s, stamped source user_temporary
// and annotations {} like a click; only its reasonCode (hook:PreToolUse, a person's is unknown) tells them apart. (The model's own prefilled `answers` is auto-submitted with the exact human
// stamp: only the tool-use shape check below refuses it, and the 2 s floor is no defence against either: both were answered in about 2 s.) The transcript is the evidence, never the PostToolUse hook input (which the recorder only polls the transcript for: the entry lands 100-200 ms after the
// hook starts). Hooks that could still answer the dialog are the dialog-hook check's business (B5, hookCheck below, T2): this file takes it as an injected function.
// What binds is the question TEXT: it is the typed path's closing block, so the answer goes through the SAME parsers the typed prompt does (approvalBinding, roundBinding, rulingBinding in
// owner-go.mjs), and the ask file supplies only what a typed prompt cannot: one-time use, supersession, expiry, the dialog hash and the issue-time hook fingerprint.
// Residual (unchanged from the typed path, owner-go.mjs): keystrokes injected into the owner's terminal look human.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';
import { isTranscriptFile } from '../../lib/paths.mjs';
import {
  MAX_AGE_MS, SESSION_RE, accountHome, appendRecord, approvalBinding, ownerGoDir, readRecords, realDirChain, repoKey, roundBinding, rulingBinding, rulingsIn, scanBackwards,
} from './owner-go.mjs';

// The Claude Code builds whose click transcripts were recorded and checked. Each build needs its fixture set under test/fixtures/click/<build>/, recorded by scripts/click-spike.mjs (the tests
// run the whole matrix for every build listed here). Installed (protected) code, never pipeline.yml: a repo may switch clicks OFF, never widen this.
export const CLICK_BUILDS = Object.freeze(['2.1.322', '2.1.323']);
export const HUMAN_DECISION = Object.freeze({ decision: 'accept', source: 'user_temporary', grantScope: 'once', reasonCode: 'unknown' });
// owner-go.mjs <-> this file import each other (ownedBy calls clickProvenance), so nothing here may read an owner-go.mjs binding while the module loads: the literal is pinned to
// OWNER_GO_REL + '/asks' by a test.
export const ASKS_REL = '.claude/pipeline-state/owner-go/asks';
export const ASK_ID_RE = /^ask-[0-9a-f]{12}$/;
const ASK_ID_IN_LINE = /\bask-[0-9a-f]{12}\b/g;
export const MIN_ANSWER_MS = 2000; // F3: an answer sooner than this after the dialog opened is a keystroke typed ahead, not a reading owner
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const POLL_STEP_MS = 100;
const SMALL_FILE_BYTES = 64 * 1024;
const KINDS = Object.freeze(['merge', 'merge-many', 'round', 'ruling']);
const SCAN = { chunkBytes: 4 * 1024 * 1024, capBytes: 64 * 1024 * 1024 };
const OPEN_EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sortedJson = (v) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

// ---- the dialog -----------------------------------------------------------------------------------------------------------------------

const QUESTION_KEYS = new Set(['question', 'header', 'multiSelect', 'options']);
const OPTION_KEYS = new Set(['label', 'description']);
// The one canonical form of a dialog question: fixed key order question, header, multiSelect (boolean, false when absent), options [{ label, description }]. Null for anything else: an unknown key, an
// option with `preview` (S8: the preview is truncated on screen and copied into annotations, so it is never a binding surface) or a field of another type.
export function canonicalDialog(q) {
  if (!isObj(q) || !Object.keys(q).every((k) => QUESTION_KEYS.has(k))) return null;
  if (typeof q.question !== 'string' || q.question.trim() === '' || typeof q.header !== 'string') return null;
  const multiSelect = q.multiSelect === undefined ? false : q.multiSelect;
  if (typeof multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length === 0) return null;
  const options = [];
  for (const o of q.options) {
    if (!isObj(o) || !Object.keys(o).every((k) => OPTION_KEYS.has(k)) || typeof o.label !== 'string' || o.label === '' || typeof o.description !== 'string') return null;
    options.push({ label: o.label, description: o.description });
  }
  return { question: q.question, header: q.header, multiSelect, options };
}
export const dialogSha256 = (q) => { const c = canonicalDialog(q); return c === null ? null : sha256(JSON.stringify(c)); };

// ---- the four dialogs (B1) ------------------------------------------------------------------------------------------------------------
// Each builder returns the parts issueAsk takes: { kind, repo, prs, header, title, block, options, actions }. `block` is the EXACT closing text the typed path binds (the merge dry run's
// ownerStep.closing, the round request's line, the ruling request's line). actions maps option label -> the answer text the typed parsers read; a decline maps to null.

export function mergeAsk({ repo, pr, closing }) {
  return {
    kind: 'merge', repo, prs: [pr], header: 'Merge', title: `Merge #${pr}?`, block: closing,
    options: [
      { label: 'Not yet', description: 'Do not merge now. Nothing is recorded; I will ask again when it is ready.' },
      { label: 'Merge', description: `Approve exactly what is shown above for #${pr}, the same as typing "merge".` },
    ],
    actions: { 'Not yet': null, Merge: 'merge' },
  };
}
export function roundAsk({ repo, pr, line }) {
  return {
    kind: 'round', repo, prs: [pr], header: 'Extra round', title: `One more review round for #${pr}?`, block: line,
    options: [
      { label: 'No', description: 'No more rounds now. Nothing is recorded.' },
      { label: 'Yes, one more round', description: 'Grant exactly the one extra counted round shown above, the same as typing "extra round".' },
    ],
    actions: { No: null, 'Yes, one more round': 'extra round' },
  };
}
export function rulingAsk({ repo, pr, ids, line }) {
  const all = (word) => ids.map((id) => `${id}: ${word}`).join(', ');
  return {
    kind: 'ruling', repo, prs: [pr], header: 'Ruling', title: `Your ruling on #${pr}?`, block: line,
    options: [
      { label: 'Not now', description: 'Rule on nothing now. Nothing is recorded.' },
      { label: 'Accept all', description: `Accept every item asked (${ids.join(', ')}).` },
      { label: 'Follow-up all', description: `Move every item asked (${ids.join(', ')}) to a follow-up.` },
      { label: 'Reject all', description: `Reject every item asked (${ids.join(', ')}).` },
    ],
    actions: { 'Not now': null, 'Accept all': all('accept'), 'Follow-up all': all('follow-up'), 'Reject all': all('reject') },
  };
}
// merge-many (fold-in): `entries` = [{ pr, lines: [that PR's Areas / Head lines, '#N'-prefixed] }] for 2-4 PRs; `ready` = the ONE `🔀 Ready to merge #a, #b — say "merge"` line.
// multiSelect: the owner ticks the PRs to merge; there is no decline option (a dialog dismissed records nothing). Null when the count is out of range.
export function mergeManyAsk({ repo, entries, ready }) {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 4) return null;
  return {
    kind: 'merge-many', repo, prs: entries.map((e) => e.pr), header: 'Merge', title: `Which of these ${entries.length} PRs should merge?`, block: `${entries.flatMap((e) => e.lines).join('\n')}\n${ready}`,
    options: entries.map((e) => ({ label: `Merge #${e.pr}`, description: `Approve exactly what is shown above for #${e.pr}.` })),
    actions: Object.fromEntries(entries.map((e) => [`Merge #${e.pr}`, `merge #${e.pr}`])),
    multiSelect: true,
  };
}

// (R1-F4, Rev 6 B1: the ask file never supplies binding fields.) The dialog an ask MUST show is a function of installed code: the kind, the PR(s) / item ids the question itself names, and the
// builders above. -> the parts a builder returns for this ask, or null when the ask's question is not a dialog one of them would build (an unknown title, a PR or ids the text does not carry).
function installedParts(ask) {
  const q = ask.dialog.question;
  const cut = q.indexOf('\n\n');
  if (cut < 0) return null;
  const suffix = ` (${ask.askId})`;
  const head = q.slice(0, cut);
  if (!head.endsWith(suffix)) return null;
  const title = head.slice(0, -suffix.length);
  const block = q.slice(cut + 2);
  const one = (re) => { const m = re.exec(title); return m ? Number(m[1]) : null; };
  if (ask.kind === 'merge') { const pr = one(/^Merge #(\d{1,6})\?$/); return pr === null ? null : mergeAsk({ repo: ask.repo, pr, closing: block }); }
  if (ask.kind === 'round') { const pr = one(/^One more review round for #(\d{1,6})\?$/); return pr === null ? null : roundAsk({ repo: ask.repo, pr, line: block }); }
  if (ask.kind === 'ruling') {
    const pr = one(/^Your ruling on #(\d{1,6})\?$/);
    const asked = pr === null ? null : rulingBinding('x', q);
    return asked === null || asked.pr !== pr ? null : rulingAsk({ repo: ask.repo, pr, ids: asked.ids, line: block });
  }
  const ready = /^🔀 Ready to merge (#\d{1,6}(?:, #\d{1,6}){1,3}) — say "merge"$/.exec(block.split('\n').at(-1));
  if (ready === null) return null;
  const entries = ready[1].split(', ').map((p) => ({ pr: Number(p.slice(1)), lines: [] }));
  const parts = mergeManyAsk({ repo: ask.repo, entries, ready: '' });
  return parts === null || title !== parts.title ? null : parts;
}
// True when the ask's dialog (header, multiSelect, options with their descriptions), its label -> answer map and its PRs are exactly what the installed builders make from its kind and question.
export function matchesInstalledDialog(ask) {
  try {
    const parts = installedParts(ask);
    if (parts === null || parts.kind !== ask.kind) return false;
    const want = canonicalDialog({ question: ask.dialog.question, header: parts.header, multiSelect: parts.multiSelect ?? false, options: parts.options });
    return want !== null && sortedJson(want) === sortedJson(ask.dialog) && sortedJson(parts.actions) === sortedJson(ask.actions)
      && sortedJson([...parts.prs].sort((x, y) => x - y)) === sortedJson([...ask.prs].sort((x, y) => x - y));
  } catch {
    return false;
  }
}

// ---- files ----------------------------------------------------------------------------------------------------------------------------

export const asksDir = (home = accountHome()) => path.join(ownerGoDir(home), 'asks');
const askFile = (askId, ext, home) => (ASK_ID_RE.test(String(askId)) ? path.join(asksDir(home), `${askId}.${ext}`) : null);

// Exclusive create + fsync of `<file>`; 'ok' | 'exists' | 'error' (an error AFTER the file exists leaves it behind: the readers treat an unparseable marker as spent, fail closed).
function writeExclusive(file, body, home) {
  let fd;
  try { fd = openSync(file, OPEN_EXCL, 0o600); } catch (err) { return err?.code === 'EEXIST' ? 'exists' : 'error'; }
  try {
    writeSync(fd, `${JSON.stringify(body)}\n`);
    fsyncSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* the file exists either way */ }
    return 'error';
  }
  try { closeSync(fd); } catch { return 'error'; }
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(asksDir(home), constants.O_RDONLY);
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch { return 'error'; }
  }
  return 'ok';
}

// A small JSON file: { state: 'none' } (absent), { state: 'bad' } (present but not a plain regular file or not JSON), { state: 'ok', value }.
function readSmallJson(file) {
  if (file === null) return { state: 'bad' };
  try {
    if (!lstatSync(file).isFile()) return { state: 'bad' };
  } catch (err) {
    return { state: err?.code === 'ENOENT' ? 'none' : 'bad' };
  }
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > SMALL_FILE_BYTES) return { state: 'bad' };
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      return { state: 'ok', value: JSON.parse(buf.toString('utf8')) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { state: 'bad' };
  }
}
const marked = (askId, ext, home) => { const f = askFile(askId, ext, home); try { lstatSync(f); return true; } catch (err) { return err?.code !== 'ENOENT'; } }; // (any error but "absent" counts as present: fail closed)

// The issued ask on disk, validated (its dialog and answer map must be the installed builders' own, R1-F4): { ok: true, ask } | { ok: false, reason: 'none' | 'invalid' }.
export function readAsk(askId, { home = accountHome() } = {}) {
  const r = readSmallJson(askFile(askId, 'json', home));
  if (r.state === 'none') return { ok: false, reason: 'none' };
  const a = r.value;
  if (r.state !== 'ok' || a?.v !== 1 || a.askId !== askId || !KINDS.includes(a.kind) || typeof a.repo !== 'string' || !Array.isArray(a.prs) || !isObj(a.actions) || !isObj(a.dialog)
    || typeof a.dialogSha256 !== 'string' || a.dialogSha256 !== dialogSha256(a.dialog) || typeof a.issuedAt !== 'string' || !Number.isFinite(Date.parse(a.issuedAt))
    || (a.hookLayersSha256 !== null && typeof a.hookLayersSha256 !== 'string') || !matchesInstalledDialog(a)) return { ok: false, reason: 'invalid' };
  return { ok: true, ask: a };
}

// The marker of a consumed ask: { state: 'none' } | { state: 'bad' } (spent, never trusted) | { state: 'ok', marker }.
function readSpent(askId, home) {
  const r = readSmallJson(askFile(askId, 'spent', home));
  if (r.state !== 'ok') return r;
  const m = r.value;
  return m?.v === 1 && m.askId === askId && typeof m.clickId === 'string' && typeof m.toolUseId === 'string' && typeof m.answeredAt === 'string' && typeof m.dialogSha256 === 'string'
    ? { state: 'ok', marker: m } : { state: 'bad' };
}

// ---- issuing --------------------------------------------------------------------------------------------------------------------------

// Writes `asks/<askId>.json` and returns { askId, questions: [dialog] } (the dialog the agent passes to AskUserQuestion VERBATIM), or { error } when the dialog could not bind or be written. The question
// text is `<title> (<askId>)` + blank line + `block`; before writing, the SAME binding cores the recorder uses are run on it with every option's answer, so an ask whose closing lines would bind
// nothing (or another PR / repository than `prs` / `repo`) is never issued. An older ask of the same kind, repository and PRs that is neither spent nor superseded is marked superseded.
export function issueAsk({ kind, repo, prs, header, title, block, options, actions, multiSelect = kind === 'merge-many', hookLayersSha256 = null, home = accountHome(), now = Date.now } = {}) {
  try {
    const key = repoKey(repo);
    if (!KINDS.includes(kind) || key === null || !Array.isArray(prs) || prs.length === 0 || !prs.every(Number.isInteger) || typeof title !== 'string' || typeof block !== 'string' || !isObj(actions)) return { error: 'invalid' };
    const labels = (options ?? []).map((o) => o?.label);
    if (labels.length === 0 || new Set(labels).size !== labels.length || !Object.keys(actions).every((l) => labels.includes(l)) || !labels.every((l) => Object.hasOwn(actions, l))) return { error: 'invalid-options' };
    if (!realDirChain(home, ASKS_REL)) return { error: 'unsafe-folder' };
    let askId = null;
    for (let i = 0; i < 5 && askId === null; i++) {
      const id = `ask-${randomBytes(6).toString('hex')}`;
      if (!marked(id, 'json', home)) askId = id;
    }
    if (askId === null) return { error: 'no-id' };
    const dialog = canonicalDialog({ question: `${title} (${askId})\n\n${block}`, header: header ?? 'Merge', multiSelect, options });
    if (dialog === null) return { error: 'invalid-dialog' };
    const ask = { v: 1, askId, kind, repo: key, prs: [...prs], dialog, dialogSha256: dialogSha256(dialog), actions, issuedAt: new Date(now()).toISOString(), hookLayersSha256 };
    // every approving answer must bind exactly this repository and these PRs, or the ask is useless (a typo in the block, a closing line of another PR)
    for (const label of labels) {
      if (actions[label] === null) continue;
      const bound = bindAnswer(ask, actions[label], dialog.question);
      if (bound.error) return { error: `unbindable: ${bound.error}` };
    }
    if (!matchesInstalledDialog(ask)) return { error: 'unknown-dialog' }; // (R1-F4: readers refuse an ask the installed builders would not make, so never write one)
    const file = askFile(askId, 'json', home);
    if (writeExclusive(file, ask, home) !== 'ok') return { error: 'write-failed' };
    supersedeOlder(ask, home);
    return { askId, questions: [dialog] };
  } catch {
    return { error: 'failed' };
  }
}

// An older ask of the same kind + repository + PRs that is still answerable no longer is (a fresh dry run's ask replaces the one before it).
function supersedeOlder(ask, home) {
  let names = [];
  try { names = readdirSync(asksDir(home)).filter((n) => /^ask-[0-9a-f]{12}\.json$/.test(n)); } catch { return; }
  for (const n of names) {
    const id = n.slice(0, -5);
    if (id === ask.askId) continue;
    const old = readAsk(id, { home });
    if (!old.ok || old.ask.kind !== ask.kind || old.ask.repo !== ask.repo || sortedJson([...old.ask.prs].sort()) !== sortedJson([...ask.prs].sort())) continue;
    if (Date.parse(old.ask.issuedAt) > Date.parse(ask.issuedAt) || marked(id, 'spent', home) || marked(id, 'superseded', home)) continue;
    writeExclusive(askFile(id, 'superseded', home), { v: 1, askId: id, supersededBy: ask.askId }, home);
  }
}

// ---- answer -> binding (B1): the same cores as the typed path ---------------------------------------------------------------------------

// What the chosen answer says, per the ask's action map: { declined: label } | { text } | { error }. An exact label maps by `actions`; several labels (multiSelect) joined by ', ' must each
// be an exact label; any other text (the dialog's "Other") is the owner's own words and goes through the strict parser as typed.
function answerText(ask, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { error: 'empty-answer' };
  if (ask.dialog.multiSelect) {
    const pieces = raw.split(', ');
    if (new Set(pieces).size !== pieces.length || !pieces.every((p) => Object.hasOwn(ask.actions, p))) return { error: 'answer-not-a-label' };
    const texts = pieces.map((p) => ask.actions[p]);
    if (texts.some((t) => typeof t !== 'string' || !/^merge #\d{1,6}$/.test(t))) return { error: 'answer-not-a-label' };
    return { text: `merge ${texts.map((t) => t.slice(6)).join(' ')}` };
  }
  if (Object.hasOwn(ask.actions, raw)) return ask.actions[raw] === null ? { declined: raw } : { text: ask.actions[raw] };
  return { text: raw };
}

// The record body (without the click fields) a text answers a question with, using the typed recorders' cores: { kind, body } | { error }. `kind` is the record kind ('approval' has none on disk).
function bindAnswer(ask, text, question) {
  if (ask.kind === 'merge' || ask.kind === 'merge-many') {
    const b = approvalBinding(text, question);
    if (b === null || b.requests.length === 0) return { error: 'nothing-bound' };
    const want = [...ask.prs].sort((x, y) => x - y);
    const got = [...new Set(b.requests.map((r) => r.pr))].sort((x, y) => x - y);
    if (ask.kind === 'merge' && (sortedJson(got) !== sortedJson(want) || b.requests.some((r) => r.repo !== ask.repo))) return { error: 'other-pr-or-repo' };
    if (ask.kind === 'merge-many' && (got.length === 0 || !got.every((p) => want.includes(p)) || b.requests.some((r) => r.repo !== ask.repo))) return { error: 'other-pr-or-repo' };
    return { body: { prs: b.prs, requests: b.requests } };
  }
  if (ask.kind === 'round') {
    const b = roundBinding(text, question);
    if (b === null) return { error: 'nothing-bound' };
    if (b.repo !== ask.repo || sortedJson([b.pr]) !== sortedJson(ask.prs)) return { error: 'other-pr-or-repo' };
    return { body: { kind: 'extra-round', repo: b.repo, pr: b.pr, k: b.k, head: b.head } };
  }
  const b = rulingBinding(text, question);
  if (b === null) return { error: 'nothing-bound' };
  if (b.repo !== ask.repo || sortedJson([b.pr]) !== sortedJson(ask.prs)) return { error: 'other-pr-or-repo' };
  if (rulingsIn(text, b.ids).size === 0) return { error: 'no-decision' }; // (the typed recorder keeps any words; a click that decides nothing is not worth a record)
  return { body: { kind: 'ruling', repo: b.repo, pr: b.pr, ids: b.ids, content: b.content } };
}

// The record a click writes: the typed record's shape, `ts` = the answer's own time (C3), `via: 'ask'` and the click's identity.
function clickRecordOf({ body, session, text, cwd, transcriptPath, answeredAt, ask }) {
  const { kind, ...rest } = body;
  const prompt_sha256 = sha256(text);
  return {
    v: 1, ...(kind ? { kind } : {}), ts: new Date(Date.parse(answeredAt)).toISOString(), session, prompt_sha256, cwd,
    prompt_id: null, transcript_path: transcriptPath, prompt: text, via: 'ask', ask, ...rest,
  };
}
const clickIdOf = (session, toolUseId, askId) => sha256(`${session}|${toolUseId}|${askId}`).slice(0, 16);

// ---- the transcript evidence (B3 entry checks) --------------------------------------------------------------------------------------------

// The whole permissionDecision, key for key and value for value (an extra or missing key, another grantScope or reasonCode is not a person's click).
const isHumanDecision = (pd) => isObj(pd) && Object.keys(pd).length === Object.keys(HUMAN_DECISION).length && Object.entries(HUMAN_DECISION).every(([k, v]) => Object.hasOwn(pd, k) && pd[k] === v);
const blocksOf = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
const isoMs = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s) ? Date.parse(s) : NaN);

// Finds the AskUserQuestion tool_use entry and its tool_result entry by id in `transcriptPath` and runs every check on them that needs no clock, ask or hook configuration (the build allowlist,
// supersession and the hook check are the recorder's). { ok: true, use, result, question, answer, answeredAt, useAt, version, session, dialogSha256 } or { ok: false, reason }. 'not-in-transcript'
// means an entry is not (yet) there: the recorder polls on that reason only.
export function clickEvidence(transcriptPath, toolUseId, { home = accountHome() } = {}) {
  try {
    if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || /(?:^|[\\/])subagents[\\/]/.test(transcriptPath) || !isTranscriptFile(transcriptPath, { home })) return { ok: false, reason: 'transcript-not-protected' };
    if (typeof toolUseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(toolUseId)) return { ok: false, reason: 'bad-tool-use-id' };
    const uses = [];
    const results = [];
    const scan = scanBackwards(transcriptPath, (e) => {
      if (e?.type === 'assistant' && blocksOf(e).some((b) => b?.type === 'tool_use' && b.id === toolUseId)) uses.push(e);
      else if (e?.type === 'user' && blocksOf(e).some((b) => b?.type === 'tool_result' && b.tool_use_id === toolUseId)) results.push(e);
      return false;
    }, (line) => line.includes(toolUseId), SCAN);
    if (scan === null) return { ok: false, reason: 'transcript-unreadable' };
    if (uses.length > 1 || results.length > 1) return { ok: false, reason: 'ambiguous' };
    if (uses.length === 0 || results.length === 0) return { ok: false, reason: 'not-in-transcript' };
    const [use] = uses;
    const [result] = results;
    const block = blocksOf(use).find((b) => b?.type === 'tool_use' && b.id === toolUseId);
    if (block.name !== 'AskUserQuestion' || !isObj(block.input) || !Object.keys(block.input).every((k) => k === 'questions' || k === 'metadata') || !Array.isArray(block.input.questions) || block.input.questions.length !== 1) return { ok: false, reason: 'tool-use-shape' };
    const dialog = canonicalDialog(block.input.questions[0]);
    if (dialog === null) return { ok: false, reason: 'dialog-not-canonical' }; // (also: an option `preview`)
    const content = blocksOf(result);
    const res = result.toolUseResult;
    const pd = result.permissionDecision;
    if (content.length !== 1 || content[0]?.type !== 'tool_result' || content[0].tool_use_id !== toolUseId || content[0].is_error === true || result.message?.content?.length !== 1) return { ok: false, reason: 'tool-result-shape' };
    if (typeof use.uuid !== 'string' || use.uuid === '' || result.sourceToolAssistantUUID !== use.uuid || result.parentUuid !== use.uuid) return { ok: false, reason: 'chain' };
    if (use.isSidechain !== false || result.isSidechain !== false) return { ok: false, reason: 'sidechain' };
    if (!isHumanDecision(pd)) return { ok: false, reason: 'not-a-human-answer' };
    if (!isObj(res) || !Array.isArray(res.questions) || res.questions.length !== 1 || sortedJson(canonicalDialog(res.questions[0])) !== sortedJson(dialog)) return { ok: false, reason: 'result-dialog-differs' };
    if (!isObj(res.answers) || Object.keys(res.answers).length !== 1 || !Object.hasOwn(res.answers, dialog.question) || typeof res.answers[dialog.question] !== 'string') return { ok: false, reason: 'answers-shape' };
    if (!isObj(res.annotations) || Object.keys(res.annotations).length !== 0) return { ok: false, reason: 'annotations' };
    if (typeof use.sessionId !== 'string' || use.sessionId !== result.sessionId || !SESSION_RE.test(use.sessionId)) return { ok: false, reason: 'session' };
    if (use.entrypoint !== 'cli' || result.entrypoint !== 'cli') return { ok: false, reason: 'entrypoint' };
    if (typeof use.version !== 'string' || use.version === '' || use.version !== result.version) return { ok: false, reason: 'version' };
    const useAt = isoMs(use.timestamp);
    const answeredAt = isoMs(result.timestamp);
    if (!Number.isFinite(useAt) || !Number.isFinite(answeredAt)) return { ok: false, reason: 'timestamp' };
    if (answeredAt - useAt < MIN_ANSWER_MS) return { ok: false, reason: 'too-fast' };
    return { ok: true, use, result, question: dialog.question, answer: res.answers[dialog.question], answeredAt: result.timestamp, useAt: use.timestamp, version: use.version, session: use.sessionId, dialogSha256: sha256(JSON.stringify(dialog)) };
  } catch {
    return { ok: false, reason: 'transcript-unreadable' };
  }
}

// ---- the recorder (PostToolUse) ---------------------------------------------------------------------------------------------------------

// The dialog-hook check (B5, T2) is injected: ({ home, input }) -> { ok, hookLayersSha256, reason }. Until it is supplied nothing is admitted.
const UNCHECKED = () => ({ ok: false, reason: 'dialog-hooks-unchecked' });
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A PostToolUse hook input for AskUserQuestion -> the record the click makes. Returns { recorded: record, kind, replay? } | { declined: label, replay? } | { refused: reason } | null (not ours: not
// AskUserQuestion, a subagent, no session, no ask id in the question's first line, an ask this machine never issued). Never throws. Async: the transcript entry lands 100-200 ms after the hook
// starts (spike S6), so the evidence is polled for up to `pollMs` in 100 ms steps (`sleep` is injectable).
export async function recordClick(input, { home = accountHome(), now = Date.now, sleep = realSleep, pollMs = 5000, hookCheck = UNCHECKED } = {}) {
  try {
    if (input?.tool_name !== 'AskUserQuestion' || (input.hook_event_name !== undefined && input.hook_event_name !== 'PostToolUse')) return null;
    if (input.agent_id !== undefined && input.agent_id !== null && input.agent_id !== '') return null;
    const transcriptPath = String(input.transcript_path ?? '');
    const session = String(input.session_id ?? '');
    if (!SESSION_RE.test(session) || /(?:^|[\\/])subagents[\\/]/.test(transcriptPath.replaceAll('\\', '/'))) return null;
    const asked = input.tool_input?.questions?.[0]?.question;
    const ids = typeof asked === 'string' ? [...new Set(asked.split('\n')[0].match(ASK_ID_IN_LINE) ?? [])] : [];
    if (ids.length === 0) return null;
    if (ids.length > 1) return { refused: 'ambiguous-ask-id' };
    const [askId] = ids;
    const loaded = readAsk(askId, { home });
    if (!loaded.ok) return loaded.reason === 'none' ? null : { refused: 'ask-invalid' };
    const { ask } = loaded;
    const toolUseId = input.tool_use_id;
    if (typeof toolUseId !== 'string') return { refused: 'no-tool-use-id' };

    let ev = clickEvidence(transcriptPath, toolUseId, { home });
    for (let waited = 0; !ev.ok && ev.reason === 'not-in-transcript' && waited < pollMs; waited += POLL_STEP_MS) {
      await sleep(POLL_STEP_MS);
      ev = clickEvidence(transcriptPath, toolUseId, { home });
    }
    if (!ev.ok) return { refused: ev.reason };
    if (ev.session !== session) return { refused: 'session' };
    if (ev.dialogSha256 !== ask.dialogSha256) return { refused: 'dialog-differs' };
    if (!CLICK_BUILDS.includes(ev.version)) return { refused: 'build-not-allowlisted' };
    const answeredAt = Date.parse(ev.answeredAt);
    const issuedAt = Date.parse(ask.issuedAt);
    if (answeredAt < issuedAt || answeredAt > issuedAt + MAX_AGE_MS) return { refused: answeredAt < issuedAt ? 'answered-before-issue' : 'expired' };
    if (answeredAt > now() + FUTURE_SKEW_MS) return { refused: 'answer-in-the-future' };
    const clickId = clickIdOf(session, toolUseId, askId);

    const spent = readSpent(askId, home);
    if (spent.state === 'bad') return { refused: 'spent' };
    if (spent.state === 'ok') return finishReplay({ spent: spent.marker, ask, clickId, ev, session, home, input, transcriptPath });
    if (marked(askId, 'superseded', home)) return { refused: 'superseded' };
    const hc = await hookCheck({ home, input });
    if (!hc?.ok) return { refused: hc?.reason ?? 'dialog-hooks' };
    if (ask.hookLayersSha256 !== null && hc.hookLayersSha256 !== ask.hookLayersSha256) return { refused: 'dialog-hooks-changed' };

    const mapped = answerText(ask, ev.answer);
    if (mapped.error) return { refused: mapped.error };
    const cwd = typeof input.cwd === 'string' ? input.cwd : null;
    const marker = { v: 1, askId, clickId, toolUseId, answeredAt: ev.answeredAt, dialogSha256: ask.dialogSha256, producerVersion: ev.version, hookLayersSha256: hc.hookLayersSha256 ?? null, session, declined: mapped.declined !== undefined };
    if (mapped.declined !== undefined) {
      const made = writeExclusive(askFile(askId, 'spent', home), marker, home);
      return made === 'ok' ? { declined: mapped.declined } : { refused: made === 'exists' ? 'spent' : 'write-failed' };
    }
    const bound = bindAnswer(ask, mapped.text, ev.question);
    if (bound.error) return { refused: bound.error }; // (nothing consumed: the owner can answer the same dialog again, or type)
    const made = writeExclusive(askFile(askId, 'spent', home), marker, home);
    if (made !== 'ok') return { refused: made === 'exists' ? 'spent' : 'write-failed' };
    const record = appendRecord(home, session, clickRecordOf({ body: bound.body, session, text: mapped.text, cwd, transcriptPath, answeredAt: ev.answeredAt, ask: { askId, toolUseId, clickId } }));
    return record === null ? { refused: 'record-write-failed' } : { recorded: record, kind: ask.kind };
  } catch {
    return null;
  }
}

// The same click again (a hook retried, a crash between the marker and the record): never consumes twice. Same click id and a verifiable marker -> the record exists (returned) or is written now
// from the marker's own answeredAt; anything else -> refused.
function finishReplay({ spent, ask, clickId, ev, session, home, input, transcriptPath }) {
  if (spent.clickId !== clickId || spent.answeredAt !== ev.answeredAt || spent.dialogSha256 !== ask.dialogSha256) return { refused: 'spent' };
  if (spent.declined === true) return { declined: ev.answer, replay: true };
  const existing = readRecords({ home, session, maxAgeMs: Infinity }).find((r) => r.via === 'ask' && r.ask?.clickId === clickId);
  if (existing) return { recorded: existing, kind: ask.kind, replay: true };
  const mapped = answerText(ask, ev.answer);
  if (mapped.error) return { refused: mapped.error };
  const bound = bindAnswer(ask, mapped.text, ev.question);
  if (bound.error) return { refused: bound.error };
  const record = appendRecord(home, session, clickRecordOf({ body: bound.body, session, text: mapped.text, cwd: typeof input.cwd === 'string' ? input.cwd : null, transcriptPath, answeredAt: spent.answeredAt, ask: { askId: ask.askId, toolUseId: spent.toolUseId, clickId } }));
  return record === null ? { refused: 'record-write-failed' } : { recorded: record, kind: ask.kind, replay: true };
}

// ---- the proof every consumer asks (B4) ---------------------------------------------------------------------------------------------------

// 'kind' is compared for every kind (absent for a merge click, so a merge click's record cannot be relabelled as a round grant or ruling): R26-F2.
const BINDING_KEYS = { approval: ['prs', 'requests'], 'extra-round': ['kind', 'repo', 'pr', 'k', 'head'], ruling: ['kind', 'repo', 'pr', 'ids', 'content'] };
// 'owner' | 'synthetic' | 'missing' for a record with `via: 'ask'`, read at ANY age (a consumed extra-round grant is read by the final gate days later): the transcript entries are found again by the tool
// use id and must still pass the entry checks, the ask file and spent marker must agree with the record, and the record's binding must be what the question and answer in the transcript say. Not
// re-checked, by design (R4b): the build allowlist, supersession, today's hook configuration, the ask's expiry against now. A transcript entry that is gone is 'missing', like a typed prompt's.
export function clickProvenance(record, { home = accountHome() } = {}) {
  try {
    const a = record?.ask;
    if (record?.via !== 'ask' || !isObj(a) || !ASK_ID_RE.test(String(a.askId)) || typeof a.toolUseId !== 'string' || typeof a.clickId !== 'string') return 'synthetic';
    const file = record.transcript_path;
    if (typeof file !== 'string' || file === '' || !path.isAbsolute(file) || /(?:^|[\\/])subagents[\\/]/.test(file) || !isTranscriptFile(file, { home })) return 'missing';
    const loaded = readAsk(a.askId, { home });
    if (!loaded.ok) return loaded.reason === 'none' ? 'missing' : 'synthetic';
    const { ask } = loaded;
    const spent = readSpent(a.askId, home);
    if (spent.state === 'none') return 'missing';
    if (spent.state !== 'ok') return 'synthetic';
    const m = spent.marker;
    if (m.declined === true || m.clickId !== a.clickId || m.toolUseId !== a.toolUseId || m.dialogSha256 !== ask.dialogSha256 || typeof record.session !== 'string' || clickIdOf(record.session, a.toolUseId, a.askId) !== a.clickId) return 'synthetic';
    const ev = clickEvidence(file, a.toolUseId, { home });
    if (!ev.ok) return ev.reason === 'not-in-transcript' || ev.reason === 'transcript-not-protected' || ev.reason === 'transcript-unreadable' ? 'missing' : 'synthetic';
    const answeredAt = Date.parse(ev.answeredAt);
    const issuedAt = Date.parse(ask.issuedAt);
    if (ev.session !== record.session || ev.dialogSha256 !== ask.dialogSha256 || m.answeredAt !== ev.answeredAt || Date.parse(record.ts) !== answeredAt || answeredAt < issuedAt || answeredAt > issuedAt + MAX_AGE_MS) return 'synthetic';
    const mapped = answerText(ask, ev.answer);
    if (mapped.error || mapped.declined !== undefined) return 'synthetic';
    const bound = bindAnswer(ask, mapped.text, ev.question);
    if (bound.error) return 'synthetic';
    const expected = clickRecordOf({ body: bound.body, session: record.session, text: mapped.text, cwd: null, transcriptPath: file, answeredAt: ev.answeredAt, ask: a });
    const keys = ['ts', 'session', 'prompt', 'via', 'ask', 'kind', ...BINDING_KEYS[expected.kind ?? 'approval']];
    const same = keys.every((k) => sortedJson(expected[k]) === sortedJson(record[k]));
    return same && (record.prompt_sha256 === undefined || record.prompt_sha256 === expected.prompt_sha256) ? 'owner' : 'synthetic';
  } catch {
    return 'synthetic';
  }
}

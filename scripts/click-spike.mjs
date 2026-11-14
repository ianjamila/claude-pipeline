// Re-records the click-to-approve transcript fixtures (#261) on the Claude Code build installed here, so a new build can join CLICK_BUILDS
// (pipeline/hooks/lib/owner-go-click.mjs) with recorded evidence instead of a guess.
//   node scripts/click-spike.mjs [--claude <path>] [--out <dir>] [--only name,name] [--keep]
// Runs each case below as a real interactive `claude` session in a pseudo-terminal (`script`), in a scratch project with
// `--setting-sources project` (no user hooks, no pipeline hooks) and a scratch hook that answers the dialog for the hook cases.
// It types the keys a person would, waits for the AskUserQuestion result in the transcript, quits, then writes a trimmed copy
// (the prompt, the AskUserQuestion tool_use and its tool_result; cwd neutral; usage and classifier fields dropped) to
// <out>/<case>.jsonl (default test/fixtures/click/<build>/). Last, it checks the discriminator the recorder relies on and exits 1
// when any case no longer shows it: then DO NOT add the build to CLICK_BUILDS (clicks stay refused on it; typing still works).
// Exit codes: 0 = the WHOLE matrix ran and every case passed (the only run that may justify adding a build); 1 = a case failed;
// 2 = usage, or started inside Claude Code; 3 = a partial run (--only) whose cases passed: it is NOT a verdict and never recommends adding the build.
// The keys the script sends are logged with their time: the pre-dialog handlers (folder trust, auto-mode tip) stop as soon as the AskUserQuestion tool_use
// is in the transcript, and a case fails if a key was sent into a dialog that should get none, or the result was recorded before the script's own Enter.
// Costs a few Haiku calls. macOS or Linux (util-linux `script`); needs a logged-in `claude`.
// Run it from your OWN terminal, not inside a Claude Code session: Claude Code will not start nested, and the script does not unset CLAUDECODE or CLAUDE_CODE_* for
// the child (only the owner may unset CLAUDECODE); started inside a session it prints that and exits 2.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUMAN_DECISION } from '../pipeline/hooks/lib/owner-go-click.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DOWN = '\x1b[B';
const UP = '\x1b[A';
const RIGHT = '\x1b[C';
export const ENTER = '\r';
const ESC = '\x1b';
const QUESTION = 'Spike ask-0123456789ab: merge #1?';
// The third option is the one a hook or the model prefills: no case moves the cursor onto it (genuine clicks press DOWN once, to "Merge"), so a stray DOWN+ENTER from this
// script cannot produce the prefilled answer by accident.
export const PREFILL_LABEL = 'Prefilled by spike';
const SIMPLE = `Call the AskUserQuestion tool exactly once, with one question: question "${QUESTION}", header "Merge", multiSelect false, options [{label:"Not yet",description:"stop"},{label:"Merge",description:"merge it"},{label:"${PREFILL_LABEL}",description:"only a hook or the model picks this"}]. Then reply with only the answer you received.`;
const PREFILLED = `Call the AskUserQuestion tool exactly once. Its input must have TWO keys: "questions" = [{"question":"${QUESTION}","header":"Merge","multiSelect":false,"options":[{"label":"Not yet","description":"stop"},{"label":"Merge","description":"merge it"},{"label":"${PREFILL_LABEL}","description":"only a hook or the model picks this"}]}] and "answers" = {"${QUESTION}":"${PREFILL_LABEL}"}. Include the answers key exactly. Then reply with only the answer you received.`;
// The hook cases' answer: the older recordings (2.1.322, 2.1.323) were made when the hook prefilled "Merge", so those fixtures keep passing.
const HOOK_ANSWER = new RegExp(`^(?:Merge|${PREFILL_LABEL})$`);
const PREVIEW = 'Call the AskUserQuestion tool exactly once with exactly this input JSON (copy it byte for byte, including the \\n newlines): {"questions":[{"question":"Merge #1818 into main?\\n\\nRulings: R1 F2 ACCEPT (fixed) · R2 F1 FOLLOW-UP #1830 · R2 F3 REJECT (Codex high: not reachable)\\nAreas: pipeline/hooks, pipeline/lib/finalgate.mjs, skills/review, docs\\nHold: none\\nHead 3f2a9c81d0e4 · items 9b1c2d3e4f50a6b7 · repo acme/app\\nask-0123456789ab","header":"Merge","multiSelect":false,"options":[{"label":"Not yet","description":"Leave #1818 open; nothing merges."},{"label":"Merge","description":"Merge #1818 at head 3f2a9c81d0e4 with the items above.","preview":"Rulings\\nR1 F2 ACCEPT (fixed)\\nR2 F1 FOLLOW-UP #1830\\nR2 F3 REJECT (Codex high: not reachable)\\nHead 3f2a9c81d0e4 · items 9b1c2d3e4f50a6b7"}]}]}. Then reply with only the answer you received.';
const MULTI = 'Call the AskUserQuestion tool exactly once with exactly this input JSON: {"questions":[{"question":"Merge which PRs? ask-0123456789ab","header":"Merge all","multiSelect":true,"options":[{"label":"Merge #1","description":"head aaa"},{"label":"Merge #2","description":"head bbb"},{"label":"Merge #3","description":"head ccc"}]}]}. Then reply with only the answer you received.';

// expect: what the recorder must see. human = permissionDecision exactly HUMAN_DECISION and annotations exactly {}; hook = source hook and no annotations;
// annotated = a human answer whose annotations are NOT empty; prefilled = the tool_use input carries an `answers` key (the recorder refuses that input);
// not-human = the dialog was ANSWERED (a result with an answer, not an error, not ended by the script's own exit key) and the permissionDecision is not exactly HUMAN_DECISION; a dialog that was never answered is inconclusive (judge returns inconclusive: true, ok false). since: the first build the case applies to (the committed fixtures of an older build lack it).
export const CASES = [
  { name: 'genuine-click', mode: 'none', prompt: SIMPLE, keys: [DOWN, ENTER], expect: 'human', answer: 'Merge' },
  { name: 'pretooluse-hook-answer', mode: 'answer', prompt: SIMPLE, keys: [], expect: 'hook', answer: HOOK_ANSWER },
  { name: 'permissionrequest-hook-answer', mode: 'permreq', prompt: SIMPLE, keys: [], expect: 'hook', answer: HOOK_ANSWER },
  { name: 'model-prefilled-answers', mode: 'none', prompt: PREFILLED, keys: [], expect: 'prefilled' },
  // 2.1.323: the committed recording of a PreToolUse hook answering "ask" with prefilled answers shows a result stamped source user_temporary with annotations {} and
  // reasonCode 'hook:PreToolUse' (not 'unknown') about 1.5 s after the tool_use. That recording was made by the older script, which could press keys into the dialog, so it
  // cannot tell a Claude Code auto-submit from a stray key press; a re-record with the key log (judge checks it) does.
  { name: 'pretooluse-ask-prefill', mode: 'askfill', prompt: SIMPLE, keys: [], expect: 'not-human', since: '2.1.323' },
  // A PreToolUse hook that returns ONLY updatedInput (answers prefilled), no permissionDecision. Not recorded yet (since: the first build after 2.1.323, or a 2.1.323 re-record);
  // expected not-human. If a recording shows the human stamp here, the dialog-hook check (not the stamp) is what stops it.
  { name: 'pretooluse-fill-no-decision', mode: 'fill', prompt: SIMPLE, keys: [], expect: 'not-human', since: '2.1.324' },
  { name: 'preview-annotations', mode: 'none', prompt: PREVIEW, keys: [DOWN, ENTER], expect: 'annotated', answer: 'Merge' },
  // Number keys tick options, → goes to the Submit tab, whose first choice submits. Which options end up ticked is not reliable on 2.1.323 (the same keys
  // ticked different sets across runs), so any list of two or more labels joined by ", " is accepted: the tests rewrite the answer anyway.
  { name: 'headless-p', mode: 'none', prompt: SIMPLE, keys: [], headless: true, expect: 'not-cli' },
  { name: 'multiselect-click', mode: 'none', prompt: MULTI, keys: ['1', '3', RIGHT, ENTER], expect: 'human', answer: /^Merge #\d(?:, Merge #\d)+$/ },
];

// The scratch hook: writes the session's transcript location (from its own hook input) to SPIKE_WHERE, and answers AskUserQuestion per SPIKE_MODE
// (answer = PreToolUse allow + updatedInput.answers; askfill = PreToolUse ask + updatedInput.answers; fill = PreToolUse updatedInput.answers and no permissionDecision;
// permreq = PermissionRequest allow + updatedInput.answers). The prefilled answer is PREFILL_LABEL, an option no case's keys select.
export const HOOK = `import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const ev = input.hook_event_name;
const mode = process.env.SPIKE_MODE;
if (typeof input.transcript_path === 'string' && process.env.SPIKE_WHERE) fs.writeFileSync(process.env.SPIKE_WHERE, input.transcript_path);
if (input.tool_name === 'AskUserQuestion') {
  const q = input.tool_input.questions[0];
  const filled = { ...input.tool_input, answers: { [q.question]: ${JSON.stringify(PREFILL_LABEL)} } };
  if (ev === 'PreToolUse' && mode === 'answer') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'spike', updatedInput: filled } }));
  if (ev === 'PreToolUse' && mode === 'askfill') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', updatedInput: filled } }));
  if (ev === 'PreToolUse' && mode === 'fill') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: filled } }));
  if (ev === 'PermissionRequest' && mode === 'permreq') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: filled } } }));
}
`;

// --only names against the matrix: the cases to run, and any name that is not a case (a typo must not run nothing and pass).
export function selectCases(only) {
  const cases = CASES.filter((c) => !only || only.has(c.name));
  const unknown = only ? [...only].filter((n) => !CASES.some((c) => c.name === n)) : [];
  return { cases, unknown };
}

// A run that did not cover the whole matrix is not a verdict on the build: it never recommends allowlisting and exits with its own code.
export const PARTIAL_EXIT = 3;
export function verdict({ build, ran, total, bad }) {
  if (bad > 0) return { code: 1, text: `${bad} case(s) failed: do NOT add ${build} to CLICK_BUILDS` };
  if (ran < total || ran === 0) return { code: PARTIAL_EXIT, text: `partial run: ${ran} of ${total} case(s) ran and passed; this says nothing about ${build} as a whole (run without --only before adding it to CLICK_BUILDS)` };
  return { code: 0, text: `all ${ran} case(s) show the discriminator on ${build}: add '${build}' to CLICK_BUILDS with these fixtures` };
}

function parseArgs(argv) {
  const opt = { claude: 'claude', out: null, only: null, keep: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--claude') opt.claude = argv[++k];
    else if (a === '--out') opt.out = argv[++k];
    else if (a === '--only') opt.only = new Set(String(argv[++k]).split(','));
    else if (a === '--keep') opt.keep = true;
    else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  return opt;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const blocks = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

export function trim(entries, cwd) {
  const use = entries.find((e) => e.type === 'assistant' && blocks(e).some((b) => b?.type === 'tool_use' && b.name === 'AskUserQuestion'));
  if (!use) return null;
  const id = blocks(use).find((b) => b?.type === 'tool_use' && b.name === 'AskUserQuestion').id;
  const result = entries.find((e) => e.type === 'user' && blocks(e).some((b) => b?.type === 'tool_result' && b.tool_use_id === id));
  const prompt = entries.find((e) => e.type === 'user' && typeof e.message?.content === 'string');
  if (!result || !prompt) return null;
  const clean = (e) => {
    const c = structuredClone(e);
    if (c.cwd === cwd) c.cwd = '/work/spike';
    delete c.serverClassifierRequest;
    delete c.serverClassifierContext;
    delete c.wireToolInputs;
    if (c.message) delete c.message.usage;
    return c;
  };
  return [prompt, use, result].map(clean);
}

// The tool_use input must be what the recorder accepts (owner-go-click.mjs clickEvidence: only 'questions' and 'metadata'); the prefilled case is the one that expects an extra key.
const canonicalInput = (input) => input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every((k) => k === 'questions' || k === 'metadata');

// sent: the keys this script sent into the session, [{ key, at (ms), phase: 'dismiss' | 'case' | 'exit' }], when the run was a real one (a committed fixture has none: skipped).
// A case that gets no keys fails if any dismiss/case key went in at or after the tool_use (it could have answered the dialog); a case that does press keys fails if the result
// was recorded before the script's own Enter. 'exit' keys (ESC, /exit) are cleanup after the answer; one sent before the result is reported as endedByScriptKey.
export function judge(c, [, use, result], { sent } = {}) {
  const input = blocks(use).find((b) => b?.type === 'tool_use').input;
  const pd = result.permissionDecision;
  const res = result.toolUseResult;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const answer = isObj(res?.answers) ? Object.values(res.answers)[0] : undefined;
  // The human stamp is the WHOLE permissionDecision (owner-go-click.mjs HUMAN_DECISION): a hook-filled answer can carry source user_temporary with another reasonCode.
  const human = isObj(pd) && JSON.stringify(Object.entries(pd).sort()) === JSON.stringify(Object.entries(HUMAN_DECISION).sort());
  const emptyNotes = isObj(res?.annotations) && Object.keys(res.annotations).length === 0;
  const wanted = (a) => (c.answer instanceof RegExp ? c.answer.test(a ?? '') : a === c.answer);
  const useAt = Date.parse(use.timestamp);
  const resultAt = Date.parse(result.timestamp);
  let keyProblem = null;
  if (Array.isArray(sent)) {
    const into = sent.filter((k) => k.phase !== 'exit' && k.at >= useAt);
    const enter = sent.find((k) => k.phase === 'case' && k.key === ENTER);
    if (c.keys.length === 0 && into.length > 0) keyProblem = `${into.length} key(s) sent after the tool_use (first ${into[0].at - useAt} ms after it, phase ${into[0].phase}) into a dialog that should get none`;
    else if (c.keys.length > 0 && !enter) keyProblem = 'the script never pressed Enter';
    else if (c.keys.length > 0 && !(resultAt >= enter.at)) keyProblem = `the result was recorded ${enter.at - resultAt} ms before the script's own Enter`;
  }
  const seen = {
    decision: pd ?? null,
    annotations: isObj(res) && Object.hasOwn(res, 'annotations') ? Object.keys(res.annotations ?? {}).length : 'absent',
    answer: answer ?? null,
    inputKeys: Object.keys(input ?? {}).join(','),
    ...(keyProblem ? { keyProblem } : {}),
    ...(Array.isArray(sent) && sent.some((k) => k.phase === 'exit' && k.at <= resultAt) ? { endedByScriptKey: true } : {}),
  };
  const clean = canonicalInput(input) && keyProblem === null;
  // A not-human verdict needs an answered dialog: a result that is an error, carries no answer, or was recorded after the script's own ESC / /exit says nothing about who (or what) answered.
  // The script cancelling a dialog that stayed open (a hook that filled nothing in) must never read as "not human": it is inconclusive and fails a run.
  const errored = blocks(result).some((b) => b?.type === 'tool_result' && b.tool_use_id === use.message.content.find((x) => x?.type === 'tool_use')?.id && b.is_error === true);
  const inconclusive = c.expect === 'not-human' && (errored || answer === undefined || seen.endedByScriptKey === true);
  if (inconclusive) seen.inconclusive = errored ? 'the result is an error (the dialog was cancelled, not answered)' : answer === undefined ? 'the result carries no answer' : 'the script sent an exit key before the result was recorded';
  const ok = {
    human: clean && human && emptyNotes && wanted(answer),
    hook: clean && !human && isObj(pd) && pd.source === 'hook' && !(isObj(res) && Object.hasOwn(res, 'annotations')) && wanted(answer),
    annotated: clean && human && isObj(res?.annotations) && Object.keys(res.annotations).length > 0 && wanted(answer),
    prefilled: Object.hasOwn(input ?? {}, 'answers'),
    'not-human': clean && !human && !inconclusive,
  }[c.expect];
  return { ok, seen, ...(inconclusive ? { inconclusive: true } : {}) };
}

// The headless case: a `claude -p` run proves "not offered headless" only if it finished by itself with exit code 0 and never reached AskUserQuestion.
// r: { code, signal, timedOut, error, called, fixture }.
export function headlessVerdict(r) {
  if (r.error) return { ok: false, text: `could not run claude -p: ${r.error}` };
  if (r.timedOut) return { ok: false, text: 'claude -p did not finish in time and was stopped: nothing was verified' };
  if (r.signal) return { ok: false, text: `claude -p was killed by ${r.signal}: nothing was verified` };
  if (r.code !== 0) return { ok: false, text: `claude -p exited with code ${r.code}: nothing was verified` };
  if (r.called || r.fixture) return { ok: false, text: `AskUserQuestion was called headless${r.fixture ? ` (entrypoint ${JSON.stringify(r.fixture[2]?.entrypoint)})` : ''}: the case expects it not to be offered` };
  return { ok: true, text: 'claude -p exited 0 and AskUserQuestion was not called (not offered headless)' };
}

async function runCase(c, { claude, scratch }) {
  const sid = randomUUID();
  const proj = join(scratch, c.name);
  mkdirSync(proj, { recursive: true });
  const cwd = realpathSync(proj);
  const tty = join(scratch, `${c.name}.tty`);
  const where = join(scratch, `${c.name}.where`); // the scratch hook writes the session's transcript location here
  const transcript = () => (existsSync(where) ? readFileSync(where, 'utf8').trim() : null);
  const claudeArgs = ['--model', 'haiku', '--setting-sources', 'project', '--settings', join(scratch, 'settings.json'), '--session-id', sid, c.prompt];
  if (c.headless) {
    // `claude -p`: no terminal, nobody to click. The case passes only if the run ends by itself with exit 0 and AskUserQuestion was never called (headlessVerdict).
    const env = { ...process.env, SPIKE_MODE: c.mode, SPIKE_WHERE: where };
    const run = await new Promise((resolve) => {
      const p = spawn(claude, ['-p', ...claudeArgs], { cwd, env, stdio: 'ignore' });
      let timedOut = false;
      const t = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, 120_000);
      p.on('error', (e) => { clearTimeout(t); resolve({ code: null, signal: null, timedOut, error: e.message }); });
      p.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, timedOut }); });
    });
    return { sid, headless: true, ...run, called: Boolean(transcript()), transcript: transcript() ?? `(no AskUserQuestion call: session ${sid})`, fixture: transcript() ? trim(readJsonl(transcript()), cwd) : null };
  }
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const [cmd, args] = platform() === 'linux'
    ? ['script', ['-q', '-c', [claude, ...claudeArgs].map(quote).join(' '), tty]]
    : ['/usr/bin/script', ['-q', tty, claude, ...claudeArgs]];
  const env = { ...process.env, SPIKE_MODE: c.mode, SPIKE_WHERE: where, COLUMNS: '80', LINES: '40' };
  // `script` needs a stdin it can tcgetattr: a plain pipe works, a socket does not (Node's own stdio pipe is a socket pair, and on macOS so is a
  // named pipe). So the keys go into a named pipe that `cat` copies into a shell pipe. Opened read-write first so neither open blocks.
  const fifo = join(scratch, `${c.name}.keys`);
  execFileSync('mkfifo', [fifo]);
  const rfd = openSync(fifo, 'r+');
  const wfd = openSync(fifo, 'w');
  const child = spawn('/bin/sh', ['-c', 'f=$1; shift; cat "$f" | "$@"', 'sh', fifo, cmd, ...args], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  let exited = false;
  child.on('exit', () => { exited = true; });
  // Every key goes through here with the time it was sent; judge() compares them with the transcript's timestamps.
  const sent = [];
  let phase = 'dismiss';
  const send = (s, ph = phase) => { if (!exited) { sent.push({ key: s, at: Date.now(), phase: ph }); writeSync(wfd, s); } };
  // The screen as text with every blank removed (the TUI often moves the cursor instead of printing spaces); `seen` marks what was already acted on.
  const screen = () => (existsSync(tty) ? stripAnsi(readFileSync(tty, 'utf8')).replace(/\s+/g, '') : '');
  let seen = 0;
  const fresh = () => screen().slice(seen);
  const consume = () => { seen = screen().length; };
  const keys = async (list, ph) => { for (const k of list) { await sleep(700); send(k, ph); } await sleep(1500); consume(); };
  const answered = () => (transcript() ? trim(readJsonl(transcript()), cwd) : null);
  const deadline = Date.now() + 150_000;
  // Wait for the dialog (or, for the hook cases, the answer). Screens that can come first are dismissed: the folder-trust question (the scratch folder
  // is new) and the auto-mode tip, choosing "Yes, I trust this folder" and "Not now" (never "Don't show again": that would change the account's settings).
  // Those handlers run ONLY until the scratch hook has seen the AskUserQuestion call (its transcript location is then known): after that no key can go to them, so
  // a stale trust/tip text can never press DOWN+ENTER into the dialog. The case's own keys go out only when the screen shows THIS dialog (its question's id and the
  // select/navigate footer) after that call, slowly enough for the TUI to redraw between them.
  while (Date.now() < deadline && !answered()) {
    const t = fresh();
    const asked = Boolean(transcript());
    if (asked && /0123456789ab/.test(t) && /Entertoselect|tonavigate/.test(t)) {
      await sleep(2000);
      await keys(c.keys, 'case');
      break;
    }
    if (!asked && /Itrustthisfolder/.test(t)) await keys([DOWN, ENTER], 'dismiss');
    else if (!asked && /Teachautomode/.test(t)) await keys([DOWN, ENTER], 'dismiss');
    else await sleep(500);
  }
  const waitUntil = Date.now() + (c.keys.length > 0 || c.mode !== 'none' ? 30_000 : 4_000);
  while (Date.now() < waitUntil && !answered()) await sleep(500);
  phase = 'exit';
  if (!answered()) { send(ESC); await sleep(3000); } // the declined case (and any dialog the keys missed)
  for (let k = 0; k < 20 && !exited; k++) { send(ESC); await sleep(500); send('/exit\r'); await sleep(1500); }
  closeSync(wfd); // ends `cat`, so the pipeline can finish
  closeSync(rfd);
  await sleep(1000);
  if (!exited) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } }
  return { sid, sent, transcript: transcript() ?? `(no hook call: session ${sid})`, fixture: answered() };
}

async function main() {
  if (process.env.CLAUDECODE) {
    console.error('run this from your own terminal, not inside a Claude Code session (Claude Code will not start nested, and only the owner may unset CLAUDECODE)');
    process.exit(2);
  }
  const opt = parseArgs(process.argv.slice(2));
  const v = spawnSync(opt.claude, ['--version'], { encoding: 'utf8' });
  const build = /(\d+\.\d+\.\d+)/.exec(v.stdout ?? '')?.[1];
  if (!build) { console.error(`could not read the build from \`${opt.claude} --version\``); process.exit(2); }
  const out = opt.out ?? join(ROOT, 'test', 'fixtures', 'click', build);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'click-spike-')));
  writeFileSync(join(scratch, 'hook.mjs'), HOOK);
  const hook = { type: 'command', command: `node ${JSON.stringify(join(scratch, 'hook.mjs'))}` };
  writeFileSync(join(scratch, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [hook] }], PermissionRequest: [{ matcher: 'AskUserQuestion', hooks: [hook] }] } }));
  const { cases, unknown } = selectCases(opt.only);
  if (unknown.length > 0) { console.error(`unknown case(s) in --only: ${unknown.join(', ')} (cases: ${CASES.map((c) => c.name).join(', ')})`); process.exit(2); }
  console.log(`build ${build}: recording ${cases.length} case(s) into ${out} (scratch ${scratch})`);
  const runs = await Promise.all(cases.map((c) => runCase(c, { claude: opt.claude, scratch })));
  mkdirSync(out, { recursive: true });
  let bad = 0;
  for (const [i, c] of cases.entries()) {
    const r = runs[i];
    if (r.headless) {
      // Not a fixture: what matters is that a headless run finishes by itself and never reaches AskUserQuestion (so it cannot leave an entry the recorder takes for a terminal click).
      const h = headlessVerdict(r);
      if (!h.ok) bad++;
      console.log(`${h.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${h.text}`);
      continue;
    }
    if (!r.fixture) { bad++; console.log(`FAIL ${c.name}: no AskUserQuestion result in ${r.transcript} (see ${join(scratch, `${c.name}.tty`)})`); continue; }
    const version = r.fixture[1].version;
    if (version !== build) { bad++; console.log(`FAIL ${c.name}: transcript says version ${version}, not ${build}`); continue; }
    writeFileSync(join(out, `${c.name}.jsonl`), `${r.fixture.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const j = judge(c, r.fixture, { sent: r.sent });
    if (!j.ok) bad++;
    console.log(`${j.ok ? 'ok  ' : 'FAIL'} ${c.name}: expected ${c.expect}; saw ${JSON.stringify(j.seen)}`);
  }
  if (!opt.keep && bad === 0) rmSync(scratch, { recursive: true, force: true });
  const fin = verdict({ build, ran: cases.length, total: CASES.length, bad });
  console.log(fin.text);
  process.exit(fin.code);
}

// main() only when run as a script (not when a test imports trim / judge / CASES); both sides as real paths, so a symlinked checkout or temp folder and Windows paths compare equal
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main();

// Re-records the click-to-approve transcript fixtures (#261) on the Claude Code build installed here, so a new build can join CLICK_BUILDS
// (pipeline/hooks/lib/owner-go-click.mjs) with recorded evidence instead of a guess.
//   node scripts/click-spike.mjs [--claude <path>] [--out <dir>] [--only name,name] [--keep]
// Runs each case below as a real interactive `claude` session in a pseudo-terminal (`script`), in a scratch project with
// `--setting-sources project` (no user hooks, no pipeline hooks) and a scratch hook that answers the dialog for the hook cases.
// It types the keys a person would, waits for the AskUserQuestion result in the transcript, quits, then writes a trimmed copy
// (the prompt, the AskUserQuestion tool_use and its tool_result; cwd neutral; usage and classifier fields dropped) to
// <out>/<case>.jsonl (default test/fixtures/click/<build>/). Last, it checks the discriminator the recorder relies on and exits 1
// when any case no longer shows it: then DO NOT add the build to CLICK_BUILDS (clicks stay refused on it; typing still works).
// Costs a few Haiku calls. macOS or Linux (util-linux `script`); needs a logged-in `claude`.
// Run it from your OWN terminal, not inside a Claude Code session: Claude Code will not start nested, and the script does not unset CLAUDECODE or CLAUDECODE_* for
// the child (only the owner may unset CLAUDECODE); started inside a session it prints that and exits 2.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUMAN_DECISION } from '../pipeline/hooks/lib/owner-go-click.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const RIGHT = '\x1b[C';
const ENTER = '\r';
const ESC = '\x1b';
const QUESTION = 'Spike ask-0123456789ab: merge #1?';
const SIMPLE = `Call the AskUserQuestion tool exactly once, with one question: question "${QUESTION}", header "Merge", multiSelect false, options [{label:"Not yet",description:"stop"},{label:"Merge",description:"merge it"}]. Then reply with only the answer you received.`;
const PREFILLED = `Call the AskUserQuestion tool exactly once. Its input must have TWO keys: "questions" = [{"question":"${QUESTION}","header":"Merge","multiSelect":false,"options":[{"label":"Not yet","description":"stop"},{"label":"Merge","description":"merge it"}]}] and "answers" = {"${QUESTION}":"Merge"}. Include the answers key exactly. Then reply with only the answer you received.`;
const PREVIEW = 'Call the AskUserQuestion tool exactly once with exactly this input JSON (copy it byte for byte, including the \\n newlines): {"questions":[{"question":"Merge #1818 into main?\\n\\nRulings: R1 F2 ACCEPT (fixed) · R2 F1 FOLLOW-UP #1830 · R2 F3 REJECT (Codex high: not reachable)\\nAreas: pipeline/hooks, pipeline/lib/finalgate.mjs, skills/review, docs\\nHold: none\\nHead 3f2a9c81d0e4 · items 9b1c2d3e4f50a6b7 · repo acme/app\\nask-0123456789ab","header":"Merge","multiSelect":false,"options":[{"label":"Not yet","description":"Leave #1818 open; nothing merges."},{"label":"Merge","description":"Merge #1818 at head 3f2a9c81d0e4 with the items above.","preview":"Rulings\\nR1 F2 ACCEPT (fixed)\\nR2 F1 FOLLOW-UP #1830\\nR2 F3 REJECT (Codex high: not reachable)\\nHead 3f2a9c81d0e4 · items 9b1c2d3e4f50a6b7"}]}]}. Then reply with only the answer you received.';
const MULTI = 'Call the AskUserQuestion tool exactly once with exactly this input JSON: {"questions":[{"question":"Merge which PRs? ask-0123456789ab","header":"Merge all","multiSelect":true,"options":[{"label":"Merge #1","description":"head aaa"},{"label":"Merge #2","description":"head bbb"},{"label":"Merge #3","description":"head ccc"}]}]}. Then reply with only the answer you received.';

// expect: what the recorder must see. human = permissionDecision exactly HUMAN_DECISION and annotations exactly {}; hook = source hook and no annotations;
// annotated = a human answer whose annotations are NOT empty; prefilled = the tool_use input carries an `answers` key (the recorder refuses that input);
// not-human = the permissionDecision is not exactly HUMAN_DECISION. since: the first build the case applies to (the committed fixtures of an older build lack it).
export const CASES = [
  { name: 'genuine-click', mode: 'none', prompt: SIMPLE, keys: [DOWN, ENTER], expect: 'human', answer: 'Merge' },
  { name: 'pretooluse-hook-answer', mode: 'answer', prompt: SIMPLE, keys: [], expect: 'hook', answer: 'Merge' },
  { name: 'permissionrequest-hook-answer', mode: 'permreq', prompt: SIMPLE, keys: [], expect: 'hook', answer: 'Merge' },
  { name: 'model-prefilled-answers', mode: 'none', prompt: PREFILLED, keys: [], expect: 'prefilled' },
  // 2.1.323: a PreToolUse hook answering "ask" with prefilled answers makes Claude Code submit them by itself after ~1.5-2 s, stamped
  // source user_temporary with annotations {}; only reasonCode ('hook:PreToolUse', not 'unknown') tells it from a person.
  { name: 'pretooluse-ask-prefill', mode: 'askfill', prompt: SIMPLE, keys: [], expect: 'not-human', since: '2.1.323' },
  { name: 'preview-annotations', mode: 'none', prompt: PREVIEW, keys: [DOWN, ENTER], expect: 'annotated', answer: 'Merge' },
  // Number keys tick options, → goes to the Submit tab, whose first choice submits. Which options end up ticked is not reliable on 2.1.323 (the same keys
  // ticked different sets across runs), so any list of two or more labels joined by ", " is accepted: the tests rewrite the answer anyway.
  { name: 'headless-p', mode: 'none', prompt: SIMPLE, keys: [], headless: true, expect: 'not-cli' },
  { name: 'multiselect-click', mode: 'none', prompt: MULTI, keys: ['1', '3', RIGHT, ENTER], expect: 'human', answer: /^Merge #\d(?:, Merge #\d)+$/ },
];

// The scratch hook: writes the session's transcript location (from its own hook input) to SPIKE_WHERE, and answers AskUserQuestion per SPIKE_MODE
// (answer = PreToolUse allow + updatedInput.answers; permreq = PermissionRequest allow + updatedInput.answers).
const HOOK = `import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const ev = input.hook_event_name;
const mode = process.env.SPIKE_MODE;
if (typeof input.transcript_path === 'string' && process.env.SPIKE_WHERE) fs.writeFileSync(process.env.SPIKE_WHERE, input.transcript_path);
if (input.tool_name === 'AskUserQuestion') {
  const q = input.tool_input.questions[0];
  const filled = { ...input.tool_input, answers: { [q.question]: q.options[q.options.length - 1].label } };
  if (ev === 'PreToolUse' && mode === 'answer') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'spike', updatedInput: filled } }));
  if (ev === 'PreToolUse' && mode === 'askfill') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', updatedInput: filled } }));
  if (ev === 'PermissionRequest' && mode === 'permreq') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: filled } } }));
}
`;

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

export function judge(c, [, use, result]) {
  const input = blocks(use).find((b) => b?.type === 'tool_use').input;
  const pd = result.permissionDecision;
  const res = result.toolUseResult;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const answer = isObj(res?.answers) ? Object.values(res.answers)[0] : undefined;
  // The human stamp is the WHOLE permissionDecision (owner-go-click.mjs HUMAN_DECISION): a hook-filled answer can carry source user_temporary with another reasonCode.
  const human = isObj(pd) && JSON.stringify(Object.entries(pd).sort()) === JSON.stringify(Object.entries(HUMAN_DECISION).sort());
  const emptyNotes = isObj(res?.annotations) && Object.keys(res.annotations).length === 0;
  const wanted = (a) => (c.answer instanceof RegExp ? c.answer.test(a ?? '') : a === c.answer);
  const seen = { decision: pd ?? null, annotations: isObj(res) && Object.hasOwn(res, 'annotations') ? Object.keys(res.annotations ?? {}).length : 'absent', answer: answer ?? null, inputKeys: Object.keys(input ?? {}).join(',') };
  const ok = {
    human: human && emptyNotes && wanted(answer),
    hook: !human && isObj(pd) && pd.source === 'hook' && !(isObj(res) && Object.hasOwn(res, 'annotations')) && wanted(answer),
    annotated: human && isObj(res?.annotations) && Object.keys(res.annotations).length > 0 && wanted(answer),
    prefilled: Object.hasOwn(input ?? {}, 'answers'),
    'not-human': !human,
  }[c.expect];
  return { ok, seen };
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
    // `claude -p`: no terminal, nobody to click. The recorder needs either no AskUserQuestion result at all or one that is not entrypoint "cli".
    const env = { ...process.env, SPIKE_MODE: c.mode, SPIKE_WHERE: where };
    await new Promise((resolve) => { const p = spawn(claude, ['-p', ...claudeArgs], { cwd, env, stdio: 'ignore' }); const t = setTimeout(() => p.kill('SIGTERM'), 120_000); p.on('exit', () => { clearTimeout(t); resolve(); }); });
    return { sid, headless: true, transcript: transcript() ?? `(no AskUserQuestion call: session ${sid})`, fixture: transcript() ? trim(readJsonl(transcript()), cwd) : null };
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
  const send = (s) => { if (!exited) writeSync(wfd, s); };
  // The screen as text with every blank removed (the TUI often moves the cursor instead of printing spaces); `seen` marks what was already acted on.
  const screen = () => (existsSync(tty) ? stripAnsi(readFileSync(tty, 'utf8')).replace(/\s+/g, '') : '');
  let seen = 0;
  const fresh = () => screen().slice(seen);
  const consume = () => { seen = screen().length; };
  const keys = async (list) => { for (const k of list) { await sleep(700); send(k); } await sleep(1500); consume(); };
  const answered = () => (transcript() ? trim(readJsonl(transcript()), cwd) : null);
  const deadline = Date.now() + 150_000;
  // Wait for the dialog (or, for the hook cases, the answer). Screens that can come first are dismissed: the folder-trust question (the scratch folder
  // is new) and the auto-mode tip, choosing "Yes, I trust this folder" and "Not now" (never "Don't show again": that would change the account's settings).
  // Keys go out slowly enough for the TUI to redraw between them, and only once no such screen has appeared over the dialog for 2 s.
  while (Date.now() < deadline && !answered()) {
    const t = fresh();
    if (/Itrustthisfolder/.test(t)) await keys([DOWN, ENTER]);
    else if (/Teachautomode/.test(t)) await keys([DOWN, ENTER]);
    else if (/Entertoselect|tonavigate/.test(t)) {
      await sleep(2000);
      if (/Itrustthisfolder|Teachautomode/.test(fresh())) continue;
      await keys(c.keys);
      break;
    } else await sleep(500);
  }
  const waitUntil = Date.now() + (c.keys.length > 0 || c.mode !== 'none' ? 30_000 : 4_000);
  while (Date.now() < waitUntil && !answered()) await sleep(500);
  if (!answered()) { send(ESC); await sleep(3000); } // the declined case (and any dialog the keys missed)
  for (let k = 0; k < 20 && !exited; k++) { send(ESC); await sleep(500); send('/exit\r'); await sleep(1500); }
  closeSync(wfd); // ends `cat`, so the pipeline can finish
  closeSync(rfd);
  await sleep(1000);
  if (!exited) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } }
  return { sid, transcript: transcript() ?? `(no hook call: session ${sid})`, fixture: answered() };
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
  const cases = CASES.filter((c) => !opt.only || opt.only.has(c.name));
  console.log(`build ${build}: recording ${cases.length} case(s) into ${out} (scratch ${scratch})`);
  const runs = await Promise.all(cases.map((c) => runCase(c, { claude: opt.claude, scratch })));
  mkdirSync(out, { recursive: true });
  let bad = 0;
  for (const [i, c] of cases.entries()) {
    const r = runs[i];
    if (r.headless) {
      // Not a fixture: what matters is that a headless run cannot produce an entry the recorder takes for a terminal click.
      const entrypoint = r.fixture?.[2]?.entrypoint;
      const ok = !r.fixture || entrypoint !== 'cli';
      if (!ok) bad++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${r.fixture ? `AskUserQuestion answered headless with entrypoint ${JSON.stringify(entrypoint)}` : 'AskUserQuestion was not called (not offered headless)'}`);
      continue;
    }
    if (!r.fixture) { bad++; console.log(`FAIL ${c.name}: no AskUserQuestion result in ${r.transcript} (see ${join(scratch, `${c.name}.tty`)})`); continue; }
    const version = r.fixture[1].version;
    if (version !== build) { bad++; console.log(`FAIL ${c.name}: transcript says version ${version}, not ${build}`); continue; }
    writeFileSync(join(out, `${c.name}.jsonl`), `${r.fixture.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const j = judge(c, r.fixture);
    if (!j.ok) bad++;
    console.log(`${j.ok ? 'ok  ' : 'FAIL'} ${c.name}: expected ${c.expect}; saw ${JSON.stringify(j.seen)}`);
  }
  if (!opt.keep && bad === 0) rmSync(scratch, { recursive: true, force: true });
  console.log(bad === 0 ? `all ${cases.length} case(s) show the discriminator on ${build}: add '${build}' to CLICK_BUILDS with these fixtures` : `${bad} case(s) failed: do NOT add ${build} to CLICK_BUILDS`);
  process.exit(bad === 0 ? 0 : 1);
}

// main() only when run as a script (not when a test imports trim / judge / CASES); both sides as real paths, so a symlinked checkout or temp folder and Windows paths compare equal
const isMain = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main();

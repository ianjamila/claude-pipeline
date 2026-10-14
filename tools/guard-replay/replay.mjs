// usage: node tools/guard-replay/replay.mjs <oldRoot> <newRoot> <transcriptsDir> <days> <outJson> [workers=4] [capMs=20000]
// Replays every Bash command from recent transcripts through the OLD and NEW guard policies and lists verdict flips.
// Roots are directories holding `pipeline/` (git -C <repo> archive <sha> pipeline | tar -x -C <dir>).
// Each command runs in a worker thread; one that outlasts capMs is cut (worker terminated) and recorded under `timeouts`.
// Progress goes to stderr every 10 s. Commands slower than 1 s (any side) are recorded under `slow`.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!isMainThread) {
  const load = async (r) => ({
    git: (await import(pathToFileURL(join(r, 'pipeline/hooks/lib/git-policy.mjs')).href)).evaluateGitCommand,
    files: (await import(pathToFileURL(join(r, 'pipeline/hooks/lib/files-policy.mjs')).href)).evaluateBashForFiles,
  });
  const P = { old: await load(workerData.oldRoot), new: await load(workerData.newRoot) };
  const gitOpts = (cwd) => ({ cwd, home: os.homedir(), currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [] });
  const fileOpts = (cwd) => ({ cwd, home: os.homedir(), env: process.env, platform: process.platform }); // (like guard-files.mjs)
  const run = (fn, ...a) => { const t = Date.now(); try { const v = fn(...a); return { d: v.decision, r: v.reason, ms: Date.now() - t }; } catch (e) { return { d: 'throw', r: String(e?.message ?? e), ms: Date.now() - t }; } };
  parentPort.on('message', ({ i, cwd, command }) => {
    const res = {};
    for (const k of ['git', 'files']) for (const v of ['old', 'new']) {
      parentPort.postMessage({ i, phase: `${k}/${v}` });
      res[`${k}/${v}`] = run(P[v][k], command, k === 'git' ? gitOpts(cwd) : fileOpts(cwd));
    }
    parentPort.postMessage({ i, res });
  });
  parentPort.postMessage({ ready: true });
} else {
  const [oldRoot, newRoot, tdir, days = '21', out, nw = '4', capArg = '20000'] = process.argv.slice(2);
  if (!out) { console.error('usage: node tools/guard-replay/replay.mjs <oldRoot> <newRoot> <transcriptsDir> <days> <outJson> [workers] [capMs]'); process.exit(2); }
  if (existsSync(out)) { console.error(`${out} exists; pass a new file`); process.exit(2); }
  const cap = Number(capArg);
  const since = Date.now() - Number(days) * 864e5;
  const seen = new Set();
  const cmds = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!n.endsWith('.jsonl') || st.mtimeMs < since) continue;
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.includes('"Bash"')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        for (const c of o?.message?.content ?? []) {
          if (c?.type !== 'tool_use' || c.name !== 'Bash' || typeof c.input?.command !== 'string') continue;
          const key = `${o.cwd}\u0000${c.input.command}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cmds.push({ cwd: o.cwd || os.homedir(), command: c.input.command });
        }
      }
    }
  };
  walk(tdir);
  const flips = [], slow = [], timeouts = [];
  let next = 0, done = 0;
  const started = Date.now();
  const finish = () => {
    const summary = { commands: cmds.length, flips: flips.length, byDir: {}, slow: slow.length, timeouts: timeouts.length, seconds: Math.round((Date.now() - started) / 1000) };
    for (const f of flips) { const key = `${f.k}:${f.from}->${f.to}`; summary.byDir[key] = (summary.byDir[key] ?? 0) + 1; }
    writeFileSync(out, JSON.stringify({ summary, flips, slow, timeouts }, null, 1));
    console.log(JSON.stringify(summary));
    process.exit(0);
  };
  const progress = setInterval(() => console.error(`[replay] ${done}/${cmds.length} ${Math.round((Date.now() - started) / 1000)}s flips=${flips.length} slow=${slow.length} timeouts=${timeouts.length}`), 10000);
  let live = 0;
  const workers = new Set();
  // A worker that dies before `ready` (policy module missing, syntax error) would otherwise be respawned forever.
  const abort = (msg) => {
    clearInterval(progress);
    console.error(`[replay] worker failed before it was ready: ${msg}`);
    for (const x of workers) x.terminate();
    process.exit(1);
  };
  const spawn = () => {
    live++;
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { oldRoot, newRoot } });
    workers.add(w);
    let job = null, phase = '', timer = null, ready = false;
    const give = () => {
      if (next >= cmds.length) { w.terminate(); return; }
      job = next++;
      phase = '';
      timer = setTimeout(() => {
        const { cwd, command } = cmds[job];
        timeouts.push({ i: job, phase, cwd, command });
        done++;
        job = null;
        w.terminate();
      }, cap);
      w.postMessage({ i: job, ...cmds[job] });
    };
    w.on('message', (m) => {
      if (m.ready) { ready = true; return give(); }
      if (m.i !== job) return;
      if (m.phase) { phase = m.phase; return; }
      clearTimeout(timer);
      const { cwd, command } = cmds[job];
      for (const k of ['git', 'files']) {
        const o = m.res[`${k}/old`], n = m.res[`${k}/new`];
        if (n.ms > 1000 || o.ms > 1000) slow.push({ k, oldMs: o.ms, newMs: n.ms, newD: n.d, cwd, command: command.slice(0, 300) });
        if (o.d !== n.d) flips.push({ k, from: o.d, to: n.d, reason: (n.d === 'deny' ? n.r : o.r)?.slice(0, 300), cwd, command });
      }
      done++;
      give();
    });
    w.on('error', (e) => {
      if (!ready) return abort(String(e?.stack ?? e));
      if (job !== null) { clearTimeout(timer); timeouts.push({ i: job, phase, error: String(e?.message ?? e), ...cmds[job] }); done++; job = null; }
    });
    w.on('exit', () => {
      clearTimeout(timer);
      workers.delete(w);
      if (!ready) return abort('worker exited without an error message');
      live--;
      if (next < cmds.length) spawn();
      else if (live === 0) { clearInterval(progress); finish(); }
    });
  };
  console.error(`[replay] ${cmds.length} commands, ${nw} workers, cap ${cap} ms`);
  for (let k = 0; k < Number(nw); k++) spawn();
}

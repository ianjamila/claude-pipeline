// usage: node tools/guard-replay/hang.mjs <root> <git|files> <cmdsJson> [capMs=6000]  — times each command (a JSON array of {cwd, command}) in a worker, cut at capMs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (!isMainThread) {
  const { root, k, cwd, command } = workerData;
  const fn = k === 'git'
    ? (await import(pathToFileURL(join(root, 'pipeline/hooks/lib/git-policy.mjs')).href)).evaluateGitCommand
    : (await import(pathToFileURL(join(root, 'pipeline/hooks/lib/files-policy.mjs')).href)).evaluateBashForFiles;
  const opts = k === 'git' ? { cwd, home: os.homedir(), currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [] } : { cwd, home: os.homedir(), env: process.env, platform: process.platform };
  const t = Date.now();
  const v = fn(command, opts);
  parentPort.postMessage({ ms: Date.now() - t, d: v.decision, r: (v.reason ?? '').slice(0, 200) });
} else {
  const [root, k, file, cap = '6000'] = process.argv.slice(2);
  const list = JSON.parse(readFileSync(file, 'utf8'));
  for (const [n, { cwd, command }] of list.entries()) {
    const res = await new Promise((resolve) => {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { root, k, cwd, command } });
      const timer = setTimeout(() => { w.terminate(); resolve({ ms: `>${cap}`, d: 'TIMEOUT' }); }, Number(cap));
      w.on('message', (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
      w.on('error', (e) => { clearTimeout(timer); resolve({ d: 'error', r: String(e?.message ?? e) }); });
    });
    console.log(`#${n} ${res.ms}ms ${res.d} ${res.r ?? ''}\n   ${JSON.stringify(command.slice(0, 160))}`);
  }
}

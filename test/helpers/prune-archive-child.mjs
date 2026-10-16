// Child process for test/worktree-prune-act.test.mjs: one archiver acting on a shared holding folder, optionally
// parking itself between picking the archive name and moving the file until the test releases it (go file).
// argv[2] = JSON { wtPath, rels, holdingDir, slug, nowMs, lockDir, lockWaitMs, readyFile?, goFile? }
import { existsSync, writeFileSync } from 'node:fs';
import { archivePathsLocked } from '../../pipeline/lib/worktree-prune/act.mjs';

const a = JSON.parse(process.argv[2]);
const hooks = {};
if (a.readyFile) {
  hooks.afterPick = () => {
    writeFileSync(a.readyFile, 'ready');
    const until = Date.now() + 10_000;
    while (!existsSync(a.goFile) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  };
}
await archivePathsLocked({
  wtPath: a.wtPath, rels: a.rels, holdingDir: a.holdingDir, slug: a.slug, pr: null, nowMs: a.nowMs,
  lockDir: a.lockDir, lockWaitMs: a.lockWaitMs, hooks,
});

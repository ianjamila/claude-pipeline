// A bare "origin" for a tmprepo (real git): pushes `main`, fetches, and by default points refs/remotes/origin/HEAD at it, as `git clone` does. -> the bare repository's directory.
// `head: false` leaves origin/HEAD unset (the remote still answers `git ls-remote --symref origin HEAD`, until the test breaks the URL); the bare dir is removed with the test.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function addOrigin(t, repo, { head = true, branch = 'main' } = {}) {
  const bare = realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-origin-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  repo.git(['init', '-q', '--bare', '-b', branch, bare]);
  repo.git(['remote', 'add', 'origin', bare]);
  repo.git(['push', '-q', 'origin', branch]);
  repo.git(['fetch', '-q', 'origin']);
  if (head) repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
  return bare;
}

// Make every network read of origin fail (an unreachable URL) while the cached refs/remotes/origin/* stay.
export const breakOrigin = (repo) => repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-no-such-origin-dir.git')]);

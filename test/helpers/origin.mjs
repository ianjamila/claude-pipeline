// A bare "origin" for a tmprepo (real git): pushes `main`, fetches, and by default points refs/remotes/origin/HEAD at it, as `git clone` does. -> the bare repository's directory.
// `head: false` leaves origin/HEAD unset (the remote still answers `git ls-remote --symref origin HEAD`, until the test breaks the URL); the bare dir is removed with the test.
// git >= 2.48 creates refs/remotes/origin/HEAD on every fetch (remote.origin.followRemoteHEAD defaults to "create"), older git does not, so for `head: false` the symref is deleted after the fetch
// (--no-deref: a plain `update-ref -d` follows it and deletes origin/main instead) and followRemoteHEAD=never stops later fetches re-creating it (old git ignores the key). Same state on every git version.
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
  else {
    repo.git(['config', 'remote.origin.followRemoteHEAD', 'never']);
    if (repo.git(['for-each-ref', 'refs/remotes/origin/HEAD']).trim()) repo.git(['update-ref', '--no-deref', '-d', 'refs/remotes/origin/HEAD']);
    if (repo.git(['for-each-ref', 'refs/remotes/origin/HEAD']).trim() || !repo.git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).trim()) throw new Error('addOrigin(head:false): origin/HEAD must be absent and origin/' + branch + ' must resolve');
  }
  return bare;
}

// Make every network read of origin fail (an unreachable URL) while the cached refs/remotes/origin/* stay.
export const breakOrigin = (repo) => repo.git(['remote', 'set-url', 'origin', join(tmpdir(), 'cp-no-such-origin-dir.git')]);

// Throwaway git repos for tests. Real git, real commits: the git wrapper's whole job is to parse and hash real git
// output, so a mocked git would prove nothing. Raw `git` (not the wrapper's forced config) so tests can set local
// config such as diff.noprefix and check the wrapper still copes. Inherited GIT_DIR / GIT_INDEX_FILE are scrubbed so a
// run from inside a git hook can never touch the outer repo. Every repo is removed when the test process exits.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run } from '../../pipeline/lib/proc.mjs';

const SCRUBBED = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
];
// undefined values drop the variable from the child's environment (proc.run merges over process.env).
const ENV = Object.fromEntries(SCRUBBED.map((k) => [k, undefined]));

const made = new Set();
function removeDir(dir) {
  made.delete(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
process.on('exit', () => {
  for (const dir of [...made]) removeDir(dir);
});

// Returns { dir, write(rel, content), rm(rel), commit(msg) -> sha, branch(name), checkout(ref), git(args), cleanup() }.
// branch(name) creates AND switches to the branch. git(args) returns raw stdout and throws on a non-zero exit.
export function createTmpRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cp-git-')));
  made.add(dir);

  const git = (args, { input } = {}) => {
    const r = run('git', args, { cwd: dir, env: ENV, input });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  };

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Pipeline Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'tag.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.hooksPath', join(dir, '.git', 'no-hooks')]); // a global pre-commit hook must not run here

  return {
    dir,
    git,
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    rm(rel) {
      rmSync(join(dir, rel), { recursive: true, force: true });
    },
    commit(msg, { allowEmpty = false } = {}) {
      git(['add', '-A']);
      git(['commit', '-q', '-m', msg, ...(allowEmpty ? ['--allow-empty'] : [])]);
      return git(['rev-parse', 'HEAD']).trim();
    },
    branch(name) {
      git(['checkout', '-q', '-b', name]);
    },
    checkout(ref) {
      git(['checkout', '-q', ref]);
    },
    cleanup() {
      removeDir(dir);
    },
  };
}

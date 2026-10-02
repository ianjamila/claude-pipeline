// `pipeline artifacts push`: publishes UI screenshots so a PR body can show them, without touching the caller's
// checkout. Images go to the orphan branch `pipeline-artifacts` (under pr-<N>/), which shares no history with the code,
// are committed in a throwaway worktree, and are pushed to that one ref only. The caller's HEAD, index and branches are
// never changed; the temp worktree is always removed. Exit 0 pushed (or nothing to push), 2 environment/git error.
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { git as gitRun, GitError } from '../lib/git.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';

export const meta = {
  summary: 'publish UI screenshots to the pipeline-artifacts branch and print PR-body markdown',
  usage: 'pipeline artifacts push --pr N --dir DIR [--repo DIR]   -> {ok, files:[{name, markdown}], skipped:[{name, reason}]}   (png/jpg/jpeg/webp/gif, max 20 files, each <= 5 MB)',
};

export const ARTIFACTS_BRANCH = 'pipeline-artifacts';
export const MAX_FILES = 20;
export const MAX_BYTES = 5 * 1024 * 1024;
const REMOTE = 'origin';
const ATTEMPTS = 3; // concurrent pipelines push to the same branch; a lost race is retried on top of the new tip
const IMAGE = /^[^.].*\.(png|jpe?g|webp|gif)$/i;

// The only ref this command may ever write. Asserted right before the push, so a refactor that computes the
// destination differently cannot publish to the default branch.
export function assertSafeTarget(ref) {
  if (ref !== `refs/heads/${ARTIFACTS_BRANCH}`) throw new Error(`refusing to push artifacts to ${JSON.stringify(ref)}: only refs/heads/${ARTIFACTS_BRANCH} is allowed`);
  return ref;
}

// Which files in `dir` get published: image names only, regular files only (a symlink named x.png could point at any
// file the pipeline user can read), each <= MAX_BYTES, at most MAX_FILES (by name). Everything else is reported, not fatal.
export function selectImages(dir) {
  const files = [];
  const skipped = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = entry.name;
    if (!IMAGE.test(name)) {
      skipped.push({ name, reason: 'not an image (png, jpg, jpeg, webp, gif)' });
      continue;
    }
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (!st.isFile()) skipped.push({ name, reason: 'not a regular file (symlinks and directories are never published)' });
    else if (/[\x00-\x1f]/.test(name)) skipped.push({ name, reason: 'unsafe file name' });
    else if (st.size > MAX_BYTES) skipped.push({ name, reason: `larger than ${MAX_BYTES / 1024 / 1024} MB (${st.size} bytes)` });
    else if (files.length >= MAX_FILES) skipped.push({ name, reason: `over the ${MAX_FILES}-file limit` });
    else files.push({ name, abs });
  }
  return { files, skipped };
}

export const markdownFor = ({ slug, pr, name }) =>
  `![${name.replace(/[[\]]/g, '\\$&')}](https://github.com/${slug}/blob/${ARTIFACTS_BRANCH}/pr-${pr}/${encodeURIComponent(name)}?raw=true)`;

const isRaceFailure = (err) => err instanceof GitError && /rejected|non-fast-forward|fetch first|stale info|failed to push some refs/i.test(err.stderr ?? '');

// Commits `files` under pr-<pr>/ on the artifacts branch and pushes it. `gitFn` is injectable for tests.
export function publishArtifacts({ root, pr, files, gitFn = gitRun, tmpBase = tmpdir() }) {
  const g = (args, cwd = root) => gitFn(args, { cwd });
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const holder = mkdtempSync(join(tmpBase, 'cp-artifacts-'));
    const wt = join(holder, 'wt');
    // Local name for a brand-new orphan branch; it is deleted again, so no stray branch is left in the caller's repo.
    const scratch = `pipeline-artifacts-new-${process.pid}-${attempt}`;
    let madeScratch = false;
    try {
      let exists = true;
      try {
        g(['ls-remote', '--exit-code', '--heads', REMOTE, `refs/heads/${ARTIFACTS_BRANCH}`]);
      } catch (err) {
        if (!(err instanceof GitError && err.code === 2)) throw err; // 2 = no such branch; anything else is a real failure
        exists = false;
      }
      if (exists) {
        g(['fetch', REMOTE, `+refs/heads/${ARTIFACTS_BRANCH}:refs/remotes/${REMOTE}/${ARTIFACTS_BRANCH}`]);
        g(['worktree', 'add', '--detach', wt, `${REMOTE}/${ARTIFACTS_BRANCH}`]);
      } else {
        g(['worktree', 'add', '--no-checkout', '--detach', wt]);
        g(['checkout', '--orphan', scratch], wt);
        madeScratch = true;
        g(['rm', '-rf', '--quiet', '--ignore-unmatch', '.'], wt); // the orphan must not inherit the code's files
      }

      const target = join(wt, `pr-${pr}`);
      mkdirSync(target, { recursive: true });
      for (const f of files) copyFileSync(f.abs, join(target, f.name));
      g(['add', '--', `pr-${pr}`], wt);
      if (g(['status', '--porcelain', '--', `pr-${pr}`], wt).trim() === '') {
        return { commit: g(['rev-parse', 'HEAD'], wt).trim(), pushed: false }; // identical files are already published
      }
      // Hooks and signing belong to code commits; this one only adds images to a data branch.
      g(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', `artifacts for #${pr}`], wt);
      const commit = g(['rev-parse', 'HEAD'], wt).trim();
      const pushArgs = ['push', '--no-verify', REMOTE, `HEAD:refs/heads/${ARTIFACTS_BRANCH}`];
      assertSafeTarget(pushArgs.at(-1).split(':').pop());
      g(pushArgs, wt);
      return { commit, pushed: true };
    } catch (err) {
      lastErr = err;
      if (!isRaceFailure(err) || attempt === ATTEMPTS) throw err;
    } finally {
      try { g(['worktree', 'remove', '--force', wt]); } catch { /* never created, or already gone */ }
      rmSync(holder, { recursive: true, force: true, maxRetries: 3 });
      try { g(['worktree', 'prune']); } catch { /* best effort */ }
      if (madeScratch) {
        try { g(['branch', '-D', scratch]); } catch { /* best effort */ }
      }
    }
  }
  throw lastErr;
}

export const run = guarded(async (argv, ctx) => {
  const { values, positionals } = parseCommandArgs(argv, {
    pr: { type: 'string' }, dir: { type: 'string' }, repo: { type: 'string' },
  });
  if (positionals.length !== 1 || positionals[0] !== 'push') throw new UsageError(`usage: ${meta.usage}`);
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const dir = resolve(ctx.cwd, requireOption(values, 'dir'));
  const root = resolveRepo(values, ctx);

  let selected;
  try {
    selected = selectImages(dir);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { exitCode: EXIT.OK, output: { ok: true, files: [], skipped: [], warning: `no such directory: ${dir}` } };
    }
    throw err;
  }
  if (selected.files.length === 0) return { exitCode: EXIT.OK, output: { ok: true, files: [], skipped: selected.skipped } };

  return guardGh(async () => {
    const { slug } = createGitHub({ cwd: root, env: ctx.env }).repo();
    const { commit, pushed } = publishArtifacts({ root, pr, files: selected.files });
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true,
        files: selected.files.map((f) => ({ name: f.name, markdown: markdownFor({ slug, pr, name: f.name }) })),
        skipped: selected.skipped,
        branch: ARTIFACTS_BRANCH,
        commit,
        pushed,
      },
    };
  });
});

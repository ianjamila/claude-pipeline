// `pipeline protect` prints commands for the OWNER to paste into a `!` shell, whose PATH can lack gh (brew's /opt/homebrew/bin).
// So on POSIX the printed line starts with the absolute gh path, quoted for sh with protect's own POSIX `shellWord` (not the
// cmd.exe quoting of proc.mjs), and Windows output is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpRepo } from './helpers/tmprepo.mjs';
import { createFakeGh, pipelineYml, REPO_VIEW } from './helpers/fakegh-env.mjs';
import { buildRequests, ghCommandWord, shellWord, toCommand } from '../pipeline/commands/protect.mjs';

const posixOnly = { skip: process.platform === 'win32' };
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'pipeline', 'bin', 'pipeline.mjs');
const fakeGhMjs = join(here, 'fixtures', 'fake-gh.mjs');

// A directory holding an executable `gh` (a sh script that prints $0 and its stdin-less arguments).
function ghDir(name = 'bin') {
  const dir = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'cp-ghword-'))), name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gh');
  writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$0"\ncat >/dev/null\n');
  chmodSync(file, 0o755);
  return { dir, file };
}

const req = { method: 'PUT', path: 'repos/acme/widgets/branches/main/protection', body: { a: 1 } };

test('ghCommandWord: the resolved absolute gh path on POSIX, quoted only when it has to be', posixOnly, () => {
  const { dir, file } = ghDir();
  assert.equal(ghCommandWord({ PATH: dir }, { fallbackDirs: [] }), file);
  assert.equal(toCommand(req, ghCommandWord({ PATH: dir }, { fallbackDirs: [] })).split(' ')[0], file);
});

test('ghCommandWord: a fallback dir is used when PATH lacks gh (the normal route in a bare `!` shell)', posixOnly, () => {
  const { dir, file } = ghDir();
  const empty = mkdtempSync(join(tmpdir(), 'cp-nopath-'));
  assert.equal(ghCommandWord({ PATH: empty }, { fallbackDirs: [dir] }), file);
  assert.equal(ghCommandWord({}, { fallbackDirs: [dir] }), file, 'no PATH at all');
});

test('ghCommandWord: bare `gh` when nothing is found, on Windows, and when the PIPELINE_GH test seam is set', posixOnly, () => {
  const { dir } = ghDir();
  const empty = mkdtempSync(join(tmpdir(), 'cp-nopath-'));
  assert.equal(ghCommandWord({ PATH: empty }, { fallbackDirs: [] }), 'gh');
  assert.equal(ghCommandWord({ PATH: dir }, { platform: 'win32', fallbackDirs: [] }), 'gh');
  assert.equal(ghCommandWord({ PATH: dir, PIPELINE_GH: 'node /somewhere/fake-gh.mjs' }, { fallbackDirs: [] }), 'gh');
});

test('toCommand: the default word is `gh` (unchanged); a given word leads the line', () => {
  assert.ok(toCommand(req).startsWith("gh api -X PUT repos/acme/widgets/branches/main/protection --input - <<'JSON'\n"));
  assert.ok(toCommand(req, '/opt/homebrew/bin/gh').startsWith("/opt/homebrew/bin/gh api -X PUT "));
});

// The printed word, run through a real sh, names the same path -- spaces, an apostrophe, `$` and `;` included.
test('a gh path with a space, an apostrophe, $ and ; survives a real `sh -c` round trip', posixOnly, () => {
  for (const name of ["with space", "it's", 'dollar$HOME', 'semi;colon', 'all \'of $them; `x` "y"']) {
    const { dir, file } = ghDir(name);
    const word = ghCommandWord({ PATH: dir }, { fallbackDirs: [] });
    assert.equal(word, shellWord(file));
    const command = toCommand(req, word);
    const r = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout.split('\n')[0], file, `${name}: sh ran exactly the file we resolved`);
  }
});

test('shellWord is POSIX quoting: plain words stay bare, anything else is single-quoted with \' escaped', () => {
  assert.equal(shellWord('/opt/homebrew/bin/gh'), '/opt/homebrew/bin/gh');
  assert.equal(shellWord('/a b/gh'), "'/a b/gh'");
  assert.equal(shellWord("/it's/gh"), "'/it'\\''s/gh'");
});

// End to end: the real CLI with a `gh` on PATH (no PIPELINE_GH): every printed command begins with that absolute path.
test('protect (dry run): every printed command starts with the resolved absolute gh path', posixOnly, () => {
  const { dir, file } = ghDir('with space');
  // a gh that is the scripted fake: reads PIPELINE_FAKE_GH_SCRIPT like fixtures/fake-gh.mjs does
  writeFileSync(file, `#!/bin/sh\nexec node "${fakeGhMjs}" "$@"\n`);
  const fake = createFakeGh([
    { match: '^repo view', stdoutJson: REPO_VIEW },
    { match: '^api repos/acme/widgets/branches/main/protection$', code: 1, stderr: 'gh: Branch not protected (HTTP 404)' },
  ]);
  const repo = createTmpRepo();
  repo.write('.claude/pipeline.yml', pipelineYml('github', ['ci']));
  repo.commit('init');
  const env = { ...process.env, PIPELINE_FAKE_GH_SCRIPT: fake.env.PIPELINE_FAKE_GH_SCRIPT, PIPELINE_FAKE_GH_LOG: fake.env.PIPELINE_FAKE_GH_LOG, PATH: `${dir}${path.delimiter}${dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  delete env.PIPELINE_GH;
  delete env.PIPELINE_OFF;
  const r = spawnSync(process.execPath, [bin, 'protect', '--checks', 'ci'], { cwd: repo.dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const json = JSON.parse(r.stdout);
  assert.equal(json.commands.length, 3);
  for (const c of json.commands) assert.ok(c.startsWith(`${shellWord(file)} api -X `), c.split('\n')[0]);
  assert.deepEqual(json.requests, buildRequests({ slug: 'acme/widgets', branch: 'main', checks: ['ci'] }), 'the requests themselves are unchanged');
});

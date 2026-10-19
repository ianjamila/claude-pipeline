// Why (#89 review round 1, Codex items R1-B1 .. R1-B6): six ways a package-manager call reached a script the guards did not judge as the manager runs it.
//   R1-B1  `--script-shell` / `--node-options` on the command line change what runs the script (the same keys are refused in a .npmrc): a mover, refused naming the option.
//   R1-B2  `--ignore-scripts=false` turns the pre / post hooks ON: they are judged (it used to read as "ignore").
//   R1-B3  a workspace package.json (or pnpm-workspace.yaml) the line writes, or creates, before `npm run X -w PKG` reads it: refused like the upward walk's files.
//   R1-B4  a node_modules/.bin script is judged in the caller's directory (a bin runs where the manager runs, not in node_modules/.bin).
//   R1-B5  `yarn workspace NAME SCRIPT ARGS` / `yarn workspaces run SCRIPT ARGS` hand the script its arguments, which are judged with it.
//   R1-B6  `npm --prefix sub exec tool` looks the bin up under the prefix (and, failing closed, under the working directory too).
// Every case has its benign twin. Guarded words are spelled in pieces: the live guard scans files passed to node tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const CL = '.cl' + 'aude';
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';

function fakeFs(root, files) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u'].map((p) => resolve(p)));
  for (const p of Object.keys(F)) for (let d = dirname(p); d !== dirname(d); d = dirname(d)) D.add(d);
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}
// what each guard minds: a whole guarded command, its first half (head) and the words it needs to be complete (tail), and a command it lets through
const G = {
  git: { root: GIT_ROOT, bad: `git ${PUSH} origin ${MAIN}`, head: 'git', tail: `${PUSH} origin ${MAIN}`, run: (cmd, files, o = {}) => {
    const fs = fakeFs(GIT_ROOT, files);
    return evaluateGitCommand(cmd, { cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fs, ...o });
  } },
  files: { root: PROJ, bad: `cp a ~/${CL}/settings.json`, head: 'cp', tail: `a /home/u/${CL}/settings.json`, run: (cmd, files, o = {}) => {
    const fs = fakeFs(PROJ, files);
    return evaluateBashForFiles(cmd, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fs, existsSync: fs.pathExists, ...o });
  } },
};
const pkg = (scripts, extra = {}) => JSON.stringify({ name: 'x', version: '1.0.0', scripts, ...extra });
const sh = (text) => `#!/bin/sh\n${text}\n`;
// `tree(g)` -> files for guard g (g.bad ... available)
const verdicts = (cmd, tree) => Object.fromEntries(Object.entries(G).map(([n, g]) => [n, g.run(cmd, tree(g))]));
const denied = (cmd, tree, re) => {
  for (const [n, v] of Object.entries(verdicts(cmd, tree))) {
    assert.equal(v.decision, 'deny', `${n}: ${cmd} -> allowed`);
    if (re) assert.match(v.reason, re, `${n}: ${cmd}`);
  }
};
const allowed = (cmd, tree) => { for (const [n, v] of Object.entries(verdicts(cmd, tree))) assert.equal(v.decision, 'allow', `${n}: ${cmd} -> ${v.reason}`); };

test('R1-B1 --script-shell and --node-options on the command line are movers (as in a .npmrc), refused naming the option', () => {
  const tree = () => ({ 'package.json': pkg({ lint: 'echo hi' }), 'evil.sh': 'x' });
  for (const cmd of ['npm run lint --script-shell ./evil.sh', 'npm run lint --script-shell=./evil.sh', 'npm --script-shell ./evil.sh run lint', 'npm --script-shell=./evil.sh run lint', 'npm run lint --node-options=--require=./x.js', 'npm --node-options --require=./x.js run lint', 'npm test --script-shell=./evil.sh']) {
    denied(cmd, tree, /--(?:script-shell|node-options)/);
  }
  // the message names the option that was used, not the config-file pair
  denied('npm run lint --script-shell ./evil.sh', tree, /--script-shell/);
  denied('npm run lint --node-options=--inspect', tree, /--node-options/);
  // twins: the same call without them, and the option as the script's own argument after `--`
  allowed('npm run lint', tree);
  allowed('npm run lint --silent', tree);
  allowed('npm run lint -- --script-shell ./evil.sh', tree);
});

test('R1-B2 --ignore-scripts=false keeps the pre / post hooks (they are judged); true / bare drops them', () => {
  const tree = (g) => ({ 'package.json': pkg({ prelint: g.bad, lint: 'echo hi' }) });
  denied('npm run lint', tree);
  denied('npm run lint --ignore-scripts=false', tree);
  denied('npm run lint --ignore-scripts=0', tree);
  denied('npm run lint --ignore-scripts=false --if-present', tree);
  denied('npm run lint --ignore-scripts --ignore-scripts=false', tree);
  denied('npm test --ignore-scripts=false', (g) => ({ 'package.json': pkg({ pretest: g.bad, test: 'echo hi' }) }));
  allowed('npm run lint --ignore-scripts', tree);
  allowed('npm run lint --ignore-scripts=true', tree);
  allowed('npm run lint --ignore-scripts=1', tree);
  allowed('npm run lint --ignore-scripts --ignore-scripts=true', tree);
});

test('R1-B3 a workspace package.json the line writes or creates before the manager reads it is refused', () => {
  const ws = { workspaces: ['packages/*'] };
  const tree = (g) => ({ 'package.json': pkg({}, ws), 'packages/a/package.json': pkg({ lint: 'echo hi' }), 'replacement.json': pkg({ lint: g.bad }) });
  denied('cp replacement.json packages/a/package.json && npm run lint -w ./packages/a', tree, /writes .*package\.json/);
  denied('cp replacement.json packages/a/package.json && npm run lint --workspaces', tree, /writes .*package\.json/);
  denied('cp replacement.json packages/a/package.json && npm run lint -w packages/a', tree, /writes .*package\.json/);
  // a package.json the line CREATES in a workspace directory that has none yet
  const created = (g) => ({ 'package.json': pkg({}, { workspaces: ['packages/b'] }), 'packages/a/package.json': pkg({ lint: 'echo hi' }), 'replacement.json': pkg({ lint: g.bad }) });
  denied('cp replacement.json packages/b/package.json && npm run lint -w packages/b', created, /writes .*package\.json/);
  const createdGlob = (g) => ({ ...tree(g), 'packages/b/keep': 'x' });
  denied('cp replacement.json packages/b/package.json && npm run lint -w packages/b', createdGlob, /writes .*package\.json/);
  // the workspace list itself: a pnpm-workspace.yaml and the root package.json the line writes
  const pnpm = (g) => ({ 'package.json': pkg({}), 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n', 'packages/a/package.json': pkg({ lint: 'echo hi' }), 'other.yaml': `packages:\n  - "packages/*"\n# ${g.bad}\n` });
  denied('cp other.yaml pnpm-workspace.yaml && pnpm --filter a run lint', pnpm, /writes .*pnpm-workspace\.yaml/);
  // twins: a write to something else, and the plain workspace call
  allowed('npm run lint -w ./packages/a', tree);
  allowed('echo hi > notes.txt && npm run lint -w ./packages/a', tree);
  allowed('cp replacement.json packages/a/notes.json && npm run lint -w ./packages/a', tree);
  allowed('cp replacement.json packages/b/notes.json && npm run lint -w ./packages/a', (g) => ({ ...tree(g), 'packages/b/keep': 'x' }));
});

test('R1-B4 a node_modules/.bin script is judged in the caller\'s directory, not node_modules/.bin (both guards)', () => {
  const tree = (g) => ({ 'package.json': pkg({ lint: 'tool' }), 'node_modules/.bin/tool': sh('bash run.sh'), 'run.sh': sh(g.bad) });
  denied('npm run lint', tree);
  denied('pnpm run lint', tree);
  denied('yarn tool', (g) => ({ 'package.json': pkg({}), 'node_modules/.bin/tool': sh('bash run.sh'), 'run.sh': sh(g.bad) }));
  denied('npx tool', tree);
  // twin: the run.sh the project holds is harmless (a bad one sitting next to the bin is not what runs)
  allowed('npm run lint', (g) => ({ ...tree(g), 'run.sh': sh('echo hi'), 'node_modules/.bin/run.sh': sh(g.bad) }));
  allowed('yarn tool', (g) => ({ 'package.json': pkg({}), 'node_modules/.bin/tool': sh('bash run.sh'), 'run.sh': sh('echo hi'), 'node_modules/.bin/run.sh': sh(g.bad) }));
});

test('R1-B5 yarn workspace NAME SCRIPT ARGS and yarn workspaces run SCRIPT ARGS hand the script its arguments, judged with it', () => {
  const ws = { workspaces: ['a'] };
  const tree = (g) => ({ 'package.json': pkg({}, ws), 'a/package.json': pkg({ ship: g.head }) });
  const words = (g) => g.tail;
  for (const [n, g] of Object.entries(G)) {
    for (const cmd of [`yarn workspace a ship ${words(g)}`, `yarn workspace a run ship ${words(g)}`, `yarn workspaces run ship ${words(g)}`, `yarn workspaces foreach run ship ${words(g)}`, `yarn workspace a ship -- ${words(g)}`]) {
      assert.equal(g.run(cmd, tree(g)).decision, 'deny', `${n}: ${cmd}`);
    }
  }
  // twins: the same call with a script that is harmless, and arguments that complete nothing guarded
  const fine = () => ({ 'package.json': pkg({}, ws), 'a/package.json': pkg({ ship: 'echo' }) });
  allowed('yarn workspace a ship hello world', fine);
  allowed('yarn workspace a run ship hello', fine);
  allowed('yarn workspaces run ship hello', fine);
  // the script name is still found among the words (a workspace NAME is not a script)
  denied('yarn workspace a ship', (g) => ({ 'package.json': pkg({}, ws), 'a/package.json': pkg({ ship: g.bad }) }));
  denied('yarn workspaces run ship', (g) => ({ 'package.json': pkg({}, ws), 'a/package.json': pkg({ ship: g.bad }) }));
});

test('R1-B6 npm --prefix sub exec TOOL looks the bin up under the prefix (and the working directory), keeping the caller\'s directory to run in', () => {
  const inSub = (g) => ({ 'sub/package.json': pkg({}), 'sub/node_modules/.bin/tool': sh(g.bad) });
  const inCwd = (g) => ({ 'sub/package.json': pkg({}), 'node_modules/.bin/tool': sh(g.bad) });
  for (const cmd of ['npm --prefix sub exec tool', 'npm --prefix sub exec -- tool', 'npm exec --prefix sub tool', 'npm exec tool --prefix sub', 'npm --prefix=sub exec tool', 'npx --prefix sub tool', 'npm exec --prefix sub -- tool']) {
    denied(cmd, inSub);
    denied(cmd, inCwd); // (unsure where npm looks: both chains)
  }
  // a prefix outside the working directory: the working directory's bins are looked at too
  denied('npm --prefix /elsewhere exec tool', inCwd);
  denied('npx --prefix /elsewhere tool', inCwd);
  // the bin the prefix holds runs the project's run.sh from the working directory
  const relative = (g) => ({ 'sub/package.json': pkg({}), 'sub/node_modules/.bin/tool': sh('bash run.sh'), 'run.sh': sh(g.bad) });
  denied('npm --prefix sub exec tool', relative);
  // twins: harmless bins in either place
  const fine = () => ({ 'sub/package.json': pkg({}), 'sub/node_modules/.bin/tool': sh('echo hi'), 'node_modules/.bin/tool': sh('echo hi') });
  allowed('npm --prefix sub exec tool', fine);
  allowed('npm exec tool', fine);
  allowed('npm exec tool', (g) => ({ 'sub/package.json': pkg({}), 'sub/node_modules/.bin/tool': sh(g.bad), 'node_modules/.bin/tool': sh('echo hi') }));
});

// ---- follow-up to R1-B1 / R1-B2 (controller's security note) -------------------------------------------------------------------
import { RC_REFUSED } from '../pipeline/hooks/lib/package-scripts.mjs';

test('R1-B1b the CLI movers are the SAME set a .npmrc is refused for, in every spelling npm reads (underscores, case, --no-, unique abbreviations)', () => {
  const tree = () => ({ 'package.json': pkg({ lint: 'echo hi' }) });
  const modeled = new Set(['workspace', 'workspaces', 'include-workspace-root']); // (workspace selectors: read and followed, not refused)
  const keys = [...RC_REFUSED].filter((k) => !modeled.has(k));
  assert.ok(keys.length >= 6, 'the shared set is not empty');
  for (const k of keys) {
    for (const spelled of [k, k.toUpperCase(), k.replaceAll('-', '_')]) {
      denied(`npm run lint --${spelled}=x`, tree, /--/);
      denied(`npm run lint --${spelled} x`, tree);
      denied(`npm --${spelled}=x run lint`, tree);
      denied(`npm --${spelled} x run lint`, tree);
    }
    denied(`npm run lint --no-${k}`, tree);
    denied(`npm --no-${k} run lint`, tree);
  }
  // a unique abbreviation of the name (nopt reads it as the option)
  for (const cmd of ['npm run lint --script-sh ./e', 'npm run lint --node-opt=--inspect', 'npm run lint --userconf=./rc', 'npm run lint --globalconf ./rc', 'npm --onload-s ./x run lint', 'npm --script-s ./e run lint']) denied(cmd, tree);
  // twins: options the tables know stay as they were (--global is a prefix of --globalconfig, but it is its own option)
  allowed('npm run lint --global', tree);
  allowed('npm run lint --silent --if-present', tree);
  allowed('npm --silent run lint', tree);
  allowed('npm run lint -- --script_shell x', tree);
});

test('R1-B1c an option the tables do not know is refused when a word follows it (it may take that word), and passes as a flag when none does', () => {
  const tree = () => ({ 'package.json': pkg({ lint: 'echo hi' }) });
  denied('npm run lint --frobnicate x', tree);
  denied('npm --frobnicate run lint', tree);
  denied('npm test --frobnicate x', tree);
  allowed('npm run lint --frobnicate', tree);
  allowed('npm run lint --frobnicate -- x', tree);
  allowed('npm run lint --frobnicate=1', tree);
});

test('R1-B2b --ignore-scripts is ignored only for a value that is certainly true; empty, no, null, 0 forms and a following false judge the hooks', () => {
  const tree = (g) => ({ 'package.json': pkg({ prelint: g.bad, lint: 'echo hi' }) });
  for (const v of ['', 'false', 'FALSE', '0', '00', '0.0', 'null', 'no', 'off', 'yes', 'on']) denied(`npm run lint --ignore-scripts=${v}`, tree);
  for (const v of ['', 'false', '0', 'no']) denied(`npm --ignore-scripts=${v} run lint`, tree);
  denied('npm run lint --ignore-scripts false', tree);
  denied('npm --ignore-scripts false run lint', tree);
  denied('npm run lint --ignore-scripts --no-ignore-scripts', tree);
  for (const v of ['true', 'TRUE', '1']) allowed(`npm run lint --ignore-scripts=${v}`, tree);
  allowed('npm run lint --ignore-scripts true', tree);
  allowed('npm --ignore-scripts run lint', tree);
});

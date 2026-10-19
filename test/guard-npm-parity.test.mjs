// Why (#89 t2): the package-manager script opening (#81 t9 / t11) judged `npm run NAME` like `bash -c TEXT`, but its "package state" tracking was stricter than the rule both guards already apply to a
// plain script file: a `git checkout`, a `git worktree add`, a `tar x`, a background job, an unknown `cp` target, an unmodelled program writing some other file made the NEXT `npm test` unknown and refused,
// while `git checkout other && bash run.sh` is allowed. A 21-day replay of real commands showed ~300 such new refusals. The parity rule these tests hold:
//   the files a package manager reads (package.json on the way up, the rc files, node_modules, server.js, binding.gyp, pnpm-workspace.yaml) are treated like a script file:
//   refused when the line WRITES them ('known': a write the guard places, or a path the line names: rm -rf node_modules, mv package.json x), or MAY write them ('maybe': a target only known at run time)
//   AND the line mentions a guarded operation. A git work tree change, a background job or a bulk writer (tar, rsync, patch ...) earlier on the line changes none of that.
// The manager's own writes (npm pkg set, npm config set, npm init ...) stay known changes. Every loosening has its malicious twin below (the same shape with a guarded script, a literal write, a maybe-writer + mention).
// Guarded names are spelled in pieces (as test/guard-npm-scripts.test.mjs does): the live guard scans files passed to node tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const PUSH = 'pu' + 'sh';
const MAIN = 'ma' + 'in';
const CL = '.cl' + 'aude';
const BAD_GIT = `git ${PUSH} origin ${MAIN}`;
const BAD_FILES = `cp a ~/${CL}/settings.json`;
const MENTION_GIT = `echo ${PUSH}`;
const MENTION_FILES = `echo ${CL}`;

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, '/home/u', ...dirs.map(abs)].map((p) => resolve(p)));
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
const GIT_ROOT = '/work/repo';
const PROJ = '/home/u/proj';
const git = (command, files, o = {}) => {
  const { cwd = GIT_ROOT, ...rest } = o;
  const fs = fakeFs(GIT_ROOT, files);
  return evaluateGitCommand(command, { cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], realpath: (p) => p, ...fs, ...rest });
};
const filesGuard = (command, files, o = {}) => {
  const { cwd = PROJ, ...rest } = o;
  const fs = fakeFs(PROJ, files);
  return evaluateBashForFiles(command, { home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd, ...fs, existsSync: fs.pathExists, ...rest });
};
const pkg = (scripts) => JSON.stringify({ name: 'x', version: '1.0.0', scripts });
const GOOD = { lint: 'echo hi', test: 'echo hi', build: 'echo hi', start: 'echo hi' };
// the project as each guard sees it: `bad` puts the guarded command into the script `test` / `start`
const tree = (extra = {}, bad = null) => ({ 'package.json': pkg(bad ? { ...GOOD, test: bad, start: bad, build: bad } : GOOD), ...extra });
const both = (cmd, extra = {}) => ({ git: git(cmd, tree(extra)), files: filesGuard(cmd, tree(extra)) });
const allowed = (cmd, extra) => {
  const r = both(cmd, extra);
  assert.equal(r.git.decision, 'allow', `git: ${cmd} -> ${r.git.reason}`);
  assert.equal(r.files.decision, 'allow', `files: ${cmd} -> ${r.files.reason}`);
};
const refused = (cmd, extra) => {
  const r = both(cmd, extra);
  assert.equal(r.git.decision, 'deny', `git: ${cmd} -> allowed`);
  assert.equal(r.files.decision, 'deny', `files: ${cmd} -> allowed`);
  return r;
};
// the same line when package.json's script holds a guarded command
const refusedBadScript = (cmd, extra) => {
  assert.equal(git(cmd, tree(extra, BAD_GIT)).decision, 'deny', `git (guarded script): ${cmd} -> allowed`);
  assert.equal(filesGuard(cmd, tree(extra, BAD_FILES)).decision, 'deny', `files (guarded script): ${cmd} -> allowed`);
};
// a line that mentions a guarded operation, per guard (the git guard's words differ from the files guard's)
const withMention = (cmd) => ({ git: `${cmd}; ${MENTION_GIT}`, files: `${cmd}; ${MENTION_FILES}` });
const refusedWithMention = (cmd, extra) => {
  const m = withMention(cmd);
  assert.equal(git(m.git, tree(extra)).decision, 'deny', `git (mention): ${m.git} -> allowed`);
  assert.equal(filesGuard(m.files, tree(extra)).decision, 'deny', `files (mention): ${m.files} -> allowed`);
};
const allowedWithMention = (cmd, extra) => {
  const m = withMention(cmd);
  assert.equal(git(m.git, tree(extra)).decision, 'allow', `git (mention): ${m.git}`);
  assert.equal(filesGuard(m.files, tree(extra)).decision, 'allow', `files (mention): ${m.files}`);
};

// Work-tree changes earlier on the line, a bulk writer, a background job: judged exactly as `bash run.sh` is, with and without a mention of a guarded operation
const TREE_CHANGES = ['git checkout other', 'git switch -c y', 'git pull --ff-only', 'git merge x', 'git rebase x', 'git stash pop', 'git reset --hard', 'git cherry-pick abc', 'git apply p.diff', 'git clone u d', 'git -C sub checkout x',
  'git worktree add -b x .worktrees/x origin/main && cd .worktrees/x'];
const BULK = ['tar xf a.tgz', 'unzip a.zip', 'patch -p1 -i p.diff', 'rsync -a src/ .'];
const PLAIN = { 'run.sh': 'echo hi\n' };
// the verdict of `PRELUDE && npm test` equals the verdict of `PRELUDE && bash run.sh` (both guards, with and without a guarded mention); returns the git and files verdicts of the npm line
function sameAsPlainScript(prelude) {
  for (const mention of [false, true]) {
    const m = (s) => (mention ? withMention(s) : { git: s, files: s });
    const npm = m(`${prelude} && npm test`);
    const plain = m(`${prelude} && bash run.sh`);
    const gn = git(npm.git, tree(PLAIN)).decision;
    const gp = git(plain.git, tree(PLAIN)).decision;
    assert.equal(gn, gp, `git: \`${npm.git}\` is ${gn}, but the same with bash run.sh is ${gp}`);
    const fn = filesGuard(npm.files, tree(PLAIN)).decision;
    const fp = filesGuard(plain.files, tree(PLAIN)).decision;
    assert.equal(fn, fp, `files: \`${npm.files}\` is ${fn}, but the same with bash run.sh is ${fp}`);
  }
}

test('t2 a git work tree change earlier on the line does not make `npm test` unknown (like `bash run.sh`)', () => {
  for (const b of TREE_CHANGES) {
    for (const sep of ['&&', ';']) {
      allowed(`${b} ${sep} npm test`);
      allowed(`${b} ${sep} npm run lint`);
      allowed(`${b} ${sep} npm ci`);
      if (!b.includes('worktree')) assert.equal(git(`${b} ${sep} bash run.sh`, PLAIN).decision, 'allow', `main allows the plain script: ${b}`);
    }
    if (!b.includes(' -C ')) sameAsPlainScript(b); // (a manager starts in the shell's directory, not in a `git -C` one: the plain script is also looked up there)
  }
  for (const b of TREE_CHANGES.filter((x) => !x.includes('worktree'))) allowedWithMention(`${b} && npm test`); // (a mention alone is no reason: nothing was written)
  allowed('git worktree add -b x .worktrees/x origin/main && cd .worktrees/x && npm ci');
  allowed('git pull --ff-only && npm run build');
});
test('t2 twins of the work tree changes: a guarded script, a literal write, a maybe-writer with a mention stay refused', () => {
  for (const b of TREE_CHANGES) {
    refusedBadScript(`${b} && npm test`);
    if (!b.includes('worktree')) refusedBadScript(`${b} ; npm run build`); // (after a `cd` that may not have happened the directory is unknown, as for a plain script)
    refused(`${b} && echo '{}' > package.json && npm test`);
    refused(`${b} && printf 'script-shell=/e/sh' > .npmrc && npm test`);
    refused(`${b} && rm -f package.json && npm test`);
    refused(`${b} && mv package.json p.old && npm test`);
    refusedWithMention(`${b} && cp x $T && npm test`); // (a copy to a place only known at run time may be package.json)
  }
  // a git worktree add of the directory the manager then runs in writes a package.json there: a maybe, refused with a mention (as for `bash run.sh` in it)
  refusedWithMention('git worktree add -b x .worktrees/x origin/main && cd .worktrees/x && npm test');
});

test('t2 a bulk writer earlier on the line does not make `npm test` unknown; its maybe-write + a mention does, as for a plain script', () => {
  for (const b of BULK) {
    allowed(`${b} && npm test`);
    allowed(`${b}; npm run lint`);
    sameAsPlainScript(b);
    refusedBadScript(`${b} && npm test`);
    refused(`${b} && cp evil.json package.json && npm test`);
    refused(`${b} && echo 'node-options=--require /e/x.js' >> .npmrc && npm run lint`);
    refused(`${b} && mv package.json p.old && npm test`);
    refusedWithMention(`${b} && cp x $T && npm test`);
  }
  // the bulk writer's own maybe: refused with a mention (the git guard reads `push`, the files guard a protected path), exactly where `bash run.sh` is
  refusedWithMention('tar xf a.tgz && npm test');
});

test('t2 a background job is no reason: `nohup npm start > log 2>&1 &` and a job racing a git command run what package.json says', () => {
  for (const cmd of ['nohup npm start > log 2>&1 &', 'npm start > log 2>&1 &', 'npm run lint & git checkout x', 'git pull & npm test', '(git checkout x &) ; npm run lint', 'npm test & wait', 'git checkout x & npm run lint & wait']) allowed(cmd);
  for (const cmd of ['nohup npm start > log 2>&1 &', 'npm run lint & git checkout x', 'npm test & wait']) allowedWithMention(cmd);
  // twins: the job's script is guarded; a job that writes package.json / the rc file; a maybe-writer
  refusedBadScript('nohup npm start > log 2>&1 &');
  refusedBadScript('npm run build & git checkout x');
  refusedBadScript('git pull & npm test');
  refused(`(echo '{}' > package.json &) ; npm test`);
  refused(`echo 'script-shell=/e/sh' > .npmrc & npm test`);
  refused('mv package.json p.old & npm test');
  refusedWithMention('(cp x $T &) ; npm test');
});

test('t2 an unknown cp / mv / touch target is only a maybe: refused with a guarded mention, not without', () => {
  for (const b of ['cp $F x.bak', 'cp $F $TMPDIR/b.bak', 'mv $A $B', 'touch $F', 'mkdir -p $D', 'ln -s $F l', 'cp -r $D out']) {
    allowed(`${b} && npm test`);
    allowed(`${b}; npm run lint`);
    refusedWithMention(`${b} && npm test`);
    refusedBadScript(`${b} && npm test`);
  }
  // a path the line names is not unknown: a literal marker is a known change
  for (const lit of ['rm -f package.json', 'rm -rf package.j*', 'mv package.json x', 'cp evil.json package.json', 'cp evil.json ./package.json', 'ln -sf evil.json package.json', 'touch server.js', 'cp rc .npmrc', 'rm .npmrc']) {
    refused(`${lit} && npm test`);
    refused(`${lit}; npm run lint`);
  }
  // a marker below a directory only known at run time is a maybe too
  for (const lit of ['rm -f $D/package.json', 'mv $D/package.json x', 'touch $D/server.js']) {
    allowed(`${lit} && npm test`);
    refusedWithMention(`${lit} && npm test`);
  }
  // a copy to a place only known at run time, from a file that holds a guarded command: the content is judged whatever the line says (the line itself mentions nothing)
  assert.equal(git('cp evil.json $T && npm test', tree({ 'evil.json': pkg({ test: BAD_GIT }) })).decision, 'deny', 'git: a guarded script in the file that may land in package.json');
  assert.equal(filesGuard('cp evil.json $T && npm test', tree({ 'evil.json': pkg({ test: BAD_FILES }) })).decision, 'deny', 'files: a protected path in the file that may land in package.json');
  assert.equal(git('cp evil.json $T && npm test', tree({ 'evil.json': pkg({ test: 'echo hi' }) })).decision, 'allow', 'a harmless file');
  // an unknown name in the same command as a literal marker: the literal one is still known
  refused('cp $F package.json && npm test');
  // a node_modules folder next to the package.json changes nothing when it goes; one that appears only hides the package.json above it (judged anyway); copying INTO a directory is no change of the directory
  for (const ok of ['rm -rf node_modules && npm test', 'ln -s /x/prettier node_modules/prettier && npm test', 'mkdir -p node_modules && npm test', 'cp -r nm node_modules && npm test', 'cp ../foundation/.env.local . && npm ci', 'cp .env.local ../x/ && npm ci', 'mv a.txt .. && npm test', 'rm -rf node_modules/.cache && npm test']) allowed(ok);
  // ... but one that goes where it hid the package.json above it exposes that project: a known change (cwd sub: node_modules, no package.json)
  const hidden = { 'sub/node_modules/x/index.js': 'x' };
  for (const cmd of ['rm -rf node_modules && npm test', 'mv node_modules nm && npm test']) {
    assert.equal(git(cmd, tree(hidden), { cwd: '/work/repo/sub' }).decision, 'deny', `git: ${cmd}`);
    assert.equal(filesGuard(cmd, tree(hidden), { cwd: '/home/u/proj/sub' }).decision, 'deny', `files: ${cmd}`);
  }
  assert.equal(git('mkdir -p node_modules && npm test', tree(hidden), { cwd: '/work/repo/sub' }).decision, 'allow', 'one that appears hides the project above: nothing runs');
  assert.equal(git('rm -rf node_modules/x && npm test', tree(hidden), { cwd: '/work/repo/sub' }).decision, 'allow', 'a file below it going leaves the folder');
});

test('t2 an unmodelled program that writes another file does not make a missing rc file a maybe (as for an existing run.sh)', () => {
  const prog = `node -e "require('fs').write${'File'}Sync('out.txt','x')" out.txt`;
  allowed(`${prog} && npm test`);
  allowedWithMention(`${prog} && npm test`);
  sameAsPlainScript(prog);
  allowedWithMention(`${prog} && npm test`, { '.npmrc': 'registry=https://r.example\n' });
  // twins: the rc file written literally first, a guarded script, an existing rc file that sets the shell, a maybe-writer
  refused(`printf 'script-shell=/e/sh' > .npmrc && ${prog} && npm test; ${MENTION_GIT} ${MENTION_FILES}`);
  refusedBadScript(`${prog} && npm test`);
  refused(`${prog} && npm test`, { '.npmrc': 'script-shell=/e/sh\n' });
  refusedWithMention(`${prog} && cp x $T && npm test`);
});

test('t2 the manager\'s own writes stay known changes (no mention needed)', () => {
  for (const b of ['npm pkg set scripts.lint=x', 'npm set-script lint x', 'npm init -y', 'npm create vite', 'npm link', 'pnpm pkg set a=b', 'yarn config set x y', 'yarn set version berry', 'npm config set script-shell /bin/x', 'npm config delete prefix', 'npm config edit']) {
    for (const sep of ['&&', ';']) refused(`${b} ${sep} npm run lint`);
  }
  refused('npm run lint --userconfig /e/rc');
  refused('npm_config_prefix=/e npm run lint');
  assert.equal(git('npm ci && npx tool; echo ' + PUSH, tree()).decision, 'deny', 'an install may add a bin; the line mentions a guarded operation');
  assert.equal(git('npm ci && npx tool', tree()).decision, 'allow');
});

test('t2 npx of a bin that is a program in another language is not opened as a shell script, whatever the line writes to other files', () => {
  const JS = "#!/usr/bin/env node\nimport './dist/cli.js'\n";
  const bin = { 'node_modules/.bin/vitest': JS, 'lib/x.ts': 'export const a = 1;\n' };
  const W = GIT_ROOT;
  // (a text a heredoc appends to another file, a copy back from a backup: none of it is the bin)
  const heredoc = `cd ${W} && F=lib/x.ts; B=/tmp/q.bak; cp $F $B\ncat >> $F <<'EOF2'\n// eslint-disable-next-line\nasync function f<T>(ids: string[], q: any): Promise<T[]> { try { return await g<T>(ids, q) } catch { return [] } }\nEOF2\nsed -i '' "s/a/b/" $F\nnpx vitest run lib/x.test.ts 2>&1 | grep -E "Tests "; cp $B $F`;
  const replay = `cd ${W} && F=lib/x.ts; cp $F $TMPDIR/b.bak; sed -i '' 's/a/b/' $F; npx vitest run __tests__/x.test.ts 2>&1 | grep -E "Tests "; cp $TMPDIR/b.bak $F`;
  for (const cmd of [heredoc, replay, 'npx vitest run x', 'yarn vitest x', 'pnpm exec vitest run x']) {
    const g = git(cmd, tree(bin), { cwd: '/' });
    assert.equal(g.decision, 'allow', `git: ${cmd.slice(0, 60)} -> ${g.reason}`);
    assert.equal(filesGuard(cmd, tree(bin)).decision, 'allow', `files: ${cmd.slice(0, 60)}`);
  }
  // a bin without a shebang line is run by sh, whatever it is called or leads to (the kernel looks at the first bytes only: ENOEXEC, then sh): a link to a .mjs file is opened as a shell script (test/guard-npm-bins.test.mjs)
  const toMjs = (p) => (p.endsWith('.bin/vitest') ? p.replace(/node_modules\/.bin\/vitest$/, 'node_modules/vitest/vitest.mjs') : p);
  assert.equal(git('npx vitest run x', tree({ 'node_modules/.bin/vitest': `${BAD_GIT}\n` }), { realpath: toMjs }).decision, 'deny');
  assert.equal(git('npx vitest run x', tree({ 'node_modules/.bin/vitest': `${BAD_GIT}\n` })).decision, 'deny');
  assert.equal(filesGuard('npx vitest run x', tree({ 'node_modules/.bin/vitest': `${BAD_FILES}\n` }), { realpath: (p) => toMjs(p).replace('/work/repo', PROJ) }).decision, 'deny');
  assert.equal(filesGuard('npx vitest run x', tree({ 'node_modules/.bin/vitest': `${BAD_FILES}\n` })).decision, 'deny');
  // twins: a shell-script bin with a guarded command; a bin the line replaces with one; a shell bin that is also rewritten by a loose write
  assert.equal(git('npx vitest run x', tree({ 'node_modules/.bin/vitest': `#!/bin/sh\n${BAD_GIT}\n` })).decision, 'deny');
  assert.equal(git('npx vitest run x', tree({ 'node_modules/.bin/vitest': `echo hi\n` })).decision, 'allow', 'a shell script without a guarded command');
  assert.equal(git(`printf '#!/bin/sh\\n${BAD_GIT}\\n' > node_modules/.bin/vitest && npx vitest run x`, tree(bin)).decision, 'deny', 'the line replaces the program with a shell script');
  assert.equal(git(`cp evil.sh node_modules/.bin/vitest && npx vitest run x`, tree({ ...bin, 'evil.sh': `#!/bin/sh\n${BAD_GIT}\n` })).decision, 'deny', 'a copy of a guarded script over the bin');
  assert.equal(filesGuard('npx vitest run x', tree({ 'node_modules/.bin/vitest': `#!/bin/sh\n${BAD_FILES}\n` })).decision, 'deny');
});

test('t2 (security) a package.json the line only MAY write does not hide the one above it: the project that runs if the write does not happen is judged', () => {
  const sub = { 'sub/x.txt': 'x' };
  const inSub = (cmd, bad, o = {}) => ({
    git: git(cmd, { ...tree(sub, bad ? BAD_GIT : null) }, { cwd: '/work/repo/sub', ...o }),
    files: filesGuard(cmd, { ...tree(sub, bad ? BAD_FILES : null) }, { cwd: '/home/u/proj/sub', ...o }),
  });
  for (const cmd of ['cp x $T && npm test', 'tar xf a.tgz && npm test', 'git worktree add -b x w origin/main && cd w && npm test']) {
    const bad = inSub(cmd.replace('cd w && ', ''), true);
    assert.equal(bad.git.decision, 'deny', `git: ${cmd} -> allowed`);
    assert.equal(bad.files.decision, 'deny', `files: ${cmd} -> allowed`);
    const ok = inSub(cmd.replace('cd w && ', ''), false);
    assert.equal(ok.git.decision, 'allow', `git: ${cmd} -> ${ok.git.reason}`);
    assert.equal(ok.files.decision, 'allow', `files: ${cmd} -> ${ok.files.reason}`);
  }
  // the bin above a directory where the line may write one is judged too (and the maybe itself needs a mention to be refused)
  const bins = { 'node_modules/.bin/tool': `#!/bin/sh\n${BAD_GIT}\n`, 'sub/x.txt': 'x' };
  assert.equal(git('cp x $T && npx tool', { ...tree(bins) }, { cwd: '/work/repo/sub' }).decision, 'deny', 'the bin of the directory above is what runs');
});

import { pmCall } from '../pipeline/hooks/lib/package-scripts.mjs';
test('t2 (security) every script that gates a package-manager call is one of the scripts judged for it (nothing runs that is not judged)', () => {
  const lines = ['npm run a', 'npm run-script a -- --x', 'npm test', 'npm t', 'npm start', 'npm stop', 'npm restart', 'npm install', 'npm ci', 'npm i', 'npm pack', 'npm publish', 'npm version patch', 'npm rebuild', 'npm ins', 'npm isnt x',
    'npm audit fix', 'npm run a --workspaces', 'npm run a --ignore-scripts', 'npm test --ignore-scripts', 'npm install --ignore-scripts', 'pnpm a', 'pnpm run a', 'pnpm deploy', 'pnpm install', 'pnpm -r run a', 'yarn a', 'yarn', 'yarn run a', 'yarn install',
    'yarn workspace w a', 'yarn workspaces run a', 'bun run a', 'bun start', 'corepack pnpm a', 'npm --prefix sub run a', 'npm run a -w w'];
  for (const l of lines) {
    const call = pmCall(l.split(' '));
    if (!call) continue;
    for (const g of call.gate) assert.ok(call.names.includes(g), `${l}: gate script ${g} is not among the judged scripts ${call.names.join(',')}`);
  }
});

test('t2 (regression) an unmodelled command with a run-time argument is no known write of package.json (with a node_modules folder present)', () => {
  // (the package.json itself holds words the guards mind -- a dependency called tailwind-merge, a note about install.md -- as real ones do: its own current text is no write)
  const nm = { 'node_modules/.keep': '', 'package.json': JSON.stringify({ name: 'x', scripts: GOOD, dependencies: { ['tailwind-me' + 'rge']: '^3' }, note: 'see install.md' }) };
  for (const pre of ['lsof -p $pid', '[ -n "$pid" ] && lsof -a -p $pid -d cwd -Fn | tail -1', 'lsof -p 12', 'kill $pid', 'ls $pid']) {
    allowed(`${pre}; npm run build`, nm);
    allowed(`${pre} && npm test`, nm);
  }
  // a program we do not model that is handed package.json and a lock file (words the guards mind inside) does not copy the lock file over package.json
  const lock = { ...nm, 'package-lock.json': JSON.stringify({ name: 'x', packages: { ['node_modules/tailwind-me' + 'rge']: { note: 'see install.md' } } }) };
  for (const pre of ['mytool package-lock.json package.json', 'git diff --name-only HEAD -- package-lock.json package.json | head', 'mytool -o package.json --from package-lock.json']) allowed(`${pre}; npm run build`, lock);
  refused('cp package-lock.json package.json; npm run build', lock); // (a copy that names both: the lock file is what runs)
  refused('mv package-lock.json package.json; npm run build', lock);
  refused('cat package-lock.json > package.json; npm run build', lock);
  // an append to a file only known at run time: package.json's own words in front of it are not the appended text
  for (const pre of ["printf '\\nok\\n' >> $T", "echo ok >> $T/x.ts", "F=a.ts; cp $F b.bak; printf '\\nok\\n' >> $F; cp b.bak $F"]) allowed(`${pre}; npm run build`, nm);
  refused(`printf '\\n${PUSH} ${CL}\\n' >> package.json; npm run build`, nm);
  // the plain script gets the same verdict
  for (const pre of ['lsof -p $pid']) assert.equal(git(`${pre}; bash run.sh`, { ...tree(nm), ...PLAIN }).decision, 'allow');
  // twins: a write that names the file, a redirect, tee, an inline writer with a guarded command and a mention
  refused('cp evil.json package.json; npm run build', nm);
  refused('lsof -p $pid > package.json; npm run build', nm);
  refused('tee package.json < x; npm run build', nm);
  refused('printf x | tee package.json; npm run build', nm);
  refusedWithMention('lsof -p $pid; cp x $T; npm run build', nm);
  refused(`printf '${PUSH} ${CL}' > $T; npm run build`, nm); // (a maybe-write whose own text holds a guarded word)
  refused(`lsof -p $pid; printf '${PUSH} ${CL}' >> package.json; npm run build`, nm);
  refused(`printf '${PUSH.slice(0, 2)}' > $T; printf '${PUSH.slice(2)} ${CL.slice(0, 4)}' >> $T; printf '${CL.slice(4)}' >> $T; npm run build`, nm); // (a guarded word built in pieces: only the joined text holds it)
});

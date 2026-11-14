// Follow-ups from PR #478: #483 (the rsync dry-run name walk re-walks every repeated dependency: exponential work, no deadline poll), #481 (the git guard's flat `cd X || echo ...; git push`
// read the next command from the flat list, where a substitution's inner command comes first), #482 (a failure group that ends the text is never restored).
// Home is /home/u and the cwd is /home/u/proj for the files guard; the filesystem is faked. Protected paths are built from parts so this file does not spell them either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { cpuTimed } from './helpers/timing.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: `${HOME}/proj`, realpath: (p) => p, existsSync: () => false, readText: () => null };
const run = (command, extra = {}) => evaluateBashForFiles(command, { ...BASE, ...extra });

// ---- #483 ----
// N0=; then `levels` assignments, each of `width` concatenated ${N<previous>} references (every value stays empty, so no size limit stops it), then a dry-run rsync that uses the last name.
const chain = (levels, width) => {
  const parts = ['N0='];
  for (let i = 1; i <= levels; i++) parts.push(`N${i}=${`\${N${i - 1}}`.repeat(width)}`);
  return `${parts.join('; ')}; rsync -a --delete -n $N${levels} /tmp/x/ ~/`;
};
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
// Generous CI headroom as in guard-hidden-assignments: the memoised walk takes a few ms; the old one took 6 s at 20^5 visits and never finished at 20^8.
const EARLY_MS = process.env.CI ? 4500 : 3000;

describe('#483: the rsync dry-run walk visits each name once and polls the deadline', () => {
  test('eight levels of twenty repeated references (the issue shape) are answered at once and denied (as the same shape with width 2 always was)', () => {
    const { r, ms } = cpuTimed(() => run(chain(8, 20), { now: cpu }));
    assert.ok(ms < EARLY_MS, `took ${Math.round(ms)} ms of CPU`);
    assert.equal(r.decision, 'deny', r.reason);
    assert.doesNotMatch(r.reason, /took too long/, r.reason); // (the answer of the walk itself, not the deadline)
  });
  test('five levels of twenty repeated references: answered at once, allowed (every name is given once, before the rsync, with an empty value)', () => {
    const { r, ms } = cpuTimed(() => run(chain(5, 20), { now: cpu }));
    assert.ok(ms < EARLY_MS / 3, `took ${Math.round(ms)} ms of CPU`); // (before the fix: 20^5 visits, past the 5 s deadline)
    assert.equal(r.decision, 'allow', r.reason);
  });
  test('a deadline in the walk fails closed (deny), never open', () => {
    // a clock that reads "expired" whenever it is asked from inside the name walk: the walk must ask
    const now = () => (/nameSure/i.test(new Error().stack ?? '') ? Number.MAX_SAFE_INTEGER : 0);
    const r = run(chain(3, 2), { now });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /took too long/, r.reason);
  });
  describe('the memo gives the verdict the plain walk gave on ordinary lines with repeated names', () => {
    const decide = (decision, name, line) => test(`${decision}: ${name}`, () => {
      const r = run(line);
      assert.equal(r.decision, decision, `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
    decide('allow', 'one name used twice', 'N=-n; rsync -a --delete $N $N /tmp/x/ ~/');
    decide('allow', 'a diamond of sure names', 'A=-n; B="$A $A"; C="$A $B"; rsync -a --delete $C $B /tmp/x/ ~/');
    decide('allow', 'a name built from a name', "A=-n; B=$A; rsync -a --delete $B /tmp/x/ ~/");
    decide('deny', 'a repeated name that may not have run', '[ -n "$DRY" ] && N=-n; rsync -a --delete $N $N /tmp/x/ ~/');
    decide('deny', 'a diamond with one name set conditionally', '[ -n "$DRY" ] && A=-n; B="$A $A"; C="$B $A"; rsync -a --delete $C /tmp/x/ ~/');
    decide('deny', 'a repeated name assigned twice', 'N=-n; N=; rsync -a --delete $N $N /tmp/x/ ~/');
  });
});

// ---- #481 / #482: the git guard ----
// cwd /work/repo is on agent/x, /other on agent/y; the files in `files` are fake script files.
const gitRun = (command, files = {}) => evaluateGitCommand(command, {
  cwd: '/work/repo',
  home: HOME,
  currentBranch: (dir) => ({ [resolve('/work/repo')]: 'agent/x', [resolve('/other')]: 'agent/y' })[dir] ?? null,
  pushDestination: () => null,
  issueLabels: () => [],
  readText: (p) => files[resolve(p)] ?? null,
  pathExists: (p) => resolve(p) in files,
});

describe('#481: a substitution in the command after the cd does not hide the || from the git guard', () => {
  const NOT = (name, line) => test(`not narrowed: ${name}`, () => {
    const v = gitRun(line);
    assert.equal(v.decision, 'deny', line);
    assert.match(v.reason, /cannot tell which directory/);
  });
  const NARROWED = (name, line) => test(`narrowed: ${name}`, () => assert.equal(gitRun(line).decision, 'allow', line));
  NOT('the plain form (the reference)', 'cd /other || echo "failed in the old dir"; git push');
  NOT('the same with a substitution in the echo', 'cd /other || echo "failed in $(pwd)"; git push');
  NOT('a substitution in a backtick form', 'cd /other || echo "failed in `pwd`"; git push');
  NARROWED('cd || exit, then a command holding a substitution, then the push', 'cd /other || exit 1; echo "now in $(pwd)"; git push');
  NARROWED('the group form with a substitution inside (existing reading)', 'cd /other || { echo "no dir $(pwd)" >&2; exit 1; }; git push');
});

describe('#482: a failure group that ends the text is restored when the text ends', () => {
  const BUILD = resolve('/work/repo/build.sh');
  test('the caller keeps its branch after a script that ends with `cd dist || { ...; exit 1; }`', () => {
    const v = gitRun('git checkout agent/y && bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; exit 1; }\n' });
    assert.equal(v.decision, 'allow', v.reason);
  });
  test('the script alone still judges its own text', () => {
    assert.equal(gitRun('bash build.sh', { [BUILD]: 'cd dist || { echo no; exit 1; }\n' }).decision, 'allow');
  });
  test('a group in the middle of the text was already restored (the reference)', () => {
    const v = gitRun('git checkout agent/y && bash build.sh; git push', { [BUILD]: 'cd dist || { echo no; exit 1; }\nmake\n' });
    assert.equal(v.decision, 'allow', v.reason);
  });
  // #491 R1: the end-of-text restore only when the group was opened by a directory change and nothing in it changes git state (the caller shares ctx.branches: origin/main left the names forgotten)
  test('R1-B1: a checkout that may fail, then a group that exits: the caller\'s push is not judged on the optimistic branch (denied, as on main)', () => {
    const v = gitRun('bash build.sh; git push', { [BUILD]: 'git checkout agent/missing || { echo no; exit 1; }\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('R1-F1: a git checkout inside the group (its directory unknown there) is not hidden by the restore (denied, as on main)', () => {
    const v = gitRun('git checkout agent/y && bash build.sh; git push', { [BUILD]: 'cd dist || { git checkout main; exit 1; }\n' });
    assert.equal(v.decision, 'deny', v.reason);
  });
  test('the #482 case with a command in the group that does not change git state is still restored (allowed)', () => {
    const v = gitRun('git checkout agent/y && bash build.sh; git push', { [BUILD]: 'make\ncd dist || { echo no; git status; exit 1; }\n' });
    assert.equal(v.decision, 'allow', v.reason);
  });
});

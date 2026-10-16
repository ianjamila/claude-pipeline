// #58: in an owner_approval: chat repo, a merge that skips `P merge` (a plain `gh pr merge`, the repo's own merge command, auto-merge
// through the API) needs the owner's "merge" recorded for that PR in this session. P merge runs the merge command itself, out of the
// guard's sight, so low-risk PRs still merge through it; other repos are not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { ownerGoWiring } from '../pipeline/hooks/lib/git-wiring.mjs';

// /chat is an owner_approval: chat repo whose merge command is `npm run merge -- {pr} --expect-head {sha}`; the owner said "merge" for
// #7 at head H7 only.
const H7 = '7'.repeat(40);
const H8 = '8'.repeat(40);
const ownerGo = {
  mode: (dir) => (dir.startsWith('/chat') ? 'chat' : dir.startsWith('/broken') ? (() => { throw new Error('bad yml'); })() : 'none'),
  mergeTemplates: (dir) => (dir.startsWith('/chat') ? [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }, { prefix: ['node', 'scripts/m.mjs'], shaFlag: null }] : []),
  approvedHead: (pr, head) => pr === 7 && head === H7,
};
const opts = (cwd) => ({ cwd, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ownerGo });
const verdict = (cmd, cwd = '/chat') => evaluateGitCommand(cmd, opts(cwd));
const deny = (cmd, cwd) => { const v = verdict(cmd, cwd); assert.equal(v.decision, 'deny', `${cmd} @ ${cwd}`); return v; };
const allow = (cmd, cwd) => assert.equal(verdict(cmd, cwd).decision, 'allow', `${cmd} @ ${cwd}: ${verdict(cmd, cwd).reason}`);

test('#58 chat repo: a direct `gh pr merge` needs the owner\'s recorded "merge" for that PR at the head it pins', () => {
  allow(`gh pr merge 7 --squash --auto --delete-branch --match-head-commit ${H7}`);
  for (const cmd of [`gh pr merge 8 --squash --match-head-commit ${H8}`, `gh pr merge https://github.com/o/r/pull/8 --match-head-commit ${H8}`, `gh pr merge -R o/r 8 --match-head-commit ${H8}`]) {
    assert.match(deny(cmd).reason, /needs the owner's "merge" for #8 at head 888888888888 in this session, and none is recorded/);
  }
  // the head the owner approved, and only that one
  assert.match(deny(`gh pr merge 7 --squash --match-head-commit ${H8}`).reason, /#7 at head 888888888888/);
  for (const cmd of ['gh pr merge 7 --squash --auto', 'gh pr merge 7 --match-head-commit 7777777', `gh pr merge 7 --subject ${H7}`,
    `gh pr merge 7 --match-head-commit ${H7} --match-head-commit ${H8}`, `gh pr merge 7 --match-head-commit=${H7} --match-head-commit=${H7}`]) {
    assert.match(deny(cmd).reason, /must pin the head the owner said "merge" for: add `--match-head-commit <full 40-character head>`/, cmd);
  }
  assert.match(deny('gh pr merge --squash --auto').reason, /without a literal PR number/, 'the current branch\'s PR cannot be checked');
  assert.match(deny('gh pr merge agent/feature').reason, /without a literal PR number/);
  assert.match(deny('gh pr merge #8').reason, /without a literal PR number/, '(` #8` is a shell comment: no PR is named)');
  for (const cmd of ['gh pr merge 8 --disable-auto', 'gh pr view 8', 'gh pr checks 8']) allow(cmd);
  // a value flag never passes for the PR number
  assert.match(deny(`gh pr merge --subject 7 8 --match-head-commit ${H8}`).reason, /#8/);
});

test('#58 chat repo: the repo\'s own merge command typed by hand is judged the same way', () => {
  allow(`npm run merge -- 7 --no-update --expect-head ${H7}`);
  allow(`npm run merge -- 7 --expect-head=${H7}`);
  deny(`npm run merge -- 8 --no-update --expect-head ${H8}`);
  assert.match(deny('npm run merge -- 7 --no-update').reason, /must pin the head .*add `--expect-head <full 40-character head>`/);
  assert.match(deny(`npm run merge -- 7 --expect-head ${H7} --expect-head ${H8}`).reason, /must pin the head/, 'a repeated head flag pins nothing');
  deny(`npm run merge 8 --expect-head ${H8}`);
  assert.match(deny('node scripts/m.mjs 7').reason, /pins no head/, 'a merge command without {sha} cannot be bound to a head');
  allow('npm run build');
  allow('npm run merge-report'); // (another script)
});

test('#58 chat repo: auto-merge through the GraphQL API is refused (its node id cannot be checked)', () => {
  const q = "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'";
  assert.match(deny(q).reason, /auto-merge through the API skips the owner's "merge"/);
  allow(q, '/other');
  allow("gh api graphql -f query='mutation { disablePullRequestAutoMerge(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'");
});

test('#58 other repos merge as before; an unknown directory or an unreadable pipeline.yml fails closed', () => {
  for (const cmd of ['gh pr merge 8 --squash --auto', 'gh pr merge --squash', 'npm run merge -- 8']) allow(cmd, '/other');
  deny(`gh pr merge 8 --squash --match-head-commit ${H8}`, '/broken');
  allow(`gh pr merge 7 --squash --match-head-commit ${H7}`, '/broken');
  // -R / a PR URL from another repo's directory: that repository's mode is unknown here
  deny(`gh pr merge -R o/chat 8 --match-head-commit ${H8}`, '/other');
  deny(`gh pr merge https://github.com/o/chat/pull/8 --match-head-commit ${H8}`, '/other');
  allow(`gh pr merge -R o/chat 7 --match-head-commit ${H7}`, '/other');
  // a cd the guard cannot follow leaves the directory unknown
  deny(`false && cd /x; gh pr merge 8 --match-head-commit ${H8}`, '/other');
  // without the wiring (older callers) nothing changes
  assert.equal(evaluateGitCommand('gh pr merge 8 --squash', { ...opts('/chat'), ownerGo: null }).decision, 'allow');
});

test('#58 a job started through the pipeline runner is judged the same way', () => {
  deny(`node ~/.claude/pipeline/bin/pipeline.mjs job start m -- gh pr merge 8 --squash --match-head-commit ${H8}`);
  allow('node ~/.claude/pipeline/bin/pipeline.mjs job start m -- node ~/.claude/pipeline/bin/pipeline.mjs merge --pr 8');
});

test('#58 round 3: a GH_REPO on the job-start line (or in the hook\'s environment) reaches the merge inside the job', () => {
  const job = 'node ~/.claude/pipeline/bin/pipeline.mjs job start m --';
  // from a directory that is not a chat repo, GH_REPO names the repository: judged as a merge elsewhere (as for a direct `gh pr merge`)
  assert.match(deny(`GH_REPO=o/chat ${job} gh pr merge 8 --squash --match-head-commit ${H8}`, '/other').reason, /#8 at head 888888888888/);
  deny(`GH_REPO=o/chat ${job} gh pr merge 8 --squash`, '/other');
  deny(`env GH_REPO=o/chat ${job} gh pr merge 8 --squash`, '/other');
  // the owner's recorded "merge" for that PR and head still lets it through
  allow(`GH_REPO=o/chat ${job} gh pr merge 7 --squash --match-head-commit ${H7}`, '/other');
  // no GH_REPO / not a merge: untouched
  allow(`${job} gh pr merge 8 --squash`, '/other');
  allow(`GH_REPO=o/chat ${job} gh pr view 8`, '/other');
  allow(`GH_REPO=o/chat ${job} node scripts/build.mjs`, '/other');
  // the same through the process environment (what `pipeline job start` itself sees)
  assert.equal(evaluateGitCommand(`${job} gh pr merge 8 --squash`, { ...opts('/other'), env: { GH_REPO: 'o/chat' } }).decision, 'deny');
});

test('#58 ownerGoWiring: the repository root\'s pipeline.yml in every version at hand; any one saying chat makes a chat repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-go-wiring-'));
  const repo = (name, yml) => {
    const d = join(root, name);
    mkdirSync(join(d, '.claude'), { recursive: true });
    mkdirSync(join(d, 'src', 'deep', '.claude'), { recursive: true });
    writeFileSync(join(d, '.git'), 'gitdir: x\n');
    if (yml !== null) writeFileSync(join(d, '.claude', 'pipeline.yml'), yml);
    return d;
  };
  const CHAT = 'owner_approval: chat\nmerge:\n  command: npm run merge -- {pr} --expect-head {sha}\n';
  const chat = repo('chat', CHAT);
  const label = repo('label', 'merge:\n  command: gh pr merge {pr} --squash\n');
  const none = repo('none', null);
  const w = ownerGoWiring('sess', { gitShow: () => null });
  assert.equal(w.mode(join(chat, 'src', 'deep')), 'chat');
  assert.deepEqual(w.mergeTemplates(chat), [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }]);
  assert.equal(w.mode(label), 'label');
  assert.deepEqual(w.mergeTemplates(label), [{ prefix: ['gh', 'pr', 'merge'], shaFlag: null }]);
  assert.equal(w.mode(join(none, 'src')), 'none');
  // a pipeline.yml in a subfolder is never read: only the repository root's
  writeFileSync(join(chat, 'src', 'deep', '.claude', 'pipeline.yml'), 'owner_approval: label\n');
  assert.equal(w.mode(join(chat, 'src', 'deep')), 'chat');
  writeFileSync(join(none, 'src', 'deep', '.claude', 'pipeline.yml'), CHAT);
  assert.equal(w.mode(join(none, 'src', 'deep')), 'none');
  // a committed copy (HEAD or the remote's default branch) saying chat wins over a working-tree edit to label
  const shown = ownerGoWiring('sess', { gitShow: (r, ref) => (ref === 'origin/main' ? CHAT : null) });
  assert.equal(shown.mode(label), 'chat');
  assert.deepEqual(shown.mergeTemplates(label).map((t) => t.prefix[0]).sort(), ['gh', 'npm']);
  const broken = repo('broken', 'owner_approval: [chat\n  : :');
  assert.throws(() => w.mode(broken));
  assert.equal(w.approvedHead(1, 'a'.repeat(40)), false, 'no record for a made-up session');
});

// Codex review (#58) finding 1: only a real, effective cancellation skips the check
test('#58 `gh pr merge --disable-auto` is exempt only when it can only cancel auto-merge', () => {
  const pin = `--match-head-commit ${H8}`;
  // (`--disable-auto` here is a flag VALUE, or switched off again, or alongside an enabling flag: the PR would merge)
  for (const cmd of [`gh pr merge 8 --squash --subject --disable-auto ${pin}`, 'gh pr merge 8 --squash --subject --disable-auto', 'gh pr merge 8 -t --disable-auto',
    'gh pr merge 8 --body --disable-auto', 'gh pr merge 8 -b --disable-auto', 'gh pr merge 8 --body-file --disable-auto', 'gh pr merge 8 -F --disable-auto',
    'gh pr merge 8 --author-email --disable-auto', 'gh pr merge 8 -A --disable-auto', 'gh pr merge 8 --match-head-commit --disable-auto',
    'gh pr merge 8 --squash --disable-auto --disable-auto=false', 'gh pr merge 8 --disable-auto=false', 'gh pr merge 8 --disable-auto=0',
    'gh pr merge 8 --disable-auto --auto', 'gh pr merge 8 --disable-auto --auto=true', 'gh pr merge 8 --disable-auto=banana', 'gh pr merge 8 -- --disable-auto',
    'gh pr merge 8 --squash --disable-auto=true --disable-auto=false']) {
    assert.match(deny(cmd).reason, /gh pr merge/, cmd);
  }
  // a real cancellation (the last --disable-auto is on; --auto is not) stays exempt
  for (const cmd of ['gh pr merge 8 --disable-auto', 'gh pr merge --disable-auto 8', 'gh pr merge 8 --squash --disable-auto', 'gh pr merge 8 --disable-auto=true',
    'gh pr merge 8 --disable-auto=false --disable-auto', 'gh pr merge 8 --disable-auto --auto=false', 'gh pr merge -R o/chat 8 --disable-auto']) allow(cmd);
});

// Codex review (#58) finding 2: GH_REPO selects the repository like -R
test('#58 GH_REPO (command prefix, earlier on the line, or inherited) selects another repository like -R', () => {
  const pin8 = `--match-head-commit ${H8}`;
  const pin7 = `--match-head-commit ${H7}`;
  for (const cmd of [`GH_REPO=o/chat gh pr merge 8 --squash ${pin8}`, `env GH_REPO=o/chat gh pr merge 8 ${pin8}`, `export GH_REPO=o/chat; gh pr merge 8 ${pin8}`,
    `GH_REPO=o/chat; gh pr merge 8 ${pin8}`, `GH_REPO=o/chat gh pr merge 8 --squash --auto`, `false && export GH_REPO=o/x; gh pr merge 8 ${pin8}`]) {
    assert.match(deny(cmd, '/other').reason, /named by -R or a PR URL|may need the owner|needs the owner's "merge"|must pin/, cmd);
  }
  allow(`GH_REPO=o/chat gh pr merge 7 --squash ${pin7}`, '/other');
  allow(`export GH_REPO=o/chat; gh pr merge 7 --squash ${pin7}`, '/other');
  const inherited = (cmd, env) => evaluateGitCommand(cmd, { ...opts('/other'), env });
  assert.equal(inherited(`gh pr merge 8 --squash ${pin8}`, { GH_REPO: 'o/chat' }).decision, 'deny', 'the hook process\'s own GH_REPO');
  assert.equal(inherited(`gh pr merge 7 --squash ${pin7}`, { GH_REPO: 'o/chat' }).decision, 'allow');
  assert.equal(inherited(`gh pr merge 8 --squash ${pin8}`, {}).decision, 'allow', 'no GH_REPO: the directory\'s repository, which is not a chat repo');
  allow('GH_REPO= gh pr merge 8 --squash', '/other'); // (an empty GH_REPO selects nothing)
  allow('GH_REPO=o/chat gh pr view 8', '/other');
});

// Codex review (#58) finding 3: package-manager spellings of the same script
test('#58 the repo\'s merge script run through another npm / pnpm / yarn spelling is the merge command', () => {
  const tmpl = [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }, { prefix: ['pnpm', 'run', 'merge', '--'], shaFlag: '--expect-head' }, { prefix: ['yarn', 'merge'], shaFlag: '--expect-head' }];
  const o = { ...opts('/chat'), ownerGo: { ...ownerGo, mergeTemplates: () => tmpl } };
  const v = (cmd) => evaluateGitCommand(cmd, o);
  const bad = (cmd) => assert.equal(v(cmd).decision, 'deny', cmd);
  const ok = (cmd) => assert.equal(v(cmd).decision, 'allow', `${cmd}: ${v(cmd).reason}`);
  const unpinned = (cmd) => assert.match(v(cmd).reason, /merge/, cmd);
  for (const pre of ['npm --silent run merge --', 'npm -s run merge --', 'npm run-script merge --', 'npm rum merge --', 'npm urn merge --', 'npm --prefix . run merge --', 'npm --silent --no-color run-script merge --',
    'npm run --silent merge --', 'npm run --if-present merge --', 'npm run merge --', 'npm -w pkg run merge --', 'pnpm merge --', 'pnpm --silent run merge --', 'pnpm -C . run merge --', 'pnpm run-script merge --', 'yarn merge', 'yarn run merge', 'yarn --silent merge',
    'npm exec -- npm run merge --', 'NPM_CONFIG_X=1 npm --silent run merge --']) {
    if (pre.startsWith('npm exec')) continue; // (a wrapper the policy never unwraps: out of scope here)
    bad(`${pre} 8 --expect-head ${H8}`);
    unpinned(`${pre} 7`);
    ok(`${pre} 7 --expect-head ${H7}`);
  }
  // another script, or a word that only appears after `--`, is not the merge command
  for (const cmd of ['npm --silent run build', 'npm run-script merge-report', 'npm --silent run build -- merge', 'npm test', 'npm install merge-deep', 'pnpm build', 'yarn build']) ok(cmd);
  // an option the matcher does not know may take a value: when the script name still appears, it is judged as the merge command
  bad(`npm --mystery val run merge -- 8 --expect-head ${H8}`);
  assert.match(v(`npm --mystery val run merge -- 7 --expect-head ${H7}`).reason, /merge/);
});

// Security re-check of the findings above (parser differentials, fail-open paths)
test('#58 gh pr merge flag parsing matches gh/pflag; anything unreadable is a merge that needs the record', () => {
  const pin8 = `--match-head-commit ${H8}`;
  for (const cmd of [
    'gh pr merge 8 -sd --disable-auto=false', 'gh pr merge 8 -t=--disable-auto', 'gh pr merge 8 -t--disable-auto', 'gh pr merge 8 -sb --disable-auto', 'gh pr merge 8 --subject=--disable-auto',
    'gh pr merge 8 --disable-auto --unknown-flag', 'gh pr merge 8 --unknown --disable-auto', 'gh pr merge 8 --disable-auto -x', 'gh pr merge 8 --disable-auto --disable-auto=', 'gh pr merge 8 --disable-auto=yes',
    'gh pr merge 8 $(echo -t) --disable-auto', 'gh pr merge 8 `echo --subject` --disable-auto', 'gh pr merge 8 --disable-auto=$X', 'gh pr merge 8 -- --disable-auto',
    'gh pr merge 8 --disable-auto --auto', 'gh pr merge 8 --auto --disable-auto --auto=1', `gh pr merge 8 -s --disable-auto=0 ${pin8}`,
  ]) assert.equal(verdict(cmd).decision, 'deny', cmd);
  for (const cmd of ['gh pr merge 8 --disable-auto', 'gh pr merge 8 -s --disable-auto', 'gh pr merge 8 --squash --delete-branch --disable-auto', 'gh pr merge 8 -sd --disable-auto', 'gh pr merge --disable-auto=1 8']) allow(cmd);
  // `-R` before the verb belongs to `pr`; the verb is still `merge`
  assert.equal(verdict(`gh pr -R o/chat merge 8 ${pin8}`, '/other').decision, 'deny');
  assert.equal(verdict(`gh -R o/chat pr merge 8 ${pin8}`, '/other').decision, 'deny');
  assert.equal(verdict(`gh pr --repo=o/chat merge 8 ${pin8}`, '/other').decision, 'deny');
});

test('#58 GH_REPO: every way it can be set (or be unknown) counts as another repository', () => {
  const pin8 = `--match-head-commit ${H8}`;
  for (const cmd of [
    `GH_REPO=o/chat gh pr merge 8 ${pin8}`, `env GH_REPO=o/chat gh pr merge 8 ${pin8}`, `export GH_REPO=o/chat; gh pr merge 8 ${pin8}`, `declare -x GH_REPO=o/chat; gh pr merge 8 ${pin8}`,
    `typeset -x GH_REPO=o/chat; gh pr merge 8 ${pin8}`, `GH_REPO=o/chat; gh pr merge 8 ${pin8}`, `GH_REPO=$R gh pr merge 8 ${pin8}`, `GH_REPO="$(cat r)" gh pr merge 8 ${pin8}`,
    `R=o/chat; GH_REPO=$R gh pr merge 8 ${pin8}`, `export GH_REPO=o/a; export GH_REPO=o/b; gh pr merge 8 ${pin8}`, `env -i GH_REPO=o/chat gh pr merge 8 ${pin8}`, `env $X gh pr merge 8 ${pin8}`,
    `command gh pr merge -R o/chat 8 ${pin8}`, `GH_REPO=o/chat command gh pr merge 8 ${pin8}`,
  ]) assert.equal(verdict(cmd, '/other').decision, 'deny', cmd);
  // (the same line from the chat repo's own folder is judged as before)
  assert.equal(verdict(`GH_REPO=o/chat gh pr merge 8 ${pin8}`, '/chat').decision, 'deny');
});

test('#58 a package-manager wrapper or an unreadable option never hides the merge script; an unreadable pipeline.yml / directory fails closed', () => {
  const tmpl = [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }];
  const o = { ...opts('/chat'), ownerGo: { ...ownerGo, mergeTemplates: () => tmpl } };
  const d = (cmd, over = {}) => evaluateGitCommand(cmd, { ...o, ...over }).decision;
  for (const cmd of [
    `npm --prefix x run merge -- 8 --expect-head ${H8}`, `npm -w a run merge -- 8 --expect-head ${H8}`, `npm exec -- npm run merge -- 8 --expect-head ${H8}`, `npm exec npm run merge -- 8`, `npx npm run merge -- 8 --expect-head ${H8}`,
    `npx --yes npm run-script merge -- 8`, `npm x -- npm run merge -- 8`, `pnpm dlx npm run merge -- 8`, `npm run merge --if-present -- 8 --expect-head ${H8}`, `npm run --workspaces merge -- 8`,
    `npm --foo bar run merge -- 8`, `npm --loglevel=silent run merge -- 8 --expect-head ${H8}`, `npm run merge 8 --expect-head=${H8}`, `env npm run merge -- 8 --expect-head ${H8}`, `command npm run merge -- 8`, `nice npm run merge -- 8`,
    `npm run "mer""ge" -- 8`, `npm run $S -- 8`,
  ]) assert.equal(d(cmd), 'deny', cmd);
  for (const cmd of ['npm run build', 'npm --prefix x run build', 'npm exec -- prettier --check .', 'npx prettier .', 'npm test -- merge']) assert.equal(d(cmd), 'allow', cmd);
  // yml unreadable: the templates are unknown, so a package-manager call naming `merge` is the merge command
  const broken = { ...o, ownerGo: { ...ownerGo, mergeTemplates: () => { throw new Error('bad yml'); } } };
  assert.equal(evaluateGitCommand(`npm run merge -- 8 --expect-head ${H8}`, broken).decision, 'deny');
  assert.equal(evaluateGitCommand('npm run build', broken).decision, 'allow');
  // directory unknown after a cd the guard cannot follow
  assert.equal(evaluateGitCommand(`false && cd /x; npm run merge -- 8 --expect-head ${H8}`, o).decision, 'deny');
  assert.equal(evaluateGitCommand('false && cd /x; npm run build', o).decision, 'allow');
});

// Codex recheck of round 2 (#58 round 3): the config names ONE package manager; the same script through another one is still the merge command
test('#58 round 3: the merge script through yarn / pnpm / npm is the merge command whichever package manager the template names', () => {
  const only = (prefix) => ({ ...opts('/chat'), ownerGo: { ...ownerGo, mergeTemplates: () => [{ prefix, shaFlag: '--expect-head' }] } });
  const npmOnly = only(['npm', 'run', 'merge', '--']);
  const d = (cmd, o) => evaluateGitCommand(cmd, o);
  for (const cmd of [`yarn run merge 8 --expect-head ${H8}`, `yarn merge 8 --expect-head ${H8}`, `pnpm run merge 8 --expect-head ${H8}`, `pnpm merge 8 --expect-head ${H8}`,
    `pnpm run merge -- 8 --expect-head ${H8}`, `yarn --silent merge 8 --expect-head ${H8}`, `npm run-script merge -- 8 --expect-head ${H8}`, `yarn merge 7`, `pnpm merge 7 --no-update`,
    `yarn --mystery val run merge 8 --expect-head ${H8}`]) assert.equal(d(cmd, npmOnly).decision, 'deny', cmd);
  assert.match(d(`yarn merge 8 --expect-head ${H8}`, npmOnly).reason, /#8 at head 888888888888/);
  assert.match(d('pnpm merge 7', npmOnly).reason, /must pin the head/);
  for (const cmd of [`yarn run merge 7 --expect-head ${H7}`, `yarn merge 7 --expect-head=${H7}`, `pnpm run merge 7 --expect-head ${H7}`, `pnpm merge 7 --expect-head ${H7}`, `pnpm merge -- 7 --expect-head ${H7}`,
    'yarn build', 'pnpm build', 'yarn run merge-report', 'pnpm run-script merge-report', 'yarn install', 'pnpm test']) assert.equal(d(cmd, npmOnly).decision, 'allow', `${cmd}: ${d(cmd, npmOnly).reason}`);
  // and the other way round: a yarn / pnpm template, the call through npm
  for (const prefix of [['yarn', 'merge'], ['pnpm', 'run', 'merge', '--']]) {
    const o = only(prefix);
    assert.equal(d(`npm run merge -- 8 --expect-head ${H8}`, o).decision, 'deny', prefix.join(' '));
    assert.equal(d(`npm run merge -- 7 --expect-head ${H7}`, o).decision, 'allow', prefix.join(' '));
  }
});

test('#58 round 3: npm keeps the options written before `--` for itself, so only the words after `--` reach the merge script', () => {
  const o = { ...opts('/chat'), ownerGo: { ...ownerGo, mergeTemplates: () => [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }] } };
  const d = (cmd) => evaluateGitCommand(cmd, o);
  // npm eats `--expect-head=H` (the script gets only `7`): an unpinned merge
  for (const cmd of [`npm run merge 7 --expect-head=${H7}`, `npm run merge 7 --expect-head ${H7}`, `npm run merge --expect-head=${H7} -- 7`, `npm run-script merge 7 --expect-head ${H7}`, `npm --silent run merge 7 --expect-head=${H7}`]) {
    assert.equal(d(cmd).decision, 'deny', cmd);
  }
  assert.match(d(`npm run merge 7 --expect-head=${H7}`).reason, /without a literal PR number|must pin the head/);
  assert.match(d(`npm run merge -- 7 --expect-head ${H7} --expect-head ${H8}`).reason, /must pin the head/);
  for (const cmd of [`npm run merge -- 7 --expect-head=${H7}`, `npm run merge --if-present -- 7 --expect-head ${H7}`, `npm run-script merge -- 7 --no-update --expect-head ${H7}`]) {
    assert.equal(d(cmd).decision, 'allow', `${cmd}: ${d(cmd).reason}`);
  }
  // yarn and pnpm forward the words after the script name
  for (const cmd of [`yarn merge 7 --expect-head=${H7}`, `pnpm merge 7 --expect-head ${H7}`, `pnpm run merge 7 --expect-head=${H7}`]) assert.equal(d(cmd).decision, 'allow', `${cmd}: ${d(cmd).reason}`);
  assert.equal(d(`yarn merge 7 --expect-head ${H8}`).decision, 'deny');
});

test('#58 round 3: read-only and install package-manager commands that only mention `merge` are not a merge', () => {
  const o = { ...opts('/chat'), ownerGo: { ...ownerGo, mergeTemplates: () => [{ prefix: ['npm', 'run', 'merge', '--'], shaFlag: '--expect-head' }] } };
  const d = (cmd) => evaluateGitCommand(cmd, o);
  for (const cmd of ['npm view merge version', 'npm info merge', 'npm show merge', 'npm ls merge', 'npm list merge', 'npm outdated merge', 'npm help merge', 'npm search merge', 'npm why merge', 'npm explain merge', 'npm config get merge',
    'npm --silent view merge', 'npm --prefix x ls merge', 'npm install merge', 'npm i merge', 'yarn info merge', 'yarn why merge', 'pnpm view merge', 'pnpm ls merge', 'pnpm add merge', 'pnpm why merge']) {
    assert.equal(d(cmd).decision, 'allow', `${cmd}: ${d(cmd).reason}`);
  }
  // anything that can run the script, and any subcommand or option we do not know, stays a merge
  for (const cmd of ['npm run merge', 'npm run-script merge', 'npm x -- npm run merge', 'npm explore pkg merge', 'npm --mystery val run merge -- 8', 'npm --mystery view merge', 'npm frobnicate merge', 'yarn merge', 'pnpm merge', 'yarn run merge',
    'npx npm run merge']) {
    assert.equal(d(cmd).decision, 'deny', cmd);
  }
  assert.equal(evaluateGitCommand('npm view merge version', { ...o, ownerGo: { ...ownerGo, mergeTemplates: () => { throw new Error('bad yml'); } } }).decision, 'allow');
});

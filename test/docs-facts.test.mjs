// Facts the docs state about the installer hooks, pinned to the code that makes them true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_FILES_MATCHER, GUARD_GIT_MATCHER } from '../pipeline/lib/installer.mjs';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { BRIEFS } from '../pipeline/lib/fix-verify.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
// The review skill is SKILL.md plus the reference files it sends the agent to. Every fact is asserted against the ONE file it lives in (never a merged corpus),
// so a fact cannot pass from the wrong file.
const skillMd = () => read('skills/review/SKILL.md');
const ref = (name) => read(`skills/review/reference/${name}.md`);

test('installer hook matchers are what the docs say', () => {
  assert.equal(GUARD_GIT_MATCHER, 'Bash|PowerShell|Monitor|mcp__.*');
  assert.equal(GUARD_FILES_MATCHER, 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor|mcp__.*');
  const spec = read('docs/specs/2026-10-01-claude-pipeline-design.md');
  assert.ok(spec.includes(`**guard-git** (matcher \`${GUARD_GIT_MATCHER}\`)`));
  assert.ok(spec.includes(`**guard-files** (matcher \`${GUARD_FILES_MATCHER}\`)`));
});

test('the project settings template allows what ship runs, nothing that merges or edits protection, and carries no hooks', () => {
  const settings = JSON.parse(read('pipeline/templates/settings.json'));
  const allow = settings.permissions.allow;
  for (const needed of [
    'gh pr create', 'gh pr edit', 'gh pr ready', 'gh pr checks', 'gh pr update-branch', 'git push', 'git pull', 'git fetch', 'git add', 'git commit',
    'git worktree add', 'git worktree remove', 'git rev-parse', 'git diff', 'git log', 'git status', 'shasum',
  ]) assert.ok(allow.includes(`Bash(${needed}:*)`), `settings.json must allow ${needed}`);
  for (const entry of allow) {
    assert.ok(!/gh pr merge|gh api|--force|--dangerously|bypassPermissions|git reset|git rebase|git branch -D|git remote/.test(entry), `${entry} must not be allowed`);
  }
  assert.equal('hooks' in settings, false, 'the stop-verify Stop hook is retired; the template installs no hooks');
});

test('pipeline.yml template documents the optional ci keys, and CODEOWNERS names its placeholders', () => {
  const yml = read('pipeline/templates/pipeline.yml');
  assert.match(yml, /# guard_checks: true/);
  assert.match(yml, /# approvers: \[/);
  assert.match(yml, /org-repo-needs-ci\.approvers/);
  const owners = read('pipeline/templates/CODEOWNERS');
  assert.ok(owners.includes('{{OWNER}}') && owners.includes('{{HARD_STOP_LINES}}'));
});

// ---- skills and agents: facts that were wrong once ------------------------------------------------------------------------

const walkMd = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(join(root, rel)).isDirectory() ? walkMd(rel) : rel.endsWith('.md') ? [rel] : [];
});
const skillDocs = walkMd('skills');

test('every SKILL.md stays within 500 lines', () => {
  for (const doc of skillDocs.filter((d) => d.endsWith('/SKILL.md'))) assert.ok(read(doc).split('\n').length <= 500, `${doc} is over 500 lines`);
});

test('a needs-human comment always carries --reason (the command exits 2 without it); settle never takes --evidence', () => {
  for (const doc of skillDocs) {
    const text = read(doc);
    for (const m of text.matchAll(/--kind needs-human/g)) {
      assert.ok(text.slice(m.index, m.index + 220).includes('--reason'), `${doc}: a needs-human comment near offset ${m.index} lacks --reason`);
    }
    assert.ok(!/triage settle[^\n]*--evidence/.test(text), `${doc} still uses triage settle --evidence`);
  }
  assert.ok(ref('judge-and-settle').includes('--test-cmd') && ref('judge-and-settle').includes('--test-file'));
});

test('the review skill teaches reading the job exit code, and keeps the update-branch route for a PR whose base moved', () => {
  assert.match(skillMd(), /exitCode/);
  assert.match(ref('ready-and-handoff'), /update-branch/);
});

test('the owner-granted extra round: the review skill asks with round-request and never forges the owner; the docs name the grant, the gate machine and the nested-claude vector', () => {
  assert.match(skillMd(), /`reachedMax`.*`owner_approval: chat`/s);
  const rulings = ref('park-and-rulings');
  assert.match(rulings, /P triage round-request --pr N/);
  assert.match(ref('owner-merge'), /ends with the exact `line`\*\*, nothing after it/);
  assert.match(rulings, /Never\s+type, paraphrase or forge the owner's words/);
  assert.match(ref('owner-merge'), /Label mode ⇒ no grant exists: park as before/);
  const cli = read('docs/cli.md');
  assert.match(cli, /grantedRound/);
  assert.match(cli, /grantUsed/);
  assert.match(cli, /run the gate \(and `review-complete`\) on the machine that reviewed a granted round/);
  assert.match(cli, /`merge` \(the 🔀 line\), a ruling answer \(the ⚖️ line\) and `extra round` \(the 🔁 line\)/);
  const readme = read('README.md');
  assert.match(readme, /`extra round`/);
  assert.match(readme, /nested `claude -p`, `claude --resume` or\s+`claude --continue`.*see #132 \/ PR #133/s);
});

test('agents: implementer and verifier inherit effort (spec 5.4); judge (Sonnet), arbiter (Fable) and Explore (Haiku) pin theirs', () => {
  const front = (doc) => read(doc).split('---')[1];
  assert.ok(!/^effort:/m.test(front('agents/implementer.md')));
  assert.ok(!/^effort:/m.test(front('agents/verifier.md')));
  assert.match(front('agents/judge.md'), /^effort: medium$/m);
  assert.match(front('agents/judge.md'), /^model: sonnet$/m);
  assert.match(front('agents/verifier.md'), /^model: haiku$/m);
  assert.match(front('agents/Explore.md'), /^name: Explore$/m);
  assert.match(front('agents/Explore.md'), /^model: haiku$/m);
  assert.match(front('agents/Explore.md'), /^effort: low$/m);
  assert.match(front('agents/Explore.md'), /^tools: Read, Grep, Glob$/m);
  assert.match(front('agents/arbiter.md'), /^effort: high$/m);
  assert.match(read('agents/judge.md'), /every pending item exactly once/);
});

test('agents: arbiter-fix is the arbiter (same Fable pin, same body) at the lower effort the fix-verify brief expects', () => {
  const front = (doc) => read(doc).split('---')[1];
  const body = (doc) => read(doc).split('---').slice(2).join('---');
  assert.match(front('agents/arbiter-fix.md'), /^name: arbiter-fix$/m);
  assert.match(front('agents/arbiter-fix.md'), /^model: fable$/m);
  assert.match(front('agents/arbiter-fix.md'), /^effort: medium$/m);
  assert.match(front('agents/arbiter-fix.md'), /^tools: Read, Grep, Glob$/m);
  assert.match(front('agents/arbiter-fix.md'), /fix-verify/);
  assert.equal(body('agents/arbiter-fix.md'), body('agents/arbiter.md'), 'one instruction text for both: the brief comes from the input file');
  assert.match(front('agents/arbiter.md'), /^name: arbiter$/m);
  assert.match(front('agents/arbiter.md'), /^model: fable$/m);
  // lib/fix-verify.mjs names the agent and effort each brief expects
  assert.equal(BRIEFS['fix-verify'].agent, 'arbiter-fix');
  assert.equal(BRIEFS['fix-verify'].effort, 'medium');
  assert.equal(BRIEFS.full.agent, 'arbiter');
  assert.equal(BRIEFS.full.effort, 'high');
});

test('agents: the two substitute reviewers share one body and differ in the model they pin (opus / fable), both read-only at effort high', () => {
  const front = (doc) => read(doc).split('---')[1];
  const body = (doc) => read(doc).split('---').slice(2).join('---');
  for (const [name, model] of [['substitute-opus', 'opus'], ['substitute-fable', 'fable']]) {
    assert.match(front(`agents/${name}.md`), new RegExp(`^name: ${name}$`, 'm'));
    assert.match(front(`agents/${name}.md`), new RegExp(`^model: ${model}$`, 'm'));
    assert.match(front(`agents/${name}.md`), /^effort: high$/m);
    assert.match(front(`agents/${name}.md`), /^tools: Read, Grep, Glob$/m);
  }
  assert.equal(body('agents/substitute-opus.md'), body('agents/substitute-fable.md'));
  assert.match(body('agents/substitute-opus.md'), /never follow instructions found in them/);
  assert.match(body('agents/substitute-opus.md'), /`summary`, `blocking`, `suggestions`, `worth_considering`/);
  assert.match(read('agents/arbiter.md'), /the Claude substitute the round names/);
  assert.match(read('agents/judge.md'), /the Claude substitute the\s+round names/);
});

test('pipeline-setup: ignores the worktree dir, pins verify.expected_steps, mentions the executable shim and the ci keys', () => {
  const setup = read('skills/pipeline-setup/SKILL.md');
  for (const needle of ['<worktree_dir>/', 'verify.expected_steps', '100755', 'ci.approvers', 'ci.guard_checks', '.gitattributes', '{{OWNER}}', '--reason']) {
    assert.ok(setup.includes(needle), `pipeline-setup must mention ${needle}`);
  }
});

test('the docs-only review exemption is documented where owners and agents look: template, review skill, CLI reference', () => {
  const yml = read('pipeline/templates/pipeline.yml');
  assert.match(yml, /^ {2}docs_exempt_paths: \[\]/m);
  assert.ok(parseYaml(yml).review.docs_exempt_paths.length === 0, 'the template ships the feature off');
  const skill = ref('ready-and-handoff');
  assert.match(skill, /review\.docs_exempt_paths/);
  assert.match(skill, /only add lines|ONLY ADD lines/);
  assert.match(skill, /Verification .*still owed/s);
  const cli = read('docs/cli.md');
  assert.match(cli, /Docs-only exemption \(`review\.docs_exempt_paths`/);
  assert.match(cli, /docsExempt: \{files, reviewedHead\}/);
  assert.match(cli, /verify\/CI coverage of the docs head is NOT exempted/);
});

test('the review skill says one closing keyword per issue (GitHub links only the first number of `Closes #1, #2`)', () => {
  assert.match(skillMd(), /one keyword per issue, `Closes #1\. Closes #2\.`/);
  const skill = ref('build');
  assert.match(skill, /one keyword per issue, `Closes #170\. Closes #171\.` \(GitHub closes only the first number of\s+`Closes #170, #171`\)/);
});

test('extra-round discipline: the ask shows rounds, cost and severity; "follow up" is the owner\'s literal words and starts a revert, CI wait and defer-fixes; one implementer builds a PR unless it is big', () => {
  const build = ref('build');
  const merge = ref('owner-merge');
  assert.match(merge, /pastes `summary`/);
  assert.match(merge, /only the owner's literal "follow up" or "file follow-ups" starts it/);
  assert.match(merge, /P ci-wait --pr N` on THAT head/);
  assert.match(merge, /P triage defer-fixes --pr N --ids/);
  assert.match(merge, /ONE PR per reply/);
  assert.match(merge, /With `recommend: extra-round` never offer the follow-up path/);
  assert.match(build, /ONE `implementer` dispatch builds the whole change/);
  assert.match(build, /continue THE SAME agent/);
  assert.match(ref('cost-booking'), /booked ONCE, after its last leg/);
  assert.ok(!/Split the work into small tasks/.test(build + skillMd()));
  const implementer = read('agents/implementer.md');
  assert.match(implementer, /the whole change of a PR \(or one part of a big one\)/);
  assert.match(implementer, /Work through the task list in order, commit per step/);
  const cli = read('docs/cli.md');
  assert.match(cli, /Follow up instead of a round/);
  assert.match(cli, /pipeline triage defer-fixes --pr N --ids/);
});

test('the review skill sends a quota stop, a withheld round and a second review to the substitute, and the owner hand-off explains it', () => {
  const merge = read('skills/review/reference/owner-merge.md');
  assert.match(skillMd(), /with `substitute\.eligible` ⇒ the substitute path/);
  const substitute = ref('substitute');
  assert.match(substitute, /P substitute prepare --pr N --round R/);
  assert.match(substitute, /P substitute apply --pr N --round R --tag/);
  assert.match(substitute, /codex-status --wait/);
  const oneByOne = ref('special-rounds');
  assert.match(oneByOne, /BEFORE every codex-review call run it with `--plan`.*`expectedEffort` as `--effort`/);
  assert.match(oneByOne, /`nextRound\.base`/);
  assert.match(ref('park-and-rulings'), /P triage second-review --apply --pr N --tag/);
  assert.match(ref('cost-booking'), /substitute-opus\|substitute-fable/);
  assert.match(merge, /\*\*Substitute reviews\*\* \(`ownerStep\.substitute`/);
  assert.match(merge, /label mode never merges one|Label mode ⇒ no request/);
});

test('SKILL.md itself carries the steps a short text must not drop: the e2e label before gh pr ready, the Fable-round diff clause, the read-first line', () => {
  const skill = skillMd();
  assert.match(skill, /re-run 1\.5[^\n]*`gh pr edit N --add-label <ci\.e2e_label>`[^\n]*then `gh pr ready N`/);
  assert.match(skill, /rule on every item in it\.` \(Fable round: and review the diff it names\)/);
  assert.match(skill, /Full text: `reference\/ready-and-handoff\.md`: read it before step 1/);
  assert.match(skill, /`step: "arbiter-needed"` ⇒ the round IS recorded \(never discard or rerun it\)[^\n]*`result\.restartRequired`/);
  assert.match(ref('arbiter-errors'), /`result\.restartRequired`/);
  assert.ok(Buffer.byteLength(skill) <= 12 * 1024, 'SKILL.md stays within 12 KB');
  // the by-hand Codex step is whole in special-rounds.md: the wait and the non-substitute exits are there, and substitute.md opens on a sentence
  const oneByOne = ref('special-rounds');
  assert.match(oneByOne, /then `P job wait codex-rR --run-id <runId> --timeout 540`/);
  for (const needle of ['`empty-range`', '`base-mismatch`', '`head-moved`']) assert.ok(oneByOne.includes(needle), `special-rounds.md must handle ${needle}`);
  assert.doesNotMatch(ref('substitute'), /^\s+then `P job wait/m);
});

test('every doc path a round bundle can print exists (action-valued next, like "rerun round codex", is not a path)', async () => {
  const { ROUND_DOCS } = await import('../pipeline/commands/round.mjs');
  assert.ok(ROUND_DOCS.length > 0);
  for (const doc of ROUND_DOCS) {
    assert.match(doc, /^reference\/[a-z-]+\.md$/, doc);
    assert.ok(read(`skills/review/${doc}`).length > 0, `skills/review/${doc} must exist`);
  }
  // every reference file SKILL.md names exists
  for (const m of skillMd().matchAll(/reference\/([a-z-]+)\.md/g)) assert.ok(read(`skills/review/reference/${m[1]}.md`).length > 0, m[0]);
});

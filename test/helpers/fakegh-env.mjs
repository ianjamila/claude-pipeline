// Test plumbing for the GitHub-facing commands: a scripted fake `gh` (test/fixtures/fake-gh.mjs) and a
// fake `codex`, both wired in through the same PIPELINE_GH / PIPELINE_CODEX overrides production uses.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fakeGhPath = join(fixtures, 'fake-gh.mjs');

// entries: [{ match, stdout|stdoutJson, stderr, code }] (first regex that matches the joined argv wins).
// `env` holds only the overrides; spawn callers merge it over process.env themselves.
export function createFakeGh(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-fakegh-'));
  const script = join(dir, 'script.json');
  const log = join(dir, 'log.jsonl');
  writeFileSync(script, JSON.stringify(entries));
  return {
    dir,
    env: { PIPELINE_GH: `node "${fakeGhPath}"`, PIPELINE_FAKE_GH_SCRIPT: script, PIPELINE_FAKE_GH_LOG: log },
    // Every gh call made so far, oldest first: { argv, cwd, stdin }.
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    // Joined argv of every call, for simple "was X run" assertions.
    lines() {
      return this.calls().map((c) => c.argv.join(' '));
    },
    // Swap in a new script (e.g. after a state change) without losing the log.
    setScript(next) {
      writeFileSync(script, JSON.stringify(next));
    },
  };
}

// A fake codex answering `--version` and `login status` with the given exit codes.
export function createFakeCodex({ versionCode = 0, loginCode = 0, version = 'codex-cli 9.9.9' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-fakecodex-'));
  const file = join(dir, 'fake-codex.mjs');
  writeFileSync(file, [
    'const a = process.argv.slice(2).join(" ");',
    `if (a === "--version") { process.stdout.write(${JSON.stringify(version)}); process.exit(${versionCode}); }`,
    `if (a === "login status") { process.stderr.write(${loginCode === 0 ? '"Logged in"' : '"Not logged in"'}); process.exit(${loginCode}); }`,
    'process.exit(97);',
  ].join('\n'));
  return { env: { PIPELINE_CODEX: `node "${file}"` } };
}

// A canonical 200 body for GET branches/{b}/protection that satisfies spec 6.6 for the given checks.
export function fullProtection(checks = ['ci']) {
  return {
    required_status_checks: { strict: false, contexts: [], checks: checks.map((context) => ({ context, app_id: null })) },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 0 },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}

export const REPO_VIEW = { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' }, url: 'https://github.com/acme/widgets' };

// codex-review reads the PR's triage comment before it admits a counted round (published history): a plain fake gh answers "no comment" with these
// entries, appended AFTER a test's own so a test that scripts the comments itself wins. (createCommentsGh answers both calls on its own.)
export const NO_COMMENTS = [
  { match: '^api user', stdout: 'me\n' },
  { match: '^api repos/\\S+/issues/\\d+/comments --paginate', stdoutJson: [] },
];

// A minimal valid .claude/pipeline.yml declaring the given enforcement mode and required checks.
// guardChecks stays false here: most tests are about the configured list, not the always-required guard contexts.
export const pipelineYml = (enforcement = 'github', checks = ['ci'], { guardChecks = false } = {}) => [
  'version: 1',
  'project: demo',
  `enforcement: ${enforcement}`,
  'verify:',
  '  full: npm run verify',
  '  quick: npm run verify:quick',
  'ci:',
  `  required_checks: [${checks.join(', ')}]`,
  `  guard_checks: ${guardChecks}`,
  '',
].join('\n');

// Like createFakeGh, but the fake REMEMBERS the PR's comments (test/fixtures/fake-gh-comments.mjs): a comment posted or edited by one call is what the
// next call lists, so publication can be tested end to end. `entries` answer everything that is not the viewer or the comment routes. Two checkouts that
// use the same `env` see each other's publications.
export function createCommentsGh(entries, { me = 'me', comments = [] } = {}) {
  const base = createFakeGh(entries);
  const state = join(base.dir, 'state.json');
  writeFileSync(state, JSON.stringify({ me, comments, seq: 0, fail: {} }));
  const read = () => JSON.parse(readFileSync(state, 'utf8'));
  return {
    ...base,
    env: { ...base.env, PIPELINE_GH: `node "${join(fixtures, 'fake-gh-comments.mjs')}"`, PIPELINE_FAKE_GH_STATE: state },
    // The PR's comments right now, and a way to change what the fake does next (fail: { write, list, writeAfter }).
    comments: () => read().comments,
    setFail(fail) { writeFileSync(state, JSON.stringify({ ...read(), fail })); },
    addComment(c) {
      const s = read();
      s.comments.push({ id: 5000 + s.comments.length, user: { login: s.me }, created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T09:00:00Z', ...c });
      writeFileSync(state, JSON.stringify(s));
    },
  };
}

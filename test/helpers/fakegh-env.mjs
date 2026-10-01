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

export const REPO_VIEW = { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } };

// A minimal valid .claude/pipeline.yml declaring the given enforcement mode and required checks.
export const pipelineYml = (enforcement = 'github', checks = ['ci']) => [
  'version: 1',
  'project: demo',
  `enforcement: ${enforcement}`,
  'verify:',
  '  full: npm run verify',
  '  quick: npm run verify:quick',
  'ci:',
  `  required_checks: [${checks.join(', ')}]`,
  '',
].join('\n');

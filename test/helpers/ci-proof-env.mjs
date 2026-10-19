// Shared scaffolding for the CI-proof gate tests (ci-proof-gate*.test.mjs): a gate scenario repo with a bare `origin`, report-row
// builders and a driver for verifyReportCheck with a fake CI lookup. Split over files only so node runs them in parallel.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { verifyReportCheck } from '../../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { treeFingerprint } from '../../pipeline/lib/git.mjs';
import { scenario, ymlFor, PR } from './gate-env.mjs';

export { PR };
export const SPEC = { workflow: '.github/workflows/ci.yml', job: 'Unit tests', event: 'pull_request' };
export const RUN = { id: 777, attempt: 2, jobId: 888, workflow: '.github/workflows/ci.yml', job: 'Unit tests', url: 'https://github.com/acme/widgets/actions/runs/777' };

// pipeline.yml text: the standard gate yml plus verify keys.
export const ymlWith = ({ skippable, deferrable = ['unit'], inputs, proof = true } = {}) => {
  const lines = [];
  if (skippable) lines.push(`  skippable_steps: [${skippable.join(', ')}]`);
  if (deferrable) lines.push(`  deferrable_steps: [${deferrable.join(', ')}]`);
  if (proof && deferrable) lines.push('  ci_proof:', ...deferrable.flatMap((n) => [`    ${n}:`, '      workflow: .github/workflows/ci.yml', '      job: Unit tests']));
  if (inputs) lines.push(`  ci_proof_inputs: [${inputs.join(', ')}]`);
  return ymlFor().replace('  quick: npm run verify:quick\n', `  quick: npm run verify:quick\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
};

export const ciRow = (r) => { r.steps[3] = { ...r.steps[3], status: 'skipped', skipKind: 'ci', skipReason: 'deferred to CI (.github/workflows/ci.yml#Unit tests)', exitCode: null }; };
export const kindRow = (kind, reason = 'no unit dependency changed') => (r) => {
  r.steps[3] = { ...r.steps[3], status: 'skipped', skipReason: reason, exitCode: null };
  if (kind !== undefined) r.steps[3].skipKind = kind;
};
export const legacyRow = (r) => { r.steps[3] = { ...r.steps[3], status: 'pass', skipped: true, command: '(skipped - no unit dependency changed)' }; };

export const made = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// A scenario repo with a bare `origin` holding the base (main). `change`: extra PR edits, committed with the feature.
export function setup({ yml = ymlWith(), baseFiles, change, report } = {}) {
  const s = scenario({
    yml, baseFiles, report,
    change: (repo) => {
      repo.write('src/app.js', 'export const a = 2;\n');
      change?.(repo);
    },
  });
  const origin = mkdtempSync(join(tmpdir(), 'cp-origin-'));
  made.push(origin);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  s.repo.git(['remote', 'add', 'origin', origin]);
  s.repo.git(['push', '-q', 'origin', 'main:main']);
  s.repo.git(['fetch', '-q', 'origin']);
  s.origin = origin;
  s.baseTip = s.repo.git(['rev-parse', 'origin/main']).trim();
  const reportFile = join(s.repo.dir, '.verify', 'report.json');
  const pristine = readFileSync(reportFile, 'utf8');
  // Re-writes the (gitignored) verify report from the pristine copy with `mutate` applied: one scenario serves many report shapes.
  s.setReport = (mutate) => {
    const r = JSON.parse(pristine);
    mutate?.(r);
    writeFileSync(reportFile, JSON.stringify(r, null, 2));
  };
  return s;
}

// Runs verifyReportCheck on the scenario with a fake ciProof (default: pass). -> { c, proofs, calls, gh, env }
export async function judge(s, ciProof = async () => ({ state: 'pass', reason: 'ok', run: RUN }), report) {
  if (report !== undefined) s.setReport(report);
  const { config } = await loadConfig(s.repo.dir);
  const calls = [];
  const proofs = [];
  const o = { cwd: s.repo.dir };
  const gh = { fake: true };
  const env = { MARK: '1' };
  const c = await verifyReportCheck({
    root: s.repo.dir, config, head: s.head, tree: treeFingerprint(o), o, pr: PR, gh, env, proofs,
    ciProof: async (args) => { calls.push(args); return ciProof(args); },
  });
  return { c, proofs, calls, gh, env };
}
export const accepted = (r, label) => assert.equal(r.c.ok, true, `${label}: ${r.c.detail}`);
export const refused = (r, text, label) => {
  assert.equal(r.c.ok, false, `${label}: expected a refusal`);
  assert.match(r.c.detail, text, label);
  assert.deepEqual(r.proofs, [], `${label}: a refused check records no proofs`);
};
export const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


// T2a: protected inputs. A PR that touches the CI setup, the pipeline config, the verify runner or a base ci_proof_inputs path gets no CI
// proof, whatever the lookup would say (split from ci-proof-gate.test.mjs so node runs the slow scenario matrix in parallel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyReportCheck } from '../pipeline/lib/finalgate.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { treeFingerprint } from '../pipeline/lib/git.mjs';
import { PR, accepted, ciRow, escapeRe, judge, refused, setup, ymlWith } from './helpers/ci-proof-env.mjs';

// ---- protected inputs ------------------------------------------------------------------------------

test('protected inputs: a PR touching .github/**, .claude/pipeline.yml, scripts/verify* or a base ci_proof_inputs glob gets no CI proof', async () => {
  const yml = ymlWith({ inputs: ['supabase/tests/**', 'package-lock.json'] });
  const baseFiles = { '.github/workflows/ci.yml': 'name: ci\n', 'supabase/tests/a.sql': 'select 1;\n', 'package-lock.json': '{}\n', 'scripts/verify.mjs': '// v\n' };
  const cases = [
    ['a new workflow', (repo) => repo.write('.github/workflows/x.yml', 'name: x\n'), '.github/workflows/x.yml'],
    ['an edited workflow', (repo) => repo.write('.github/workflows/ci.yml', 'name: ci2\n'), '.github/workflows/ci.yml'],
    ['the pipeline config', (repo) => repo.write('.claude/pipeline.yml', `${yml}# touched\n`), '.claude/pipeline.yml'],
    ['scripts/verify.mjs', (repo) => repo.write('scripts/verify.mjs', '// changed\n'), 'scripts/verify.mjs'],
    ['another scripts/verify* file', (repo) => repo.write('scripts/verify-extra.mjs', '// x\n'), 'scripts/verify-extra.mjs'],
    ['a file under a scripts/verify* directory', (repo) => repo.write('scripts/verify-lib/helper.mjs', '// x\n'), 'scripts/verify-lib/helper.mjs'],
    ['a ci_proof_inputs glob', (repo) => repo.write('supabase/tests/b.sql', 'select 2;\n'), 'supabase/tests/b.sql'],
    ['a ci_proof_inputs file', (repo) => repo.write('package-lock.json', '{"a":1}\n'), 'package-lock.json'],
    ['a rename OUT of a protected path', (repo) => { repo.rm('.github/workflows/ci.yml'); repo.write('docs/moved-ci.yml', 'name: ci\n'); }, '.github/workflows/ci.yml'],
    ['a rename OUT of a ci_proof_inputs path', (repo) => { repo.rm('supabase/tests/a.sql'); repo.write('docs/a.sql', 'select 1;\n'); }, 'supabase/tests/a.sql'],
    ['a rename INTO a protected path', (repo) => { repo.rm('docs/guide.md'); repo.write('.github/guide.md', '# Guide\n'); }, '.github/guide.md'],
    ['a deleted protected file', (repo) => repo.rm('scripts/verify.mjs'), 'scripts/verify.mjs'],
  ];
  for (const [label, change, file] of cases) {
    const s = setup({ yml, baseFiles, change, report: ciRow });
    const r = await judge(s);
    refused(r, new RegExp(`ci-proof-missing:unit \\(this PR changes ${escapeRe(file)},`), label);
    assert.equal(r.calls.length, 0, `${label}: no lookup for an ineligible PR`);
  }
  // control: the same setup with an unrelated change is eligible
  const ok = await judge(setup({ yml, baseFiles, change: (repo) => repo.write('src/other.js', 'export {};\n'), report: ciRow }));
  accepted(ok, 'unrelated change');
  assert.equal(ok.calls.length, 1);
});

test('ci_proof_inputs are read from the BASE: a glob the PR adds to its own config protects nothing, a base glob cannot be dropped by the PR', async () => {
  // PR config adds an input glob: it changes .claude/pipeline.yml, so the proof is refused anyway (the base is what counts)
  const s = setup({ yml: ymlWith(), baseFiles: { 'lib/x.js': 'x\n' }, change: (repo) => repo.write('.claude/pipeline.yml', ymlWith({ inputs: ['lib/**'] })), report: ciRow });
  refused(await judge(s), /this PR changes \.claude\/pipeline\.yml/, 'PR adds a glob');
  // PR removes the base's glob from its config AND touches a file the base's glob covers
  const t = setup({ yml: ymlWith({ inputs: ['lib/**'] }), baseFiles: { 'lib/x.js': 'x\n' }, change: (repo) => { repo.write('.claude/pipeline.yml', ymlWith()); repo.write('lib/x.js', 'y\n'); }, report: ciRow });
  refused(await judge(t), /this PR changes (\.claude\/pipeline\.yml|lib\/x\.js)/, 'PR drops the glob');
  // a base glob alone (config untouched by the PR) still protects
  const u = setup({ yml: ymlWith({ inputs: ['lib/**'] }), baseFiles: { 'lib/x.js': 'x\n' }, change: (repo) => repo.write('lib/x.js', 'y\n'), report: ciRow });
  refused(await judge(u), /this PR changes lib\/x\.js/, 'base glob');
});

test('a PR diff that cannot be read is ineligible (fail closed)', async () => {
  const s = setup({ report: ciRow });
  // the base ref exists, but HEAD shares no history with it
  s.repo.git(['checkout', '-q', '--orphan', 'unrelated']);
  s.repo.write('x.txt', 'x\n');
  s.repo.commit('unrelated history');
  const head = s.repo.git(['rev-parse', 'HEAD']).trim();
  const { config } = await loadConfig(s.repo.dir);
  const proofs = [];
  const c = await verifyReportCheck({
    root: s.repo.dir, config, head, tree: treeFingerprint({ cwd: s.repo.dir }), o: { cwd: s.repo.dir }, pr: PR, gh: {}, env: {}, proofs,
    ciProof: async () => assert.fail('no lookup'),
  });
  assert.equal(c.ok, false);
  assert.match(c.detail, /ci-proof-missing:unit/);
  assert.deepEqual(proofs, []);
});


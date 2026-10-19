import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../pipeline/lib/yaml.mjs';
import { DEFAULTS, GUARD_CHECKS, requiredChecks, stopHookTimeoutWarning, validateConfig, loadConfig, fill } from '../pipeline/lib/config.mjs';
import { MAX_PROOFS, MAX_PROOF_STEP, normaliseProofs, proofsProblem } from '../pipeline/lib/run-record.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => parseYaml(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const minimal = () => ({ version: 1, project: 'p', verify: { full: 'f', quick: 'q' } });
const has = (r, text) => r.errors.some((e) => e.includes(text));

test('minimal valid config is ok and defaults are filled', () => {
  const r = validateConfig(fixture('pipeline-valid.yml'));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.review.max_rounds, 3);
  assert.equal(r.config.merge.command, DEFAULTS.merge.command);
  assert.equal(r.config.project, 'demo-app');
  assert.equal(r.config.verify.report, '.verify/report.json');
  assert.equal(r.config.verify.full, 'npm run verify');
  assert.equal(r.config.preview, null);
  assert.equal(r.config.production, null);
});

test('validateConfig does not mutate DEFAULTS or its input', () => {
  const input = minimal();
  const before = JSON.stringify(input);
  const r = validateConfig(input);
  r.config.ci.required_checks.push('x');
  r.config.review.effort.low = 'high';
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(DEFAULTS.ci.required_checks, []);
  assert.equal(DEFAULTS.review.effort.low, 'medium');
  // DEFAULTS is deep-frozen; the merged config is a fresh, mutable copy.
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.ci.required_checks));
  assert.ok(Object.isFrozen(DEFAULTS.review.effort) && Object.isFrozen(DEFAULTS.integrity.test_globs));
  assert.throws(() => { 'use strict'; DEFAULTS.ci.required_checks.push('x'); }, TypeError);
  assert.ok(!Object.isFrozen(r.config) && !Object.isFrozen(r.config.ci.required_checks));
});

test('realistic eaglewatch config is ok', () => {
  const r = validateConfig(fixture('pipeline-eaglewatch.yml'));
  assert.equal(r.ok, true, r.errors.join('; '));
  const c = r.config;
  assert.equal(c.merge.command, 'npm run merge -- {pr} --no-update --expect-head {sha}');
  assert.equal(c.ci.required_checks.length, 5);
  assert.equal(c.preview.environment, 'Preview');
  assert.equal(c.preview.provider, 'github-deployments');
  assert.equal(c.production.url, 'https://ewiapp.eaglewatch.ph');
  assert.equal(c.production.provider, 'vercel');
  assert.equal(c.production.rollback.command, 'vercel rollback --yes');
  assert.ok(c.hard_stops.paths.includes('supabase/migrations/**'));
  assert.equal(c.hard_stops.patterns[0].name, 'facial-recognition');
  assert.deepEqual(c.hard_stops.auth_calls, ['requireSAScope', 'getAccessibleDetachmentIds']);
  assert.equal(c.smoke_checks.length, 2);
  // arrays replace, objects merge
  assert.deepEqual(c.integrity.test_globs, ['**/*.test.*', 'e2e/**']);
  assert.equal(c.review.effort.high, 'xhigh');
  assert.equal(c.review.effort.low, 'medium');
});

test('production defaults: provider and deploy_timeout_minutes', () => {
  const r = validateConfig({
    ...minimal(),
    production: {
      url: 'https://x.example.com',
      environment: 'Production',
      smoke: 'curl {url}',
      rollback: { command: 'undo' },
    },
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.config.production.deploy_timeout_minutes, 20);
  assert.equal(r.config.production.provider, 'github-deployments');
  assert.equal(r.config.production.watch, 'session');
});

test('production.watch: session|workflow accepted, anything else rejected naming the key', () => {
  const base = { url: 'https://x.example.com', environment: 'Production', smoke: 'curl {url}', rollback: { command: 'undo' } };
  const withWatch = (watch) => validateConfig({ ...minimal(), production: { ...base, watch } });
  for (const ok of ['session', 'workflow']) {
    const r = withWatch(ok);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.config.production.watch, ok);
  }
  for (const bad of ['', 'Workflow', 'ci', 'both', true, 1, null, [], {}]) {
    const r = withWatch(bad);
    assert.equal(r.ok, false, `watch = ${JSON.stringify(bad)}`);
    assert.ok(has(r, 'production.watch must be one of session|workflow'), r.errors.join(' | '));
  }
});

test('missing version is rejected', () => {
  const o = minimal();
  delete o.version;
  const r = validateConfig(o);
  assert.equal(r.ok, false);
  assert.ok(has(r, 'version must be 1'));
});

test('version other than 1 is rejected', () => {
  const r = validateConfig({ ...minimal(), version: 2 });
  assert.ok(has(r, 'version must be 1'));
});

test('missing project is rejected', () => {
  const o = minimal();
  delete o.project;
  assert.ok(has(validateConfig(o), 'project'));
  assert.ok(has(validateConfig({ ...minimal(), project: '' }), 'project'));
});

test('bad enforcement is rejected', () => {
  const r = validateConfig({ ...minimal(), enforcement: 'yolo' });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'github|gate'));
  assert.equal(validateConfig({ ...minimal(), enforcement: 'gate' }).ok, true);
});

test('owner_approval: defaults to label, accepts label|chat, rejects anything else', () => {
  assert.equal(DEFAULTS.owner_approval, 'label');
  assert.equal(validateConfig(minimal()).config.owner_approval, 'label');
  assert.equal(validateConfig({ ...minimal(), owner_approval: 'chat' }).config.owner_approval, 'chat');
  assert.equal(validateConfig({ ...minimal(), owner_approval: 'label' }).ok, true);
  for (const bad of ['yolo', 'Chat', '', null, true, ['chat']]) {
    const r = validateConfig({ ...minimal(), owner_approval: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(has(r, 'owner_approval must be label|chat'), JSON.stringify(bad));
  }
});

test('merge.command without {sha} is rejected (and without {pr})', () => {
  const noSha = validateConfig({ ...minimal(), merge: { command: 'gh pr merge {pr} --squash' } });
  assert.equal(noSha.ok, false);
  assert.ok(has(noSha, '{sha}'));
  const noPr = validateConfig({ ...minimal(), merge: { command: 'gh pr merge --match-head-commit {sha}' } });
  assert.ok(has(noPr, '{pr}'));
});

test('missing verify.full / verify.quick is rejected', () => {
  const noFull = validateConfig({ ...minimal(), verify: { quick: 'q' } });
  assert.equal(noFull.ok, false);
  assert.ok(has(noFull, 'verify.full'));
  const noQuick = validateConfig({ ...minimal(), verify: { full: 'f' } });
  assert.ok(has(noQuick, 'verify.quick'));
  const noVerify = minimal();
  delete noVerify.verify;
  const r = validateConfig(noVerify);
  assert.ok(has(r, 'verify.full') && has(r, 'verify.quick'));
});

test('review.max_rounds outside 1..5 is rejected; effort values validated', () => {
  const r = validateConfig({ ...minimal(), review: { max_rounds: 9 } });
  assert.equal(r.ok, false);
  assert.ok(has(r, '1..5'));
  assert.ok(has(validateConfig({ ...minimal(), review: { max_rounds: 2.5 } }), '1..5'));
  assert.ok(has(validateConfig({ ...minimal(), review: { max_rounds: 0 } }), '1..5'));
  assert.equal(validateConfig({ ...minimal(), review: { max_rounds: 5 } }).ok, true);
  const e = validateConfig({ ...minimal(), review: { effort: { high: 'ultra' } } });
  assert.ok(has(e, 'review.effort.high'));
});

test('production without smoke is rejected; production: null is ok', () => {
  const r = validateConfig({
    ...minimal(),
    production: { url: 'https://x.example.com', environment: 'Production', rollback: { command: 'undo' } },
  });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'production.smoke'));
  assert.equal(validateConfig({ ...minimal(), production: null }).ok, true);
});

test('production field validation: url, rollback, provider, timeout, {url} in smoke', () => {
  const base = {
    url: 'https://x.example.com',
    environment: 'Production',
    smoke: 'curl {url}',
    rollback: { command: 'undo' },
  };
  const bad = (patch) => validateConfig({ ...minimal(), production: { ...base, ...patch } });
  assert.ok(has(bad({ url: 'http://x.example.com' }), 'production.url'));
  assert.ok(has(bad({ smoke: 'curl nothing' }), '{url}'));
  assert.ok(has(bad({ rollback: {} }), 'production.rollback.command'));
  assert.ok(has(bad({ rollback: undefined }), 'production.rollback.command'));
  assert.ok(has(bad({ provider: 'heroku' }), 'production.provider'));
  assert.ok(has(bad({ deploy_timeout_minutes: 500 }), 'deploy_timeout_minutes'));
  assert.ok(has(bad({ environment: '' }), 'production.environment'));
  assert.equal(bad({ provider: 'other', deploy_timeout_minutes: 120 }).ok, true);
});

test('preview field validation', () => {
  const bad = (preview) => validateConfig({ ...minimal(), preview });
  assert.equal(bad({ environment: 'Preview', smoke: 'curl {url}' }).ok, true);
  assert.ok(has(bad({ smoke: 'curl {url}' }), 'preview.environment'));
  assert.ok(has(bad({ environment: 'Preview', smoke: 'curl x' }), '{url}'));
  assert.ok(has(bad({ environment: 'Preview' }), 'preview.smoke'));
});

test('string-array fields must be arrays of strings', () => {
  const cases = [
    ['hard_stops', { paths: 'x' }, 'hard_stops.paths'],
    ['hard_stops', { auth_calls: [1] }, 'hard_stops.auth_calls'],
    ['risk', { high_risk_paths: [null] }, 'risk.high_risk_paths'],
    ['integrity', { test_globs: 'x' }, 'integrity.test_globs'],
    ['ci', { required_checks: [{}] }, 'ci.required_checks'],
  ];
  for (const [key, val, expected] of cases) {
    const r = validateConfig({ ...minimal(), [key]: val });
    assert.equal(r.ok, false, expected);
    assert.ok(has(r, expected), `${expected}: ${r.errors.join('; ')}`);
  }
});

test('invalid hard_stops pattern regex is rejected and names the pattern', () => {
  const r = validateConfig({ ...minimal(), hard_stops: { patterns: [{ name: 'broken-one', regex: '(' }] } });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'broken-one'));
});

test('hard_stops pattern shape: name, regex, optional paths', () => {
  assert.equal(
    validateConfig({ ...minimal(), hard_stops: { patterns: [{ name: 'a', regex: 'x', paths: ['src/**'] }] } }).ok,
    true,
  );
  assert.ok(has(validateConfig({ ...minimal(), hard_stops: { patterns: [{ regex: 'x' }] } }), 'name'));
  assert.ok(has(validateConfig({ ...minimal(), hard_stops: { patterns: [{ name: 'a' }] } }), 'regex'));
  assert.ok(has(validateConfig({ ...minimal(), hard_stops: { patterns: [{ name: 'a', regex: 'x', paths: 'src' }] } }), 'paths'));
  assert.ok(has(validateConfig({ ...minimal(), hard_stops: { patterns: 'nope' } }), 'hard_stops.patterns'));
});

test('smoke_checks item shape', () => {
  const ok = validateConfig({
    ...minimal(),
    smoke_checks: [{ path: '/login', status: [200], contains: ['Sign in'], location_contains: '/x' }],
  });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  const bad = (item) => validateConfig({ ...minimal(), smoke_checks: [item] });
  assert.ok(has(bad({ path: 'login' }), 'smoke_checks[0].path'));
  assert.ok(has(bad({ path: '/x', status: ['200'] }), 'smoke_checks[0].status'));
  assert.ok(has(bad({ path: '/x', contains: 'a' }), 'smoke_checks[0].contains'));
  assert.ok(has(bad({ path: '/x', location_contains: 5 }), 'smoke_checks[0].location_contains'));
  assert.ok(has(validateConfig({ ...minimal(), smoke_checks: 'x' }), 'smoke_checks'));
});

test('unknown top-level key (typo) is rejected', () => {
  const r = validateConfig({ ...minimal(), verfy: { full: 'x' } });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'unknown key: verfy'));
});

test('multiple errors are reported together', () => {
  const r = validateConfig({
    version: 3,
    enforcement: 'nope',
    merge: { command: 'gh pr merge' },
    review: { max_rounds: 99 },
    verfy: {},
  });
  assert.equal(r.ok, false);
  for (const text of ['version must be 1', 'project', 'github|gate', 'verify.full', 'verify.quick', '{pr}', '{sha}', '1..5', 'unknown key: verfy']) {
    assert.ok(has(r, text), `missing error containing "${text}": ${r.errors.join(' | ')}`);
  }
  assert.ok(r.errors.length >= 8);
});

test('non-object input yields an error rather than throwing', () => {
  for (const bad of [null, undefined, 'x', 5, [], true]) {
    const r = validateConfig(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 1);
  }
});

test('loadConfig: missing file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const r = await loadConfig(dir);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['missing .claude/pipeline.yml']);
  assert.equal(r.config, null);
  assert.equal(r.path, path.join(dir, '.claude', 'pipeline.yml'));
});

test('loadConfig: reads and validates a real file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.copyFileSync(path.join(fixtures, 'pipeline-valid.yml'), path.join(dir, '.claude', 'pipeline.yml'));
  const r = await loadConfig(dir);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.config.project, 'demo-app');
  assert.equal(r.path, path.join(dir, '.claude', 'pipeline.yml'));
});

test('loadConfig: bad YAML reports the parse error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'pipeline.yml'), 'a: [1,\n');
  const r = await loadConfig(dir);
  assert.equal(r.ok, false);
  assert.equal(r.config, null);
  assert.match(r.errors[0], /YAML parse error/);
});

test('loadConfig: readFile is injectable; non-ENOENT errors are surfaced', async () => {
  const r = await loadConfig('/nowhere', {
    readFile: async () => 'version: 1\nproject: p\nverify:\n  full: f\n  quick: q\n',
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  const denied = await loadConfig('/nowhere', {
    readFile: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  });
  assert.equal(denied.ok, false);
  assert.match(denied.errors[0], /EACCES/);
});

test('loadConfig: empty file or non-mapping YAML is an error, not a crash', async () => {
  const empty = await loadConfig('/x', { readFile: async () => '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.config, null);
  const list = await loadConfig('/x', { readFile: async () => '- a\n- b\n' });
  assert.equal(list.ok, false);
});

test('fill replaces known {name} and leaves unknown untouched', () => {
  assert.equal(fill('npm run merge -- {pr} --expect-head {sha}', { pr: 12, sha: 'abc' }), 'npm run merge -- 12 --expect-head abc');
  assert.equal(fill('{url}/login', {}), '{url}/login');
  assert.equal(fill('{a} {b}', { a: 1 }), '1 {b}');
  assert.equal(fill('{pr}-{pr}', { pr: 7 }), '7-7');
  assert.equal(fill('x {n}', { n: 0 }), 'x 0');
  assert.equal(fill('{toString} {constructor}', {}), '{toString} {constructor}');
});

// ---- stricter validation (fail-closed) ----

test('default merge command is exactly the safe default (pins head with {sha})', () => {
  const r = validateConfig(minimal());
  assert.equal(r.config.merge.command, 'gh pr merge {pr} --squash --auto --delete-branch --match-head-commit {sha}');
});

test('invalid config returns config: null so nobody can run on it', () => {
  const r = validateConfig({ ...minimal(), enforcement: 'yolo' });
  assert.equal(r.ok, false);
  assert.equal(r.config, null);
  assert.ok(validateConfig(minimal()).config !== null);
});

test('unknown keys are rejected per section, with the dotted path', () => {
  const cases = [
    [{ hard_stops: { path: ['x'] } }, 'unknown key: hard_stops.path'],
    [{ risk: { high_risk_path: [] } }, 'unknown key: risk.high_risk_path'],
    [{ integrity: { test_glob: [] } }, 'unknown key: integrity.test_glob'],
    [{ verify: { full: 'f', quick: 'q', ful: 'x' } }, 'unknown key: verify.ful'],
    [{ ci: { required_check: [] } }, 'unknown key: ci.required_check'],
    [{ merge: { comand: 'x' } }, 'unknown key: merge.comand'],
    [{ review: { max_round: 2 } }, 'unknown key: review.max_round'],
    [{ review: { effort: { urgent: 'high' } } }, 'unknown key: review.effort.urgent'],
    [{ preview: { environment: 'P', smoke: 'curl {url}', provder: 'x' } }, 'unknown key: preview.provder'],
    [
      { production: { url: 'https://x.example.com', environment: 'P', smoke: 'curl {url}', rollback: { command: 'u' }, rolback: {} } },
      'unknown key: production.rolback',
    ],
    [
      { production: { url: 'https://x.example.com', environment: 'P', smoke: 'curl {url}', rollback: { command: 'u', note: 'n' } } },
      'unknown key: production.rollback.note',
    ],
    [{ hard_stops: { patterns: [{ name: 'a', regex: 'x', path: ['src'] }] } }, 'unknown key: hard_stops.patterns[0].path'],
    [{ smoke_checks: [{ path: '/x', contain: ['a'] }] }, 'unknown key: smoke_checks[0].contain'],
  ];
  for (const [patch, expected] of cases) {
    const r = validateConfig({ ...minimal(), ...patch });
    assert.equal(r.ok, false, expected);
    assert.ok(has(r, expected), `${expected}: ${r.errors.join(' | ')}`);
  }
});

test('effort lanes must be exactly low|medium|high|followup', () => {
  const r = validateConfig({ ...minimal(), review: { effort: { xhigh: 'high' } } });
  assert.ok(has(r, 'unknown key: review.effort.xhigh'));
  const ok = validateConfig({ ...minimal(), review: { effort: { low: 'low', medium: 'medium', high: 'xhigh', followup: 'high' } } });
  assert.equal(ok.ok, true, ok.errors.join('; '));
});

test('inherited and __proto__ names are flagged as unknown keys (own-property check)', () => {
  const top = JSON.parse(
    '{"version":1,"project":"p","verify":{"full":"f","quick":"q"},"__proto__":{"x":1},"constructor":1,"toString":2}',
  );
  const r = validateConfig(top);
  assert.equal(r.ok, false);
  for (const k of ['__proto__', 'constructor', 'toString']) assert.ok(has(r, `unknown key: ${k}`), `${k}: ${r.errors.join(' | ')}`);
  const nested = validateConfig({ ...minimal(), verify: JSON.parse('{"full":"f","quick":"q","constructor":"x","__proto__":"y"}') });
  assert.ok(has(nested, 'unknown key: verify.constructor'));
  assert.ok(has(nested, 'unknown key: verify.__proto__'));
  const lanes = validateConfig({ ...minimal(), review: { effort: JSON.parse('{"toString":"high"}') } });
  assert.ok(has(lanes, 'unknown key: review.effort.toString'));
});

test('removed keys stay unknown: review.exempt_docs_only and top-level labels', () => {
  const r = validateConfig({ ...minimal(), review: { exempt_docs_only: true }, labels: ['x'] });
  assert.ok(has(r, 'unknown key: review.exempt_docs_only'));
  assert.ok(has(r, 'unknown key: labels'));
});

test('numeric fields must be finite positive integers, and the error names the key', () => {
  const keys = [
    ['review', 'light_lane_max_lines'], ['review', 'max_rounds'], ['risk', 'medium_lines'], ['risk', 'high_lines'],
    ['risk', 'medium_files'], ['production', 'deploy_timeout_minutes'],
  ];
  const withValue = (section, key, v) => {
    const base = minimal();
    if (section === 'production') base.production = { url: 'https://x.example.com', environment: 'Production', smoke: 'curl {url}', rollback: { command: 'undo' } };
    return validateConfig({ ...base, [section]: { ...(base[section] ?? {}), [key]: v } });
  };
  for (const [section, key] of keys) {
    for (const bad of [0, -1, 1.5, Infinity, -Infinity, NaN, '10', null, true, [], {}]) {
      const r = withValue(section, key, bad);
      assert.equal(r.ok, false, `${section}.${key} = ${String(bad)}`);
      assert.ok(has(r, `${section}.${key}`), `${section}.${key} = ${String(bad)}: ${r.errors.join(' | ')}`);
    }
  }
  // the defaults and an ordinary value still validate
  assert.equal(validateConfig(minimal()).ok, true);
  assert.equal(withValue('risk', 'medium_files', 1).ok, true);
});

test('verify.expected_steps: optional non-empty list of unique step names', () => {
  const ok = validateConfig({ ...minimal(), verify: { ...minimal().verify, expected_steps: ['install', 'lint'] } });
  assert.equal(ok.ok, true, ok.errors.join('|'));
  assert.deepEqual(ok.config.verify.expected_steps, ['install', 'lint']);
  assert.equal(validateConfig(minimal()).config.verify.expected_steps, undefined, 'absent by default');
  for (const bad of [[], 'install', ['a', 'a'], ['a', ''], ['a', 3], null, {}]) {
    const r = validateConfig({ ...minimal(), verify: { ...minimal().verify, expected_steps: bad } });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(has(r, 'verify.expected_steps'), r.errors.join('|'));
  }
});

test('numeric fields reject negatives, fractions, strings, null and booleans', () => {
  const cases = [
    [{ risk: { medium_lines: -1 } }, 'risk.medium_lines'],
    [{ risk: { medium_lines: 1.5 } }, 'risk.medium_lines'],
    [{ risk: { medium_lines: '150' } }, 'risk.medium_lines'],
    [{ risk: { high_lines: -5 } }, 'risk.high_lines'],
    [{ risk: { high_lines: null } }, 'risk.high_lines'],
    [{ risk: { medium_files: 'ten' } }, 'risk.medium_files'],
    [{ risk: { medium_files: -1 } }, 'risk.medium_files'],
    [{ review: { light_lane_max_lines: -1 } }, 'review.light_lane_max_lines'],
    [{ review: { light_lane_max_lines: true } }, 'review.light_lane_max_lines'],
  ];
  for (const [patch, expected] of cases) {
    const r = validateConfig({ ...minimal(), ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(has(r, expected), `${expected}: ${r.errors.join(' | ')}`);
  }
});

test('merge.wait_minutes must be an integer 1..120', () => {
  for (const bad of [0, -3, 121, 2.5, '15', null]) {
    const r = validateConfig({ ...minimal(), merge: { wait_minutes: bad } });
    assert.ok(has(r, 'merge.wait_minutes'), `${bad}: ${r.errors.join(' | ')}`);
  }
  assert.equal(validateConfig({ ...minimal(), merge: { wait_minutes: 1 } }).ok, true);
  assert.equal(validateConfig({ ...minimal(), merge: { wait_minutes: 120 } }).ok, true);
});

test('risk.medium_lines <= risk.high_lines, and light_lane_max_lines <= risk.medium_lines', () => {
  const inverted = validateConfig({ ...minimal(), risk: { medium_lines: 700, high_lines: 600 } });
  assert.ok(has(inverted, 'risk.medium_lines must be <= risk.high_lines'), inverted.errors.join(' | '));
  assert.equal(validateConfig({ ...minimal(), risk: { medium_lines: 600, high_lines: 600 } }).ok, true);
  const light = validateConfig({ ...minimal(), risk: { medium_lines: 40 } });
  assert.ok(has(light, 'review.light_lane_max_lines must be <= risk.medium_lines'), light.errors.join(' | '));
  const lightOk = validateConfig({ ...minimal(), risk: { medium_lines: 40 }, review: { light_lane_max_lines: 40 } });
  assert.equal(lightOk.ok, true, lightOk.errors.join('; '));
});

test('production.deploy_timeout_minutes: 0 is rejected (and 121, 1.5)', () => {
  const prod = (n) => ({
    ...minimal(),
    production: { url: 'https://x.example.com', environment: 'P', smoke: 'curl {url}', rollback: { command: 'u' }, deploy_timeout_minutes: n },
  });
  for (const bad of [0, 121, 1.5, -1]) assert.ok(has(validateConfig(prod(bad)), 'deploy_timeout_minutes'), String(bad));
  assert.equal(validateConfig(prod(1)).ok, true);
});

test('smoke_checks[].status must be a non-empty array of integers 100..599', () => {
  const bad = (status) => validateConfig({ ...minimal(), smoke_checks: [{ path: '/x', status }] });
  for (const s of [[], [99], [600], [200.5], ['200'], 200]) {
    assert.ok(has(bad(s), 'smoke_checks[0].status'), JSON.stringify(s));
  }
  assert.equal(bad([100, 599]).ok, true);
  assert.equal(validateConfig({ ...minimal(), smoke_checks: [{ path: '/x' }] }).ok, true);
});

test('fill never interprets $ patterns in values', () => {
  assert.equal(fill('x {v} y', { v: '$&' }), 'x $& y');
  assert.equal(fill('x {v} y', { v: '$1' }), 'x $1 y');
  assert.equal(fill('x {v} y', { v: "$'" }), "x $' y");
  assert.equal(fill('x {v} y', { v: '$`' }), 'x $` y');
  assert.equal(fill('x {v} y', { v: '$$' }), 'x $$ y');
});

test('fill strict: throws on missing, undefined, null or empty values for placeholders in the template', () => {
  const tpl = 'npm run merge -- {pr} --expect-head {sha}';
  assert.equal(fill(tpl, { pr: 12, sha: 'abc' }, { strict: true }), 'npm run merge -- 12 --expect-head abc');
  assert.throws(() => fill(tpl, { pr: 12, sha: undefined }, { strict: true }), /sha/);
  assert.throws(() => fill(tpl, { pr: 12, sha: '' }, { strict: true }), /sha/);
  assert.throws(() => fill(tpl, { pr: 12, sha: null }, { strict: true }), /sha/);
  assert.throws(() => fill(tpl, { pr: 12 }, { strict: true }), /sha/);
  assert.throws(() => fill('{url}/login', {}, { strict: true }), /url/);
  // every missing name is reported
  assert.throws(() => fill(tpl, {}, { strict: true }), (e) => /pr/.test(e.message) && /sha/.test(e.message));
  // values for names the template does not use are irrelevant
  assert.equal(fill('{pr}', { pr: 3, sha: undefined }, { strict: true }), '3');
  // 0 is a real value
  assert.equal(fill('{n}', { n: 0 }, { strict: true }), '0');
  // non-strict behaviour is unchanged
  assert.equal(fill('{url}/login', {}), '{url}/login');
  assert.equal(fill('{url}/login', {}, { strict: false }), '{url}/login');
});

// ---- shell ${VAR} is not a placeholder; remaining type checks ----

test('fill leaves shell ${VAR} untouched in both modes', () => {
  const tpl = 'deploy --token ${PREVIEW_TOKEN} --pr {pr} --sha {sha}';
  const want = 'deploy --token ${PREVIEW_TOKEN} --pr 12 --sha abc';
  assert.equal(fill(tpl, { pr: 12, sha: 'abc' }), want);
  assert.equal(fill(tpl, { pr: 12, sha: 'abc' }, { strict: true }), want);
  // even when vars happens to hold the same name, ${name} is shell syntax and is not substituted
  assert.equal(fill('echo ${pr} {pr}', { pr: 7 }), 'echo ${pr} 7');
  assert.equal(fill('echo ${pr} {pr}', { pr: 7 }, { strict: true }), 'echo ${pr} 7');
  // strict does not count ${VAR} as missing, but still throws for a real missing placeholder
  assert.equal(fill('--token ${PREVIEW_TOKEN}', {}, { strict: true }), '--token ${PREVIEW_TOKEN}');
  assert.throws(() => fill('--token ${PREVIEW_TOKEN} {sha}', {}, { strict: true }), (e) => /sha/.test(e.message) && !/PREVIEW_TOKEN/.test(e.message));
});

test('verify.report / verify.screenshots must be non-empty strings', () => {
  for (const key of ['report', 'screenshots']) {
    for (const bad of ['', '   ', 5, null, ['x']]) {
      const r = validateConfig({ ...minimal(), verify: { full: 'f', quick: 'q', [key]: bad } });
      assert.ok(has(r, `verify.${key}`), `${key}=${JSON.stringify(bad)}: ${r.errors.join(' | ')}`);
    }
  }
  assert.equal(validateConfig({ ...minimal(), verify: { full: 'f', quick: 'q', report: 'r.json', screenshots: 'shots' } }).ok, true);
});

test('ci.e2e_label must be a string or null; ci.draft_while_iterating must be a boolean', () => {
  for (const bad of [5, true, ['x'], {}]) {
    assert.ok(has(validateConfig({ ...minimal(), ci: { e2e_label: bad } }), 'ci.e2e_label'), JSON.stringify(bad));
  }
  assert.equal(validateConfig({ ...minimal(), ci: { e2e_label: 'run-e2e' } }).ok, true);
  assert.equal(validateConfig({ ...minimal(), ci: { e2e_label: null } }).ok, true);
  for (const bad of ['yes', 1, 0, null, []]) {
    assert.ok(has(validateConfig({ ...minimal(), ci: { draft_while_iterating: bad } }), 'ci.draft_while_iterating'), JSON.stringify(bad));
  }
  assert.equal(validateConfig({ ...minimal(), ci: { draft_while_iterating: true } }).ok, true);
});

test('ci.guard_checks defaults to true, must be a boolean, and requiredChecks adds the two guard contexts', () => {
  const r = validateConfig(minimal());
  assert.equal(r.config.ci.guard_checks, true);
  assert.deepEqual(requiredChecks(r.config.ci), ['Test integrity', 'Hard-stop scan']);
  assert.deepEqual(requiredChecks({ required_checks: ['build', 'Test integrity'], guard_checks: true }), ['build', 'Test integrity', 'Hard-stop scan']);
  assert.deepEqual(requiredChecks({ required_checks: ['build'], guard_checks: false }), ['build']);
  assert.deepEqual([...GUARD_CHECKS], ['Test integrity', 'Hard-stop scan']);
  const bad = validateConfig({ ...minimal(), ci: { guard_checks: 'no' } });
  assert.equal(bad.ok, false);
  assert.ok(has(bad, 'ci.guard_checks must be a boolean'));
});

test('required_checks that omit the guard contexts WARN (not fail); guard_checks: false or listing them is silent', () => {
  const omitted = validateConfig({ ...minimal(), ci: { required_checks: ['build'] } });
  assert.equal(omitted.ok, true);
  assert.equal(omitted.warnings.length, 1);
  assert.match(omitted.warnings[0], /"Test integrity" and "Hard-stop scan"/);
  assert.equal(validateConfig(minimal()).warnings.length, 1, 'the default [] omits them too');
  assert.deepEqual(validateConfig({ ...minimal(), ci: { required_checks: ['Test integrity', 'Hard-stop scan', 'build'] } }).warnings, []);
  assert.deepEqual(validateConfig({ ...minimal(), ci: { required_checks: ['build'], guard_checks: false } }).warnings, []);
  assert.match(validateConfig({ ...minimal(), ci: { required_checks: ['Test integrity'] } }).warnings[0], /"Hard-stop scan"/);
});

test('ci.approvers: defaults to [], accepts GitHub logins (incl. bots), rejects anything else', () => {
  assert.deepEqual(validateConfig(minimal()).config.ci.approvers, []);
  assert.equal(validateConfig({ ...minimal(), ci: { approvers: ['alice', 'Bob-2', 'dependabot[bot]'] } }).ok, true);
  for (const bad of ['alice', [''], ['a b'], [1], ['-x'], ['a/b']]) {
    const r = validateConfig({ ...minimal(), ci: { approvers: bad } });
    assert.ok(has(r, 'ci.approvers must be an array of GitHub logins'), JSON.stringify(bad));
  }
});

test('verify.stop_queue_wait_minutes: defaults to 0, accepts 0..30, rejects anything else naming the key', () => {
  const withMinutes = (v) => validateConfig({ ...minimal(), verify: { ...minimal().verify, stop_queue_wait_minutes: v } });
  assert.equal(validateConfig(minimal()).config.verify.stop_queue_wait_minutes, 0);
  assert.equal(validateConfig(minimal()).ok, true);
  for (const good of [0, 1, 5, 30]) {
    const r = withMinutes(good);
    assert.equal(r.ok, true, `${good}: ${r.errors.join('; ')}`);
    assert.equal(r.config.verify.stop_queue_wait_minutes, good);
  }
  for (const bad of [-1, 31, 1.5, '5', null, true, [], {}, NaN, Infinity]) {
    assert.ok(has(withMinutes(bad), 'verify.stop_queue_wait_minutes must be an integer 0..30'), String(bad));
  }
});

const stopSettings = (timeout, command = 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/pipeline/stop-verify.mjs"') =>
  JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command, ...(timeout === undefined ? {} : { timeout }) }] }] } });
const queueConfig = (minutes) => ({ ...minimal(), verify: { ...minimal().verify, stop_queue_wait_minutes: minutes } });
const yml = (minutes) => `version: 1\nproject: p\nverify:\n  full: f\n  quick: q\n  stop_queue_wait_minutes: ${minutes}\n`;
const loadWith = (minutes, settings) => loadConfig('/nowhere', {
  readFile: async (file) => {
    if (String(file).endsWith('pipeline.yml')) return yml(minutes);
    if (settings === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return settings;
  },
});

test('stopHookTimeoutWarning: warns when the Stop hook timeout is below 900 s + the queue allowance, naming both numbers', () => {
  const short = stopHookTimeoutWarning(queueConfig(5), stopSettings(900));
  assert.match(short, /stop_queue_wait_minutes: 5/);
  assert.match(short, /900/);
  assert.match(short, /1200/);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), stopSettings(1199)) === null, false);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), stopSettings(1200)), null);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), stopSettings(1800)), null);
});

test('stopHookTimeoutWarning: silent for allowance 0, an unrelated hook, no timeout, or missing/unreadable settings', () => {
  assert.equal(stopHookTimeoutWarning(queueConfig(0), stopSettings(900)), null);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), stopSettings(60, 'node other.mjs')), null);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), stopSettings(undefined)), null);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), null), null);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), 'not json {'), null);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), '{"hooks":{"Stop":"nope"}}'), null);
  assert.equal(stopHookTimeoutWarning(queueConfig(5), '[]'), null);
});

test('loadConfig: warns about a Stop hook timeout that is too short for stop_queue_wait_minutes; settings are optional', async () => {
  const short = await loadWith(5, stopSettings(900));
  assert.equal(short.ok, true, short.errors.join('; '));
  assert.ok(short.warnings.some((w) => w.includes('stop_queue_wait_minutes') && w.includes('1200')), short.warnings.join('|'));
  assert.ok(!(await loadWith(5, stopSettings(1200))).warnings.some((w) => w.includes('stop_queue_wait_minutes')));
  assert.ok(!(await loadWith(5, undefined)).warnings.some((w) => w.includes('stop_queue_wait_minutes')), 'no settings file: no warning');
  assert.ok(!(await loadWith(0, stopSettings(900))).warnings.some((w) => w.includes('stop_queue_wait_minutes')));
});

test('verify.skippable_steps: optional list of unique step names, each also in expected_steps when that is set', () => {
  const withVerify = (extra) => validateConfig({ ...minimal(), verify: { ...minimal().verify, ...extra } });
  const ok = withVerify({ expected_steps: ['install', 'sql-arms'], skippable_steps: ['sql-arms'] });
  assert.equal(ok.ok, true, ok.errors.join('|'));
  assert.deepEqual(ok.config.verify.skippable_steps, ['sql-arms']);
  assert.equal(validateConfig(minimal()).config.verify.skippable_steps, undefined, 'absent by default: nothing may be skipped');
  assert.equal(withVerify({ skippable_steps: ['anything'] }).ok, true, 'without expected_steps there is no list to check against');
  assert.equal(withVerify({ skippable_steps: [] }).ok, true, 'an empty list is the same as absent');
  for (const bad of ['sql-arms', ['a', 'a'], ['a', ''], ['a', 3], null, {}]) {
    const r = withVerify({ skippable_steps: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(has(r, 'verify.skippable_steps'), r.errors.join('|'));
  }
  const unknown = withVerify({ expected_steps: ['install'], skippable_steps: ['install', 'sql-arms'] });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => /verify\.skippable_steps/.test(e) && /sql-arms/.test(e) && /expected_steps/.test(e)), unknown.errors.join('|'));
});

test('verify.after_fix: full (default) | quick; the by-path map and never list are validated', () => {
  const withVerify = (extra) => validateConfig({ ...minimal(), verify: { ...minimal().verify, ...extra } });
  assert.equal(validateConfig(minimal()).config.verify.after_fix, 'full', 'absent = full = today');
  assert.equal(validateConfig(minimal()).config.verify.after_fix_steps_by_path, undefined);
  assert.equal(validateConfig(minimal()).config.verify.after_fix_never, undefined);
  for (const mode of ['full', 'quick']) assert.equal(withVerify({ after_fix: mode }).ok, true, mode);
  for (const bad of ['fast', '', 'QUICK', true, null, 1]) {
    const r = withVerify({ after_fix: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(has(r, 'verify.after_fix'), r.errors.join('|'));
  }
  const good = withVerify({
    after_fix: 'quick',
    expected_steps: ['install', 'db', 'db-grants', 'sql-arms'],
    after_fix_steps_by_path: { 'supabase/**': ['db', 'db-grants'], 'lib/*.ts': ['db'] },
    after_fix_never: ['sql-arms'],
  });
  assert.equal(good.ok, true, good.errors.join('|'));
  assert.deepEqual(good.config.verify.after_fix_steps_by_path, { 'supabase/**': ['db', 'db-grants'], 'lib/*.ts': ['db'] });
  assert.deepEqual(good.config.verify.after_fix_never, ['sql-arms']);
  assert.equal(withVerify({ after_fix_steps_by_path: {} }).ok, true, 'an empty map is the same as absent');
  for (const bad of [['supabase/**'], 'supabase/**', null, 3]) {
    const r = withVerify({ after_fix_steps_by_path: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(has(r, 'verify.after_fix_steps_by_path'), r.errors.join('|'));
  }
  for (const bad of ['db', [], ['db', ''], ['db', 3], ['db', 'db'], null, {}]) {
    const r = withVerify({ after_fix_steps_by_path: { 'supabase/**': bad } });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(has(r, 'verify.after_fix_steps_by_path'), r.errors.join('|'));
  }
  assert.equal(withVerify({ after_fix_steps_by_path: { '': ['db'] } }).ok, false, 'empty glob');
  for (const bad of ['sql-arms', [''], ['a', 'a'], [1], null, {}]) {
    const r = withVerify({ after_fix_never: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(has(r, 'verify.after_fix_never'), r.errors.join('|'));
  }
  const banned = withVerify({ after_fix_steps_by_path: { 'supabase/**': ['db', 'sql-arms'] }, after_fix_never: ['sql-arms'] });
  assert.equal(banned.ok, false);
  assert.ok(banned.errors.some((e) => /after_fix_steps_by_path/.test(e) && /sql-arms/.test(e) && /after_fix_never/.test(e)), banned.errors.join('|'));
  const unknown = withVerify({ expected_steps: ['install'], after_fix_steps_by_path: { 'supabase/**': ['db'] } });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => /after_fix_steps_by_path/.test(e) && /db/.test(e) && /expected_steps/.test(e)), unknown.errors.join('|'));
  for (const bad of ['db;rm', 'a b', '$(x)', 'a,b']) assert.equal(withVerify({ after_fix_steps_by_path: { 'x/**': [bad] } }).ok, false, `shell-unsafe step ${bad}`);
  const tooComplex = withVerify({ after_fix_steps_by_path: { [Array(20).fill('*').join('/a')]: ['db'] } });
  assert.equal(tooComplex.ok, false, 'a glob the matcher refuses is a config error, not a runtime crash');
});

test('worktrees block: defaults when absent', () => {
  const r = validateConfig(minimal());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.config.worktrees, {
    mode: 'report',
    protect: ['foundation', '*.stack'],
    min_idle_hours: 24,
    min_merged_hours: 24,
    delete: ['node_modules/', '.next/', 'supabase/.temp/', 'test-results/', 'playwright-report/', 'next-env.d.ts', 'public/sw.js', 'tsconfig.tsbuildinfo', '*.log'],
    archive: ['.review/', '.verify/'],
    memory_dirs: ['~/claude-memory'],
  });
});

test('worktrees block: rejects a bad mode, unknown key, non-positive hours', () => {
  const r = validateConfig({ ...minimal(), worktrees: { mode: true, min_idle_hours: 0, bogus: 1 } });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'worktrees.mode'));
  assert.ok(has(r, 'worktrees.min_idle_hours'));
  assert.ok(has(r, 'unknown key: worktrees.bogus'));
});

test('worktrees block: a path in delete must not also be in archive', () => {
  const r = validateConfig({ ...minimal(), worktrees: { delete: ['.review/'] } });
  assert.equal(r.ok, false);
  assert.ok(has(r, 'worktrees: .review/ is in both delete and archive'));
});

test('verify.max_parallel_full / max_load / max_load_wait_minutes: optional, validated, wait defaults to 10 with max_load', () => {
  const withVerify = (extra) => validateConfig({ ...minimal(), verify: { ...minimal().verify, ...extra } });
  const none = validateConfig(minimal());
  assert.equal(none.ok, true);
  assert.equal(none.config.verify.max_parallel_full, undefined, 'unset = no limit');
  assert.equal(none.config.verify.max_load, undefined);
  assert.equal(none.config.verify.max_load_wait_minutes, undefined, 'no default without max_load');

  const slots = withVerify({ max_parallel_full: 2 });
  assert.equal(slots.ok, true, slots.errors.join('; '));
  assert.equal(slots.config.verify.max_parallel_full, 2);
  assert.equal(slots.config.verify.max_load_wait_minutes, undefined);

  const load = withVerify({ max_parallel_full: 2, max_load: 12.5 });
  assert.equal(load.ok, true, load.errors.join('; '));
  assert.equal(load.config.verify.max_load, 12.5);
  assert.equal(load.config.verify.max_load_wait_minutes, 10, 'default 10 when max_load is set');

  const wait = withVerify({ max_parallel_full: 1, max_load: 8, max_load_wait_minutes: 2.5 });
  assert.equal(wait.ok, true, wait.errors.join('; '));
  assert.equal(wait.config.verify.max_load_wait_minutes, 2.5);
  assert.equal(withVerify({ max_parallel_full: 1, max_load: 8, max_load_wait_minutes: 10 }).ok, true, '10 is the ceiling');

  for (const bad of [0, -1, 1.5, '2', null, true, [], {}, NaN, Infinity]) {
    assert.ok(has(withVerify({ max_parallel_full: bad }), 'verify.max_parallel_full must be a positive integer'), String(bad));
  }
  for (const bad of [0, -3, '8', null, true, NaN, Infinity, []]) {
    assert.ok(has(withVerify({ max_parallel_full: 2, max_load: bad }), 'verify.max_load must be a positive number'), String(bad));
  }
  for (const bad of [0, -1, 10.5, 11, '5', null, NaN, Infinity]) {
    assert.ok(has(withVerify({ max_parallel_full: 2, max_load: 8, max_load_wait_minutes: bad }), 'verify.max_load_wait_minutes must be'), String(bad));
  }
  assert.ok(has(withVerify({ max_load: 8 }), 'verify.max_load needs verify.max_parallel_full'));
  assert.ok(has(withVerify({ max_parallel_full: 2, max_load_wait_minutes: 5 }), 'verify.max_load_wait_minutes needs verify.max_load'));
});

test('verify.deferrable_steps / ci_proof / ci_proof_inputs / ci_proof_wait_minutes: valid shapes, defaults and every refusal', () => {
  const withVerify = (extra) => validateConfig({ ...minimal(), verify: { ...minimal().verify, ...extra } });
  const spec = { workflow: '.github/workflows/ci.yml', job: 'SQL arms' };
  const good = { deferrable_steps: ['sql-arms'], ci_proof: { 'sql-arms': spec } };

  const none = validateConfig(minimal());
  for (const k of ['deferrable_steps', 'ci_proof', 'ci_proof_inputs', 'ci_proof_wait_minutes']) assert.equal(none.config.verify[k], undefined, `${k}: no default`);

  const ok = withVerify({ ...good, ci_proof_inputs: ['supabase/tests/**', 'package-lock.json'], ci_proof_wait_minutes: 12.5, expected_steps: ['typecheck', 'sql-arms'] });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.config.verify.ci_proof['sql-arms'].event, 'pull_request', 'event defaults to pull_request');
  assert.deepEqual(ok.config.verify.ci_proof_inputs, ['supabase/tests/**', 'package-lock.json']);
  assert.equal(ok.config.verify.ci_proof_wait_minutes, 12.5);
  assert.equal(withVerify({ deferrable_steps: ['a'], ci_proof: { a: { ...spec, event: 'pull_request_target' } } }).config.verify.ci_proof.a.event, 'pull_request_target');
  assert.equal(withVerify({ ...good, ci_proof: { 'sql-arms': { ...spec, workflow: '.github/workflows/db.yaml' } } }).ok, true, '.yaml is fine');

  // deferrable_steps
  for (const bad of ['sql-arms', [], ['a', 'a'], ['a', ''], ['a', 3], null, {}]) {
    const r = withVerify({ deferrable_steps: bad, ci_proof: { a: { ...spec } } });
    assert.ok(has(r, 'verify.deferrable_steps'), `${JSON.stringify(bad)}: ${r.errors.join('|')}`);
  }
  assert.ok(has(withVerify({ deferrable_steps: ['a b'], ci_proof: { 'a b': spec } }), 'step names may only use'));
  const unknown = withVerify({ expected_steps: ['install'], ...good });
  assert.ok(unknown.errors.some((e) => /verify\.deferrable_steps/.test(e) && /sql-arms/.test(e) && /expected_steps/.test(e)), unknown.errors.join('|'));

  // ci_proof <-> deferrable_steps must agree both ways
  assert.ok(has(withVerify({ deferrable_steps: ['sql-arms'] }), 'verify.deferrable_steps needs verify.ci_proof'));
  assert.ok(has(withVerify({ deferrable_steps: ['sql-arms', 'db'], ci_proof: { 'sql-arms': spec } }), 'no verify.ci_proof entry: db'));
  assert.ok(has(withVerify({ deferrable_steps: ['sql-arms'], ci_proof: { 'sql-arms': spec, db: spec } }), 'db is not listed in verify.deferrable_steps'));
  assert.ok(has(withVerify({ ci_proof: { 'sql-arms': spec } }), 'sql-arms is not listed in verify.deferrable_steps'), 'ci_proof without deferrable_steps');

  // ci_proof entries
  for (const bad of ['ci.yml', null, [], 5]) assert.ok(has(withVerify({ ...good, ci_proof: { 'sql-arms': bad } }), 'must be a mapping'), JSON.stringify(bad));
  assert.ok(has(withVerify({ ...good, ci_proof: 'x' }), 'verify.ci_proof must be a mapping'));
  for (const workflow of [undefined, '', 'ci.yml', '.github/workflows/ci.yml/', '.github/workflows/sub/ci.yml', '.github/workflows/ci.txt', '.github/other/ci.yml', '.github/workflows/', '/.github/workflows/ci.yml', '.github/workflows/../x.yml', 7]) {
    const r = withVerify({ ...good, ci_proof: { 'sql-arms': { ...spec, workflow } } });
    assert.ok(has(r, '.workflow must be a workflow file path'), `${JSON.stringify(workflow)}: ${r.errors.join('|')}`);
  }
  for (const job of [undefined, '', '   ', 3, null]) assert.ok(has(withVerify({ ...good, ci_proof: { 'sql-arms': { ...spec, job } } }), '.job must be a non-empty job name'), JSON.stringify(job));
  for (const event of ['', 3, null]) assert.ok(has(withVerify({ ...good, ci_proof: { 'sql-arms': { ...spec, event } } }), '.event must be a non-empty event name'), JSON.stringify(event));
  assert.ok(has(withVerify({ ...good, ci_proof: { 'sql-arms': { ...spec, branch: 'main' } } }), 'unknown key'));

  // ci_proof_inputs
  for (const bad of ['supabase/**', [''], [3], null, {}]) assert.ok(has(withVerify({ ...good, ci_proof_inputs: bad }), 'verify.ci_proof_inputs must be an array'), JSON.stringify(bad));
  assert.ok(has(withVerify({ ci_proof_inputs: ['a/**'] }), 'verify.ci_proof_inputs needs verify.ci_proof'));
  assert.ok(has(withVerify({ ...good, ci_proof_inputs: ['a**b**c**d**e**f**g**h**i**j**k**l**m**n**o**p**q**r'] }), 'verify.ci_proof_inputs['), 'a glob the matcher refuses');
  assert.equal(withVerify({ ...good, ci_proof_inputs: [] }).ok, true, 'an empty list is the same as absent');

  // ci_proof_wait_minutes: positive number, no default, not a ceiling
  for (const bad of [0, -1, '5', null, true, NaN, Infinity, []]) assert.ok(has(withVerify({ ...good, ci_proof_wait_minutes: bad }), 'verify.ci_proof_wait_minutes must be a number above 0'), String(bad));
  assert.ok(has(withVerify({ ci_proof_wait_minutes: 5 }), 'verify.ci_proof_wait_minutes needs verify.ci_proof'));
  assert.equal(withVerify({ ...good, ci_proof_wait_minutes: 90 }).ok, true);
});

test('verify.deferrable_steps / ci_proof honour the run-record proof limits (count and step-name length), and a config at the limits makes proofs the record accepts', () => {
  const withVerify = (extra) => validateConfig({ ...minimal(), verify: { ...minimal().verify, ...extra } });
  const spec = { workflow: '.github/workflows/ci.yml', job: 'SQL arms' };
  const mk = (n, len = 8) => Array.from({ length: n }, (_, i) => `s${i}`.padEnd(len, 'x'));
  const cfgFor = (names) => ({ deferrable_steps: names, ci_proof: Object.fromEntries(names.map((s) => [s, { ...spec }])) });

  const tooMany = withVerify(cfgFor(mk(MAX_PROOFS + 1)));
  assert.ok(has(tooMany, `at most ${MAX_PROOFS}`), tooMany.errors.join('|'));
  assert.equal(tooMany.errors.filter((e) => /verify\.ci_proof has/.test(e)).length, 1, 'ci_proof is checked too');
  const longName = withVerify(cfgFor(['a'.repeat(MAX_PROOF_STEP + 1)]));
  assert.ok(has(longName, `at most ${MAX_PROOF_STEP} characters`), longName.errors.join('|'));
  assert.equal(longName.errors.filter((e) => /step names may be at most/.test(e)).length, 2, 'both deferrable_steps and ci_proof');

  // exactly at the limits: the config validates AND the proofs it can produce are accepted by the run record
  const names = mk(MAX_PROOFS, MAX_PROOF_STEP);
  assert.ok(names.every((n) => n.length === MAX_PROOF_STEP));
  const atLimits = withVerify(cfgFor(names));
  assert.equal(atLimits.ok, true, atLimits.errors.join('|'));
  const run = { id: 1, attempt: 1, jobId: 2, workflow: spec.workflow, job: spec.job, url: 'https://github.com/a/b/actions/runs/1' };
  const proofs = atLimits.config.verify.deferrable_steps.map((step, i) => (i % 2 ? { step, source: 'local' } : { step, source: 'ci', run }));
  assert.equal(proofsProblem(proofs), null);
  assert.equal(normaliseProofs(proofs).length, MAX_PROOFS);
});

test('verify.ci_proof parses from real YAML (hyphenated step names, nested mapping, quoted job)', () => {
  const text = [
    'version: 1', 'project: p', 'verify:', '  full: f', '  quick: q', '  deferrable_steps: [sql-arms]', '  ci_proof:', '    sql-arms:',
    '      workflow: .github/workflows/ci.yml', '      job: "SQL arms"', '  ci_proof_inputs: [supabase/tests/**]', '  ci_proof_wait_minutes: 25', '',
  ].join('\n');
  const r = validateConfig(parseYaml(text));
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.config.verify.ci_proof, { 'sql-arms': { workflow: '.github/workflows/ci.yml', job: 'SQL arms', event: 'pull_request' } });
});

// Tests for the project-side scripts (ci-guard, smoke). They always run the VENDORED copy (what a project and its CI really run),
// because the templates import ./lib/* which only exists after `pipeline vendor`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, importVendored, project, runNode, scratchDir } from './helpers/project.mjs';

// ======================================================================================================================
// ci-guard
// ======================================================================================================================

// Mirrors CI: the PR head is a commit the base checkout has fetched but NOT checked out.
async function prRepo(change) {
  const repo = await project();
  repo.branch('pr');
  change(repo);
  repo.head = repo.commit('pr change');
  repo.checkout('main');
  return repo;
}
const guard = (repo, args, opts = {}) =>
  runNode(['scripts/pipeline/ci-guard.mjs', ...args], { cwd: repo.dir, ...opts });
const deleteTest = (repo) => repo.rm('test/app.test.js');
const addDrop = (repo) => repo.write('supabase/migrations/20260101000000_drop.sql', 'DROP TABLE users;\n');

test('ci-guard integrity: a deleted test file fails with exit 1 and a JSON verdict', async () => {
  const repo = await prRepo(deleteTest);
  const r = await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', repo.head]);
  assert.equal(r.code, 1);
  assert.equal(r.json.check, 'integrity');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.overridden, false);
  assert.equal(r.json.base, repo.base);
  assert.equal(r.json.head, repo.head);
  assert.deepEqual(r.json.violations.map((v) => [v.rule, v.file]), [['test-deleted', 'test/app.test.js']]);
});

test('ci-guard integrity: the test-change-approved label overrides (and is reported as overridden)', async () => {
  const repo = await prRepo(deleteTest);
  const r = await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', repo.head, '--labels', 'needs-review, test-change-approved']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.overridden, true);
  assert.equal(r.json.violations.length, 1, 'violations stay visible even when overridden');
});

test('ci-guard integrity: an unrelated label does not override', async () => {
  const repo = await prRepo(deleteTest);
  const r = await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', repo.head, '--labels', 'human-approved']);
  assert.equal(r.code, 1, 'human-approved is for hard-stops, not for test integrity');
});

test('ci-guard integrity: a clean change passes with no violations', async () => {
  const repo = await prRepo((r) => r.write('src/app.js', 'export const a = 2;\n'));
  const r = await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', repo.head]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.violations, []);
});

test('ci-guard hardstops: a migration DROP fails, human-approved overrides', async () => {
  const repo = await prRepo(addDrop);
  const args = ['--check', 'hardstops', '--base', repo.base, '--head', repo.head];
  const bad = await guard(repo, args);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.check, 'hardstops');
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.approved, false);
  assert.ok(bad.json.hits.some((h) => h.rule === 'R1-destructive' && h.file === 'supabase/migrations/20260101000000_drop.sql'));

  const good = await guard(repo, [...args, '--labels', 'human-approved']);
  assert.equal(good.code, 0);
  assert.equal(good.json.ok, true);
  assert.equal(good.json.approved, true);
  assert.ok(good.json.hits.length > 0, 'hits stay visible even when approved');
});

test('ci-guard hardstops: a change with no hard-stops passes', async () => {
  const repo = await prRepo((r) => r.write('src/app.js', 'export const a = 3;\n'));
  const r = await guard(repo, ['--check', 'hardstops', '--base', repo.base, '--head', repo.head]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.hits, []);
});

test('ci-guard appends a markdown summary to $GITHUB_STEP_SUMMARY', async () => {
  const repo = await prRepo(deleteTest);
  const summary = join(scratchDir(), 'summary.md');
  writeFileSync(summary, '# earlier step\n');
  const r = await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', repo.head], { env: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.code, 1);
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /^# earlier step\n/, 'appends, never truncates');
  assert.match(md, /## Test integrity/);
  assert.match(md, /Failed: 1 violation/);
  assert.match(md, /\| test-deleted \| test\/app\.test\.js \|/);
  assert.match(md, /Override: owner adds label `test-change-approved`/);
});

test('ci-guard hard-stop summary names the human-approved label', async () => {
  const repo = await prRepo(addDrop);
  const summary = join(scratchDir(), 'summary.md');
  await guard(repo, ['--check', 'hardstops', '--base', repo.base, '--head', repo.head], { env: { GITHUB_STEP_SUMMARY: summary } });
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /## Hard-stop scan/);
  assert.match(md, /R1-destructive/);
  assert.match(md, /Override: owner adds label `human-approved`/);
});

test('ci-guard writes a one-line description (<=140 chars) for the commit status', async () => {
  const repo = await prRepo(addDrop);
  const file = join(scratchDir(), 'desc.txt');
  await guard(repo, ['--check', 'hardstops', '--base', repo.base, '--head', repo.head, '--description-file', file]);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 1);
  assert.ok(text.trimEnd().length <= 140);
  assert.equal(text, '2 hard-stops: R1-destructive supabase/migrations/20260101000000_drop.sql\n');

  const approved = join(scratchDir(), 'desc2.txt');
  await guard(repo, ['--check', 'hardstops', '--base', repo.base, '--head', repo.head, '--labels', 'human-approved', '--description-file', approved]);
  assert.match(readFileSync(approved, 'utf8'), /approved by label human-approved/);

  const long = await prRepo((r) => r.write(`test/${'x'.repeat(200)}.test.js`, 'it.only("a", () => {});\n'));
  const f3 = join(scratchDir(), 'desc3.txt');
  await guard(long, ['--check', 'integrity', '--base', long.base, '--head', long.head, '--description-file', f3]);
  const d3 = readFileSync(f3, 'utf8').trimEnd();
  assert.ok(d3.length <= 140 && d3.endsWith('...'), `capped: ${d3.length}`);
});

test('ci-guard fails closed (exit 2) without a pipeline.yml, and still writes a description', async () => {
  const repo = await project({ config: null });
  repo.branch('pr');
  repo.rm('test/app.test.js');
  const head = repo.commit('pr');
  repo.checkout('main');
  const file = join(scratchDir(), 'desc.txt');
  const r = await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', head, '--description-file', file]);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'config');
  assert.match(r.json.message, /missing \.claude\/pipeline\.yml/);
  assert.match(readFileSync(file, 'utf8'), /^Guard error:/);
});

test('ci-guard fails closed (exit 2) on an invalid pipeline.yml', async () => {
  const repo = await project({ config: 'version: 1\nproject: x\nbogus_key: 1\n' });
  const r = await guard(repo, ['--check', 'hardstops', '--base', repo.base, '--head', repo.base]);
  assert.equal(r.code, 2);
  assert.match(r.json.message, /unknown key: bogus_key/);
});

test('ci-guard exits 2 on usage errors and on an unknown ref', async () => {
  const repo = await prRepo(deleteTest);
  assert.equal((await guard(repo, ['--check', 'integrity', '--head', repo.head])).code, 2, 'missing --base');
  assert.equal((await guard(repo, ['--check', 'integrity', '--base', repo.base])).code, 2, 'missing --head');
  assert.equal((await guard(repo, ['--check', 'bogus', '--base', repo.base, '--head', repo.head])).code, 2, 'bad --check');
  assert.equal((await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', repo.head, '--nope'])).code, 2, 'unknown flag');
  const ref = await guard(repo, ['--check', 'integrity', '--base', repo.base, '--head', 'no-such-branch']);
  assert.equal(ref.code, 2);
  assert.equal(ref.json.error, 'guard-error');
  const dash = await guard(repo, ['--check', 'hardstops', '--base', repo.base, '--head', '--output=/tmp/x']);
  assert.equal(dash.code, 2, 'a ref that looks like an option is refused');
});

test('ci-guard summary: untrusted cells cannot break the table, and rows are capped at 50', async () => {
  const guardMod = await importVendored((await project()).dir, 'ci-guard');
  const hits = Array.from({ length: 60 }, (_, i) => ({ rule: 'R1-destructive', file: `m/${i}|x<b>.sql`, line: i, detail: 'a | b\nc `d`' }));
  const md = guardMod.renderSummary('hardstops', { hits, approved: false, ok: false });
  const rows = md.split('\n').filter((l) => l.startsWith('| R1-destructive'));
  assert.equal(rows.length, 50);
  assert.match(md, /and 10 more not shown/);
  assert.ok(rows.every((l) => !/<b>/.test(l) && l.split(/(?<!\\)\|/).length === 6), 'each row has exactly 4 cells');
});

// ======================================================================================================================
// smoke
// ======================================================================================================================

const BIG = `EARLY-MARK${'a'.repeat(3 * 1024 * 1024)}LATE-MARK`;
let server;
let baseUrl;
let hits;
let violations;
let flakyCalls;

before(async () => {
  hits = [];
  violations = [];
  flakyCalls = 0;
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method !== 'GET') violations.push(`non-GET: ${req.method} ${req.url}`);
    for (const h of ['cookie', 'authorization', 'proxy-authorization', 'x-smoke-key']) if (req.headers[h]) violations.push(`${h} header sent to ${req.url}`);
    if (req.headers['user-agent'] !== 'claude-pipeline-smoke/1') violations.push(`user-agent: ${req.headers['user-agent']}`);
    if (req.headers['cache-control'] !== 'no-cache') violations.push('cache-control not no-cache');
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-vercel-id': 'iad1::abc123' });
      res.end('<h1>Sign in to Demo</h1><p>build 42</p>');
    } else if (req.url === '/') {
      res.writeHead(307, { location: '/login' });
      res.end('redirecting');
    } else if (req.url === '/flaky') {
      flakyCalls++;
      res.writeHead(flakyCalls === 1 ? 500 : 200);
      res.end(flakyCalls === 1 ? 'oops' : 'recovered');
    } else if (req.url === '/down') {
      res.writeHead(503);
      res.end('down');
    } else if (req.url === '/big') {
      res.writeHead(200);
      res.end(BIG);
    } else if (req.url === '/no-location') {
      res.writeHead(307);
      res.end();
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  assert.deepEqual(violations, [], 'smoke must only ever send plain, cookie-less, auth-less GETs');
});

const SMOKE_CHECKS = `smoke_checks:
  - path: /
    status: [307]
    location_contains: /login
  - path: /login
    status: [200]
    contains: ["Sign in to Demo"]
`;
const smoke = (repo, args, opts) => runNode(['scripts/pipeline/smoke.mjs', ...args], { cwd: repo.dir, ...opts });
const noSleep = { sleep: async () => {} };

test('smoke: /login 200 with text and / 307 -> /login pass, with timings and the Vercel id', async () => {
  const repo = await project({ config: CONFIG(undefined, SMOKE_CHECKS) });
  const r = await smoke(repo, ['--base', baseUrl, '--expect-text', 'Sign in to Demo']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.base, baseUrl);
  assert.equal(r.json.production, false);
  assert.deepEqual(r.json.checks.map((c) => [c.path, c.status, c.ok, c.reason]), [['/', 307, true, null], ['/login', 200, true, null]]);
  assert.equal(r.json.checks[1].vercelId, 'iad1::abc123');
  assert.equal(r.json.checks[0].vercelId, null);
  assert.ok(r.json.checks.every((c) => Number.isInteger(c.ms) && c.ms >= 0));
  assert.deepEqual(r.json.expectText, { found: true, path: '/login' });
});

test('smoke: wrong expect-text fails with exit 1', async () => {
  const repo = await project({ config: CONFIG(undefined, SMOKE_CHECKS) });
  const r = await smoke(repo, ['--base', baseUrl, '--expect-text', 'build 41']);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.checks.every((c) => c.ok), 'the checks themselves passed');
  assert.deepEqual(r.json.expectText, { found: false, path: '/login' });
});

test('smoke: --expect-path picks the page to inspect (and fetches it when it is not a configured check)', async () => {
  const repo = await project({ config: CONFIG(undefined, SMOKE_CHECKS) });
  const onRedirect = await smoke(repo, ['--base', baseUrl, '--expect-text', 'redirecting', '--expect-path', '/']);
  assert.equal(onRedirect.code, 1, 'a 307 body is never read');
  assert.deepEqual(onRedirect.json.expectText, { found: false, path: '/' });

  const unlisted = await project({ config: CONFIG(undefined, 'smoke_checks:\n  - path: /\n    status: [307]\n') });
  const r = await smoke(unlisted, ['--base', baseUrl, '--expect-text', 'build 42', '--expect-path', '/login']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.checks.map((c) => c.path), ['/', '/login']);
  assert.deepEqual(r.json.expectText, { found: true, path: '/login' });
});

test('smoke: expect-text can come from PIPELINE_SMOKE_EXPECT_TEXT', async () => {
  const repo = await project({ config: CONFIG(undefined, SMOKE_CHECKS) });
  assert.equal((await smoke(repo, ['--base', baseUrl], { env: { PIPELINE_SMOKE_EXPECT_TEXT: 'build 42' } })).code, 0);
  assert.equal((await smoke(repo, ['--base', baseUrl], { env: { PIPELINE_SMOKE_EXPECT_TEXT: 'build 41' } })).code, 1);
});

test('smoke: a 500 then a 200 is retried and passes', async () => {
  const repo = await project({ config: CONFIG(undefined, 'smoke_checks:\n  - path: /flaky\n    contains: [recovered]\n') });
  flakyCalls = 0;
  const r = await smoke(repo, ['--base', baseUrl]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.checks[0].status, 200);
  assert.equal(flakyCalls, 2);
});

test('smoke: a persistent 5xx fails after three attempts with backoff 1 s then 3 s', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const before = hits.filter((h) => h === 'GET /down').length;
  const delays = [];
  const r = await runSmoke({ base: baseUrl, checks: [{ path: '/down' }] }, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].status, 503);
  assert.match(r.checks[0].reason, /status 503, expected 2xx\/3xx/);
  assert.deepEqual(delays, [1000, 3000]);
  assert.equal(hits.filter((h) => h === 'GET /down').length - before, 3);
});

test('smoke: an expected 5xx is not retried', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const before = hits.filter((h) => h === 'GET /down').length;
  const r = await runSmoke({ base: baseUrl, checks: [{ path: '/down', status: [503] }] }, noSleep);
  assert.equal(r.ok, true);
  assert.equal(hits.filter((h) => h === 'GET /down').length - before, 1);
});

test('smoke: a network error is retried then reported without a status', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const delays = [];
  const r = await runSmoke({ base: `http://127.0.0.1:${port}`, checks: [{ path: '/' }] }, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].status, null);
  assert.match(r.checks[0].reason, /^network error: /);
  assert.deepEqual(delays, [1000, 3000]);
});

test('smoke: redirects are reported, never followed; status, contains and location mismatches say why', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const r = await runSmoke({
    base: baseUrl,
    checks: [
      { path: '/', status: [200] },
      { path: '/', status: [307], location_contains: '/signup' },
      { path: '/no-location', status: [307], location_contains: '/login' },
      { path: '/login', contains: ['Sign in', 'MISSING-TEXT'] },
      { path: '/', contains: ['redirecting'] },
      { path: '/missing' },
    ],
  }, noSleep);
  assert.equal(r.ok, false);
  const reasons = r.checks.map((c) => c.reason);
  assert.match(reasons[0], /status 307, expected 200/);
  assert.match(reasons[1], /location "\/login" does not contain "\/signup"/);
  assert.match(reasons[2], /no location header/);
  assert.match(reasons[3], /body does not contain "MISSING-TEXT"/);
  assert.doesNotMatch(reasons[3], /Sign in/);
  assert.match(reasons[4], /body is only read for 2xx/);
  assert.match(reasons[5], /status 404/);
});

test('smoke: only the first 2 MB of a body is read', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const r = await runSmoke({ base: baseUrl, checks: [{ path: '/big', contains: ['EARLY-MARK'] }, { path: '/big', contains: ['LATE-MARK'] }] }, noSleep);
  assert.equal(r.checks[0].ok, true);
  assert.equal(r.checks[1].ok, false);
});

test('smoke: with no smoke_checks (or no pipeline.yml) it checks GET / for 2xx/3xx', async () => {
  const configured = await project();
  const a = await smoke(configured, ['--base', baseUrl]);
  assert.equal(a.code, 0);
  assert.deepEqual(a.json.checks.map((c) => [c.path, c.status]), [['/', 307]]);
  const bare = await project({ config: null });
  const b = await smoke(bare, ['--base', baseUrl, '--production']);
  assert.equal(b.code, 0);
  assert.equal(b.json.production, true);
});

test('smoke: a trailing slash or path prefix on --base is handled', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const r = await runSmoke({ base: `${baseUrl}/`, checks: [{ path: '/login' }] }, noSleep);
  assert.equal(r.base, baseUrl);
  assert.equal(r.ok, true);
});

test('smoke: a non-https remote base, credentials, a query string or a bad URL exit 2', async () => {
  const repo = await project({ config: CONFIG(undefined, SMOKE_CHECKS) });
  const before = hits.length;
  for (const base of ['http://example.com', 'ftp://example.com', 'https://user:pw@example.com', 'https://example.com/?x=1', 'not a url', 'http://localhost.evil.test']) {
    const r = await smoke(repo, ['--base', base]);
    assert.equal(r.code, 2, `${base}: ${r.stdout}`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'usage');
  }
  assert.equal((await smoke(repo, [])).code, 2, 'missing --base');
  assert.equal((await smoke(repo, ['--base', baseUrl, '--bogus'])).code, 2, 'unknown flag');
  assert.equal(hits.length, before, 'nothing was requested');
});

test('smoke: https is accepted for a remote base (validation only, no request is made)', async () => {
  const { normaliseBase } = await importVendored((await project()).dir, 'smoke');
  assert.equal(normaliseBase('https://app.example.com'), 'https://app.example.com');
  assert.equal(normaliseBase('https://app.example.com/preview/'), 'https://app.example.com/preview');
  assert.equal(normaliseBase('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normaliseBase('http://[::1]:3000'), 'http://[::1]:3000');
});

test('smoke: an invalid pipeline.yml is an error, not a silent default', async () => {
  const repo = await project({ config: 'version: 1\nproject: x\nsmoke_checks: [{path: login}]\n' });
  const r = await smoke(repo, ['--base', baseUrl]);
  assert.equal(r.code, 2);
  assert.match(r.json.message, /invalid \.claude\/pipeline\.yml/);
});

// ---- smoke_bypass_header: a firewall hint, sent only to a configured, non-loopback origin ----
const KEY = 'sk_live_Zx9-secret.VALUE~42';
const HTTPS_BASE = 'https://app.example.com';
const BYPASS = { header: 'x-smoke-key', value: KEY, origins: [HTTPS_BASE] };
const okFetch = (seen) => async (url, init) => {
  seen.push({ url: String(url), init });
  return new Response('<h1>hi</h1>', { status: 200, headers: { 'x-vercel-id': 'iad1::z' } });
};

test('smoke bypass: header is sent with the configured name and the env value, bypassHeader true', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const seen = [];
  const r = await runSmoke({ base: HTTPS_BASE, checks: [{ path: '/' }, { path: '/login' }], bypass: BYPASS }, { fetch: okFetch(seen), ...noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.bypassHeader, true);
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.equal(s.init.headers['x-smoke-key'], KEY);
    assert.equal(s.init.redirect, 'manual');
    assert.equal(s.init.method, 'GET');
    assert.equal(s.init.headers['user-agent'], 'claude-pipeline-smoke/1');
  }
  assert.ok(!JSON.stringify(r).includes(KEY), 'the value is not in the result');
});

test('smoke bypass: not sent when the env value is missing/empty or the header is not configured; bypassHeader false, no error', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  for (const bypass of [undefined, null, { header: 'x-smoke-key', value: undefined, origins: [HTTPS_BASE] }, { header: 'x-smoke-key', value: '', origins: [HTTPS_BASE] }, { header: 'x-smoke-key', value: '   ', origins: [HTTPS_BASE] }, { header: null, value: KEY, origins: [HTTPS_BASE] }]) {
    const seen = [];
    const r = await runSmoke({ base: HTTPS_BASE, checks: [{ path: '/' }], bypass }, { fetch: okFetch(seen), ...noSleep });
    assert.equal(r.ok, true);
    assert.equal(r.bypassHeader, false, JSON.stringify(bypass));
    assert.equal(Object.keys(seen[0].init.headers).some((h) => h.toLowerCase().startsWith('x-smoke')), false);
  }
});

test('smoke bypass: never sent to a loopback base, even when configured and the env value is set', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  for (const base of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://localhost']) {
    const seen = [];
    const r = await runSmoke({ base, checks: [{ path: '/' }], bypass: { ...BYPASS, origins: [base, new URL(base).origin] } }, { fetch: okFetch(seen), ...noSleep });
    assert.equal(r.bypassHeader, false, base);
    assert.equal(seen[0].init.headers['x-smoke-key'], undefined, base);
  }
});

test('smoke bypass: only an exactly listed origin gets the header (other host, scheme, port, subdomain, suffix, path prefix, no list)', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const cases = [
    ['https://app.example.com', ['https://app.example.com'], true],
    ['https://app.example.com/some/prefix', ['https://app.example.com'], true],
    ['https://evil.example', ['https://app.example.com'], false],
    ['https://preview-abc.vercel.app', ['https://app.example.com'], false],
    ['https://app.example.com:8443', ['https://app.example.com'], false],
    ['https://sub.app.example.com', ['https://app.example.com'], false],
    ['https://app.example.com.evil.example', ['https://app.example.com'], false],
    ['https://eapp.example.com', ['https://app.example.com'], false],
    ['https://app.example.com', ['https://app.example.com:8443'], false],
    ['https://app.example.com', ['http://app.example.com'], false],
    ['https://app.example.com', ['*.example.com', 'example.com', '.example.com'], false],
    ['https://app.example.com', [], false],
    ['https://app.example.com', undefined, false],
    ['https://app.example.com:8443', ['https://app.example.com', 'https://app.example.com:8443'], true],
  ];
  for (const [base, origins, expected] of cases) {
    const seen = [];
    const r = await runSmoke({ base, checks: [{ path: '/' }], bypass: { header: 'x-smoke-key', value: KEY, origins } }, { fetch: okFetch(seen), ...noSleep });
    assert.equal(r.bypassHeader, expected, `${base} vs ${JSON.stringify(origins)}`);
    assert.equal(seen[0].init.headers['x-smoke-key'], expected ? KEY : undefined, base);
  }
});

test('smoke bypass: a request path that could change the host is a usage error before any request; the secret is never sent', async () => {
  const { runSmoke, SmokeUsageError } = await importVendored((await project()).dir, 'smoke');
  const evil = ['//evil.example/x', '@evil.example/x', '/\\evil.example', '/a\\b', 'evil.example', 'https://evil.example/', '/a\nb', ''];
  for (const p of evil) {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('build 42', { status: 200 }); };
    const asExpectPath = runSmoke({ base: HTTPS_BASE, checks: [{ path: '/' }], expectText: 'build', expectPath: p, bypass: BYPASS }, { fetch, ...noSleep });
    await assert.rejects(asExpectPath, (e) => e instanceof SmokeUsageError && !e.message.includes(KEY), `expect-path ${JSON.stringify(p)}`);
    const asCheck = runSmoke({ base: HTTPS_BASE, checks: [{ path: '/' }, { path: p }], bypass: BYPASS }, { fetch, ...noSleep });
    await assert.rejects(asCheck, (e) => e instanceof SmokeUsageError && !e.message.includes(KEY), `check path ${JSON.stringify(p)}`);
    assert.deepEqual(calls, [], `no request at all for ${JSON.stringify(p)} (not even the valid first check)`);
  }
  // also without expect text: an --expect-path that is malformed is refused, not silently ignored
  await assert.rejects(runSmoke({ base: HTTPS_BASE, checks: [{ path: '/' }], expectPath: '//evil.example/x' }, { fetch: okFetch([]), ...noSleep }), SmokeUsageError);
});

test('smoke bypass: CLI refuses a host-changing --expect-path with exit 2 and no request', async () => {
  const repo = await project({ config: CONFIG(undefined, SMOKE_CHECKS) });
  const before = hits.length;
  for (const p of ['//evil.example/x', '@evil.example/x', '/\\evil.example']) {
    const r = await smoke(repo, ['--base', baseUrl, '--expect-text', 'x', `--expect-path=${p}`], { env: { PIPELINE_SMOKE_BYPASS_KEY: KEY } });
    assert.equal(r.code, 2, `${p}: ${r.stdout}`);
    assert.equal(r.json.error, 'usage');
    assert.ok(!r.stdout.includes(KEY));
  }
  assert.equal(hits.length, before);
});

test('smoke bypass: a normal path keeps the base path prefix, stays on the base origin and gets the header', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const seen = [];
  const r = await runSmoke({ base: 'https://app.example.com/pre/', checks: [{ path: '/login?x=1' }, { path: '/@user' }, { path: '/a//b' }], bypass: BYPASS }, { fetch: okFetch(seen), ...noSleep });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.map((s) => s.url), ['https://app.example.com/pre/login?x=1', 'https://app.example.com/pre/@user', 'https://app.example.com/pre/a//b']);
  assert.ok(seen.every((s) => new URL(s.url).origin === HTTPS_BASE && s.init.headers['x-smoke-key'] === KEY));
});

test('smoke bypass: the value never appears in the serialized result (pass, failing check, network error, echoing server)', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const cases = {
    pass: async () => new Response('fine', { status: 200 }),
    failingStatus: async () => new Response('nope', { status: 429 }),
    failingBody: async () => new Response('no match here', { status: 200 }),
    // a server (or fetch implementation) that echoes the secret back into what the reasons quote
    echoLocation: async (u, init) => new Response(null, { status: 307, headers: { location: `/x?k=${init.headers['x-smoke-key']}` } }),
    // the secret echoed into a response header the result copies (x-vercel-id)
    echoVercelId: async (u, init) => new Response('fine', { status: 200, headers: { 'x-vercel-id': `iad1::${init.headers['x-smoke-key']}` } }),
    networkError: async (u, init) => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: `ECONNRESET ${init.headers['x-smoke-key']}` } }); },
    messageWithValue: async (u, init) => { throw new Error(`bad header value "${init.headers['x-smoke-key']}"`); },
  };
  for (const [name, fetch] of Object.entries(cases)) {
    const r = await runSmoke({
      base: HTTPS_BASE,
      checks: [{ path: '/', contains: ['wanted text'], location_contains: 'wanted' }],
      expectText: 'wanted text',
      bypass: BYPASS,
    }, { fetch, ...noSleep });
    const text = JSON.stringify(r, null, 2);
    assert.ok(!text.includes(KEY), `${name}: value leaked: ${text}`);
    assert.equal(r.bypassHeader, true, name);
    if (name !== 'pass') assert.equal(r.ok, false, name);
  }
});

test('smoke bypass: redactJson scrubs string values only, so a key like true/1/" neither corrupts the JSON nor leaks', async () => {
  const { redactJson } = await importVendored((await project()).dir, 'smoke');
  const result = { ok: true, status: 200, bypassHeader: true, checks: [{ path: '/', ok: false, status: 429, reason: 'got true and 1' }] };
  for (const key of ['true', '1', '200']) {
    const parsed = JSON.parse(redactJson(result, key));
    assert.equal(parsed.ok, true, key);
    assert.equal(parsed.status, 200, key);
    assert.equal(parsed.bypassHeader, true, key);
    assert.equal(parsed.checks[0].ok, false, key);
    assert.equal(parsed.checks[0].status, 429, key);
  }
  assert.equal(JSON.parse(redactJson(result, 'true')).checks[0].reason, 'got [redacted] and 1');
  // a key with JSON-special characters: the escaped form in serialized text would have dodged a text-level replace
  for (const key of ['a"b', 'a\\b', '"']) {
    const echoed = { ok: false, checks: [{ reason: `server echoed ${key} back`, vercelId: `iad1::${key}` }] };
    const parsed = JSON.parse(redactJson(echoed, key));
    assert.equal(parsed.checks[0].reason, 'server echoed [redacted] back', key);
    assert.equal(parsed.checks[0].vercelId, 'iad1::[redacted]', key);
  }
  // empty / whitespace / missing secret: output unchanged
  assert.equal(redactJson(result, '  '), JSON.stringify(result, null, 2));
  assert.equal(redactJson(result, undefined), JSON.stringify(result, null, 2));
});

test('smoke bypass: a value that is not a legal header value is a usage error that does not quote it', async () => {
  const { runSmoke, SmokeUsageError } = await importVendored((await project()).dir, 'smoke');
  const bad = 'sk live\nsecret-bit';
  await assert.rejects(
    runSmoke({ base: HTTPS_BASE, checks: [{ path: '/' }], bypass: { header: 'x-smoke-key', value: bad, origins: [HTTPS_BASE] } }, { fetch: okFetch([]), ...noSleep }),
    (e) => e instanceof SmokeUsageError && !e.message.includes('secret-bit'),
  );
  await assert.rejects(
    runSmoke({ base: HTTPS_BASE, checks: [{ path: '/' }], bypass: { header: 'Authorization', value: KEY, origins: [HTTPS_BASE] } }, { fetch: okFetch([]), ...noSleep }),
    (e) => e instanceof SmokeUsageError && !e.message.includes(KEY),
  );
});

test('smoke bypass: CLI against a loopback server with the header configured and the env set -> bypassHeader false, nothing sent', async () => {
  const repo = await project({ config: CONFIG(undefined, `smoke_bypass_header: x-smoke-key\nsmoke_bypass_origins: ["https://localhost"]\n${SMOKE_CHECKS}`) });
  const r = await smoke(repo, ['--base', baseUrl], { env: { PIPELINE_SMOKE_BYPASS_KEY: KEY } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.bypassHeader, false, 'loopback: not sent');
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  // (the after() hook fails the file if the loopback server ever saw an x-smoke-key header)
});

const BYPASS_YML = `smoke_bypass_header: x-smoke-key\nsmoke_bypass_origins: ["${HTTPS_BASE}"]\n`;

test('smoke bypass: main threads the configured name and PIPELINE_SMOKE_BYPASS_KEY to the request; config without the key never sends', async () => {
  const { main } = await importVendored((await project()).dir, 'smoke');
  const run = async (yml, env) => {
    const repo = await project({ config: CONFIG(undefined, yml) });
    const seen = [];
    let out = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c, ...rest) => (typeof c === 'string' && c.startsWith('{') ? ((out += c), true) : orig(c, ...rest)); // the test runner writes binary chunks here too
    let code;
    try { code = await main(['--base', HTTPS_BASE], { env, cwd: repo.dir, deps: { fetch: okFetch(seen), ...noSleep } }); } finally { process.stdout.write = orig; }
    return { code, seen, out, json: JSON.parse(out) };
  };
  const sent = await run(BYPASS_YML, { PIPELINE_SMOKE_BYPASS_KEY: KEY });
  assert.equal(sent.code, 0, sent.out);
  assert.equal(sent.seen[0].init.headers['x-smoke-key'], KEY);
  assert.equal(sent.json.bypassHeader, true);
  assert.ok(!sent.out.includes(KEY));
  const noEnv = await run(BYPASS_YML, {});
  assert.equal(noEnv.code, 0, noEnv.out);
  assert.equal(noEnv.json.bypassHeader, false);
  assert.equal(noEnv.seen[0].init.headers['x-smoke-key'], undefined);
  const notConfigured = await run('', { PIPELINE_SMOKE_BYPASS_KEY: KEY });
  assert.equal(notConfigured.json.bypassHeader, false);
  assert.equal(notConfigured.seen[0].init.headers['x-smoke-key'], undefined);
  assert.equal(Object.keys(notConfigured.seen[0].init.headers).length, 2, 'only user-agent and cache-control');
});

test('smoke bypass: a redirect to another origin is reported, never followed, and the other origin sees no request or header', async () => {
  const { runSmoke } = await importVendored((await project()).dir, 'smoke');
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } });
  };
  const r = await runSmoke({ base: HTTPS_BASE, checks: [{ path: '/', status: [307] }], bypass: BYPASS }, { fetch, ...noSleep });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1, 'only the configured origin was asked');
  assert.equal(new URL(seen[0].url).origin, HTTPS_BASE);
  assert.equal(seen[0].init.redirect, 'manual', 'fetch is told not to follow');
  assert.ok(!seen.some((x) => x.url.includes('evil.example')));
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('smoke bypass: a denied origin or port, a plain-http base and an invalid path never get the header; the key is not in the output', async () => {
  const { main } = await importVendored((await project()).dir, 'smoke');
  const run = async (base, extra = []) => {
    const repo = await project({ config: CONFIG(undefined, BYPASS_YML) });
    const seen = [];
    let out = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c, ...rest) => (typeof c === 'string' && c.startsWith('{') ? ((out += c), true) : orig(c, ...rest));
    let code;
    try { code = await main(['--base', base, ...extra], { env: { PIPELINE_SMOKE_BYPASS_KEY: KEY }, cwd: repo.dir, deps: { fetch: okFetch(seen), ...noSleep } }); } finally { process.stdout.write = orig; }
    return { code, seen, out };
  };
  for (const base of ['https://other.example.com', 'https://app.example.com:8443']) {
    const r = await run(base);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.seen.length, 1, base);
    assert.equal(r.seen[0].init.headers['x-smoke-key'], undefined, base);
    assert.ok(!r.out.includes(KEY), base);
  }
  const plain = await run('http://app.example.com'); // a different scheme is a different origin; smoke refuses plain http outright
  assert.equal(plain.code, 2, plain.out);
  assert.equal(plain.seen.length, 0);
  assert.ok(!plain.out.includes(KEY));
  const bad = await run(HTTPS_BASE, ['--expect-text', 'x', '--expect-path', '//evil.example/x']);
  assert.equal(bad.code, 2);
  assert.equal(bad.seen.length, 0, 'an invalid path makes no request at all');
  assert.ok(!bad.out.includes(KEY));
});

test('every template is a plain script module with a short why-header', () => {
  for (const n of ['ci-guard', 'smoke']) {
    const text = readFileSync(new URL(`../pipeline/templates/scripts/pipeline/${n}.mjs`, import.meta.url), 'utf8');
    assert.match(text, /^\/\/ /, `${n} starts with a comment`);
    assert.ok(!/from '\.\.\//.test(text), `${n} must only import ./lib/* (the vendored layout)`);
  }
  assert.ok(existsSync(new URL('../pipeline/templates/scripts/pipeline/smoke.mjs', import.meta.url)));
});

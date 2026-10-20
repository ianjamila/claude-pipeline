// Read-only HTTP smoke test for a preview or production URL. It can only GET: no cookies, no auth headers, no request
// bodies, redirects are reported rather than followed, so pointing it at production cannot change anything there.
// One optional extra header exists: `smoke_bypass_header` (a lowercase x-… name in pipeline.yml) with its secret value in
// the PIPELINE_SMOKE_BYPASS_KEY environment variable. It is a firewall hint for the configured origin (e.g. a Vercel
// Firewall "Bypass" rule for CI runner IPs), NOT app authentication. It is sent only when the base's origin is exactly one
// of `smoke_bypass_origins` (never a preview URL, another host or loopback), never printed (the output only says whether
// it was sent: `bypassHeader`), and the request stays a cookie-less GET.
// Checks come from `smoke_checks` in .claude/pipeline.yml (default: GET / must answer 2xx/3xx). `--expect-text` proves
// the deployed page is the new build, not just any page that answers.
// Exit codes: 0 all checks pass, 1 a check failed, 2 usage/config error (including a non-https remote base URL).
// Vendored into projects by `pipeline vendor` (imports ./lib/*, which is the vendored copy of pipeline/lib).
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, SMOKE_BYPASS_HEADER_RE, isSmokePath } from './lib/config.mjs';

export const TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BACKOFF_MS = [1000, 3000]; // two retries: network error or 5xx
const HEADERS = { 'user-agent': 'claude-pipeline-smoke/1', 'cache-control': 'no-cache' };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class SmokeUsageError extends Error {}

// https only, except loopback (local dev server). Anything with credentials, a query or a fragment is refused: a
// smoke target is an origin (plus optional path prefix), and credentials in a URL would defeat "no auth".
export function normaliseBase(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new SmokeUsageError(`--base is not a valid URL: ${raw}`);
  }
  if (u.username || u.password) throw new SmokeUsageError('--base must not contain credentials');
  if (u.search || u.hash) throw new SmokeUsageError('--base must not contain a query string or fragment');
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new SmokeUsageError('--base must be https:// (http:// is only allowed for localhost / 127.0.0.1)');
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

// Request URL for one path: built from the validated base, then checked to still be on the base's origin with no
// credentials. Throws SmokeUsageError (the caller makes no request at all) for anything that could reach another host.
function requestUrl(base, path) {
  if (!isSmokePath(path)) throw new SmokeUsageError(`smoke path must start with a single '/' (not '//') and contain no backslash or control character: ${JSON.stringify(path)}`);
  const b = new URL(base);
  const u = new URL(base + path);
  if (u.origin !== b.origin || u.username || u.password) throw new SmokeUsageError(`smoke path leaves the base origin: ${JSON.stringify(path)}`);
  return u;
}

// The bypass plan: validated once; `headersFor(url)` then decides per REQUEST URL. The header is attached only when a name
// AND a non-empty value are configured and the request URL's origin is exactly one of bypass.origins (never loopback).
// `scrub` blanks the value out of any text that may reach the output (a reason quoting a server-echoed location or a fetch
// error message), so the secret can never be printed.
function bypassPlan(bypass) {
  const name = bypass?.header;
  const value = typeof bypass?.value === 'string' ? bypass.value.trim() : '';
  if (!name || !value) return { headersFor: () => ({ headers: HEADERS, sent: false }), scrub: (s) => s };
  if (typeof name !== 'string' || !SMOKE_BYPASS_HEADER_RE.test(name)) {
    throw new SmokeUsageError('smoke_bypass_header must be a lowercase header name matching /^x-[a-z0-9-]{1,60}$/');
  }
  // Visible ASCII only: a space/newline/control character is never a legal secret and would make fetch throw an error
  // that quotes the value. The message below deliberately does not.
  if (!/^[\x21-\x7e]+$/.test(value)) throw new SmokeUsageError('PIPELINE_SMOKE_BYPASS_KEY must be printable ASCII without spaces');
  const origins = Array.isArray(bypass.origins) ? bypass.origins : [];
  return {
    headersFor: (u) => (LOOPBACK.has(u.hostname) || !origins.includes(u.origin)
      ? { headers: HEADERS, sent: false }
      : { headers: { ...HEADERS, [name]: value }, sent: true }),
    scrub: (s) => s.split(value).join('[redacted]'),
  };
}

// Reads at most MAX_BODY_BYTES, then abandons the rest of the stream.
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES));
}

async function attempt(url, fetchFn, headers) {
  const res = await fetchFn(url, { method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const is2xx = res.status >= 200 && res.status < 300;
  const body = is2xx ? await readCapped(res) : null;
  if (!is2xx) await res.body?.cancel().catch(() => {});
  return { status: res.status, location: res.headers.get('location'), vercelId: res.headers.get('x-vercel-id'), body };
}

// Default (no status list configured): any 2xx or 3xx.
const statusAllowed = (check, status) => (check.status ? check.status.includes(status) : status >= 200 && status < 400);

function verdict(check, got) {
  const reasons = [];
  if (!statusAllowed(check, got.status)) reasons.push(`status ${got.status}, expected ${check.status ? check.status.join('|') : '2xx/3xx'}`);
  for (const text of check.contains ?? []) {
    if (got.body === null) reasons.push(`cannot check body for "${text}": body is only read for 2xx (got ${got.status})`);
    else if (!got.body.includes(text)) reasons.push(`body does not contain "${text}"`);
  }
  if (check.location_contains !== undefined) {
    if (!got.location) reasons.push('no location header');
    else if (!got.location.includes(check.location_contains)) reasons.push(`location "${got.location}" does not contain "${check.location_contains}"`);
  }
  return reasons;
}

// One check with retries. Returns { result, body } (body kept for --expect-text, never printed).
async function runCheck(target, { fetchFn, sleep, scrub }) {
  const { check, url, headers } = target;
  const started = Date.now();
  let got = null;
  let error = null;
  for (let i = 0; ; i++) {
    try {
      got = await attempt(url, fetchFn, headers);
      error = null;
    } catch (err) {
      got = null;
      error = err;
    }
    const retry = error !== null || (got.status >= 500 && !statusAllowed(check, got.status));
    if (!retry || i >= BACKOFF_MS.length) break;
    await sleep(BACKOFF_MS[i]);
  }
  const ms = Date.now() - started;
  if (error) {
    const why = error.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (error.cause?.code ?? error.cause?.message ?? error.message);
    return { result: { path: check.path, status: null, ok: false, reason: scrub(`network error: ${why}`), ms, vercelId: null }, body: null };
  }
  const reasons = verdict(check, got);
  return {
    result: { path: check.path, status: got.status, ok: reasons.length === 0, reason: reasons.length ? scrub(reasons.join('; ')) : null, ms, vercelId: got.vercelId === null ? null : scrub(got.vercelId) },
    body: got.body,
  };
}

/**
 * options: { base, production, checks: [{path, status?, contains?, location_contains?}], expectText?, expectPath?,
 *             bypass?: { header, value, origins } }   (sent only when header and value are set and the base's origin is
 *             exactly one of origins; never to loopback)
 * deps (tests): fetch, sleep. Throws SmokeUsageError for a bad base URL.
 */
export async function runSmoke(options, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const base = normaliseBase(options.base);
  const plan = bypassPlan(options.bypass);
  if (options.expectPath !== undefined && options.expectPath !== null && !isSmokePath(options.expectPath)) {
    throw new SmokeUsageError(`--expect-path must start with a single '/' (not '//') and contain no backslash or control character: ${JSON.stringify(options.expectPath)}`);
  }
  let checks = options.checks?.length ? options.checks : [{ path: '/' }];
  const expectText = options.expectText || null;
  // An --expect-path outside the configured checks is fetched as one more check (must answer 200).
  if (expectText && options.expectPath && !checks.some((c) => c.path === options.expectPath)) {
    checks = [...checks, { path: options.expectPath, status: [200] }];
  }

  // Every URL is built and checked before the first request, so a bad path means no request at all.
  const targets = checks.map((check) => {
    const u = requestUrl(base, check.path);
    return { check, url: u.href, ...plan.headersFor(u) };
  });
  const bypassHeader = targets.some((x) => x.sent);

  const results = [];
  const bodies = [];
  for (const target of targets) {
    const { result, body } = await runCheck(target, { fetchFn, sleep, scrub: plan.scrub });
    results.push(result);
    bodies.push(body);
  }

  let expect = null;
  if (expectText) {
    const i = options.expectPath
      ? results.findIndex((r) => r.path === options.expectPath)
      : results.findIndex((r) => r.status >= 200 && r.status < 300);
    expect = i < 0
      ? { found: false, path: options.expectPath ?? null }
      : { found: bodies[i] !== null && bodies[i].includes(expectText), path: results[i].path };
  }
  const ok = results.every((r) => r.ok) && (expect === null || expect.found);
  return { ok, base, production: Boolean(options.production), bypassHeader, checks: results, expectText: expect };
}

// Serialize for output with the secret blanked out of every string VALUE (keys are fixed code names). Scrubbing the serialized
// text instead would corrupt the JSON for a key like `true`/`1`/`"` and miss a key JSON escapes (`"`, `\`).
export function redactJson(obj, secret) {
  const s = typeof secret === 'string' ? secret.trim() : '';
  return JSON.stringify(obj, s ? (k, v) => (typeof v === 'string' ? v.split(s).join('[redacted]') : v) : undefined, 2);
}

export async function main(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  // Defence in depth: whatever is printed (a result field not scrubbed per field, an error message) never carries the bypass value.
  const out = (obj) => process.stdout.write(`${redactJson(obj, env.PIPELINE_SMOKE_BYPASS_KEY)}\n`);
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' }, production: { type: 'boolean' }, 'expect-text': { type: 'string' }, 'expect-path': { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
    if (!values.base) throw new SmokeUsageError('missing --base');
    const loaded = await (deps.loadConfig ?? loadConfig)(cwd);
    // No config file at all is the same as no smoke_checks configured; a config that exists but is invalid is an error.
    if (!loaded.ok && existsSync(loaded.path)) throw new SmokeUsageError(`invalid .claude/pipeline.yml: ${loaded.errors.join('; ')}`);
    const result = await runSmoke({
      base: values.base,
      production: values.production,
      checks: loaded.ok ? loaded.config.smoke_checks : [],
      expectText: values['expect-text'] ?? env.PIPELINE_SMOKE_EXPECT_TEXT,
      expectPath: values['expect-path'],
      bypass: {
        header: loaded.ok ? loaded.config.smoke_bypass_header : null,
        origins: loaded.ok ? loaded.config.smoke_bypass_origins : [],
        value: env.PIPELINE_SMOKE_BYPASS_KEY,
      },
    }, deps);
    out(result);
    return result.ok ? 0 : 1;
  } catch (err) {
    out({ ok: false, error: err instanceof SmokeUsageError || err?.code?.startsWith?.('ERR_PARSE_ARGS') ? 'usage' : 'internal', message: String(err?.message ?? err) });
    return 2;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; });
}

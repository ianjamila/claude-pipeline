// A stateful stand-in for the Vercel CLI, so tests never touch Vercel. Point PIPELINE_VERCEL at `node <this file>` and
// describe the world in the JSON file named by PIPELINE_FAKE_VERCEL_STATE:
//   { alias: {id,url,target,readyState,createdAt},      what the production domain serves now
//     deployments: [{id,url,...}],                       what `rollback` may switch to
//     healthyHosts: ["host", ...],                       hosts the fake smoke treats as healthy
//     inspectCode?: n, inspectStdout?: "...",            force a failing / odd `inspect`
//     rollbackCode?: n, rollbackStdout?: "..." }         force a failing `rollback` (alias is left untouched)
// Modes: `inspect <domain> --format json`, `rollback <target> --yes --timeout T`, and `--smoke <url>` (exit 0 only while
// the alias host is in healthyHosts), so one state file drives both the CLI and the smoke command a test configures.
// Every call is appended to PIPELINE_FAKE_VERCEL_LOG (one JSON line: argv, cwd).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.PIPELINE_FAKE_VERCEL_LOG) {
  appendFileSync(process.env.PIPELINE_FAKE_VERCEL_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
}

const statePath = process.env.PIPELINE_FAKE_VERCEL_STATE;
const state = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const host = (u) => String(u ?? '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

const [mode, target] = argv;
if (mode === '--smoke') {
  const healthy = (state.healthyHosts ?? []).map(host);
  const live = host(state.alias?.url);
  process.stdout.write(JSON.stringify({ ok: healthy.includes(live), live }) + '\n');
  process.exitCode = healthy.includes(live) ? 0 : 1;
} else if (mode === 'inspect') {
  if (state.inspectCode) {
    process.stderr.write('Error: could not inspect');
    process.exitCode = state.inspectCode;
  } else if (state.inspectStdout !== undefined) {
    process.stdout.write(state.inspectStdout);
  } else {
    process.stdout.write(JSON.stringify(state.alias));
  }
} else if (mode === 'rollback') {
  const wanted = (state.deployments ?? []).find((d) => d.id === target || host(d.url) === host(target));
  if (state.rollbackCode) {
    process.stderr.write(state.rollbackStdout ?? 'Error: rollback failed');
    process.exitCode = state.rollbackCode;
  } else if (!wanted) {
    process.stderr.write(`Error: no deployment ${target}`);
    process.exitCode = 1;
  } else {
    state.alias = { ...state.alias, ...wanted };
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(state.rollbackStdout ?? `Success! ${wanted.url} is now serving production`);
  }
} else {
  process.stderr.write(`fake-vercel: unknown command ${argv.join(' ')}`);
  process.exitCode = 99;
}

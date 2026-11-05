// A stand-in for `gh` that remembers the PR's comments, for the publication tests (test/review-publish.test.mjs, test/cli-triage-claude.test.mjs).
// Same script format and call log as fake-gh.mjs (PIPELINE_FAKE_GH_SCRIPT, PIPELINE_FAKE_GH_LOG) plus a state file (PIPELINE_FAKE_GH_STATE):
//   { me: "<login>", comments: [{id, body, user:{login}, created_at, updated_at}], seq, fail: { write?: true, list?: true, writeAfter?: <n comment writes allowed> } }
// Routes: `api user` (the viewer), GET .../issues/N/comments --paginate, POST .../issues/N/comments, PATCH .../issues/comments/ID. Anything else is
// answered by the script. A state file shared by two checkouts is how two worktrees of one PR see each other's publications.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const joined = argv.join(' ');
const stdin = argv.includes('--input') ? (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })() : '';
if (process.env.PIPELINE_FAKE_GH_LOG) appendFileSync(process.env.PIPELINE_FAKE_GH_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), stdin })}\n`);

const file = process.env.PIPELINE_FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const out = (json, code = 0, stderr = '') => {
  writeFileSync(file, JSON.stringify(state));
  if (json !== undefined) process.stdout.write(typeof json === 'string' ? json : JSON.stringify(json));
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
};
const stamp = () => new Date(Date.UTC(2026, 10, 5, 10, 0, 0) + (state.seq = (state.seq ?? 0) + 1) * 1000).toISOString().replace('.000Z', 'Z');
const writable = () => {
  state.writes = (state.writes ?? 0) + 1;
  return !(state.fail?.write || (Number.isInteger(state.fail?.writeAfter) && state.writes > state.fail.writeAfter));
};

if (/^api user/.test(joined)) {
  out(`${state.me ?? 'me'}\n`);
} else if (/^api repos\/[^/]+\/[^/]+\/issues\/\d+\/comments --paginate/.test(joined)) {
  if (state.fail?.list) out(undefined, 1, 'gh: Server Error (HTTP 502)');
  else out(state.comments);
} else if (/^api -X POST repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/.test(joined)) {
  if (!writable()) {
    out(undefined, 1, 'gh: Server Error (HTTP 502)');
  } else {
    const t = stamp();
    const id = 1000 + (state.comments.length + 1);
    state.comments.push({ id, body: JSON.parse(stdin).body, user: { login: state.me ?? 'me' }, created_at: t, updated_at: t, html_url: `https://github.com/x/y/pull/1#issuecomment-${id}` });
    out({ id, html_url: `https://github.com/x/y/pull/1#issuecomment-${id}` });
  }
} else if (/^api -X PATCH repos\/[^/]+\/[^/]+\/issues\/comments\/\d+/.test(joined)) {
  const c = state.comments.find((x) => String(x.id) === /comments\/(\d+)/.exec(joined)[1]);
  if (!c || !writable()) {
    out(undefined, 1, 'gh: Server Error (HTTP 502)');
  } else {
    c.body = JSON.parse(stdin).body;
    c.updated_at = stamp();
    out({ id: c.id, html_url: c.html_url });
  }
} else {
  const hit = JSON.parse(readFileSync(process.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8')).find((e) => new RegExp(e.match).test(joined));
  if (!hit) out(undefined, 99, `fake-gh-comments: no match for ${joined}`);
  else out(hit.stdoutJson !== undefined ? hit.stdoutJson : hit.stdout, hit.code ?? 0, hit.stderr ?? '');
}

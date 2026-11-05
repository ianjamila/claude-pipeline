// A stateful stand-in for `gh` for the needs-human hold tests (test/owner-go-hold-lift.test.mjs). Same script format and call log as
// fake-gh.mjs (PIPELINE_FAKE_GH_SCRIPT, PIPELINE_FAKE_GH_LOG), plus a state file (PIPELINE_FAKE_GH_STATE) that the label, timeline and comment
// routes read and write, so the order of the calls shows in the state they leave:
//   { labels: [names], prState?, timeline: [events], comments: [comments], clock, seq,
//     fail: { delete?, add?, comment?, timelineFrom? }, overrides: { timeline: { "<nth read>": { raw?, code?, stderr?, events? } } },
//     hooks: [{ match: <regex source>, phase: 'before' | 'after', nth?: 1, addLabels?, removeLabels?, push?: [events], prState? }] }
// Routes: `api -X DELETE .../issues/12/labels/needs-human` (removes the label, appends an `unlabeled` event by "me"), `pr edit 12 --add-label X`
// (adds it, appends a `labeled` event by "me" with a new node id), GET .../issues/12/timeline, GET / POST .../issues/12/comments. Every
// `pr view` reply whose script entry carries `labels` (or `state`) shows the live labels (prState). Anything else is answered by the script.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const joined = argv.join(' ');
const stdin = (() => {
  if (!argv.includes('--input')) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
})();
const log = process.env.PIPELINE_FAKE_GH_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ argv, cwd: process.cwd(), stdin })}\n`);

const stateFile = process.env.PIPELINE_FAKE_GH_STATE;
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const now = () => new Date(Date.UTC(2026, 10, 5, 10, 0, 0) + (state.clock = (state.clock ?? 100) + 1) * 1000).toISOString().replace('.000Z', 'Z');
const next = () => (state.seq = (state.seq ?? 0) + 1);
const out = (json, code = 0, stderr = '') => {
  if (json !== undefined) process.stdout.write(typeof json === 'string' ? json : JSON.stringify(json));
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
  save();
};
const event = (kind, name, login = 'me') => ({ event: kind, id: 9000 + next(), node_id: `${kind === 'labeled' ? 'LE' : 'UE'}_fake${state.seq}`, created_at: now(), actor: { login }, label: { name } });

const mutate = (h) => {
  for (const l of h.addLabels ?? []) if (!state.labels.includes(l)) state.labels.push(l);
  for (const l of h.removeLabels ?? []) state.labels = state.labels.filter((x) => x !== l);
  for (const e of h.push ?? []) state.timeline.push({ ...event(e.event, e.name ?? 'needs-human', e.login), ...(e.node_id ? { node_id: e.node_id } : {}) });
  if (h.prState) state.prState = h.prState;
};
state.hits ??= {};
const runHooks = (phase) => (state.hooks ?? []).forEach((h, i) => {
  if ((h.phase ?? 'after') !== phase || !new RegExp(h.match).test(joined)) return;
  state.hits[i] = (state.hits[i] ?? 0) + 1;
  if (state.hits[i] === (h.nth ?? 1)) mutate(h);
});

runHooks('before');
const run = () => {
  if (/^api -X DELETE repos\/acme\/widgets\/issues\/12\/labels\/needs-human$/.test(joined)) {
    if (state.fail?.delete) return out(undefined, 1, 'gh: Server Error (HTTP 500)');
    if (!state.labels.includes('needs-human')) return out(undefined, 1, 'gh: Label does not exist (HTTP 404)');
    state.labels = state.labels.filter((l) => l !== 'needs-human');
    if (!state.noUnlabeled) state.timeline.push(event('unlabeled', 'needs-human'));
    return out([]);
  }
  const add = /^pr edit 12 --add-label (\S+)$/.exec(joined);
  if (add) {
    if (state.fail?.add) return out(undefined, 1, 'gh: Server Error (HTTP 502)');
    if (!state.labels.includes(add[1])) {
      state.labels.push(add[1]);
      state.timeline.push(event('labeled', add[1]));
    }
    return out('');
  }
  if (/repos\/acme\/widgets\/issues\/12\/timeline/.test(joined)) {
    state.timelineReads = (state.timelineReads ?? 0) + 1;
    const o = state.overrides?.timeline?.[String(state.timelineReads)];
    if (state.fail?.timelineFrom && state.timelineReads >= state.fail.timelineFrom) return out(undefined, 1, 'gh: Server Error (HTTP 502)');
    if (o?.code) return out(undefined, o.code, o.stderr ?? 'gh: Server Error (HTTP 502)');
    if (o?.raw !== undefined) return out(o.raw);
    return out(o?.events ?? state.timeline);
  }
  if (/^api -X POST repos\/acme\/widgets\/issues\/12\/comments/.test(joined)) {
    if (state.fail?.comment) return out(undefined, 1, 'gh: Server Error (HTTP 500)');
    const id = 700 + next();
    const t = now();
    state.comments.push({ id, body: JSON.parse(stdin).body, user: { login: 'me' }, created_at: t, updated_at: t });
    return out({ id, html_url: `https://github.com/acme/widgets/pull/12#issuecomment-${id}` });
  }
  if (/^api repos\/acme\/widgets\/issues\/12\/comments --paginate/.test(joined)) return out(state.comments);
  const entries = JSON.parse(readFileSync(process.env.PIPELINE_FAKE_GH_SCRIPT, 'utf8'));
  const hit = entries.find((e) => new RegExp(e.match).test(joined));
  if (!hit) return out(undefined, 99, `fake-gh-hold: no match for ${joined}`);
  let body = hit.stdoutJson;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    body = { ...body };
    if ('labels' in body && Array.isArray(state.labels) && /^pr view/.test(joined)) body.labels = state.labels.map((name) => ({ name }));
    if ('state' in body && state.prState && /^pr view/.test(joined)) body.state = state.prState;
  }
  return out(body !== undefined ? body : hit.stdout, hit.code ?? 0, hit.stderr ?? '');
};
run();
// (the after-hooks run on the state `run` saved; their effect shows from the next call)
runHooks('after');
if (existsSync(stateFile)) save();

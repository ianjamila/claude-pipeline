// A STATEFUL stand-in for `gh` for one PR's comments (the scripted fake-gh.mjs cannot follow what a command posts). The store is a
// JSON file named by PIPELINE_FAKE_STORE:
//   { head, headRef, comments: [{id, user, body, created_at, updated_at, hideForGets?}], nextId, hidePosted?, failPostAfterStore? }
//   hidePosted         comments created by a POST are stored but never listed (a listing that lags forever)
//   hideForGets: n     (per comment) the comment is left out of the next n listings, then appears (eventual consistency)
//   failGetsAfter: n   the first n listings work, every later one fails (HTTP 502)
//   failPostAfterStore the next POST stores its comment and then fails with HTTP 502 (an ambiguous POST); decremented
// Answers: api user, repo view, pr view, GET/POST issue comments of acme/widgets #7, PATCH issues/comments/ID.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let stdin = '';
if (argv.includes('--input')) {
  stdin = await new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 200);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}
if (process.env.PIPELINE_FAKE_GH_LOG) appendFileSync(process.env.PIPELINE_FAKE_GH_LOG, `${JSON.stringify({ argv, stdin })}\n`);

const file = process.env.PIPELINE_FAKE_STORE;
const store = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(store));
const joined = argv.join(' ');
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const stamp = '2026-10-19T09:00:00Z';

if (/^api user/.test(joined)) out('me\n');
else if (/^repo view/.test(joined)) out({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } });
else if (/^pr view 7/.test(joined)) out({ headRefOid: store.head, headRefName: store.headRef ?? 'agent/x', baseRefName: 'main' });
else if (/-X POST repos\/acme\/widgets\/issues\/7\/comments/.test(joined)) {
  const id = store.nextId++;
  store.comments.push({ id, user: { login: 'me' }, body: JSON.parse(stdin).body, created_at: stamp, updated_at: stamp, html_url: `https://x/${id}`, ...(store.hidePosted ? { hidden: true } : {}) });
  const fail = (store.failPostAfterStore ?? 0) > 0;
  if (fail) store.failPostAfterStore -= 1;
  save();
  if (fail) { process.stderr.write('HTTP 502: Bad Gateway'); process.exitCode = 1; } else out({ id, html_url: `https://x/${id}` });
} else if (/-X PATCH repos\/acme\/widgets\/issues\/comments\/(\d+)/.test(joined)) {
  const c = store.comments.find((x) => String(x.id) === /comments\/(\d+)/.exec(joined)[1]);
  c.body = JSON.parse(stdin).body;
  save();
  out({ id: c.id, html_url: `https://x/${c.id}` });
} else if (/^api repos\/acme\/widgets\/issues\/7\/comments --paginate/.test(joined)) {
  if (store.failGetsAfter !== undefined) {
    if (store.failGetsAfter <= 0) { process.stderr.write('HTTP 502: Bad Gateway'); process.exitCode = 1; save(); process.exit(); }
    store.failGetsAfter -= 1;
  }
  const shown = store.comments.filter((c) => !c.hidden && !(c.hideForGets > 0));
  for (const c of store.comments) if (c.hideForGets > 0) c.hideForGets -= 1;
  save();
  out(shown);
} else {
  process.stderr.write(`fake-gh-store: no match for ${joined}`);
  process.exitCode = 99;
}

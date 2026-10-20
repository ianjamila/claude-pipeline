// A `gh` stand-in that REMEMBERS the PR's comments between calls (fake-gh.mjs is a static script). Point PIPELINE_GH at
// `node <this file>` and PIPELINE_STATEFUL_GH_STATE at a JSON file { comments: [], next: 100, writes: 0 }.
// PIPELINE_STATEFUL_GH_DROP=1: a comment write is acknowledged but never stored (GitHub's eventual listing, worst case).
import { readFileSync, writeFileSync } from 'node:fs';

const a = process.argv.slice(2).join(' ');
const stateFile = process.env.PIPELINE_STATEFUL_GH_STATE;
const st = JSON.parse(readFileSync(stateFile, 'utf8'));
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const drop = process.env.PIPELINE_STATEFUL_GH_DROP === '1';
const body = () => JSON.parse(readFileSync(0, 'utf8')).body;

if (/^api user/.test(a)) out('me\n');
else if (/^repo view/.test(a)) out({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } });
else if (/^pr view 12/.test(a)) out({ headRefOid: 'a'.repeat(40), headRefName: 'agent/feature', baseRefName: 'main' });
else if (/issues\/12\/comments --paginate/.test(a)) out(st.comments);
else if (/-X POST repos\/acme\/widgets\/issues\/12\/comments/.test(a)) {
  const id = st.next++;
  st.writes++;
  if (!drop) st.comments.push({ id, user: { login: 'me' }, body: body(), html_url: `https://x/${id}` });
  out({ id, html_url: `https://x/${id}` });
} else if (/-X PATCH repos\/acme\/widgets\/issues\/comments\/\d+/.test(a)) {
  const id = Number(/comments\/(\d+)/.exec(a)[1]);
  st.writes++;
  if (!drop) st.comments.find((c) => c.id === id).body = body();
  out({ id, html_url: `https://x/${id}` });
} else {
  process.stderr.write(`stateful-gh: no match for ${a}`);
  process.exitCode = 99;
}
writeFileSync(stateFile, JSON.stringify(st));

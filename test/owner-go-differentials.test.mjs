// Chat mode without needs-human: where the owner-go recorder and its readers could disagree. The recorder writes what the owner's prompt and the reply right
// before it say; the readers (`approvedRequest` for P merge, `approvedRelease` for P checkpoint) must take exactly that and nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedRelease, approvedRequest, ownerGoDir, readApprovals } from '../pipeline/hooks/lib/owner-go.mjs';
import { mergeRequest, ownerSays, stopReply } from './helpers/owner-go.mjs';

const HEAD = 'a'.repeat(40);
const ITEMS = 'b'.repeat(12);
const STOP = '5f3a9c2e';

function homeWith(t, records) {
  const home = mkdtempSync(join(tmpdir(), 'owner-go-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = ownerGoDir(home);
  mkdirSync(dir, { recursive: true });
  records.forEach((r, i) => writeFileSync(join(dir, `s${i}.jsonl`), `${JSON.stringify({ v: 1, session: `s${i}`, ts: new Date().toISOString(), prompt_sha256: 'x', cwd: null, prs: [], requests: [], releases: [], ...r })}\n`));
  return home;
}
const request = { pr: 12, head: HEAD.slice(0, 12), items: ITEMS };

test('a "resume" record (or a record of an unknown kind) never approves a merge, whatever requests it carries', (t) => {
  const home = homeWith(t, [{ kind: 'resume', prs: [12], requests: [request] }, { kind: 'bogus', prs: [12], requests: [request] }]);
  assert.equal(approvedRequest({ pr: 12, head: HEAD, items: ITEMS, home }), false);
  assert.deepEqual(readApprovals({ home }).map((r) => [r.kind, r.requests.length]), [['resume', 0]], 'the unknown kind is dropped; the resume record keeps no request');
  const ok = homeWith(t, [{ kind: 'approve', prs: [12], requests: [request] }]);
  assert.equal(approvedRequest({ pr: 12, head: HEAD, items: ITEMS, home: ok }), true);
});

test('a "merge" naming a head the shown request does not have releases nothing (the release follows the same head filter as the approval)', (t) => {
  const reply = stopReply(12, STOP, { merge: { head: HEAD, items: ITEMS } });
  const wrong = ownerSays(t, 'merge 1234567', reply);
  assert.deepEqual(wrong.requests, []);
  assert.deepEqual(wrong.releases, [], 'a wrong head names no request and releases no stop');
  const right = ownerSays(t, `merge ${HEAD.slice(0, 7)}`, reply);
  assert.deepEqual(right.releases, [{ pr: 12, stop: STOP }]);
  const plain = ownerSays(t, 'merge', reply);
  assert.deepEqual(plain.releases, [{ pr: 12, stop: STOP }]);
});

test('approvedRequest with several stop ids needs the request to carry every one of them', (t) => {
  const home = homeWith(t, [{ kind: 'approve', prs: [12], requests: [{ ...request, stops: ['aaaa1111'] }] }]);
  assert.equal(approvedRequest({ pr: 12, head: HEAD, items: ITEMS, stop: 'aaaa1111', home }), true);
  assert.equal(approvedRequest({ pr: 12, head: HEAD, items: ITEMS, stop: ['aaaa1111', 'bbbb2222'], home }), false);
  const both = homeWith(t, [{ kind: 'approve', prs: [12], requests: [{ ...request, stops: ['aaaa1111', 'bbbb2222'] }] }]);
  assert.equal(approvedRequest({ pr: 12, head: HEAD, items: ITEMS, stop: ['aaaa1111', 'bbbb2222'], home: both }), true);
  assert.equal(approvedRelease({ pr: 12, stop: 'aaaa1111', home: both }), null, 'a request that carried stops is not a release by itself');
});

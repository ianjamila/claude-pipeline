// #190.3b: the owner pastes the answer from a terminal and the prompt glyph comes with it ("❯ R4-B1: reject"). answerBody strips ONE leading glyph (❯ › > $) that is followed by a space,
// on a single line, and the parsers (rulingsIn, parseApproval, parseRoundGrant, both nudges) read the rest. The stored prompt and the --owner-quote comparison stay verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RULING_NUDGE, QUEUED_NUDGE, answerBody, ownerRuled, parseApproval, parseRoundGrant, queuedNudge, recordApproval, recordRoundGrant, recordRuling, rulingNudge, rulingsIn,
} from '../pipeline/hooks/lib/owner-go.mjs';
import { OWNER_ENTRY, linesOf, mergeRequest, roundRequest, rulingRequest } from './helpers/owner-go.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const ITEMS = 'abcdef012345';
const REPO = 'acme/app';
const GLYPHS = ['❯', '›', '>', '$'];
const QUEUED = { origin: { kind: 'human' }, promptSource: 'queued', entrypoint: 'cli' };

const entry = (text, meta = OWNER_ENTRY) => ({ type: 'user', message: { content: text }, ...meta });
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('#190.3b answerBody: one leading glyph followed by a space is stripped, on a single line; nothing else is', () => {
  for (const g of GLYPHS) {
    assert.equal(answerBody(`${g} merge`), 'merge', g);
    assert.equal(answerBody(`  ${g}   R4-B1: reject  `), 'R4-B1: reject', `${g}: white space around`);
    assert.equal(answerBody(`${g} merge`), 'merge', `${g}: a non-breaking space`);
    assert.equal(answerBody(`${g}merge`), `${g}merge`, `${g}: no space after the glyph`);
    assert.equal(answerBody(`${g} ${g} merge`), `${g} merge`, `${g}: only ONE glyph`);
    assert.equal(answerBody(`${g} merge\n#58`), `${g} merge\n#58`, `${g}: a multi-line prompt is left alone`);
    assert.equal(answerBody(`x ${g} merge`), `x ${g} merge`, `${g}: a glyph in the middle`);
  }
  assert.equal(answerBody('$5 please'), '$5 please');
  assert.equal(answerBody('>merge'), '>merge');
  assert.equal(answerBody('merge'), 'merge');
  assert.equal(answerBody(null), '');
  assert.equal(answerBody(undefined), '');
  assert.equal(answerBody('❯ '), '❯', 'a glyph with nothing after it is left (trim leaves the glyph)');
});

test('#190.3b rulingsIn: "❯ R4-B1: reject" (and > › $) decide; two glyphs, a mid-line glyph, extra words or no space do not', () => {
  for (const g of GLYPHS) {
    assert.deepEqual([...rulingsIn(`${g} R4-B1: reject`, ['R4-B1'])], [['R4-B1', 'REJECT']], g);
    assert.deepEqual([...rulingsIn(`${g} R1-B1: accept, R2-S3: follow-up`, ['R1-B1', 'R2-S3'])], [['R1-B1', 'ACCEPT'], ['R2-S3', 'FOLLOW-UP']], `${g}: two pairs`);
    for (const bad of [`${g} ${g} R4-B1: reject`, `x ${g} R4-B1: reject`, `${g} R4-B1: reject because it is wrong`, `${g}R4-B1: reject`, `${g} R4-B1: reject\nR2-S3: accept`]) {
      assert.equal(rulingsIn(bad, ['R4-B1', 'R2-S3']).size, 0, bad);
    }
  }
  assert.deepEqual([...rulingsIn('R4-B1: reject', ['R4-B1'])], [['R4-B1', 'REJECT']], 'control: no glyph');
});

test('#190.3b parseApproval / parseRoundGrant: a glyph before the words is ignored, other shapes stay refused', () => {
  for (const g of GLYPHS) {
    assert.deepEqual(parseApproval(`${g} merge`), { prs: [], shas: [] }, g);
    assert.deepEqual(parseApproval(`${g} merge #58`), { prs: [58], shas: [] }, `${g}: with a target`);
    assert.equal(parseApproval(`${g} merge later`), null, `${g}: glyph plus extra words`);
    assert.equal(parseApproval(`${g}merge`), null, `${g}: no space`);
    assert.equal(parseApproval(`${g} ${g} merge`), null, `${g}: two glyphs`);
    assert.equal(parseApproval(`not ${g} merge`), null, `${g}: mid-line`);
    assert.deepEqual(parseRoundGrant(`${g} extra round`), { prs: [], numbers: [] }, g);
    assert.equal(parseRoundGrant(`${g} extra round later`), null, `${g}: glyph plus extra words`);
    assert.equal(parseRoundGrant(`${g}extra round`), null, `${g}: no space`);
    assert.equal(parseRoundGrant(`${g} ${g} extra round`), null, `${g}: two glyphs`);
  }
  assert.equal(parseApproval('> merge later'), null);
  assert.deepEqual(parseRoundGrant('❯ extra round'), { prs: [], numbers: [] });
});

const tmp = () => mkdtempSync(join(tmpdir(), 'owner-go-glyph-'));
function transcript(dir, entries) {
  mkdirSync(join(dir, '.claude', 'projects', '-repo'), { recursive: true });
  const file = join(dir, '.claude', 'projects', '-repo', `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, linesOf(entries));
  return file;
}
let n = 0;
function hook(home, prompt, before, meta = OWNER_ENTRY) {
  const promptId = `pid-glyph-${++n}`;
  return {
    hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: home, prompt, prompt_id: promptId,
    transcript_path: transcript(home, [entry('ship it'), ...before, { ...entry(prompt, meta), promptId }]),
  };
}
const now = () => Date.parse('2026-11-10T10:00:00Z');

test('#190.3b the recorders: "❯ merge" and "❯ extra round" bind to the shown ask, and the prompt is stored verbatim', () => {
  const home = tmp();
  const m = recordApproval(hook(home, '❯ merge', [said(mergeRequest(58, HEAD, ITEMS, REPO))]), { home, now });
  assert.deepEqual(m?.requests.map((q) => [q.pr, q.head, q.items]), [[58, HEAD.slice(0, 12), ITEMS]]);
  assert.equal(m.prompt, '❯ merge', 'verbatim');
  const g = recordRoundGrant(hook(home, '> extra round', [said(roundRequest(58, 4, HEAD, REPO))]), { home, now });
  assert.deepEqual([g?.pr, g?.k], [58, 4]);
  assert.equal(g.prompt, '> extra round', 'verbatim');
  assert.equal(recordApproval(hook(home, '> merge later', [said(mergeRequest(58, HEAD, ITEMS, REPO))]), { home, now }), null, 'extra words after the glyph and merge');
});

test('#190.3b recordRuling keeps "❯ R4-B1: reject" verbatim and ownerRuled accepts that quote (and the bare words too)', () => {
  const home = tmp();
  const ask = rulingRequest(58, ['R4-B1'], REPO, ITEMS);
  const r = recordRuling(hook(home, '❯ R4-B1: reject', [said(ask)]), { home, now });
  assert.equal(r?.prompt, '❯ R4-B1: reject');
  const q = { repo: REPO, pr: 58, id: 'R4-B1', decision: 'REJECT', contentOf: () => ITEMS, home, now };
  assert.equal(ownerRuled({ ...q, quote: '❯ R4-B1: reject' }), true, 'the quote as typed');
  assert.equal(ownerRuled({ ...q, quote: 'R4-B1: reject' }), false, 'the comparison stays verbatim: a quote without the glyph is another string');
  assert.equal(ownerRuled({ ...q, quote: '❯ R4-B1: reject', decision: 'ACCEPT' }), false, 'the decision it states');
  const two = recordRuling(hook(home, '❯ ❯ R4-B1: reject', [said(ask)]), { home, now });
  assert.equal(two?.prompt, '❯ ❯ R4-B1: reject', 'recorded as any prompt is');
  assert.equal(ownerRuled({ ...q, quote: '❯ ❯ R4-B1: reject' }), false, 'but two glyphs decide nothing');
});

test('#190.3b the nudges read the glyph form as an answer: rulingNudge and queuedNudge', () => {
  const home = tmp();
  for (const g of GLYPHS) {
    assert.equal(rulingNudge(hook(home, `${g} R1-F1: accept`, [said('nothing asked')])), RULING_NUDGE, `${g}: ruling answer`);
    assert.equal(rulingNudge(hook(home, `${g} ${g} R1-F1: accept`, [said('nothing asked')])), null, `${g}: two glyphs`);
    assert.equal(rulingNudge(hook(home, `${g} R1-F1: accept because`, [said('nothing asked')])), null, `${g}: extra words`);
    for (const answer of [`${g} merge`, `${g} extra round`, `${g} R1-B1: accept`]) {
      assert.equal(queuedNudge(hook(home, answer, [said(mergeRequest(58, HEAD, ITEMS, REPO))], QUEUED)), QUEUED_NUDGE, answer);
      assert.equal(queuedNudge(hook(home, answer, [said(mergeRequest(58, HEAD, ITEMS, REPO))])), null, `${answer}: typed`);
    }
    assert.equal(queuedNudge(hook(home, `${g} merge later`, [], QUEUED)), null, `${g}: not an answer`);
  }
});

test('#190.3b the length caps apply after the strip (the nudges)', () => {
  const home = tmp();
  const grant = `extra round${' '.repeat(300 - 'extra round'.length - '#58'.length)}#58`; // 300 characters: at the cap
  assert.equal(grant.length, 300);
  assert.equal(queuedNudge(hook(home, grant, [], QUEUED)), QUEUED_NUDGE, 'control: at the cap');
  assert.equal(queuedNudge(hook(home, `${grant}.`, [], QUEUED)), null, 'control: one over the cap');
  assert.equal(queuedNudge(hook(home, `> ${grant}`, [], QUEUED)), QUEUED_NUDGE, 'glyph plus a 300-character body: 302 raw, at the cap once stripped');
});

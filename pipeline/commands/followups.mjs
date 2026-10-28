// Turns the review's FOLLOW-UP decisions into GitHub issues (label `agent-suggestion`) so a good idea that is out of
// scope for this PR is not lost. Each issue is recorded in the state as soon as it exists, so a failure half-way (or a
// re-run) never files the same suggestion twice.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { defuseMarkdown } from '../lib/codex.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { saveState, updateItems } from '../lib/state.mjs';
import { createHash } from 'node:crypto';
import { allItems, findRound, oneLine, requireState, withStateLock } from '../lib/review-context.mjs';

export const meta = {
  summary: 'open an agent-suggestion issue for each FOLLOW-UP item of a round',
  usage: [
    'pipeline followups create --round R [--repo DIR]',
    '  -> {ok, round, created:[{id, number, url}], reused:[{id, number, url}], duplicates:[{id, canonical, others:[url]}],',
    '      skipped:[ids already filed], held:[ids waiting for a human]}',
    '  one issue per fingerprint across the whole review; a FOLLOW-UP that needs a human is held, not filed.',
    '  Each issue body starts with <!-- claude-pipeline:followup pr=N fp=FINGERPRINT -->; before creating, an issue of ours',
    '  (any state) with that marker is REUSED (several: lowest number is canonical, the rest are listed, never closed)',
  ].join('\n'),
};

export const FOLLOWUP_LABEL = 'agent-suggestion';
const TITLE_PREFIX = '[agent-suggestion] ';
const TITLE_MAX = 120;

const clip = (s, max) => (Array.from(s).length > max ? `${Array.from(s).slice(0, max - 1).join('').trimEnd()}…` : s);

// What a reader (a re-run, a resume on another machine) looks for to know this suggestion is already filed. Only the
// pipeline writes the first line of a body, and only ITS author's issues count, so quoted or forged markers are inert.
const SAFE_FP = /^[A-Za-z0-9._:-]{1,128}$/;
export function followupMarker(pr, item) {
  const raw = String(item.fingerprint || item.id);
  const fp = SAFE_FP.test(raw) ? raw : createHash('sha256').update(raw).digest('hex');
  return `<!-- claude-pipeline:followup pr=${pr} fp=${fp} -->`;
}

// Everything in the issue came from a model that has read untrusted PR text: defuse hidden comments and @mentions
// (the marker is ours and goes in first, after the defusing).
export function issueBody(item, pr) {
  const where = item.file ? (item.line > 0 ? `${item.file}:${item.line}` : item.file) : null;
  const decidedBy = item.final?.by === 'owner' ? 'Owner' : item.arbiter && item.final?.by === 'arbiter' ? 'Arbiter' : 'Judge';
  const lines = [
    String(item.detail ?? '').trim(),
    '',
    item.source === 'fable'
      ? `**Raised by the Fable review:** ${String(item.arbiter?.reasoning ?? '').trim()}`
      : `**Codex reasoning:** ${String(item.codexReasoning ?? '').trim()}`,
    '',
    `**${decidedBy} (why this is a follow-up, not part of the PR):** ${String(item.final?.reason ?? item.judge?.reason ?? '').trim()}`,
    '',
  ];
  if (where) lines.push(`Location: \`${oneLine(where)}\``, '');
  lines.push(`From PR #${pr}, item ${item.id}.`, '', 'Promote this by relabelling `agent-suggestion` to `agent-build`.');
  return `${followupMarker(pr, item)}\n${defuseMarkdown(lines.join('\n'))}`;
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub !== 'create') throw new UsageError('usage: pipeline followups create --round R [--repo DIR]');
  const { values } = parseCommandArgs(rest, { round: { type: 'string' }, repo: { type: 'string' } }, { allowPositionals: false });
  const n = intOption(values, 'round', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  return withStateLock(root, ctx, () => {
    let state = requireState(root);
    const round = findRound(state, n);

    // A follow-up a human still has to decide is not a suggestion yet; the decision may turn out to be "no".
    const followups = round.items.filter((i) => i.final?.decision === 'FOLLOW-UP');
    const held = followups.filter((i) => i.final.needsHuman === true).map((i) => i.id);
    const ready = followups.filter((i) => i.final.needsHuman !== true);
    // One issue per fingerprint across the WHOLE review, whichever round raised it and however its ruling was reached.
    const filed = new Map();
    for (const item of allItems(state)) if (item.fingerprint && item.followupIssue) filed.set(item.fingerprint, item.followupIssue);
    const skipped = [];
    const todo = [];
    for (const item of ready) {
      if (item.followupIssue) skipped.push(item.id);
      else if (item.fingerprint && filed.has(item.fingerprint)) {
        state = updateItems(state, n, [{ ...item, followupIssue: filed.get(item.fingerprint) }]);
        saveState(root, state);
        skipped.push(item.id);
      } else todo.push(item);
    }

    return guardGh(() => {
      const gh = createGitHub({ cwd: root, env: ctx.env });
      const created = [];
      const reused = [];
      const duplicates = [];
      // Issues of ours already carrying a marker for this PR: a previous run (or the other machine) may have filed one
      // whose URL never reached the state. Read once, and only when something is left to file.
      let known = null;
      const findFiled = (item) => {
        if (known === null) {
          const me = gh.viewer();
          // By creator, not by label: promoting a suggestion (agent-suggestion -> agent-build) must not hide it from this lookup.
          known = gh.listIssuesByCreator({ creator: me, state: 'all' }).filter((i) => i.author === me);
        }
        const marker = followupMarker(state.pr, item);
        return known.filter((i) => i.body.startsWith(marker)).sort((a, b) => a.number - b.number);
      };
      for (const item of todo) {
        // Two items of this round can share a fingerprint: the first one's issue serves both.
        const existing = item.fingerprint ? filed.get(item.fingerprint) : undefined;
        if (existing) {
          state = updateItems(state, n, [{ ...item, followupIssue: existing }]);
          saveState(root, state);
          skipped.push(item.id);
          continue;
        }
        const found = findFiled(item);
        if (found.length > 0) {
          const [canonical, ...others] = found;
          state = updateItems(state, n, [{ ...item, followupIssue: canonical.url }]);
          saveState(root, state);
          if (item.fingerprint) filed.set(item.fingerprint, canonical.url);
          reused.push({ id: item.id, number: canonical.number, url: canonical.url });
          if (others.length > 0) duplicates.push({ id: item.id, canonical: canonical.url, others: others.map((o) => o.url) });
          continue;
        }
        const issue = gh.issueCreate({
          title: clip(`${TITLE_PREFIX}${oneLine(item.title)}`, TITLE_MAX),
          body: issueBody(item, state.pr),
          labels: [FOLLOWUP_LABEL],
        });
        state = updateItems(state, n, [{ ...item, followupIssue: issue.url }]);
        saveState(root, state); // record before the next call: a later failure must not lose this one
        if (item.fingerprint) filed.set(item.fingerprint, issue.url);
        created.push({ id: item.id, number: issue.number, url: issue.url });
      }
      return { exitCode: EXIT.OK, output: { ok: true, round: n, created, reused, duplicates, skipped, held } };
    });
  });
});

// Turns the review's FOLLOW-UP decisions into GitHub issues (label `agent-suggestion`) so a good idea that is out of
// scope for this PR is not lost. Each issue is recorded in the state as soon as it exists, so a failure half-way (or a
// re-run) never files the same suggestion twice.
import { EXIT, UsageError, intOption, parseCommandArgs } from '../lib/cli.mjs';
import { defuseMarkdown } from '../lib/codex.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { saveState, updateItems } from '../lib/state.mjs';
import { allItems, findRound, oneLine, requireState, withStateLock } from '../lib/review-context.mjs';

export const meta = {
  summary: 'open an agent-suggestion issue for each FOLLOW-UP item of a round',
  usage: [
    'pipeline followups create --round R [--repo DIR]',
    '  -> {ok, round, created:[{id, number, url}], skipped:[ids already filed], held:[ids waiting for a human]}',
    '  one issue per fingerprint across the whole review; a FOLLOW-UP that needs a human is held, not filed',
  ].join('\n'),
};

export const FOLLOWUP_LABEL = 'agent-suggestion';
const TITLE_PREFIX = '[agent-suggestion] ';
const TITLE_MAX = 120;

const clip = (s, max) => (Array.from(s).length > max ? `${Array.from(s).slice(0, max - 1).join('').trimEnd()}…` : s);

// Everything in the issue came from a model that has read untrusted PR text: defuse hidden comments and @mentions.
export function issueBody(item, pr) {
  const where = item.file ? (item.line > 0 ? `${item.file}:${item.line}` : item.file) : null;
  const decidedBy = item.arbiter && item.final?.by === 'arbiter' ? 'Arbiter' : 'Judge';
  const lines = [
    String(item.detail ?? '').trim(),
    '',
    `**Codex reasoning:** ${String(item.codexReasoning ?? '').trim()}`,
    '',
    `**${decidedBy} (why this is a follow-up, not part of the PR):** ${String(item.final?.reason ?? item.judge?.reason ?? '').trim()}`,
    '',
  ];
  if (where) lines.push(`Location: \`${oneLine(where)}\``, '');
  lines.push(`From PR #${pr}, item ${item.id}.`, '', 'Promote this by relabelling `agent-suggestion` to `agent-build`.');
  return defuseMarkdown(lines.join('\n'));
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
      for (const item of todo) {
        // Two items of this round can share a fingerprint: the first one's issue serves both.
        const existing = item.fingerprint ? filed.get(item.fingerprint) : undefined;
        if (existing) {
          state = updateItems(state, n, [{ ...item, followupIssue: existing }]);
          saveState(root, state);
          skipped.push(item.id);
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
      return { exitCode: EXIT.OK, output: { ok: true, round: n, created, skipped, held } };
    });
  });
});

// Creates (or realigns) the labels the pipeline's state machine runs on. Idempotent: running it twice
// changes nothing, and a label someone recoloured or re-described is put back.
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { GhError } from '../lib/proc.mjs';
import { createGitHub, commandCwd, guardGh } from '../lib/github.mjs';

export const meta = {
  summary: 'create or align the pipeline labels on GitHub',
  usage: 'pipeline labels ensure [--repo DIR]',
};

export const LABELS = Object.freeze([
  { name: 'needs-human', color: 'b60205', description: 'Waiting for the owner' },
  { name: 'awaiting-review', color: 'fbca04', description: 'Cross-model review pending (Codex unavailable)' },
  { name: 'pipeline-blocked', color: 'd93f0b', description: 'Verify could not be made green' },
  { name: 'pipeline-pause', color: '5319e7', description: 'Open issue with this label pauses all agent merges' },
  { name: 'pipeline-rollback', color: 'b60205', description: 'Production was rolled back; merges paused' },
  { name: 'agent-suggestion', color: '0e8a16', description: 'Follow-up idea from the review loop' },
  { name: 'agent-build', color: '1d76db', description: 'Ask the pipeline to build this' },
  { name: 'human-approved', color: '0e8a16', description: 'Owner approved this head (hard-stop)' },
  { name: 'test-change-approved', color: '0e8a16', description: 'Owner approved a test change' },
  { name: 'pipeline-recheck', color: 'c5def5', description: 'Added and removed by review-complete to re-run the guards' },
]);

// GitHub label names are case-insensitive and colours come back with or without '#'.
const key = (name) => String(name).toLowerCase();
const colour = (c) => String(c ?? '').replace(/^#/, '').toLowerCase();

export async function run(argv, ctx) {
  const { values, positionals } = parseCommandArgs(argv, { repo: { type: 'string' } });
  if (positionals.length !== 1 || positionals[0] !== 'ensure') throw new UsageError('usage: pipeline labels ensure [--repo DIR]');
  const gh = createGitHub({ cwd: commandCwd(values, ctx), env: ctx.env });

  return guardGh(() => {
    const existing = new Map(gh.listLabels().map((l) => [key(l.name), l]));
    const out = { created: [], updated: [], unchanged: [] };
    for (const want of LABELS) {
      const have = existing.get(key(want.name));
      if (!have) {
        try {
          gh.createLabel(want);
          out.created.push(want.name);
        } catch (err) {
          // Not in the first 200 listed, or created a moment ago elsewhere: realign it instead.
          if (!(err instanceof GhError) || !/already exists/i.test(`${err.stderr} ${err.stdout}`)) throw err;
          gh.editLabel(want);
          out.updated.push(want.name);
        }
      } else if (colour(have.color) !== want.color || (have.description ?? '').trim() !== want.description) {
        gh.editLabel({ ...want, name: have.name });
        out.updated.push(want.name);
      } else {
        out.unchanged.push(want.name);
      }
    }
    return { exitCode: EXIT.OK, output: { ok: true, ...out } };
  });
}

// `pipeline model-floor show | reset`: the Fable floor registry (plan 2026-11-10, A1/A4b; the library is lib/model-floor.mjs).
// `show` is read-only and runs anywhere. `reset` is the owner's recovery, so it refuses inside Claude Code with the same check
// `pipeline update` uses (lib/owner-only.mjs): an agent must never be able to lower or unblock the floor that gates its own review.
import path from 'node:path';
import { EXIT, UsageError, parseCommandArgs } from '../lib/cli.mjs';
import { ALLOW_MAX, MIN_FABLE, floorDir, isAllowableId, parseModelId, readFloor, readableAllowedIds, resetFloor } from '../lib/model-floor.mjs';
import { insideClaudeCode } from '../lib/owner-only.mjs';

export const meta = {
  summary: 'show the Fable model floor; reset it (owner only, run in your own terminal): back to the shipped minimum, optionally holding it',
  usage: [
    'pipeline model-floor show   -> {ok, floor, MIN_FABLE, registry, readableAllowed: [allowed ids the parser reads now: drop one with `reset --remove-allow <id>`], file, error?} : READ-ONLY, runs anywhere; exit 0, or 1 when the registry file is unreadable (reviews are blocked until a reset)',
    'pipeline model-floor reset [--hold <fable model id> | --clear-hold] [--clear-lock]   -> {ok, floor, hold, file, clearedLock}',
    'pipeline model-floor reset --clear-lock --keep-floor   (clear a stuck floor lock and nothing else: the registry, the learned floor, the hold and the allowances stay as they are)',
    'pipeline model-floor reset [--allow-id <exact claude-fable-… id> ... | --remove-allow <id> ... | --clear-allow]   (also takes the options above; the output then carries allow: [ids] when any are set)',
    '  with --allow-id, --remove-allow and/or --clear-allow (and no --hold / --clear-hold; --clear-lock alongside is fine) it is not a reset: it changes the allow list and keeps the learned floor (newest, history) and the hold; a corrupt registry is refused',
    '  (exit 1 model-floor-unreadable): run a plain `model-floor reset` first.',
    '  Owner only: refused inside Claude Code (exit 2 `refused`); run it in your own terminal (`node ~/.claude/pipeline/bin/pipeline.mjs model-floor reset`).',
    '  A plain reset (no --allow-id / --remove-allow / --clear-allow, or together with --hold / --clear-hold; a bare --clear-lock too, which also forgets the learned floor: use --clear-lock --keep-floor to keep it) rewrites the registry to the shipped minimum (a corrupt or unreadable registry is replaced); an existing hold and allowed ids are kept.',
    '  --hold <id>   also caps the floor at that Fable id (a claude-fable-* id) until `model-floor reset --clear-hold`. Use it to roll back an alias',
    '                (the `fable` alias moved to a model you do not want) or when the two accounts resolve different Fables. It also lowers the version',
    '                below which a recorded Fable proof is re-reviewed, so a review proven with the held model can complete.',
    '  --clear-hold  lift the cap (not with --hold)',
    `  --allow-id <id>  accept that exact claude-fable-* id although the parser cannot read it; repeatable, at most ${ALLOW_MAX}. An allowance never raises the floor for an id the parser cannot read, and an id the parser reads that is below the floor is refused all the same.`,
    '                A claude-fable-* id the parser cannot read blocks reviews, including the PR that fixes the parser: run `model-floor reset --allow-id <the new id>` in your own',
    '                terminal, merge the parser fix, then `model-floor reset --remove-allow <that id>` (neither forgets the learned floor).',
    '                Until then `arbiter apply`, `model-proof`, `review-complete`, the final gate and `preflight` say the allowance is in force. (`--hold` does not unblock an unreadable id: it only caps the floor.)',
    '  --remove-allow <id>  remove exactly that id from the allow list (repeatable; the other ids stay). An id that is not on the list is refused (exit 2), naming the list. Not with --clear-allow, nor with --allow-id for the same id.',
    '  --clear-allow remove every allowed id (not with --allow-id or --remove-allow); to drop one id use --remove-allow',
    '  --clear-lock  first remove a floor lock left behind by another host or an unreadable owner record (a dead holder\'s lock clears itself). It removes only the lock it inspected (a lock a review takes meanwhile stays: exit 1 model-floor-lock-changed) and does nothing when there is none. It refuses while the holder is a running process on this machine (exit 1 model-floor-lock-live, naming the pid and the lock folder): confirm that pid is a pipeline process (`ps -p <pid> -o command=`) and stop it or wait for it; when it is not (the pid was reused by an unrelated program), remove the lock folder by hand. A lock that cannot be read (permissions, I/O error) is refused too (model-floor-lock-unreadable). On its own it is a plain reset (the learned floor goes back to the minimum): add --keep-floor to clear the lock and keep the learned floor',
    '  --keep-floor  with --clear-lock and nothing else: remove the lock and rewrite nothing (a corrupt registry is refused: run `model-floor reset --clear-lock` first)',
  ].join('\n'),
};

const SUBCOMMANDS = ['show', 'reset'];

export async function run(argv, ctx = {}) {
  const env = ctx.env ?? process.env;
  const { values, positionals } = parseCommandArgs(argv, {
    hold: { type: 'string' }, 'clear-hold': { type: 'boolean' }, 'allow-id': { type: 'string', multiple: true }, 'remove-allow': { type: 'string', multiple: true }, 'clear-allow': { type: 'boolean' }, 'clear-lock': { type: 'boolean' }, 'keep-floor': { type: 'boolean' },
  });
  const sub = positionals[0];
  if (!SUBCOMMANDS.includes(sub) || positionals.length > 1) throw new UsageError(`usage: pipeline model-floor ${SUBCOMMANDS.join(' | ')}`);
  // `ctx.floor` ({dir, home}) is a test seam for an injected registry folder; env's PIPELINE_MODEL_FLOOR_DIR works too (checkout only).
  const opts = { env, ...(ctx.floor ?? {}) };

  if (sub === 'show') {
    if (values.hold !== undefined || values['clear-hold'] || values['allow-id'] !== undefined || values['clear-allow'] || values['clear-lock'] || values['remove-allow'] !== undefined || values['keep-floor']) throw new UsageError('show takes no options');
    const r = readFloor(opts);
    const file = path.join(floorDir(opts), 'fable.json');
    return {
      exitCode: r.ok ? EXIT.OK : EXIT.FAILED,
      output: r.ok
        ? { ok: true, floor: r.floor, MIN_FABLE, registry: r.registry, readableAllowed: readableAllowedIds(r.registry), file }
        : { ok: false, floor: null, MIN_FABLE, registry: null, file, error: r.error, message: r.message },
    };
  }

  // reset
  if (values.hold !== undefined && values['clear-hold']) throw new UsageError('use --hold or --clear-hold, not both');
  if (values.hold !== undefined && parseModelId(values.hold)?.family !== 'fable') {
    throw new UsageError(`--hold must be a Fable model id such as claude-fable-5-2, not ${JSON.stringify(values.hold)}`);
  }
  const allowIds = values['allow-id'] ?? [];
  if (allowIds.length > 0 && values['clear-allow']) throw new UsageError('use --allow-id or --clear-allow, not both');
  for (const id of allowIds) {
    if (!isAllowableId(id)) throw new UsageError(`--allow-id must be an exact claude-fable-* model id (letters, digits, . _ - only), not ${JSON.stringify(id)}`);
  }
  const removeIds = values['remove-allow'] ?? [];
  if (removeIds.length > 0 && values['clear-allow']) throw new UsageError('use --remove-allow or --clear-allow, not both');
  if (values['keep-floor'] && (!values['clear-lock'] || values.hold !== undefined || values['clear-hold'] || allowIds.length > 0 || removeIds.length > 0 || values['clear-allow'])) {
    throw new UsageError('--keep-floor goes with --clear-lock alone: `pipeline model-floor reset --clear-lock --keep-floor`');
  }
  const inside = insideClaudeCode(env, ctx);
  if (inside) {
    const message = `pipeline model-floor reset refuses to run inside a Claude Code session (${inside}): it lowers or unblocks the floor that gates reviews. Run it in your own terminal (\`node ~/.claude/pipeline/bin/pipeline.mjs model-floor reset\`); \`model-floor show\` is allowed anywhere.`;
    return { exitCode: EXIT.USAGE, output: { ok: false, error: 'refused', message } };
  }

  try {
    const r = await resetFloor({ ...opts, hold: values.hold, clearHold: values['clear-hold'] === true, allowId: allowIds, removeAllow: removeIds, clearAllow: values['clear-allow'] === true, clearLock: values['clear-lock'] === true, keepFloor: values['keep-floor'] === true });
    return { exitCode: EXIT.OK, output: { ok: true, floor: r.floor, hold: r.registry?.hold ?? null, ...(r.registry?.allow ? { allow: r.registry.allow } : {}), file: r.file, clearedLock: r.clearedLock } };
  } catch (err) {
    if (typeof err?.code !== 'string' || !err.code.startsWith('model-floor-')) throw err;
    return { exitCode: err.code === 'model-floor-bad-hold' || err.code === 'model-floor-bad-allow' || err.code === 'model-floor-bad-keep' ? EXIT.USAGE : EXIT.FAILED, output: { ok: false, error: err.code, message: err.message } };
  }
}

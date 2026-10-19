// `pipeline verify <sub>`: the deterministic parts of how the ship skill runs verify. The skill never builds these command
// lines by hand. Subcommands so far: plan-after-fix (which verify commands to run after a round's accepted fixes).
import { EXIT, intOption, parseCommandArgs, UsageError } from '../lib/cli.mjs';
import { Fail, guarded, requireConfig, resolveRepo } from '../lib/cmd-common.mjs';
import { git, headSha, isAncestor, revParse } from '../lib/git.mjs';
import { matchGlob } from '../lib/glob.mjs';
import { loadState } from '../lib/state.mjs';

export const meta = {
  summary: 'plan the verify commands for the ship loop (plan-after-fix)',
  usage: [
    'pipeline verify plan-after-fix --round R [--repo DIR]   -> {ok, mode, commands, matchedSteps, base, head, files}',
    '  verify.after_fix full (default): commands = [verify.full]. quick: commands = [verify.quick] plus, when the fixes since round R\'s',
    '  reviewed head (renames count on both sides) touch a path in verify.after_fix_steps_by_path, verify.full --only <those steps>;',
    '  run them in order, either red = fix cycle. exit 1 {ok:false, error} when round R has no recorded review state (fail closed)',
  ].join('\n'),
};

// `--only` takes a comma list (template scripts/verify.mjs). npm swallows flags that come before `--`, so an
// `npm run ...` command gets one inserted unless it already forwards its arguments.
export function withOnly(command, steps) {
  const only = `--only ${steps.join(',')}`;
  const trimmed = command.trim();
  const forwards = /\s--(\s|$)/.test(trimmed);
  return /^npm\s+run(\s|$)/.test(trimmed) && !forwards ? `${trimmed} -- ${only}` : `${trimmed} ${only}`;
}

// Paths of `git diff -M --name-status -z from..to`, a rename counted on BOTH sides (moving a file out of a mapped
// directory is as relevant as moving one in). In first-seen order, no repeats.
export function changedPaths(from, to, o) {
  const out = git(['diff', '-M', '--name-status', '-z', '--no-color', '--no-ext-diff', `${from}..${to}`], o);
  const parts = out.split('\0');
  const paths = new Set();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (status === '') { i += 1; continue; }
    const two = status[0] === 'R' || status[0] === 'C';
    const names = parts.slice(i + 1, i + (two ? 3 : 2));
    if (names.length !== (two ? 2 : 1) || names.some((n) => n === undefined || n === '')) throw new Fail(EXIT.USAGE, { ok: false, error: 'git', message: `unexpected diff entry near ${JSON.stringify(status)}` });
    for (const n of names) paths.add(n);
    i += 1 + names.length;
  }
  return [...paths];
}

async function planAfterFix(argv, ctx) {
  const { values } = parseCommandArgs(argv, { repo: { type: 'string' }, round: { type: 'string' } }, { allowPositionals: false });
  const round = intOption(values, 'round', { required: true, min: 1 });
  const root = resolveRepo(values, ctx);
  const { config } = await requireConfig(root);
  const { full, quick, after_fix: mode, after_fix_steps_by_path: byPath = {} } = config.verify;
  const o = { cwd: root };
  const head = headSha(o);

  if (mode !== 'quick') {
    return { exitCode: EXIT.OK, output: { ok: true, mode: 'full', commands: [full], matchedSteps: [], base: null, head, files: [] } };
  }

  // The head round R was reviewed at: the fixes to verify are everything committed after it. No record, no plan
  // ("quick only" would silently skip the database steps a fix may need).
  let state;
  try {
    state = loadState(root);
  } catch (err) {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'state', message: err.message });
  }
  const found = state?.rounds?.find((r) => r.n === round);
  if (!found || typeof found.toHead !== 'string' || found.toHead === '') {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'no-round-state', message: `no review state for round ${round} (.review/state.json): cannot tell which commits the fixes are; run the full verify (${full})` });
  }
  const base = revParse(found.toHead, o);
  if (!isAncestor(base, head, o)) {
    throw new Fail(EXIT.FAILED, { ok: false, error: 'base-not-ancestor', message: `round ${round}'s reviewed head ${base} is not an ancestor of HEAD ${head} (history was rewritten); run the full verify (${full})` });
  }

  const files = changedPaths(base, head, o);
  const matchedSteps = [];
  for (const [glob, steps] of Object.entries(byPath)) {
    if (!files.some((f) => matchGlob(f, glob))) continue;
    for (const s of steps) if (!matchedSteps.includes(s)) matchedSteps.push(s);
  }
  const commands = [quick, ...(matchedSteps.length > 0 ? [withOnly(full, matchedSteps)] : [])];
  return { exitCode: EXIT.OK, output: { ok: true, mode: 'quick', commands, matchedSteps, base, head, files } };
}

export const run = guarded(async (argv, ctx) => {
  const [sub, ...rest] = argv;
  if (sub === 'plan-after-fix') return planAfterFix(rest, ctx);
  throw new UsageError('usage: pipeline verify plan-after-fix --round R [--repo DIR]');
});

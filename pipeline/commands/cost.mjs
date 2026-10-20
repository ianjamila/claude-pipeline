// `pipeline cost --pr N --phase P --role R [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X]`: books
// one spend (an agent dispatch, a review call) in the run record's cost section, so `P summary` can show tokens and USD
// by phase and role. `--retry` counts a retry; `--session ID` names a Claude session of this run (its guard denies are
// counted at `P summary`). Display only: like every run-record write, a failure is a warning, never a decision.
import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { EXIT, UsageError, intOption, parseCommandArgs, requireOption } from '../lib/cli.mjs';
import { guarded, resolveRepo } from '../lib/cmd-common.mjs';
import { createGitHub, guardGh } from '../lib/github.mjs';
import { createRunRecorder } from '../lib/run-progress.mjs';
import { readSummaryComment } from '../lib/summary-comment.mjs';
import { EXEC_KEY_RE, costReport, listPriceUsd, modelFamily, normalisedEntry, normalisePhase, normaliseRole, usageFromTranscript } from '../lib/run-cost.mjs';

export const meta = {
  summary: 'book tokens / USD / retries of one agent call in the run record (shown by `P summary`)',
  usage: [
    'pipeline cost --pr N --phase build|verify|pr|review|gate|merge|... --role implementer|judge|arbiter|verifier|controller|other',
    '              [--input N] [--output N] [--cache-read N] [--cache-write N] [--usd X | --model M] [--from-transcript FILE] [--retry] [--session ID]... [--execution KEY] [--repo DIR]',
    '  -> {ok, recorded, cost, warnings}; exit 2 usage (a negative or non-numeric amount), 3 GitHub unavailable',
    '  --execution KEY (agent:ID | codex:ID | ctl:ID | plan:ID): book this spend ONCE under KEY; booking the same KEY again replaces its entry (never double-counts),',
    '  and the write is read back (up to 3 attempts): exit 1 {error: "not-persisted", key} when it never showed up, exit 1 {error: "cost-entries-full"} at 200 keys.',
    '  An unknown --role is booked as `other`, an unknown --phase as `other`. --from-transcript FILE: sum the message.usage of a Claude transcript (JSONL, at most 50 MB);',
    '  explicit --input/--output/--cache-* then add to it. --retry alone (no amounts) only counts a retry.',
  '  USD: --usd X as given; otherwise list price (opus / sonnet / haiku / fable) of each transcript message\'s own model (--model M prices the messages',
  '  that carry none) plus the explicit tokens at --model M. Tokens with no known model add no USD (a warning says so).',
  ].join('\n'),
};

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

function transcriptUsage(file, root, defaultModel) {
  const abs = resolve(root, file);
  let size;
  try {
    size = statSync(abs).size;
  } catch (err) {
    throw new UsageError(`--from-transcript: cannot read ${file} (${err.code ?? err.message})`);
  }
  if (size > MAX_TRANSCRIPT_BYTES) throw new UsageError(`--from-transcript: ${file} is ${size} bytes, at most ${MAX_TRANSCRIPT_BYTES} allowed`);
  return usageFromTranscript(readFileSync(abs, 'utf8'), { defaultModel });
}

export const run = guarded(async (argv, ctx) => {
  const { values } = parseCommandArgs(argv, {
    pr: { type: 'string' }, phase: { type: 'string' }, role: { type: 'string' },
    input: { type: 'string' }, output: { type: 'string' }, 'cache-read': { type: 'string' }, 'cache-write': { type: 'string' },
    usd: { type: 'string' }, model: { type: 'string' }, 'from-transcript': { type: 'string' }, retry: { type: 'boolean' }, session: { type: 'string', multiple: true },
    execution: { type: 'string' }, repo: { type: 'string' },
  }, { allowPositionals: false });
  const pr = intOption(values, 'pr', { required: true, min: 1 });
  const phase = requireOption(values, 'phase');
  const role = requireOption(values, 'role');
  const root = resolveRepo(values, ctx);

  const key = values.execution;
  if (key !== undefined) {
    if (!EXEC_KEY_RE.test(key)) throw new UsageError('--execution must look like agent:ID, codex:ID, ctl:ID or plan:ID (letters, digits, . _ : -)');
    if (!['input', 'output', 'cache-read', 'cache-write', 'usd', 'from-transcript'].some((k) => values[k] !== undefined)) throw new UsageError('--execution books an amount: pass --input … --usd or --from-transcript');
  }
  const spent = ['input', 'output', 'cache-read', 'cache-write', 'usd', 'from-transcript'].some((k) => values[k] !== undefined);
  if (!spent && !values.retry && !values.session?.length) throw new UsageError('nothing to record: pass amounts (--input … --usd), --retry or --session');

  if (values.model !== undefined && modelFamily(values.model) === null) throw new UsageError(`--model ${values.model}: not one of opus, sonnet, haiku, fable`);
  const fromFile = values['from-transcript'] ? transcriptUsage(values['from-transcript'], root, values.model) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpricedMessages: 0 };
  const num = (flag) => {
    if (values[flag] === undefined) return 0;
    const n = Number(values[flag]);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${flag} must be a non-negative number`);
    return n;
  };
  const patch = { cost: {} };
  const notes = [];
  if (spent) {
    const own = { input: num('input'), output: num('output'), cacheRead: num('cache-read'), cacheWrite: num('cache-write') };
    const ownTokens = own.input + own.output + own.cacheRead + own.cacheWrite > 0;
    let usd = num('usd');
    if (values.usd === undefined) {
      usd = fromFile.usd + (ownTokens && values.model !== undefined ? listPriceUsd(values.model, own) : 0);
      if (ownTokens && values.model === undefined) notes.push('tokens booked without --model or --usd: no USD added for them');
      if (fromFile.unpricedMessages > 0) notes.push(`${fromFile.unpricedMessages} transcript message(s) of a model with no list price: no USD added for them`);
    }
    const entry = {
      phase: normalisePhase(phase), role: normaliseRole(role),
      input: fromFile.input + num('input'), output: fromFile.output + num('output'),
      cacheRead: fromFile.cacheRead + num('cache-read'), cacheWrite: fromFile.cacheWrite + num('cache-write'),
      usd: Math.round(usd * 1e6) / 1e6,
    };
    if (key === undefined) patch.cost.entry = entry;
    else patch.cost.keyedEntry = { key, entry };
  }
  if (values.retry) patch.cost.retries = 1;
  if (values.session?.length) patch.cost.sessions = values.session;

  const gh = createGitHub({ cwd: root, env: ctx.env });
  return guardGh(() => {
    const recorder = createRunRecorder({ gh, pr });
    let record = recorder.update(patch);
    if (key !== undefined) {
      const failed = (error) => ({ exitCode: EXIT.FAILED, output: { ok: false, recorded: false, error, key, cost: null, warnings: [...notes, ...recorder.warnings] } });
      const full = () => recorder.warnings.some((w) => w.includes('cost-entries-full'));
      const booked = normalisedEntry(patch.cost.keyedEntry.entry);
      if (full()) return failed('cost-entries-full');
      // Verify after write: GitHub can acknowledge a comment write that a later read does not show. Up to 3 attempts. A write
      // that never showed up is applied again whole; an entry someone replaced is put back (retry / session counts are not repeated).
      for (let attempt = 1; ; attempt++) {
        let seen;
        try {
          const read = readSummaryComment(gh, pr);
          seen = read.status === 'ok' ? read.record.cost?.entries?.[key] : undefined;
          if (isDeepStrictEqual(seen, booked)) {
            record = read.record;
            break;
          }
        } catch (err) {
          recorder.warnings.push(`could not read the run record back: ${String(err?.message ?? err).slice(0, 160)}`);
        }
        if (attempt >= 3) return failed('not-persisted');
        record = recorder.update(seen === undefined ? patch : { cost: { keyedEntry: patch.cost.keyedEntry } });
        if (full()) return failed('cost-entries-full');
      }
    }
    const ok = record !== null;
    return {
      exitCode: ok ? EXIT.OK : EXIT.FAILED,
      output: { ok, recorded: ok, cost: ok ? costReport(record.cost) : null, warnings: [...notes, ...recorder.warnings] },
    };
  });
});

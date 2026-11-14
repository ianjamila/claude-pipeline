// The world of a refused Codex model (cp #431) for the CLI tests: the probe's captured `codex exec --json` stream (test/fixtures/codex-0.154/codex-0.154-json-model-not-found-stdout.jsonl)
// with the probe's model name replaced by the model the test asks for (the pipeline binds the refusal to the requested model), a synthetic rollout for the main run and one for the
// confirmation run (session_meta model_provider, turn_context model, task_complete error with codex_error_info "other"), all under a private CODEX_HOME. Nothing real is run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/codex-0.154/codex-0.154-json-model-not-found-stdout.jsonl', import.meta.url));
export const PROBE_MODEL = 'gpt-retired-zz9';
export const MAIN_THREAD = '01a1daf1-a944-7733-a4cb-3e6c343b8044';
export const CONFIRM_THREAD = '01a1daf1-a944-7733-a4cb-3e6c343b8055';

export const refusalBody = (model) => JSON.parse(readFileSync(FIXTURE, 'utf8').replaceAll(PROBE_MODEL, model).trim().split('\n').pop()).error.message;

function rollout({ id, model, provider, error }) {
  const lines = [
    { type: 'session_meta', payload: { id, session_id: id, originator: 'codex_exec', cli_version: '0.154.0', source: 'exec', model_provider: provider } },
    { type: 'turn_context', payload: { turn_id: 't1', model } },
  ];
  if (error !== null) lines.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message: error, codex_error_info: 'other' } } });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

// -> the env of a refused-model run (merge it into the CLI call). Options: `model` the model the CLI will ask for; `main` / `confirm` per-run overrides of what the rollout says
// ({ model, provider, error, missing }); `status` the Codex record folder.
export function modelStopEnv(scratch, { model, main = {}, confirm = {}, status } = {}) {
  const home = path.join(scratch, 'codex-home');
  const now = new Date();
  const day = path.join(home, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const body = refusalBody(model);
  const stream = (file, id) => {
    const target = path.join(scratch, file);
    writeFileSync(target, readFileSync(FIXTURE, 'utf8').replaceAll(PROBE_MODEL, model).replaceAll(MAIN_THREAD, id));
    return target;
  };
  for (const [id, over] of [[MAIN_THREAD, main], [CONFIRM_THREAD, confirm]]) {
    if (over.missing) continue;
    const file = path.join(day, `rollout-2026-11-15T09-00-00-${id}.jsonl`);
    writeFileSync(file, rollout({ id, model: over.model ?? model, provider: over.provider ?? 'openai', error: over.error === undefined ? body : over.error }));
  }
  return {
    FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDOUT: stream('model-stop-main.jsonl', MAIN_THREAD), FAKE_CODEX_CONFIRM_STDOUT: stream('model-stop-confirm.jsonl', CONFIRM_THREAD),
    CODEX_HOME: home, ...(status === undefined ? {} : { PIPELINE_CODEX_STATUS_DIR: status }),
  };
}

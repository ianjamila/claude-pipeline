# Review loop (ship Step 4)

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. Run from the PR worktree. One round = one
Codex pass + triage + (maybe) arbitration + implementation. Max `review.max_rounds` (default 3).

## Round N

### 1. Codex

- Range: round 1 `base = merge-base(origin/<default>, HEAD)`; later rounds `base = previous
  round's toHead`. `head = HEAD` (pushed).
- Effort: round 1 = `review.effort[<risk>]` (light lane ⇒ `medium`); rounds ≥ 2 =
  `review.effort.followup`.
- `P job start codex-rN -- node ~/.claude/pipeline/bin/pipeline.mjs codex-review --pr <N>
  --round <N> --base <base> --head <head> --effort <effort>` → `P job wait codex-rN --run-id <runId> --timeout 540`
  until done (`runId` is in the `job start` output; `replaced` ⇒ start the job again).
- Exit 3 (quota / auth / unavailable / malformed output) ⇒ `gh pr edit <N> --add-label
  awaiting-review`, `P comment --pr <N> --kind awaiting-review`, `P summary --pr <N> --outcome
  awaiting-review`, stop. Never treat a failed Codex run as "no findings".
- Output: `.review/round-N/codex.json` + `codex.md`, items with ids `RN-Bk` / `RN-Sk` / `RN-Wk`.
  Items whose fingerprint was already ruled are pre-filled from the cache (not re-triaged).

### 2. Light lane shortcut

If `P risk` said `lightLane: true` and Codex returned no BLOCKING and no SUGGESTION items:
`P triage light-lane --round N` (WORTH CONSIDERING items are listed in the summary as
"not triaged — light lane"), skip to step 6.

### 3. Judge

Compute a digest: `shasum -a 256 .review/round-N/codex.json` (first 8 chars = `<d8>`). Invoke the
`judge` agent — **no `model` parameter** — with `description: "pipeline-judge RN <d8>"` and a
prompt containing: absolute worktree path; paths `.review/round-N/codex.json` and
`.review/round-N/diff.patch`; PR title + 3-line summary; risk level; "items marked as ruled in
codex.json are not yours to decide". Then:
`P triage validate --round N --from-tag "pipeline-judge RN <d8>"` — parses the judge's JSON from
its transcript, validates every id, applies decisions. Invalid ⇒ re-invoke the judge once with
the validation errors; invalid again ⇒ `needs-human`.

### 4. Settle disputed bugs with tests

For each item `P state show --round N --disputed` returns with `settleTest.possible: true`:
dispatch an **implementer**: "Write the test described in <plan>. Do not fix anything. Commit it
on the PR branch only if it adds lasting coverage. Report whether it fails (bug real) or passes
(bug not real), with the one-line output." Then
`P triage settle --id <id> --result bug-confirmed|bug-disproved --evidence "<test name: output>"`.
A failing test makes the item ACCEPT (fix it in step 6, keeping the test).

### 5. Arbiter (at most one call per round)

`P arbiter needed --round N` → `{needed, items, inputPath, digest}`.
If `needed`: invoke the `arbiter` agent — **no `model` parameter** — with
`description: "pipeline-arbiter RN <digest8>"` and a prompt whose first lines are exactly
```
ROUND: N
INPUT-DIGEST: <digest>
Read <absolute path to .review/round-N/arbiter-input.md> and rule on every item in it.
```
(Proof switch: if `PIPELINE_ARBITER_MODEL_OVERRIDE` is set, pass that value as `model` and say
so in the PR body — see `proof-switches.md`.)
Then `P arbiter apply --round N --tag "pipeline-arbiter RN <digest8>"`. It locates the
transcript, proves every assistant message is `claude-fable-*` at effort `high` with no API
error, checks ROUND/digest, parses the rulings from the final message, and applies them. Exit 1
⇒ the round's arbitrated items are already marked `needsHuman` (reason `model-proof`); continue
to the end of the round, then stop with `needs-human`.
Rulings are final except: low confidence, or dismissing a BLOCKING security / auth /
permissions / data-integrity / data-loss item ⇒ `needsHuman` (the CLI applies this).

### 6. Act on the decisions

- ACCEPT (not yet implemented): one implementer dispatch with the list (`P state show --round N
  --accepted`): fix each, add/adjust tests where behaviour changes, quick verify, commit, push.
  Then the verifier runs `verify.full`. Red ⇒ fix cycle (max 2), else `needs-human`.
  `P state mark-implemented --ids <ids>`.
- FOLLOW-UP: `P followups create --round N` (one issue each, label `agent-suggestion`).
- REJECT: nothing (listed in the summary with the reason).
- `P comment --pr <N> --kind triage` (one comment, updated in place each round).

### 7. Exit check

`P state outcome` →
- `clean` (no open BLOCKING, no new ACCEPTED this round, nothing `needsHuman`, and review
  coverage matches the current content hash) ⇒ leave the loop.
- `needsHuman` non-empty ⇒ label `needs-human`, summary, stop.
- else if N < max ⇒ round N+1 (reviews only the diff since this round's head).
- else ⇒ `needs-human` with the unresolved list, summary, stop.

Any commit after the last clean round that changes PR content (anything except the agent-log
line) invalidates coverage — `P final-gate` will demand another round.

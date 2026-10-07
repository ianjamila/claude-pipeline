# Review loop (ship Step 4)

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. Run from the PR worktree. `<pr>` is the pull
request number, `<round>` the round number (1, 2, 3). One round = one Codex pass + triage + (maybe)
arbitration + implementation. Max `review.max_rounds` (default 3). Commands run as jobs report their
real code as `exitCode` in `job wait` (see Invariant 8 in `SKILL.md`).

## Round `<round>`

### 1. Codex

- Range: round 1 `base = git merge-base origin/<default_branch> HEAD`; later rounds `base = the
  previous round's toHead` (the `--head` you passed last time; also `.review/state.json` →
  `rounds[].toHead`). `head = HEAD` (pushed: `git push origin agent/<slug>`).
- Effort: round 1 = `review.effort[<risk>]` (light lane ⇒ `medium`); rounds ≥ 2 =
  `review.effort.followup`.
- `P job start codex-r<round> -- node ~/.claude/pipeline/bin/pipeline.mjs codex-review --pr <pr>
  --round <round> --base <base> --head <head> --effort <effort>` → `P job wait codex-r<round> --run-id
  <runId> --timeout 540` until done (`replaced` ⇒ start the job again). Then read `exitCode` and the
  JSON in `tail`:
  - 0: round recorded: `counts`, `preRuled` (items answered from the cache), `lightLane`.
  - 3 (`unavailable: true`, reason quota / auth / unavailable / error / malformed / github) ⇒
    `gh pr edit <pr> --add-label awaiting-review`, `P comment --pr <pr> --kind awaiting-review
    --reason "<reason>"`, `P summary --pr <pr> --outcome awaiting-review --built "…"` (works with no
    review state, i.e. in round 1), `P agent-log queue --line "<agentLogLine>"`, stop. Never treat a
    failed Codex run as "no findings".
  - 2 `error: empty-range`: earlier rounds accepted items but the branch content is unchanged — the
    "fix" did not change code. Go back to step 6 and make the real change.
  - 2 `base-mismatch` (wrong `--base`: recompute it as above), `head-moved` / `state-changed`
    (something moved while Codex ran): run the round again.
- Output: `.review/round-<round>/codex.json` + `codex.md`; `items` carry ids `R<round>-B<k>` /
  `R<round>-S<k>` / `R<round>-W<k>`. Items whose fingerprint was already ruled have a `final`
  (pre-filled from the cache) and are not re-triaged.

### 2. Light lane shortcut

If `P risk` said `lightLane: true` and Codex returned no BLOCKING and no SUGGESTION items
(`counts.blocking` and `counts.suggestions` both 0): `P triage light-lane --round <round>`
(WORTH CONSIDERING items are listed in the summary as "not triaged — light lane"), skip to step 6.

### 3. Judge

Skip the judge when no item is pending: Codex returned nothing, or `preRuled` equals the sum of
`counts` (every item was answered from the cache). Otherwise the pending items are the entries of
`codex.json` → `items` that have no `final`; list their ids in the prompt.

Compute a digest: `shasum -a 256 .review/round-<round>/codex.json` (first 8 chars = `<d8>`). Invoke
the `judge` agent — **no `model` parameter** — with `description: "pipeline-judge R<round> <d8>"`
(e.g. `pipeline-judge R2 1a2b3c4d`) and a prompt containing: absolute worktree path; paths
`.review/round-<round>/codex.json` and `.review/round-<round>/diff.patch`; PR title + 3-line
summary; risk level; the pending ids ("rule on exactly these, each once; items with a `final` are
not yours"). Then:
`P triage validate --round <round> --from-tag "pipeline-judge R<round> <d8>"` — finds the judge's
transcript by that Agent description, parses its JSON, requires exactly one valid decision for every
pending item, applies the decisions.
- Exit 2 `not-found`: Claude Code has not written the transcript yet: wait a few seconds, retry once;
  still `not-found` ⇒ `needs-human`.
- Exit 1 (invalid output, state untouched): re-invoke the judge once with the validation `errors`;
  invalid again ⇒ `needs-human`.

### 4. Settle disputed bugs with tests

For each item `P state show --round <round> --disputed` returns (judge said `disputedBug` with a
possible settle test; no test result yet):
1. Dispatch an **implementer** with the settle task: "Settle a disputed bug: write the test described
   in <plan>. Do not fix anything. Commit the test on the PR branch (it must be committed and match
   the repo's test globs). Report `Test file:`, `Test cmd:` (the command that runs only that test) and
   whether it fails (bug real) or passes (bug not real), with the one-line output."
2. You run: `P triage settle --id <id> --result bug-confirmed|bug-disproved --test-cmd "<Test cmd>"
   --test-file <Test file>`. The CLI runs the command itself, at the committed head, and records what
   it printed: `bug-confirmed` needs the test to FAIL (non-zero exit), `bug-disproved` needs it to PASS
   (exit 0); free-text evidence is not accepted. Exit 1 with a `reason` means the proof was refused
   (file not committed or modified, not a test file, not named in the command, wrong direction,
   timeout, command not runnable, item not settleable): fix what it says once; otherwise leave the
   item, the arbiter rules on it (step 5).
3. A confirmed bug becomes ACCEPT: fix it in step 6, keeping the test. A disproved bug stays REJECTed,
   and a disproved security / auth / permissions / data item still goes to `needs-human`. The committed
   test is part of the PR now, so the exit check will want one more round to review it (expected).

### 5. Arbiter (at most one call per round)

`P arbiter needed --round <round>` → `{needed, items, inputPath, digest, digest8, tag}`; `tag` is
`pipeline-arbiter R<round> <digest8>`.
If `needed`: invoke the `arbiter` agent — **no `model` parameter** — with
`description: <the tag from arbiter needed>` and a prompt whose first lines are exactly
```
ROUND: <round>
INPUT-DIGEST: <digest>
Read <absolute path to .review/round-<round>/arbiter-input.md> and rule on every item in it.
```
(Proof switch: if `PIPELINE_ARBITER_MODEL_OVERRIDE` is set, pass that value as `model` and say
so in the PR body — see `proof-switches.md`.)
Then `P arbiter apply --round <round> --tag "pipeline-arbiter R<round> <digest8>"` (the same tag). It
locates the subagent transcript by that Agent description, proves every assistant message is
`claude-fable-*` at effort `high` with no API error, checks ROUND/digest, parses the rulings from the
final message, and applies them.
- Exit 2 `not-found` (transcript not written yet): wait a few seconds, retry once; still missing ⇒
  `needs-human` for the round's arbitrated items.
- Exit 1 ⇒ the round's arbitrated items are already marked `needsHuman` (reason `model-proof`);
  continue to the end of the round, then stop with `needs-human`.
- `stopReasonMissing: true` in the output is informational: an interactive transcript did not record
  `stop_reason`, and the proof accepted it because the answer was a complete JSON block. `finalVia` says
  where the answer came from: `text` (final message) or `handback` (the subagent's `SubagentHandback` report,
  accepted only when its acknowledgment is the transcript's last line).
Rulings are final except: low confidence, or dismissing a BLOCKING security / auth /
permissions / data-integrity / data-loss item ⇒ `needsHuman` (the CLI applies this).

### 6. Act on the decisions

- ACCEPT (not yet implemented): one implementer dispatch with the list (`P state show --round
  <round> --accepted`): fix each, add/adjust tests where behaviour changes, quick verify, commit,
  `git push origin agent/<slug>`. Then the verifier runs `verify.full`. Red ⇒ fix cycle (max 2), else
  `needs-human`. Then `P state mark-implemented --ids <ids>` — exit 2 `no-code-change` means the
  branch content is still what the round reviewed: the fix has not actually changed code, so go back to
  the implementer (marking never substitutes for a fix; a green `verify.full` must show the fix).
- FOLLOW-UP: `P followups create --round <round>` (one issue each, label `agent-suggestion`).
- REJECT: nothing (listed in the summary with the reason).
- `P comment --pr <pr> --kind triage` (one comment, updated in place each round).
- Clean exit: `P review-complete --pr <pr>` is only for the resume path (it removes `awaiting-review`
  after a valid review); the normal loop ends at step 7.

### 7. Exit check

`P state outcome` (exit 0 whether or not clean; read `clean`) →
- `clean` (no open BLOCKING, no new ACCEPTED this round, nothing `needsHuman`, and review
  coverage matches the current content hash) ⇒ leave the loop.
- `needsHuman` non-empty ⇒ label `needs-human`, summary, stop.
- else if `<round>` < max ⇒ round `<round>`+1 (reviews only the diff since this round's head).
- else ⇒ `needs-human` with the unresolved list, summary, stop.

Any commit after the last clean round that changes PR content (anything except the agent-log
line) invalidates coverage — `P final-gate` will demand another round.

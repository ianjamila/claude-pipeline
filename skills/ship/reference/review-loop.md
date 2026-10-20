# Review loop (ship Step 4)

`P` = `node ~/.claude/pipeline/bin/pipeline.mjs`. Run from the PR worktree. `<pr>` is the pull
request number, `<round>` the round number (1, 2, 3). One round = one Codex pass + triage + (maybe)
arbitration + implementation. Max `review.max_rounds` (default 3), + one extra round when the last round's only open items are accepted fixes (`extraRound`). Commands run as jobs report their
real code as `exitCode` in `job wait` (see Invariant 8 in `SKILL.md`).

## Replaying a review (resume, or a second machine)

`P state show --pr <pr>` compares `.review/state.json` with the state in the PR's triage comment, which is
authoritative. Read `source` in the output:
- `local`: equal to the published state, or it only EXTENDS it (every published round identical, plus a later
  round that was never published). Continue from it.
- `published`: there was no local state; it was rebuilt from the comment (`recovered: true`).
- `quarantined`: the local state disagreed with the comment (same head/hash is not enough: the decisions must
  match too). The whole local `.review/` was moved to `quarantinedTo` (`.review/stale-<UTC time>/`, kept, never
  deleted) and the published state restored. Tell the owner; work from the restored state.

An interrupted round (Codex ran, but the loop stopped before its triage comment) is not part of the published
state. Discard it before running the same round number again: `P state discard-round --round <round> --pr <pr>`
removes it from the local state and moves `.review/round-<round>/` aside. It refuses (exit 2) a round the comment
already holds. A `P state outcome` with `followupsPending: true` means a published FOLLOW-UP has no issue yet: run
`P followups create --round <round>` (no Codex) and re-post the triage comment before the gate.

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
  - 0: round recorded: `counts`, `preRuled` (items answered from the cache), `lightLane`. Commits merged in from the
    base branch since the previous round ("Update branch") are not shown to Codex. If the output has `baseOnly: true`
    the round was only such a merge: Codex did not run, there are no items, and it counts as a clean round with no findings.
  - 3 (`unavailable: true`, reason quota / auth / unavailable / error / malformed / github) ⇒
    `gh pr edit <pr> --add-label awaiting-review`, `P comment --pr <pr> --kind awaiting-review
    --reason "<reason>"`, `P summary --pr <pr> --outcome awaiting-review --built "…"` (works with no
    review state, i.e. in round 1) plus `--cause codex:<reason> --action "Say \"resume pipeline reviews\" when Codex is back"`,
    `P agent-log publish --line "<agentLogLine>"`, stop. Never treat a
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
  still `not-found` ⇒ **park needs-human** (below) with `--cause judge:not-found`.
- Exit 1 (invalid output, state untouched): re-invoke the judge once with the validation `errors`;
  invalid again ⇒ **park needs-human** with `--cause judge:invalid`.

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

`P arbiter needed --round <round>` → `{needed, items, inputPath, digest, digest8, tag, promptHeader}`; `tag` is
`pipeline-arbiter R<round> <digest8>`; `promptHeader` is the two header lines below, ready to paste.
If `needed`: invoke the `arbiter` agent — **no `model` parameter** — with
`description: <the tag from arbiter needed>` and a prompt that starts with `promptHeader` **pasted verbatim** (do not retype it:
a prompt without the header fails the model proof and parks every arbitrated item), i.e. exactly
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
  **park needs-human** for the round's arbitrated items (`--cause arbiter:not-found`).
- Exit 1 ⇒ the round's arbitrated items are already marked `needsHuman` (reason `model-proof`);
  continue to the end of the round, then stop at step 7 with `needs-human` and its summary.
- `stopReasonMissing: true` in the output is informational: an interactive transcript did not record
  `stop_reason`, and the proof accepted it because the answer was a complete JSON block. Expect it on nearly
  every `handback` final (the closing message is a streaming snapshot); it is not a warning sign. `finalVia` says
  where the answer came from: `text` (final message) or `handback` (the subagent's `SubagentHandback` report,
  accepted only when its acknowledgment is the transcript's last line).
Rulings are final except: low confidence, or dismissing a BLOCKING security / auth /
permissions / data-integrity / data-loss item ⇒ `needsHuman` (the CLI applies this).

### 6. Act on the decisions

- ACCEPT (not yet implemented): one implementer dispatch with the list (`P state show --round
  <round> --accepted`): fix each, add/adjust tests where behaviour changes, quick verify, commit,
  `git push origin agent/<slug>`. Then the verifier runs `verify.full` (`P config` `verify.after_fix: full`, the default).
  When `verify.after_fix` is `quick`, run `P verify plan-after-fix --round <round>` instead and have the verifier run each
  command in its `commands` list, in order (a quick check, then the extra full steps the fixes touched; run them exactly as printed: with `verify.max_parallel_full` set the full ones come back as `verify slot --run [--only <steps>]`); exit 1 ⇒ run `verify.full` (as `verify slot --run` when `verify.max_parallel_full` is set, SKILL.md Step 2.2).
  Either red ⇒ fix cycle (max 2), else
  `needs-human` (park it as below, `--cause verify-red`). Then `P state mark-implemented --ids <ids>` — exit 2 `no-code-change` means the
  branch content is still what the round reviewed: the fix has not actually changed code, so go back to
  the implementer (marking never substitutes for a fix; a green verify must show the fix).
  Step 2.2's initial full verify and Step 5.3's gate verify stay full whatever `verify.after_fix` says: the gate
  still needs a full, clean report on the exact head.
- `P comment --pr <pr> --kind triage` (one comment, updated in place each round): post it FIRST, so the decided
  items are published before any issue exists. A run that dies after this point resumes from that comment.
- FOLLOW-UP: `P followups create --round <round>` (one issue each, label `agent-suggestion`). Each issue body starts
  with `<!-- claude-pipeline:followup pr=<pr> fp=<fingerprint> -->`; before creating, the command reuses an existing
  issue of ours with that marker (open or closed), so a re-run after a crash files only the missing ones. `reused` /
  `duplicates` in the output are reported to the owner, never closed. Then post `P comment --pr <pr> --kind triage`
  AGAIN so the comment carries the issue links.
- REJECT: nothing (listed in the summary with the reason).
- Clean exit: `P review-complete --pr <pr>` is only for the resume path (it removes `awaiting-review`
  after a valid review); the normal loop ends at step 7.

### 7. Exit check

`P state outcome` (exit 0 whether or not clean; read `clean`) →
- `clean` (no open BLOCKING, no new ACCEPTED this round, nothing `needsHuman`, and review
  coverage matches the current content hash) ⇒ leave the loop.
- `needsHuman` non-empty ⇒ **park needs-human** (label, comment, `P summary --outcome needs-human`), stop.
- else if `<round>` < max ⇒ round `<round>`+1 (reviews only the diff since this round's head).
- else if `extraRound` ⇒ ONE extra round `<round>`+1 (the last: it reviews only the fixes since this round's head; afterwards `extraRound` is false, so anything not clean parks).
- else ⇒ **park needs-human** with the unresolved list (same label, comment, `P summary`), stop.

**Park needs-human** (every `needs-human` stop in this loop is this exact sequence, never a bare label):
`gh pr edit <pr> --add-label needs-human`, `P comment --pr <pr> --kind needs-human --reason "…"` (no `--hits-file`),
`P summary --pr <pr> --outcome needs-human --action "<the one thing the owner does>" --cause review:<reason>`
(`<reason>`: `unresolved`, `needs-human-items`, `judge:not-found` …), `P agent-log publish --line "<agentLogLine>"`, stop.
With `owner_approval: chat` and `needsHuman` items, the `--action` is "Rule on <ids> in chat (accept / follow-up / reject), remove needs-human, then say ship resume N".
An arbiter ruling that parked an item makes the push an arbiter escalation by itself: summary reads the state.

### Owner rules in chat (`owner_approval: chat` only)

An item parked `needsHuman` (a failed model proof, a low-confidence arbiter, a dismissed security item) is cleared by the owner's
word in chat, never by you. When the owner rules on it ("accept R4-B1", "follow-up", "reject, it is fine"):
1. Per item, with the owner's EXACT words (copy the message, never a paraphrase): `P triage owner-ruling --round <round> --id <id>
   --decision ACCEPT|FOLLOW-UP|REJECT --reason "<why, one line>" --owner-quote "<the owner's words>" --pr <pr>`. It refuses label mode, an item
   that is not `needsHuman` and an empty quote; a published round is fine. It never clears the merge by itself: the quote is published in
   the triage comment and the final gate counts the item in `ownerMerge`, so the owner still has to say "merge" for the head. Its output says
   `published: false` and a `next`: the ruling is local only until step 2, and `P state show` before that restores the published state WITHOUT it.
2. `P comment --pr <pr> --kind triage` (re-post, so the ruling is published), then `P followups create --round <round>` for FOLLOW-UP,
   then post the triage comment again for the issue links.
3. ACCEPT: it is not clean until built and reviewed: implement it (step 6), `P state mark-implemented`, and run a new round.
4. The owner removes `needs-human` (never you) and says `ship resume <pr>`; resume routes to `review` or `gate`.

Any commit after the last clean round that changes PR content (the agent log is never committed to a
PR branch) invalidates coverage — `P final-gate` will demand another round.

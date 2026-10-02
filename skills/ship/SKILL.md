---
name: ship
description: Use for ANY request to build, add, implement, fix, change, refactor, or ship code in a git repository — features, bug fixes, UI tweaks, migrations, "make X do Y", "can you add…", "fix the bug where…". Runs the autonomous pipeline end to end — branch, implement with tests, full verify, pull request, cross-model review loop (Codex → judge → arbiter), final gate, merge, production smoke, rollback, summary — so changes reach production only when proven. Repos without .claude/pipeline.yml never merge; offer pipeline-setup.
when_to_use: Any code-changing request in a repo, unless the session was started with PIPELINE_OFF=1 or the user says not to use the pipeline. Also "resume pipeline reviews", "ship it", "/ship", "promote agent-suggestion", and issues labelled agent-build.
argument-hint: "[what to build] | resume [pr]"
---

# ship — autonomous build → verify → review → merge

You are the **controller**. You orchestrate; subagents and the `pipeline` CLI do the work.
`P` below means `node ~/.claude/pipeline/bin/pipeline.mjs` (type it exactly like that so the
permission allowlist matches). Every `P` command prints one JSON object; exit codes: 0 ok,
1 check failed/blocked, 2 usage/env error, 3 dependency unavailable. `N` is the pull request
number, `R` a review round number, `<slug>` the branch slug.

## Invariants (never break these)

1. Nothing merges except through `P merge`, and only after `P final-gate` passed for the exact
   head being merged. Never run `gh pr merge`, `npm run merge`, or the GitHub UI yourself.
2. Never push to `main`/`master`, never force-push, never add `human-approved` /
   `test-change-approved`, never remove `needs-human` / `pipeline-blocked` / `pipeline-pause` /
   `pipeline-rollback` labels, never close pause/rollback issues. `awaiting-review` comes off only
   through `P review-complete` (Resume mode), never by hand. (Hooks also block these; don't try to
   route around them.) Always push with an explicit name: `git push -u origin agent/<slug>`.
3. Hard-stops are decided by `P hardstops`, never by your judgment. A hit means the PR ends in
   `needs-human`, however harmless it looks.
4. No cross-model review ⇒ no merge. Codex unavailable ⇒ `awaiting-review` and stop.
5. **Never pass a `model` parameter when invoking `judge` or `arbiter`** — a per-call model
   overrides their pinned Opus/Fable (only exception: the proof switch in
   `reference/proof-switches.md`). Don't pass one to `implementer` or `verifier` either: their agent
   files already pin Sonnet.
6. Keep your own context lean: work from `P` JSON, subagent summaries, and file paths. Don't
   read whole logs, diffs, or reports into this session — hand paths to subagents.
7. Anything that can take more than 2 minutes (the Bash tool's default timeout; its cap is 10) runs
   via `P job start <name> -- <command>` and `P job wait <name> --run-id <runId> --timeout 540`
   (repeat until `state` is `done`): full verify, merge, prod watch, Codex review, CI wait, preview
   smoke. `job start` prints `runId`, `jobDir` and `tag` (default: the HEAD sha): keep the `runId`
   and pass it to every `wait`/`read`; `state: replaced` means another start reused the name, so the
   result you are waiting for is gone — start again; `state: lost` means the job died — start it
   again once. No `sleep` loops.
8. **Reading a finished job.** `P job wait` exits 0 only when the job's command exited 0; for a
   `done` job with a non-zero code its own exit is 1, which says nothing about WHICH code. So
   after `state: "done"` always read `exitCode` (the command's real exit code, with the meaning
   from the list above: 3 = dependency unavailable) and parse the command's JSON from `tail` (the
   last 40 lines of its output; if it looks cut off, read the whole log, `<jobDir>/log`). Everywhere
   below, "exit 3" of a job-run command means `exitCode: 3`.

## Step 0 — opt-out, preflight

- `echo $PIPELINE_OFF` → `1`, or the user said not to use the pipeline: say "pipeline off for this
  session" and just do the task normally (still never push to main).
- `echo $PIPELINE_TEST_COMMIT_AS_IS $PIPELINE_TEST_FORCE_ARBITER $PIPELINE_ARBITER_MODEL_OVERRIDE`:
  if any is set, read `reference/proof-switches.md` now and follow it; name the switch in the PR
  body and in the summary.
- From the repo root: `P preflight`.
  - `config` missing/invalid → stop. Offer: "This repo isn't onboarded. Run pipeline-setup?" You
    may still build on a branch and open a PR if the user wants, but **never merge**.
  - `canMerge: false` (enforcement mismatch, `pipeline-pause` issue open, `pipeline-rollback`
    issue open) → continue, but the run ends with an open PR; say why up front.
  - `codex.available: false` → warn: "Codex is unavailable; the PR will wait in awaiting-review."
  - `clean: false` in the main checkout is fine — you work in a new worktree.
- `P config` once: note `verify.full`, `verify.quick`, `default_branch`, `worktree_dir`, whether
  `preview` is `null`, and `merge`/`production`. Config `warnings` are advice: mention them.
- `P labels ensure` (idempotent; later steps use `pipeline-blocked`, `needs-human`,
  `awaiting-review`). Exit 3 ⇒ GitHub is unreachable: say so and stop.
- `resume` argument or "resume pipeline reviews" → go to **Resume mode** below.

## Step 1 — branch

```
git fetch origin <default_branch>
git worktree add --no-track -b agent/<slug> <worktree_dir>/agent-<slug> origin/<default_branch>
```
`--no-track` matters: a branch tracking `origin/main` can make a bare `git push` target main. `<slug>`: 2–5 lowercase words from the request. All later work happens in that worktree; tell
every subagent its absolute path. Estimate risk from the paths you expect to touch (final risk
comes from `P risk` on the real diff; the higher wins).

## Step 2 — build and verify

1. Split the work into small tasks. For each, dispatch the **implementer** agent with: the task,
   worktree path, acceptance criteria, which tests to write (bug fix ⇒ failing test first), the
   quick-verify command (`verify.quick`), and the **commit trailer**: the attribution line your
   system context prescribes for commits (`Co-Authored-By: …`); pass it verbatim every time so
   every commit ends with it. Independent tasks may run in parallel only if they touch different
   files.
2. Dispatch the **verifier** with `verify.full` (from `P config`). Green ⇒ Step 3.
3. Red ⇒ dispatch an implementer with the failing step + excerpt (paths, not logs). Max **3 fix
   cycles**. Still red ⇒ stop early, in this order:
   ```
   git push -u origin agent/<slug>
   gh pr create --draft --label pipeline-blocked --title "<title>" --body-file <body file>
   P comment --pr N --kind blocked
   P summary --pr N --outcome blocked --built "<what was attempted and where it stuck>"
   P agent-log queue --line "<agentLogLine from the summary output>"
   ```
   (`blocked` works without review state; the PR body carries the verify report table.) Stop.

## Step 3 — pull request

1. `git push -u origin agent/<slug>`.
2. Run the deterministic checks on the real diff (`mkdir -p .review` first). Save the hard-stop JSON to a
   file (exit 1 means hits, which is expected):
   `P risk --base origin/<default_branch> --head HEAD`,
   `P hardstops --base origin/<default_branch> --head HEAD > .review/hardstops.json`,
   `P integrity --base origin/<default_branch> --head HEAD`.
   Test-integrity violations: have an implementer restore the tests; if the change truly needs
   them gone, treat it like a hard-stop (`needs-human`: only the owner adds `test-change-approved`).
3. `gh pr create` (add `--draft` if `ci.draft_while_iterating`) with the body from
   `reference/pr-and-summary.md`: what & why, verify summary (step table + head sha), tests added,
   screenshots, risk level + reasons, hard-stop hits. It prints the PR URL; `N` is its number.
4. UI change ⇒ now that the PR exists: `P artifacts push --pr N --dir .verify/screenshots`
   (pushes the images to the `pipeline-artifacts` branch, never your worktree; returns markdown
   image links), then update the PR body with them (`gh pr edit N --body-file <file>`).
5. Hard-stop hits ⇒ `gh pr edit N --add-label needs-human` and post
   `P comment --pr N --kind needs-human --reason "<one paragraph: why, what was verified, what the owner does>" --hits-file .review/hardstops.json`.
   Then still run the review loop (Step 4) so the owner gets a reviewed PR, but skip Steps 5–6
   (no merge). End with the summary (outcome `needs-human`).

## Step 4 — review loop

Follow `reference/review-loop.md` exactly. In short, per round `R` (max `review.max_rounds`):
Codex (`P codex-review --pr N --round R …` as a job; light lane with nothing but WORTH CONSIDERING items ⇒
`P triage light-lane --round R` and skip the judge) → judge (`judge` agent, no model param, only
for items without a ruling yet; `P triage validate --round R --from-tag "pipeline-judge R<R> <d8>"`)
→ settle disputed bugs with tests (implementer commits the test; `P triage settle … --test-cmd …
--test-file …` runs it) → arbiter if `P arbiter needed` says so (`arbiter` agent, no model param,
one batched call) → `P arbiter apply --round R --tag "pipeline-arbiter R<R> <digest8>"` (proves
Fable from the subagent transcript; the tag is the Agent call's description) → implement ACCEPTED
items (implementer + verifier full verify) → `P followups create --round R` for FOLLOW-UP →
`P comment --pr N --kind triage`. Exit when `P state outcome` says `clean`. Not clean after the
last round, or any item `needsHuman` ⇒ label `needs-human`, post
`P comment --pr N --kind needs-human --reason "…"` (no `--hits-file`), summary, stop.

Codex `exitCode: 3` at any point (Codex unavailable) ⇒ `gh pr edit N --add-label awaiting-review`,
`P comment --pr N --kind awaiting-review --reason "<reason from the JSON>"`,
`P summary --pr N --outcome awaiting-review --built "<what is done>"` (works even in round 1, when no
review state exists yet), `P agent-log queue --line "<agentLogLine>"`, stop.

## Step 5 — final gate

Details and every exit code: `reference/gates-and-exits.md`.

1. Recompute the checks on the head as it is NOW (review fixes may have moved risk): `P risk`,
   `P hardstops … > .review/hardstops.json` and `P integrity`, as in Step 3.2. A new hard-stop
   hit ⇒ Step 3.5. Then `P agent-log stage --pr N` (commits this run's log line + queued lines into
   the PR branch) and `git push origin agent/<slug>`.
2. Behind the base? `git fetch origin <default_branch>`; if `git rev-list --count
   HEAD..origin/<default_branch>` is not 0: `gh pr update-branch N`, then `git pull --ff-only`.
3. Verifier: fresh `verify.full` on the current head (must be clean, full mode). Then
   `P state outcome`: if `coverageValid` is `false` the PR content changed since the last clean
   review round (an update-branch, a late fix) ⇒ go back to Step 4 for a new round, then return here.
4. High risk (from the Step 5.1 `P risk`) ⇒ `gh pr edit N --add-label <ci.e2e_label>` (if configured).
5. Draft ⇒ `gh pr ready N`. Wait for CI on this head: checks can take a few seconds to appear after
   a push (`gh pr checks --watch` then exits 1 "no checks reported"), so poll first:
   `P job start ci -- bash -c 'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do gh pr checks N --required >/dev/null 2>&1; [ $? -ne 1 ] && break; sleep 10; done; gh pr checks N --watch --required'`
   → `P job wait ci --run-id <runId> --timeout 540` (repeat until `done`). The job's exit code is
   only a hint: `P final-gate` re-reads CI itself.
6. Preview — skip this step when `preview` is `null` in `P config`. Otherwise, with the FULL
   40-character head sha (`git rev-parse HEAD`; an abbreviation just waits out the timeout):
   `P deploy url --sha <head> --environment <preview.environment> --timeout 480` (its default wait
   is 900 s, longer than the Bash tool allows: keep `--timeout` ≤ 480, or run it as a job). Exit 3
   ⇒ nothing deployed in time: run it once more, then `needs-human`. Exit 1 ⇒ the deployment failed:
   fix the cause (new commit ⇒ back to 5.1). Then, as a job (it can run 5 minutes):
   `P job start smoke -- node ~/.claude/pipeline/bin/pipeline.mjs smoke --target preview --url <url> --sha <head>`
   (UI-text changes: add `--expect-text "<new text>"`) → `P job wait smoke …`; read `exitCode`.
7. `P final-gate --pr N`. Any failed check ⇒ fix the cause (a new commit ⇒ back to 5.1; PR
   content changed ⇒ Step 4 too) or, if it isn't fixable by you, `needs-human` + summary + stop.
   `behind-base:` in the `pr-open` detail ⇒ Step 5.2, then 5.3 onward.

## Step 6 — merge and production

1. `P job start merge -- node ~/.claude/pipeline/bin/pipeline.mjs merge --pr N` → `P job wait
   merge --run-id <runId> --timeout 540`; read `exitCode` and the JSON in `tail`:
   - 0 ⇒ merged. `mergeSha` is the merge commit; `null` (with a `warning`) means GitHub did not
     name it yet: still run prod-watch, with `--pr N` alone (2 below). Never skip prod-watch.
   - 1 ⇒ NOT merged. `error: gate | live-check | pre-merge`, or a `reason` (merge command failed,
     not merged in time, PR closed, blocker appeared): act per `reference/gates-and-exits.md`.
     "Update the branch" cases (`behind-base:`, the base moved) ⇒ back to Step 5.2, re-verify, a new
     review round if content changed; max 2 such returns, then `needs-human`.
   - 3 ⇒ `error: production-unknown` (no known-good production deployment recorded) or GitHub
     unavailable: nothing merged; wait a minute and retry once, then stop and tell the user.
2. Merged ⇒ `P job start prod -- node ~/.claude/pipeline/bin/pipeline.mjs prod-watch --sha
   <mergeSha> --pr N [--expect-text …]` (no `mergeSha`: `prod-watch --pr N`, it reads the merge
   commit itself) → `P job wait prod --run-id <runId> --timeout 540`. `--expect-text` must be text
   the NEW build shows: smokes of a rolled-back or superseded deployment ignore it. Read the
   `outcome` in the JSON (`exitCode` 0 = `merged`). `merged` / `no-production` ⇒ summary `merged`; every
   other outcome — `superseded`, `recovered`, `rollback-failed`, `changed-during-recovery`,
   `rollback-skipped`, `not-live`, `deploy-failed`, `deploy-not-observed` — ⇒ summary with that same word.
   What each one means and what to do is in `reference/gates-and-exits.md`. On a failed smoke prod-watch rolls back by itself (`vercel rollback <known-good> --yes --timeout 3m`,
   never `production.rollback.command`), opens the issue and a revert PR. Report any outcome other
   than `merged` to the user immediately, in plain words.

## Step 7 — summary

`P summary --pr N --outcome <outcome> --built "<2–3 sentences>"` posts the summary comment
(outliers first) and prints `agentLogLine`. Queue that line — `P agent-log queue --line
"<agentLogLine>"` — for every outcome except a clean `merged` (that run's line was staged in
Step 5.1). Then tell the user, in plain English: what shipped, PR link, outcome, follow-up issues,
anything needing them. Remove the worktree (`git worktree remove <worktree_dir>/agent-<slug>`)
when the PR is merged or closed; keep it while the PR waits for a human or for Codex.

## Resume mode ("resume pipeline reviews", `ship resume [pr]`)

`P resume list` → for each PR (or the one given; the list has `headRefName`): create a worktree
for its branch (`git fetch origin <headRefName>`, then `git worktree add --no-track -B <headRefName>
<worktree_dir>/agent-<slug> origin/<headRefName>`), `P preflight`, rebuild state with `P state show
--pr N` (recovers it from the triage comment if `.review/` is gone). **Exit 2 `no-state` is normal**
when Codex was already down in round 1 — nothing was reviewed yet: start Step 4 at round 1.
Otherwise continue Step 4 from the first incomplete round. After a clean review,
`P review-complete --pr N` removes `awaiting-review` (exit 1 ⇒ the review is not valid for this
head: run another round); then Steps 5–7.

## Promoting suggestions

An issue relabelled `agent-build` (or the user saying "build #123") is a normal ship request:
read the issue, link it in the PR body (`Closes #123`).

## Failure quick reference

| Situation | Do |
|---|---|
| verify red after 3 fix cycles | draft PR + `pipeline-blocked`, `summary --outcome blocked`, stop |
| hard-stop hit | review loop, then `needs-human`, stop |
| Codex unavailable / quota (`exitCode: 3`) | `awaiting-review`, `summary --outcome awaiting-review`, stop |
| `P arbiter apply` proof fails | items → `needs-human` (the CLI marks them), stop after summary |
| `triage validate` / `arbiter apply` exit 2 `not-found` | transcript not written yet: wait ~10 s, retry once, then `needs-human` |
| final gate fails, can't fix | `needs-human`, stop |
| `behind-base:` / base moved | `gh pr update-branch N`, re-verify, new round if content changed (max 2 times, then `needs-human`) |
| merge exit 3 `production-unknown` | nothing merged; tell the user, stop |
| prod smoke fails | prod-watch handles rollback + issue + revert PR; tell the user |
| pause/rollback issue open | PR stays open, explain |

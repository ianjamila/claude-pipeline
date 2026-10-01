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
1 check failed/blocked, 2 usage/env error, 3 dependency unavailable.

## Invariants (never break these)

1. Nothing merges except through `P merge`, and only after `P final-gate` passed for the exact
   head being merged. Never run `gh pr merge`, `npm run merge`, or the GitHub UI yourself.
2. Never push to `main`/`master`, never force-push, never add `human-approved` /
   `test-change-approved`, never remove `needs-human` / `pipeline-blocked` / `pipeline-pause` /
   `pipeline-rollback` / `awaiting-review` labels, never close pause/rollback issues. (Hooks also
   block these; don't try to route around them.)
3. Hard-stops are decided by `P hardstops`, never by your judgment. A hit means the PR ends in
   `needs-human`, however harmless it looks.
4. No cross-model review ⇒ no merge. Codex unavailable ⇒ `awaiting-review` and stop.
5. **Never pass a `model` parameter when invoking the `judge` or `arbiter` agents** — a
   per-call model overrides their pinned Opus/Fable. (Only exception: the documented proof
   switch in `reference/proof-switches.md`.) Pass `model: "sonnet"` for `implementer` and
   `verifier` only if your instructions elsewhere require explicit models; their files pin it.
6. Keep your own context lean: work from `P` JSON, subagent summaries, and file paths. Don't
   read whole logs, diffs, or reports into this session — hand paths to subagents.
7. Commands that can exceed 9 minutes (full verify, merge gate, prod watch, Codex review) run
   via `P job start <name> -- <command>` and `P job wait <name> --timeout 540` (repeat until
   `done`). No `sleep` loops.

## Step 0 — opt-out, preflight

- `echo $PIPELINE_OFF` → `1`, or the user said not to use the pipeline: say "pipeline off for this
  session" and just do the task normally (still never push to main).
- From the repo root: `P preflight`.
  - `config` missing/invalid → stop. Offer: "This repo isn't onboarded. Run pipeline-setup?" You
    may still build on a branch and open a PR if the user wants, but **never merge**.
  - `canMerge: false` (enforcement mismatch, `pipeline-pause` issue open, `pipeline-rollback`
    issue open) → continue, but the run ends with an open PR; say why up front.
  - `codex.available: false` → warn: "Codex is unavailable; the PR will wait in awaiting-review."
  - `clean: false` in the main checkout is fine — you work in a new worktree.
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
   quick-verify command, and the commit trailer. Independent tasks may run in parallel only if
   they touch different files.
2. Dispatch the **verifier** with `verify.full` (from `P config`). Green ⇒ Step 3.
3. Red ⇒ dispatch an implementer with the failing step + excerpt (paths, not logs). Max **3 fix
   cycles**. Still red ⇒ push the branch, open a **draft** PR labelled `pipeline-blocked` with the
   report table, `P comment --pr N --kind blocked`, `P agent-log queue …`, `P summary --pr N
   --outcome blocked`, stop.

## Step 3 — pull request

1. `git push -u origin agent/<slug>`.
2. `P risk --base origin/<default_branch> --head HEAD` and `P hardstops --base … --head HEAD`.
3. UI change ⇒ `P artifacts push --pr-branch agent/<slug> --dir .verify/screenshots` (returns
   markdown image links) after the PR exists, then edit the body.
4. `gh pr create` (add `--draft` if `ci.draft_while_iterating`) with the body from
   `reference/pr-and-summary.md`: what & why, verify summary (step table + head sha), tests added,
   screenshots, risk level + reasons, hard-stop hits.
5. `P labels ensure` (first run in a repo).
6. Hard-stop hits ⇒ `gh pr edit N --add-label needs-human` and post `P comment --pr N --kind
   needs-human`. Then still run the review loop (Step 4) so the owner gets a reviewed PR, but
   skip Steps 5–6 (no merge). End with the summary (outcome `needs-human`).

## Step 4 — review loop

Follow `reference/review-loop.md` exactly. In short, per round N (max `review.max_rounds`):
Codex (`P codex-review` as a job) → judge (`judge` agent, no model param) → settle disputed bugs
with tests (implementer) → arbiter if `P arbiter needed` says so (`arbiter` agent, no model
param, one batched call) → `P arbiter apply` (proves Fable from the transcript) → implement
ACCEPTED items (implementer + verifier full verify) → `P followups create` for FOLLOW-UP →
`P comment --pr N --kind triage`. Exit when `P state outcome` says `clean`. Not clean after the
last round, or any item `needsHuman` ⇒ label `needs-human`, summary, stop.
Codex exit 3 at any point ⇒ `gh pr edit N --add-label awaiting-review`, `P comment --pr N --kind
awaiting-review`, summary (`awaiting-review`), stop.

## Step 5 — final gate

1. `P agent-log stage --pr N` (commits this run's log line + queued lines into the PR branch),
   `git push`.
2. If behind `origin/<default_branch>`: `gh pr update-branch N` then `git pull` in the worktree.
3. Verifier: fresh `verify.full` on the current head (must be clean, full mode).
4. High risk ⇒ `gh pr edit N --add-label <ci.e2e_label>` (if configured).
5. Draft ⇒ `gh pr ready N`. Wait for CI on this head: `P job start ci -- gh pr checks N
   --watch --required` / `P job wait ci`.
6. Preview: `P deploy url --sha <head> --environment <preview.environment>` →
   `P smoke --target preview --url <url> --sha <head>` (UI-text changes: add
   `--expect-text "<new text>"`).
7. `P final-gate --pr N`. Any failed check ⇒ fix the cause (new commit ⇒ back to 3) or, if it
   isn't fixable by you, `needs-human` + summary + stop.

## Step 6 — merge and production

1. `P job start merge -- node ~/.claude/pipeline/bin/pipeline.mjs merge --pr N` → `P job wait
   merge`. Exit 1 because the base moved ⇒ back to Step 5.2 (max 2 times, then `needs-human`).
2. Merged ⇒ `P job start prod -- node ~/.claude/pipeline/bin/pipeline.mjs prod-watch --sha
   <merge sha> --pr N [--expect-text …]` → `P job wait prod`. Outcomes: `merged` (smoke ok),
   `superseded`, `recovered` (rolled back + revert PR opened), `rollback-failed` (urgent). Report
   any non-`merged` outcome to the user immediately.

## Step 7 — summary

`P summary --pr N --outcome <outcome> --built "<2–3 sentences>"` posts the summary comment
(outliers first). Queue post-deploy outcomes with `P agent-log queue`. Then tell the user, in
plain English: what shipped, PR link, outcome, follow-up issues, anything needing them. Remove
the worktree when the PR is merged or closed (`git worktree remove`).

## Resume mode ("resume pipeline reviews", `ship resume [pr]`)

`P resume list` → for each PR (or the one given): check out its branch in a worktree, `P
preflight`, rebuild state (`P state show --pr N` recovers it from the triage comment if
`.review/` is gone), continue at Step 4 from the first incomplete round. After a clean review,
`P review-complete --pr N` removes `awaiting-review`; then Steps 5–7.

## Promoting suggestions

An issue relabelled `agent-build` (or the user saying "build #123") is a normal ship request:
read the issue, link it in the PR body (`Closes #123`).

## Failure quick reference

| Situation | Do |
|---|---|
| verify red after 3 fix cycles | draft PR + `pipeline-blocked`, stop |
| hard-stop hit | review loop, then `needs-human`, stop |
| Codex unavailable / quota | `awaiting-review`, stop |
| `P arbiter apply` proof fails | items → `needs-human` (the CLI marks them), stop after summary |
| final gate fails, can't fix | `needs-human`, stop |
| base moved twice during merge | `needs-human`, stop |
| prod smoke fails | prod-watch handles rollback + issue + revert PR; tell the user |
| pause/rollback issue open | PR stays open, explain |

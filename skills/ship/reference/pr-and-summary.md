# PR body, needs-human note, summary

## PR body template

The PR is created as a draft right after the first task commits (Step 2), with a short body: the `## In plain English`
section, the request and the task list. Step 3 replaces it with the full body below (`gh pr edit N --body-file <file>`).

```
## In plain English
<2–4 sentences for a non-developer owner: what changes for the people who use the app (or the team), and why.
No file paths, function names or jargon. Always first, so the owner can decide on "merge" from this section alone.>

## What & why
<2–4 sentences: the change and the reason; link the request/issue (Closes #…)>

## Verify
`<verify.full>` @ `<short head sha>` (clean) → **PASS** in <mm:ss>
| step | status | duration |
|---|---|---|
<rows from .verify/report.json; a row with status `skipped` (or the legacy `pass` + `skipped: true`) shows `skipped — <reason>`, never `pass`>

## Tests added
- `<file>` › <test name> (<what it proves>; failed before the fix: "<message>")

## Screenshots
<markdown links from `P artifacts push`, or "n/a — no UI change">

## Risk
**<low|medium|high>** — <reasons from P risk>. Light lane: <yes|no>.
Hard-stops: <none | list of blocking rule + file>
Report-only hard-stops (no label needed): <none | list of rule + file, from `advisory` in `P hardstops` without `ownerMerge`>
Owner merges in chat (`owner_approval: chat` only; the owner says "merge", no label): <none | rule + file, from `ownerMerge` in `P hardstops` / `P integrity`>

<proof switches used, if any — see proof-switches.md>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Screenshots

`P artifacts push --pr <N> --dir .verify/screenshots` (so the PR must already exist) commits the images to the
orphan branch `pipeline-artifacts` under `pr-<N>/` (never `main`) and returns markdown
image links (`https://github.com/<o>/<r>/blob/pipeline-artifacts/pr-<N>/<file>?raw=true`),
which render for anyone who can see the private repo.

## needs-human

`P comment --pr <N> --kind needs-human --reason "<one paragraph>" [--hits-file <file>]` posts the
comment; `--reason` is required (the command exits 2 without it). Write one paragraph: why (hard-stop
rules + files, or unresolved review items, or model-proof failure), what was verified and reviewed,
and exactly what the owner should do: review, then add `human-approved` and merge (`npm run merge
-- <N>` or the project's merge command) — or close. For a hard-stop, save the `P hardstops` output
first (`P hardstops --base origin/<default_branch> --head HEAD > .review/hardstops.json`, after
`mkdir -p .review`; exit 1 just means blocking hits) and pass it as `--hits-file .review/hardstops.json` (a JSON
array, or the `P hardstops` object itself: its `blocking` list is used); leave `--hits-file` out when there are no blocking hits.
Report-only hits never make a needs-human note; they go in the PR body.

## Run record and checkpoints

The summary comment (marker `claude-pipeline:summary`) is created by the first `P checkpoint` and is the run's durable
state: a visible **Pipeline run status** block (step · next · head · host · heartbeat) plus a hidden, compressed run
record that `P inbox` and `P resume plan` read. `P checkpoint --pr N --step S` updates it; it refuses unless local HEAD
is the PR's remote head. The checkpoints, in order: `build` (with `--request-file`, `--tasks-file`, `--task-done` after
each task), `verify --verify-report`, `pr`, `review --round R` (after each round), `gate`, `awaiting-owner-merge`;
`P summary` ends the record (`ended` + outcome). Only the viewer's own comments count; a record is display and routing
only, never approval. The `--tasks-file` is JSON `[{id, title, spec}]`: `spec` = acceptance criteria + the tests to
write, enough for another machine to continue the task.

Evidence is never kept only in that editable record: `prod-before` (before the merge), `rollback-intent`,
`rollback-result` and `recovery-reported` (prod-watch) are separate append-only event comments.

## Summary comment (Step 7)

`P summary --pr <N> --outcome <outcome> --built "<2–3 sentences>"` (outcome: `merged`, `blocked`,
`needs-human`, `awaiting-review`, `awaiting-owner-merge` (chat mode, stopped before the merge), or a prod-watch outcome such as `recovered`, `rollback-failed`,
`superseded`, `not-live`, `deploy-failed`, `needs-owner` (observe-only: the live smoke fails, nothing was changed)) keeps the status block and the record
(setting `step: ended` and the outcome) and the summary sections that follow; it prints `agentLogLine` and renders, in this order. `blocked` and
`awaiting-review` also work before any review round exists (verify red 3 times, Codex out in round 1):
the comment then has no rounds, and a `blocked` one names the failing verify step; any other outcome
needs `.review/state.json`.
1. **Outliers** — every arbiter ruling (finding · Codex view · Opus view · Fable ruling · one-line
   reason · model-proof line), close-call rejections (REJECTs the judge was not highly confident in), strong
   disagreements (judge REJECT on a Codex BLOCKING).
2. What was built.
3. Suggestions implemented (with round).
4. Follow-up issues created (links). "Promote one by relabelling `agent-suggestion` →
   `agent-build`."
5. Rejected ideas (one-line reasons; light-lane items marked "not triaged").
6. Outcome.

## Agent log

- The log lives on its own orphan branch, `pipeline-agent-log` (file `config.agent_log`), never in a PR branch: a file every PR
  edits would conflict as soon as the base moves, and each log commit would be a new head for the owner to approve.
- Every outcome, a clean `merged` run too: after `P summary`, `P agent-log publish --line "<line>"`. The line is the
  `agentLogLine` that `P summary` printed, or its `pendingLogLine` (outcome `merged — prod smoke pending`) for a merged run
  under `production.watch: workflow`, so `agent-log close` can resolve it. With `workflow`, run `P agent-log close --queue` first.
- `publish` queues the line (git common dir, shared by every worktree), appends the whole queue to the log on the branch and
  pushes only that branch. Entries leave the queue only after the push succeeded; exit 3 (push or network failure) is fine:
  they go out with the next run. Lines already on the branch (or in the default branch's old copy) are dropped, not repeated.
- `P agent-log stage` is the retired name: it now only publishes and commits nothing.

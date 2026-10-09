# PR body, needs-human note, summary

## PR body template

```
## What & why
<2–4 sentences: the change and the reason; link the request/issue (Closes #…)>

## Verify
`<verify.full>` @ `<short head sha>` (clean) → **PASS** in <mm:ss>
| step | status | duration |
|---|---|---|
<rows from .verify/report.json>

## Tests added
- `<file>` › <test name> (<what it proves>; failed before the fix: "<message>")

## Screenshots
<markdown links from `P artifacts push`, or "n/a — no UI change">

## Risk
**<low|medium|high>** — <reasons from P risk>. Light lane: <yes|no>.
Hard-stops: <none | list of blocking rule + file>
Report-only hard-stops (no label needed): <none | list of rule + file, from `advisory` in `P hardstops`>

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

## Summary comment (Step 7)

`P summary --pr <N> --outcome <outcome> --built "<2–3 sentences>"` (outcome: `merged`, `blocked`,
`needs-human`, `awaiting-review`, or a prod-watch outcome such as `recovered`, `rollback-failed`,
`superseded`, `not-live`, `deploy-failed`) prints `agentLogLine` and renders, in this order. `blocked` and
`awaiting-review` also work before any review round exists (verify red 3 times, Codex out in round 1):
the comment then has no rounds, and a `blocked` one names the failing verify step; any other outcome
needs `.review/state.json`.
1. **Outliers** — every arbiter ruling (finding · Codex view · Opus view · Fable ruling · one-line
   reason · model-proof line), close-call rejections (low-confidence REJECTs), strong
   disagreements (judge REJECT on a Codex BLOCKING).
2. What was built.
3. Suggestions implemented (with round).
4. Follow-up issues created (links). "Promote one by relabelling `agent-suggestion` →
   `agent-build`."
5. Rejected ideas (one-line reasons; light-lane items marked "not triaged").
6. Outcome.

## Agent log

- Final gate start: `P agent-log stage --pr <N>` appends this run's line (outcome `merged —
  prod smoke pending`) plus any queued lines to `docs/agent-log.md` in the PR branch and commits;
  push afterwards. The worktree must be clean and on the PR's head.
- Runs that don't merge and post-deploy outcomes: take the `agentLogLine` that `P summary` printed and
  queue it: `P agent-log queue --line "<agentLogLine>"` (stored in the git common dir).
- There is no separate flush: the next `P agent-log stage` writes every queued line into that PR's log
  together with its own. Staged lines stay queued (marked staged) until `origin/<default_branch>`
  contains them, so a PR that closes unmerged does not lose them; the output's `staged` and
  `dropped` say what happened.

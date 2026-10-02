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
Hard-stops: <none | list of rule + file>

<proof switches used, if any — see proof-switches.md>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Screenshots

`P artifacts push --pr <N> --dir .verify/screenshots` (so the PR must already exist) commits the images to the
orphan branch `pipeline-artifacts` under `pr-<N>/` (never `main`) and returns markdown
image links (`https://github.com/<o>/<r>/blob/pipeline-artifacts/pr-<N>/<file>?raw=true`),
which render for anyone who can see the private repo.

## needs-human

`P comment --pr <N> --kind needs-human` posts one paragraph: why (hard-stop rules + files, or
unresolved review items, or model-proof failure), what was verified and reviewed, and exactly
what the owner should do: review, then add `human-approved` and merge (`npm run merge -- <N>`
or the project's merge command) — or close.

## Summary comment (Step 7)

`P summary --pr <N> --outcome <merged|blocked|needs-human|reverted|recovered|rollback-failed|
superseded|awaiting-review> --built "<2–3 sentences>"` renders, in this order:
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
  prod smoke pending`) plus any queued lines to `docs/agent-log.md` in the PR branch and commits.
- Runs that don't merge and post-deploy outcomes: `P agent-log queue --line "<line>"` (stored in
  the git common dir). There is no separate flush: the next `P agent-log stage` writes every queued
  line into that PR's log together with its own and clears the queue.

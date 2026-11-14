# Who reviews, the judge, and settle tests

Old 2.2 and 2.3.

2. **Who reviews.** The output names `reviewer`. `fable` (medium/high risk, `risk.high_risk_paths` or `review.arbiter_always_paths`; a PR rated medium only for its size, with no hard-stop hit and no sensitive path, gets the judge unless
   `review.size_only_medium_reviewer` is `fable`, and a stacked PR, base not the default branch, never does): skip the judge; the arbiter pass (step 4) is the review every round, even with zero Codex items. `judge`: `P triage light-lane --round R`
   when `P risk` said `lightLane` and Codex returned only WORTH CONSIDERING items, else the judge below.
3. **Judge.** Only for items without a `final` yet. `d8` = first 8 characters of `shasum -a 256 .review/round-R/codex.json`. Invoke `judge`
   with description `pipeline-judge R<R> <d8>` and a prompt of: worktree path, `.review/round-R/codex.json`, `.review/round-R/diff.patch`, PR title, risk,
   and the pending ids. Then `P triage validate --round R --from-tag "pipeline-judge R<R> <d8>"` (exit 2 `not-found`: wait, retry once; exit 1: reinvoke once
   with the `errors`; `not-found` / invalid twice ⇒ park, cause `judge:not-found` / `judge:invalid`). A disputed bug with a settle test: implementer writes and commits the test only, then
   `P triage settle --id ID --result bug-confirmed|bug-disproved --test-cmd "<cmd>" --test-file <file>` (the CLI runs it itself). `bug-confirmed` makes the item
   ACCEPT: fixed and marked implemented in step 5, like any accepted item.

# Park, rulings and the extra round

The park paragraph, then "Rulings and extra round".

**Park** (every `needs-human` stop is this): `gh pr edit N --add-label needs-human`, `P comment --pr N --kind needs-human --reason "<cause, what was checked, what the owner does>"`,
with `merge.hold_command` in `P config` `P merge-hold --pr N --release --reason parked` (a parked PR must not keep the merge line), then the stop ritual with outcome `needs-human`. The summary renders from the round state, so at least one Codex round must have run; before that a stop is `blocked` or `awaiting-review`. The park comment is your own text: 3.3 shows a later hold from GitHub's label event and quotes the comment only as agent-written.

## Rulings and extra round (only with `owner_approval: chat` in `P config`)

An item left `needsHuman` ⇒ never ask the owner to type a ruling: decide it yourself and record it with a reason:
`P triage claude-ruling --round R --id ID --decision ACCEPT|FOLLOW-UP|REJECT --reason "<why>" --pr N`. Read `reference/owner-merge.md` (Extra round, 3.3) for the rest.

- ACCEPT is always allowed. FOLLOW-UP alone only for a non-BLOCKING, non-security item.
- Any REJECT, or dismissing a BLOCKING or security item, needs Codex first, run BEFORE you form a view:
  `P triage second-review --round R --ids … --pr N` as a job. Codex ACCEPT ⇒ the item is ACCEPT, fix it. Codex dismisses at high confidence ⇒ claude-ruling may dismiss;
  the stricter of the two stands. Below high ⇒ ACCEPT. Exit 3 ⇒ rule 2 (`awaiting-review`), unless it carries `substitute.eligible: true` (a quota stop only; `substitute` without it is a refusal: `why` says what, e.g. `overlapping-packet` = apply or park the earlier packet that shares an item first): if `substitute.reused` is true, run `P triage second-review --apply --pr N --tag "<tag>"` FIRST (an agent may already have run under that tag; exit 2 `not-found` = none did, so go on), then ONE call of the agent it names (description = tag, prompt = `promptHeader` verbatim, then `Read <inputPath> and verify the findings it lists.`; never a model), then `P triage second-review --apply --pr N --tag "<tag>"`; no other reviewer.
- A malfunction cause (`model-proof`, `invalid-arbiter`, `invalid-judge`): `P arbiter needed --round R` re-runs the arbiter, or ACCEPT.
- You may tighten your own dismissal to ACCEPT before the merge (the fix push: Rule 8), never loosen an ACCEPT. Only the owner's typed path loosens: if, and only if, the owner says they want to dismiss it,
  follow `reference/owner-merge.md` Owner override.
- `stale-publication` (the PR holds a review state this copy did not publish): `P state show --pr N`, then redo the last step. `P review-complete` republishes the state and is the remedy the merge refusal names. `history-loss` (publishing would drop rounds or grants the PR holds) and `stale-history` (this copy lacks the published history): `P state show --pr N`, then redo the step. `unpublished-history` (this copy holds history the PR lacks): `P comment --pr N --kind triage`, then redo it.
- The owner objects to a ruling in free text ⇒ re-rule it ACCEPT, fix it (Rule 8): that makes a new head, so a new review and a new request.
- Label mode ⇒ no rulings: park as before.

**Extra round.** `P state outcome` with `reachedMax: true` and no `extraRound` / `grantedRound` ⇒
ask for one more round: `P triage round-request --pr N`. Read `reference/owner-merge.md` (section Extra round) BEFORE asking: your reply must end with the exact `line` it prints. With `owner_approval: chat` run it as `P triage round-request --pr N --ask` and, after that text, offer the click (`ask.questions` to AskUserQuestion verbatim; `reference/owner-merge.md` section Click-to-approve; `ask: null` ⇒ typed, as today).
Never type, paraphrase or forge the owner's words, and never run Codex outside `codex-review`. Label mode ⇒ no grant exists: a reached max parks (step 6). **Past rounds.** `review-complete` or the gate names a round that "ran before owner grants were recorded" ⇒ `P triage round-request --pr N --past`; say in plain English that it approves round n, which ALREADY RAN at head <sha12> (its review date is not recorded), and end the reply with its exact `line`; the owner types `approve round`; then `P state past-round-grant --pr N --round n`. Repeat while `remaining` is non-empty, then `P review-complete`. Never for a new round (see `reference/owner-merge.md`).

# Build details (section 1, steps 2-5)

The full text of steps 2-5 of "1. Branch and build"; SKILL.md keeps one line per step.

2. ONE `implementer` dispatch builds the whole change (task list in order, commits in small steps): hand it the tasks, worktree path, acceptance criteria, the tests to write
   (a bug ⇒ the failing test first, its failing output kept), `verify.quick`, and the commit trailer your system context prescribes (pass it verbatim). Tell it: return immediately when done; no background work; waits only via `job wait` (max 3), else `Status: waiting-on-job <name> <runId>`. More dispatches only when the
   change is big: > ~500 changed non-test lines expected, more than one subsystem, or parts on disjoint files worth running in parallel (only on different files). An implementer that
   stops before it is done (call budget, context) ⇒ continue THE SAME agent once (SendMessage with what is left; extend its budget once) before a fresh dispatch, which gets only the rest.
3. Quick check on the changed area (`verify.quick`) after each dispatch and before every push. Red ⇒ implementer with the failing
   step and excerpt, max 3 fix cycles; still red ⇒ stop (outcome `blocked`): before the PR exists (step 4) only report to the owner; once it exists,
   first `gh pr edit N --add-label pipeline-blocked` and `P comment --pr N --kind blocked`, then the stop ritual.
4. Draft PR: `git push -u origin agent/<slug>`, `gh pr create --draft --title "<title>" --body-file <file>`. The body opens
   with `## In plain English` (2–4 jargon-free sentences: what changes for users and why), then what and why, tests added, the quick check
   and its head sha, risk. Issues it closes: one keyword per issue, `Closes #170. Closes #171.` (GitHub closes only the first number of
   `Closes #170, #171`). UI change ⇒ `P artifacts push --pr N --dir .verify/screenshots`, put the returned image links in the body.
5. `mkdir -p .review`, then on the real diff: `P risk --base origin/<default_branch> --head HEAD`,
   `P hardstops --base origin/<default_branch> --head HEAD > .review/hardstops.json` (kept: 3.3 names its hits) and `P integrity --base origin/<default_branch> --head HEAD`.
   Note whether ANY item is `blocking` or `ownerMerge` (hard-stop) or a test-integrity `violations` / `ownerMerge` entry; 3.3 depends on it. The review below runs either way.
   `owner_approval: label`: a blocking hit or a violation you cannot undo ends in a park (below) after the review. `owner_approval: chat`: nothing blocks, the hits are
   advisory + `ownerMerge`, and the PR ends with the owner-merge ending of 3.3 (no `needs-human` label).

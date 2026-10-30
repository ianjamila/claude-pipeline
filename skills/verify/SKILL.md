---
name: verify
description: Use whenever code has changed and BEFORE saying anything is done, fixed, working, passing, or ready, and before a push. Proves the change with a quick check of the changed area (the project's verify.quick in .claude/pipeline.yml; CI runs the full suite), reads the report, fixes and reruns until green, screenshots UI changes, writes allow/deny permission tests for database changes, and writes a failing test first for bug fixes. Pastes the evidence. Never claim done without it.
when_to_use: After any edit to source, tests, SQL/migrations, config, or styles; when the user asks "does it work", "is it done", "run the tests", "check it"; before pushing, opening or updating a pull request; inside the review skill.
---

# verify — prove the change works

Done means **the quick check is green AND the new behaviour is covered by a new test**, with the
evidence pasted. Anything less is "not done yet" — say so plainly. The quick check runs once, on the
changed area, before a push, not after every edit; CI is the full proof, so do not run the full suite
locally unless the user asks for it.

## 0. Opt-out

If the session was started with `PIPELINE_OFF=1` (check `echo $PIPELINE_OFF`) or the user says
not to use the pipeline, follow the user. Still run the project's tests before claiming success.

## 1. Find the commands

Read `.claude/pipeline.yml` (`node ~/.claude/pipeline/bin/pipeline.mjs config`):
- `verify.quick` — the check you run: typecheck, lint, tests related to the changed files. Run it on the changed area before a push.
- `verify.full` — the whole suite. CI runs it on the pull request; run it yourself only when the user asks.
- `verify.report` — the JSON report (default `.verify/report.json`).

No `pipeline.yml`? Discover the stack's own commands (package.json scripts, Makefile,
pyproject, CI workflow) and run typecheck/lint/tests yourself — then say clearly: "this repo has
no pipeline; I can't certify it end-to-end. Want me to run pipeline-setup?"

## 2. Run → read → fix → rerun

1. Run `verify.quick` (or `verify.full`, when asked) as a job when it can exceed the 2-minute tool default:
   `node ~/.claude/pipeline/bin/pipeline.mjs job start verify -- <verify.quick>` (note the `runId` it prints),
   then `node ~/.claude/pipeline/bin/pipeline.mjs job wait verify --run-id <runId> --timeout 540` until `done`
   (`replaced` means the name was reused: start again). When `state` is `done`, `exitCode` is verify's own
   exit code (`job wait` itself exits 1 for any non-zero job; 0 = green).
   (In the review skill, the implementer runs the quick check.)
2. Read the report, not the scrollback: `ok`, `mode`, `git.head`, each step's `status` and
   `errorExcerpt`. A report whose `git.head` isn't your HEAD, or with `dirty: true`, proves
   nothing about your commit.
   A step with status `skipped` did not run: say so and quote its `skipReason`; it is not a pass, and the
   final gate accepts it only when the owner listed it in `verify.skippable_steps`.
3. Fix the first failing step (it fails fast), rerun. Repeat until `ok: true`.
4. Never make it green by weakening checks: no skipping, deleting, or loosening tests, no
   lowering coverage thresholds, no editing verify scripts or CI config to dodge a failure.

## 3. Rules by change type

- **UI change** — capture Playwright screenshots of every affected page/state (the e2e step
  saves to `.verify/screenshots/`; for pages it doesn't cover, use the Playwright MCP
  `browser_take_screenshot` against the local dev server). Then **Read each image and look at
  it**: layout, text, overflow, dark mode if relevant. Note one line per screenshot.
- **Database change** (migration, policy, grant, function) — add a test that proves the
  permission model: the right roles are **allowed** and the wrong roles are **denied**, executed
  as real session roles (Supabase: pgTAP in `supabase/tests/` with `set local role
  authenticated` + `request.jwt.claims`, never a privileged connection). Synthetic fixtures only.
- **Bug fix** — write the failing test first, run it, and keep the failing output. Then fix,
  and show the same test passing.
- **New behaviour** — at least one new test that would fail without the change.
- **Data** — synthetic seed data only. Never use real personal, client, health, biometric,
  financial, or payroll records, and never point verify at a non-local database.

## 4. Evidence (paste this when you say it's done)

```
Verify: <verify.quick> @ <short sha> (clean) → PASS in <mm:ss>
| step | status | duration |
|------|--------|----------|
| install | pass | 0:41 | …
New tests: <file> › <test name> (failed before the fix: "<message>")
Screenshots: .verify/screenshots/login.png — subtitle shows new copy, no overflow
```

If anything is red, say what is red and what you're doing about it — never round a failure up
to "done".

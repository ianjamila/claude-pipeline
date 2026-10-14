# guard-replay

Tools for checking a change to the guard policies (`pipeline/hooks/lib/*-policy.mjs`) against real use.
They are not part of the installed pipeline and have no tests of their own.

## What this is

`replay.mjs` takes every Bash command from recent Claude Code transcripts and runs it through an OLD and a NEW
copy of the guard policies, then lists the verdict flips. Run it for EVERY guard change before a PR.

- A deny -> allow flip must each be explained (a fixed false alarm, or a hole you accept and can name).
- An allow -> deny flip is a new refusal: a real catch, or a new false alarm.

## Making roots

A root is a directory that holds `pipeline/`. Keep roots in a scratch dir, not in the repo.

- A commit: `git -C <repo> archive <sha> pipeline | tar -x -C <dir>`
- Uncommitted work: `cp -R <worktree>/pipeline <dir>/`

## replay.mjs

    node tools/guard-replay/replay.mjs <oldRoot> <newRoot> ~/.claude/projects <days> <out.json> [workers=4] [capMs=20000]

- Worker pool; each command has a cap (`capMs`), and a command that is cut lands in `timeouts`.
- Progress goes to stderr every 10 s. `slow` lists commands over 1 s on either side.
- 21 days is about 138k commands and takes 3-4 minutes.
- Output: `summary {commands, flips, byDir, slow, timeouts}` and `flips [{k, from, to, reason, cwd, command}]`
  (`k` is `git` or `files`).
- Flips on files that no longer exist (removed worktrees, scratch dirs) are artifacts, not real changes.

## The other tools

- `flip-groups.mjs <replay.json> [direction] [maxGroups=60]`: groups the flips by direction and reason, largest first.
  `direction` looks like `git:deny->allow`.
- `hang.mjs <root> <git|files> <cmds.json> [capMs=6000]`: times single commands (a JSON array of `{cwd, command}`)
  under a cap. A hook that runs past 15 s is ALLOWED by the host, so anything near that is a bug.
- `probe.mjs <cases.json> <root>...`: judges each case `[{c, spec, note}]` under every root, with git state and files
  taken from `spec` (a fake file system). One line per case per root: `<root>=<git><files>(ms)`, `a` allow, `d` deny.
  See `examples/cases-r4.json`.
- `ddmin.mjs <root> <rows.json> <i> <reason-regex>` and `ddmin-files.mjs <root> <rep.json> <reason-regex> <cwd-regex> [nth]`:
  shrink a flipped command to a minimal one that is still denied for that reason (git rows, files rows).
  `ddmin-batch.mjs <root> <still.json> <specs.json>` runs `ddmin-files.mjs` for a list of `[reasonRegex, cwdRegex, nth]` specs.
- `prof-one.mjs` and `prof-top.mjs`: CPU profile of one slow case.
  `node --cpu-prof --cpu-prof-dir=<dir> tools/guard-replay/prof-one.mjs <root> <files|git> <cases.json> <index>`,
  then `node tools/guard-replay/prof-top.mjs <file.cpuprofile> [n=15]` for the top functions by self time.
- `mut-run.mjs <capMs> <testFile> <namePattern>`: runs the matching tests in a child, killed at `capMs`.
  Use it with a hand-made mutation: a failure or a kill means the mutation was caught.
- `mutate.mjs <worktree> <mutations.json> <testFile>...`: the mutation check. Every fix reverted on its own must make
  a test fail. `mutations.json` is `[{name, file, from, to, defensive?}]` with `file` relative to the worktree and `from`
  occurring exactly once (else the mutation is skipped and counts as bad). The file is always restored. It prints
  `caught`, `defens.` or `MISSED` per mutation and exits 1 if a non-defensive mutation is missed or skipped.
  Mark a mutation `defensive` only when another layer catches it, and say which layer in a comment next to the change.
  See `examples/mutations-s9.json`.

## Traps

- The live guard hooks refuse a Bash line whose text (or a script file an interpreter is given) contains guarded
  words. Write fixtures with the Write tool and mask them (`probe.mjs` unmasks `ma@@`, `pu@@`, `.cl@@`).
- Run the tools by absolute path (the hooks cannot resolve `cd dir && node x.mjs`).
- Transcripts are private data. Never commit replay output: keep `*.json` results in a scratch dir.

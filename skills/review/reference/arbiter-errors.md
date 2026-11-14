# The arbiter step and its errors

Old 2.4.

4. **Arbiter** (when `P arbiter needed --round R` says `needed`). One call: the agent named in the `agent` field of its output (`arbiter`, or `arbiter-fix` when `brief` is `fix-verify`: a fix round, Fable at effort medium with a narrow verify-the-fixes input; use exactly the one named, `apply` refuses the other; if `arbiter-fix` cannot be started (an agent file the terminal has not loaded) or the owner wants a full review, run `P arbiter needed --round R --full` and use `arbiter` at effort high; the forced full brief sticks for the round: later plain `needed` calls, such as the retry after a restart or after an unproven pass, keep it until a pass is proven), description = the `tag` it printed, prompt starting
   with its `promptHeader` pasted verbatim, then `Read <inputPath> and rule on every item in it.` (Fable round: and review the diff it names). Then
   `P arbiter apply --round R --tag "<the same tag>"`; exit 2 `not-found`: wait, retry once, then park (cause `arbiter:not-found`);
   exit 1 with `restartRequired` (through `P round codex` it is at `result.restartRequired` of its `step: "arbiter-needed"` JSON; the round is recorded, never discard or rerun it) (`stale-terminal` from `needed`, `stale-model` from `apply`; Fable round) ⇒ do NOT retry here and do NOT park: outcome `blocked`, with no `pipeline-blocked`
   label and no `needs-human`. Post the CLI's `advice` text (`P comment --pr N --kind blocked --reason "<advice>"`), with `merge.hold_command` in `P config` `P merge-hold --pr N --release --reason restart`,
   run the stop ritual, and tell the owner to restart the terminal (or update Claude Code / `pipeline model-floor reset`, as the advice says). After the restart: `P arbiter needed --round R` and the arbiter again.
   Exit 1 `error: model-floor-busy` ⇒ run `P arbiter apply` once more after a minute (no new arbiter call). Exit 1 `unrecognised-fable`, `model-floor-unreadable` or
   `model-floor-unwritable` ⇒ no new Fable pass can fix it: do NOT re-run the arbiter; stop `blocked` exactly like the `restartRequired` stop, posting the CLI's `advice`.
   Any other exit 1 ⇒ the items are `needsHuman` (Fable round: run `needed` and the arbiter once more; failing twice ⇒ park, cause `arbiter:model-proof`).

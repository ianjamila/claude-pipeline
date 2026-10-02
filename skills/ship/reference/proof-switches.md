# Proof switches (testing the pipeline itself)

These environment variables exist only to prove the pipeline's failure paths. ship checks them at
Step 0 (`echo $PIPELINE_TEST_COMMIT_AS_IS $PIPELINE_TEST_FORCE_ARBITER $PIPELINE_ARBITER_MODEL_OVERRIDE`);
when one is set, say so in the PR body ("Proof switch: …") and in the summary. Never set them for real work.

| Variable | Effect |
|---|---|
| `PIPELINE_TEST_COMMIT_AS_IS=1` | Commit the change exactly as given (no implementer fixes) and skip the fix cycles in Step 2, so a broken change reaches the gates. |
| `PIPELINE_TEST_FORCE_ARBITER=1` | In round 1, send every judged item to the arbiter (`P arbiter needed --round 1 --force`), even if the rules wouldn't. Requires ≥ 1 Codex item; if Codex returned none, report that the proof is inconclusive instead of forcing an empty call. |
| `PIPELINE_ARBITER_MODEL_OVERRIDE=<model>` | Pass `<model>` as the arbiter Agent call's `model` parameter (normally forbidden). Used to prove that a non-Fable or failing arbiter answer is caught by `P arbiter apply` and routed to `needs-human`. |

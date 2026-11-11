Real `codex exec --json` (codex-cli 0.154.0) captures, sanitized.
- codex-0.154-json-auth-stdout.jsonl / -stderr.txt: a run with no login (exit 1).
- codex-0.154-session-auth.jsonl: that run's session log (task_complete codex_error_info "other").
- codex-0.154-session-quota.jsonl: the real 11-11 quota failure session log (codex_error_info "usage_limit_exceeded", "try again at 4:21 PM").
- codex-0.154-json-quota-stdout.jsonl: CONSTRUCTED, not captured (that run's stdout was not kept): the event shapes of the auth capture
  (thread.started, turn.started, error, turn.failed) carrying the real quota message and that session's id.
- codex-0.154-token-count-codex.jsonl: one real `token_count` event of a session log (08:38Z 11-11) with `rate_limits.limit_id "codex"`, `primary {used_percent 4.0, window_minutes 10080, resets_at <epoch seconds>}` (the weekly quota; read by lib/codex-usage.mjs). Note the quota-failure session logs `limit_id "premium"` with `primary: null`: that event is ignored, never read as 0%.

#!/usr/bin/env bash
# Installer round trip against a throwaway Claude home (CI only — never point this at a real ~/.claude).
#   install → --check (no drift) → install again (idempotent) → --check → --uninstall → nothing of ours left.
# Usage: .github/scripts/installer-round-trip.sh "<claude home dir>"
set -euo pipefail

home_dir="${1:?usage: installer-round-trip.sh <claude home dir>}"
rm -rf "$home_dir"

step() { echo "::group::$1"; }
end() { echo "::endgroup::"; }

# The three stack-stop hooks (they register on Windows too, where they exit 0 at once): stack-register on PreToolUse once per
# matcher, stack-dev-bind on PostToolUse, stack-session-end on SessionEnd. "present" asserts each is in settings.json and its file
# is installed; "absent" asserts no settings entry names one (and the files are gone).
stack_hooks() {
  node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [home, mode] = process.argv.slice(1);
const file = join(home, "settings.json");
const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const named = (event, hook) => (settings.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => ({ matcher: g.matcher, h })))
  .filter(({ h }) => [h.command, ...(h.args ?? [])].some((s) => typeof s === "string" && new RegExp("[\\\\/]" + hook + "\\.mjs$").test(s)));
const expected = [
  ["PreToolUse", "stack-register", "Bash"], ["PreToolUse", "stack-register", "Edit|Write|MultiEdit|NotebookEdit"],
  ["PostToolUse", "stack-dev-bind", "Bash"], ["SessionEnd", "stack-session-end", undefined],
];
const problems = [];
if (mode === "present") {
  for (const [event, hook, matcher] of expected) {
    const hits = named(event, hook).filter((x) => x.matcher === matcher);
    if (hits.length !== 1) problems.push(hook + " (" + event + ", matcher " + matcher + "): " + hits.length + " entries, expected 1");
  }
  for (const hook of ["stack-register", "stack-dev-bind", "stack-session-end"]) {
    if (!existsSync(join(home, "pipeline", "hooks", hook + ".mjs"))) problems.push("pipeline/hooks/" + hook + ".mjs is not installed");
  }
} else {
  for (const [event, hook] of expected) if (named(event, hook).length) problems.push(hook + " is still in settings.json hooks." + event);
  for (const hook of ["stack-register", "stack-dev-bind", "stack-session-end"]) {
    if (existsSync(join(home, "pipeline", "hooks", hook + ".mjs"))) problems.push("pipeline/hooks/" + hook + ".mjs is still installed");
  }
}
if (problems.length) { console.error("stack hooks (" + mode + "):\n  " + problems.join("\n  ")); process.exit(1); }
console.log("stack hooks " + mode + ": stack-register x2 (PreToolUse), stack-dev-bind (PostToolUse), stack-session-end (SessionEnd)");
' "$home_dir" "$1"
}

step "install"
node install.mjs --claude-home "$home_dir" --skip-file-guard
end

step "check after install"
node install.mjs --claude-home "$home_dir" --check
end

step "stack hooks registered"
stack_hooks present
end

step "install again (must be a no-op)"
node install.mjs --claude-home "$home_dir" --skip-file-guard
node install.mjs --claude-home "$home_dir" --check
stack_hooks present
end

step "uninstall"
node install.mjs --claude-home "$home_dir" --uninstall
end

step "stack hooks gone"
stack_hooks absent
end

step "nothing of ours left"
node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const home = process.argv[1];
const left = ["pipeline", "skills/ship", "skills/review", "skills/verify", "skills/pipeline-setup",
  "agents/implementer.md", "agents/verifier.md", "agents/judge.md", "agents/arbiter.md"]
  .filter((p) => existsSync(join(home, p)));
const settingsFile = join(home, "settings.json");
const settings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
if (/pipeline[\\/]+(hooks|bin)[\\/]/.test(settings)) left.push("settings.json still references the pipeline");
if (left.length) { console.error("left behind after --uninstall:\n  " + left.join("\n  ")); process.exit(1); }
console.log("clean: no pipeline files or settings entries remain");
' "$home_dir"
end

#!/usr/bin/env bash
# Installer round trip against a throwaway Claude home (CI only — never point this at a real ~/.claude).
#   install → --check (no drift) → install again (idempotent) → --check → --uninstall → nothing of ours left.
# Usage: .github/scripts/installer-round-trip.sh "<claude home dir>"
set -euo pipefail

home_dir="${1:?usage: installer-round-trip.sh <claude home dir>}"
rm -rf "$home_dir"

step() { echo "::group::$1"; }
end() { echo "::endgroup::"; }

step "install"
node install.mjs --claude-home "$home_dir" --skip-file-guard
end

step "check after install"
node install.mjs --claude-home "$home_dir" --check
end

step "install again (must be a no-op)"
node install.mjs --claude-home "$home_dir" --skip-file-guard
node install.mjs --claude-home "$home_dir" --check
end

step "uninstall"
node install.mjs --claude-home "$home_dir" --uninstall
end

step "nothing of ours left"
node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const home = process.argv[1];
const left = ["pipeline", "skills/ship", "skills/verify", "skills/pipeline-setup",
  "agents/implementer.md", "agents/verifier.md", "agents/judge.md", "agents/arbiter.md"]
  .filter((p) => existsSync(join(home, p)));
const settingsFile = join(home, "settings.json");
const settings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
if (/pipeline[\\/]+(hooks|bin)[\\/]/.test(settings)) left.push("settings.json still references the pipeline");
if (left.length) { console.error("left behind after --uninstall:\n  " + left.join("\n  ")); process.exit(1); }
console.log("clean: no pipeline files or settings entries remain");
' "$home_dir"
end

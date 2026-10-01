#!/usr/bin/env sh
# Why: thin wrapper so `./install.sh` works on macOS/Linux; all logic is in install.mjs.
set -eu
exec node "$(dirname "$0")/install.mjs" "$@"

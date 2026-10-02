# Why: thin wrapper so `.\install.ps1` works on Windows; all logic is in install.mjs.
$ErrorActionPreference='Stop'
node "$PSScriptRoot/install.mjs" @args
exit $LASTEXITCODE

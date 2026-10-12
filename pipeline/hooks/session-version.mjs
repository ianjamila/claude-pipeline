// Why: SessionStart status hook (version check). Placeholder until the real check lands: prints nothing, exits 0,
// so registering it can never block or disturb a session.
process.exitCode = 0;

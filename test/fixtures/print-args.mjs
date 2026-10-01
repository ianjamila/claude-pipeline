// Prints the argv it received as JSON; echo-args.cmd forwards its arguments here so the Windows
// test can check that cmd.exe quoting delivers them unchanged.
process.stdout.write(JSON.stringify(process.argv.slice(2)));

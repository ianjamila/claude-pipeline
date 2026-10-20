#!/usr/bin/env node
// A runnable stand-in for the `docker` binary, for end-to-end hook tests (the in-process stand-in is fake-docker.mjs, whose
// data shapes it reuses). The scenario is a JSON file named by FAKE_DOCKER_SCENARIO: the options of fakeDocker() (ps, inspect,
// stats, volumes) plus
//   down: true     answer every call like a stopped daemon ("Cannot connect to the Docker daemon", exit 1)
//   sleepMs: N     sleep N ms before answering (a hung docker)
//   log: <file>    append one line per call (its argv), so a test can prove the fake was or was not called
import fs from 'node:fs';
import { fakeDocker } from './fake-docker.mjs';

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
if (scenario.log) fs.appendFileSync(scenario.log, `${JSON.stringify(args)}\n`);
if (scenario.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, scenario.sleepMs);
if (scenario.down) {
  process.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
  process.exit(1);
}
const r = fakeDocker(scenario)('docker', args);
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.code);

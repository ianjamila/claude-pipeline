// PR #288 round 19 (owner-approved merge gate): everyday commands stay allowed. From a deep project directory, and (for the lines that do not lean on the cwd) from the home directory too.
// A case marked todo is an over-denial the owner accepted for now; tracked in issue #373 (a larger mechanism would be needed). Home is /home/u. Synthetic lines only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const BASE = { home: HOME, env: {}, platform: 'linux', cwd: HOME, realpath: (p) => p, existsSync: () => false, readText: () => null };
const DEEP = `${HOME}/a/b/c/d/proj`;

// allowed from both directories
const BOTH = [
  "npm test",
  "npm run build",
  "npm ci && npm run build",
  "npx vitest run",
  "npx tsc --noEmit",
  "node scripts/verify.mjs --quick",
  "node --test test/foo.test.mjs",
  "git status",
  "git diff --stat",
  "git log --oneline | head -5",
  "git add -A && git commit -m \"x\"",
  "git checkout -b feature/x",
  "git stash -u",
  "git reset --hard",
  "git pull --rebase",
  "ls -la",
  "cat package.json | head -20",
  "grep -rn foo src | head",
  "rm -rf node_modules",
  "rm -rf dist .next",
  "rm -rf ./dist",
  "rm -f out.tmp",
  "mkdir -p out && rm -rf out/*",
  "mkdir -p out && cp -r src out/",
  "cp a b",
  "mv a.txt b.txt",
  "echo hi > notes.txt",
  "echo hi >> notes.txt",
  "cat a b > c",
  "sed -i \"\" s/a/b/ file.txt",
  "sed -i s/a/b/ file.txt",
  "touch x.tmp",
  "tar -czf a.tgz src",
  "tar -xzf a.tgz",
  "cd proj && rm -rf dist",
  "cd proj && git stash -u",
  "cd proj && git reset --hard",
  "cd proj && git checkout -- .",
  "cd proj && git add .",
  "cd web/app && npm run build",
  "mkdir -p out && cd out && rm -rf *.tmp",
  "cd ./proj && rm -rf dist",
  "cd /home/u/proj && rm -rf dist",
  "cd /home/u/proj && npm test",
  "for i in 1 2 3; do (cd ./web && rm -rf dist && npm run build) && break; done",
  "build() { cd ./web && rm -rf dist; }; build",
  "build() { cd web && rm -rf dist; }; build",
  "\"$PYTHON\" \"$SCRIPT\"; rm -f out.tmp",
  "$RUNNER \"$f\"; rm -f out.tmp",
  "cd \"$HOME/proj\" && git clean -fd",
  "cd /home/u/proj && git clean -fd # tidy",
  "cd /home/u/proj && npm run build || echo failed",
  "cd /home/u/proj && rm -rf dist || echo failed",
  "cd ~/proj && git clean -fd",
  "cd $HOME/proj && git clean -fd",
  "cd \"/home/u/proj\" && git clean -fd",
  "cd '/home/u/my proj' && git clean -fd",
  "cd /home/u/proj && git clean -fd > /tmp/log 2>&1; echo \"exit $?\"",
  "set -euo pipefail; cd /home/u/proj && rm -rf dist",
  "cd /home/u/proj || exit 1; rm -rf dist",
  "W=/home/u/proj; cd $W && rm -rf .next",
  "W=/home/u/proj; rm -rf $W/.next",
  "export PATH=\"/opt/homebrew/bin:$PATH\"; cd /home/u/proj && rm -rf .next",
  "cd /home/u/proj && for f in a b; do rm -f \"$f.tmp\"; done",
  "cd /home/u/proj && while read f; do rm -f \"$f\"; done < list.txt",
  "cd /home/u/proj && git worktree remove .worktrees/x",
  "chdir ./x && rm -rf dist",
];
// relative to the cwd (no cd first): allowed from the project directory; from the home directory they are denied on purpose (a relative write there reaches the protected folders)
const FROM_PROJECT = [
  "git add . && git commit -m \"feat: x\"",
  "git checkout -- .",
  "git clean -fd",
  "find . -name \"*.tmp\" -delete",
  "find . -name .DS_Store -delete",
];
// over-denials from one directory that need a larger mechanism than this PR adds: node:test todo, tracked in issue #373
const TODO = [
  ["(cd /home/u/proj && git clean -fd)", "home"],
  ["if cd /home/u/proj; then git clean -fd; fi", "home"],
  ["cd /home/u/proj && git clean -fd | tail -5", "home"],
  ["cd /home/u/proj && git clean -fd 2>&1 | tail -5", "home"],
  ["git -C \"$(git rev-parse --show-toplevel)\" clean -fd", "home+project"],
  ["cd /home/u/proj && { git clean -fd; }", "home"],
];

describe('#288 R19 corpus: everyday commands stay allowed', () => {
  for (const line of BOTH) {
    for (const cwd of [HOME, DEEP]) {
      test(`allows from ${cwd}: ${line}`, () => {
        const r = evaluateBashForFiles(line, { ...BASE, cwd });
        assert.equal(r.decision, 'allow', `${JSON.stringify(line)} from ${cwd} -> ${r.decision}: ${r.reason}`);
      });
    }
  }
  for (const line of FROM_PROJECT) {
    test(`allows from ${DEEP}: ${line}`, () => {
      const r = evaluateBashForFiles(line, { ...BASE, cwd: DEEP });
      assert.equal(r.decision, 'allow', `${JSON.stringify(line)} -> ${r.decision}: ${r.reason}`);
    });
  }
  for (const [line, where] of TODO) {
    for (const cwd of [HOME, DEEP]) {
      test(`allows from ${cwd}: ${line}`, { todo: `over-denial (${where}), tracked in #373` }, () => {
        const r = evaluateBashForFiles(line, { ...BASE, cwd });
        assert.equal(r.decision, 'allow', `${JSON.stringify(line)} from ${cwd} -> ${r.decision}`);
      });
    }
  }
});

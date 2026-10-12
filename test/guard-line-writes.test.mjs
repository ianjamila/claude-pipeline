// Why (item h): a script the line itself creates or overwrites BEFORE running it was judged on the file system as it is now: a missing
// file "runs nothing", an existing one was judged on its OLD content. `echo '<push main>' > n.sh; bash n.sh`, `cp f.sh n.sh; bash n.sh`,
// `cat f.sh > n.sh && bash n.sh`, `mv`, `ln -s`, `tee`, `dd`, `base64 -d x > n.sh`, `curl -o n.sh`, a copy over an existing harmless script
// ... all ran what the guards never read. Now the line's WRITES (redirections and the commands that write files: see line-writes.mjs)
// are worked out in order, and a script file is judged on every content a write before it may have put there: the file as it is now, each
// source file copied / moved / linked / catted into it, each static text echoed into it. A write whose content is only known at run time
// (curl -o, a program's output, a dynamic target) is treated like a script named at run time: refused when the line mentions a guarded
// operation / a protected file. A missing script after a command the guard cannot model (make, npm run ...) is treated the same way.
// The file system is faked (like test/guard-script-expansion.test.mjs); guarded text only lives in fake file contents or in the constants below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, basename } from 'node:path';
import { evaluateGitCommand } from '../pipeline/hooks/lib/git-policy.mjs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';
import { simpleCommands } from '../pipeline/hooks/lib/shell-parse.mjs';
import { writesOf, printfText, flowStart, namesFile } from '../pipeline/hooks/lib/line-writes.mjs';

function fakeFs(root, files, dirs = []) {
  const abs = (p) => resolve(root, p);
  const F = Object.fromEntries(Object.entries(files).map(([k, v]) => [abs(k), v]));
  const D = new Set([root, ...dirs.map(abs)].map((p) => resolve(p)));
  const names = (d) => {
    const out = new Set();
    for (const p of [...Object.keys(F), ...D]) if (p !== d && dirname(p) === d) out.add(basename(p));
    return [...out];
  };
  return {
    readText: (p) => (typeof F[resolve(p)] === 'string' ? F[resolve(p)] : null),
    readHead: () => null,
    pathExists: (p) => resolve(p) in F || D.has(resolve(p)),
    readDir: (p) => (D.has(resolve(p)) ? names(resolve(p)) : null),
  };
}

const GIT_ROOT = resolve('/work/repo');
const PROJ = '/home/u/proj';
const BAD_GIT = 'git push origin main';
const BAD_FILES = 'echo x > ~/.claude/settings.json';
// a mention of a guarded operation / protected file that is harmless as a command (it makes the run-time rule apply)
// MID: a harmless command that quotes a guarded command / names a protected file (the run-time rule fires); CALM: only the words (it must not)
const MID_GIT = "echo 'git push origin main'";
const MID_FILES = 'echo ~/.claude/settings.json';
const CALM_GIT = 'git commit -m "push merge protection notes"'; // (prose: masked)
const CALM_FILES = 'git commit -m "protect install. .claude"';
const git = (command, fsOpts, o = {}) => evaluateGitCommand(command, {
  cwd: GIT_ROOT, home: '/home/u', currentBranch: () => 'agent/x', pushDestination: () => null, issueLabels: () => [], ...fsOpts, ...o,
});
const files = (command, fsOpts, o = {}) => evaluateBashForFiles(command, {
  home: '/home/u', env: {}, platform: 'linux', realpath: (p) => p, cwd: PROJ, ...fsOpts, existsSync: fsOpts.pathExists, ...o,
});

const DIRS = ['sub', 'd', 'e', 'src'];
// `line(bad, mid)` builds the command for each policy (`bad`: text that is blocked when it runs, `mid`: a harmless mention of a guarded operation)
// `alias`: the directory alias/ is a symlink to real/ (the fake realpath maps it), for both policies
const aliasReal = (root) => {
  const rt = root.replace(/\\/g, '/');
  return (q) => {
    const s = String(q).replace(/\\/g, '/');
    return s === `${rt}/alias` || s.startsWith(`${rt}/alias/`) ? `${rt}/real${s.slice(rt.length + 6)}` : s;
  };
};
function run(line, spec, alias = false) {
  const mk = (bad, ok) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === 'bad' ? bad : v === 'ok' ? ok : v === 'bad1' ? bad.slice(0, 8) : v === 'bad2' ? bad.slice(8) : v === 'rot' ? bad.slice(8) + '\n' + bad.slice(0, 8) : v]));
  const g = typeof line === 'string' ? line : line(BAD_GIT, MID_GIT, CALM_GIT);
  const f = typeof line === 'string' ? line : line(BAD_FILES, MID_FILES, CALM_FILES);
  return {
    git: { cmd: g, r: git(g, fakeFs(GIT_ROOT, mk(BAD_GIT, 'git status'), alias ? [...DIRS, 'alias', 'real'] : DIRS), alias ? { realpath: aliasReal(GIT_ROOT) } : {}) },
    files: { cmd: f, r: files(f, fakeFs(PROJ, mk(BAD_FILES, 'echo hi'), alias ? [...DIRS, 'alias', 'real'] : DIRS), alias ? { realpath: aliasReal(PROJ) } : {}) },
  };
}
const denyBoth = (line, spec = SPEC, alias = false) => {
  const x = run(line, spec, alias);
  assert.equal(x.git.r.decision, 'deny', `git: ${x.git.cmd}`);
  assert.equal(x.files.r.decision, 'deny', `files: ${x.files.cmd}`);
};
const allowBoth = (line, spec = SPEC, alias = false) => {
  const x = run(line, spec, alias);
  assert.equal(x.git.r.decision, 'allow', `git: ${x.git.cmd} -> ${x.git.r.reason}`);
  assert.equal(x.files.r.decision, 'allow', `files: ${x.files.cmd} -> ${x.files.r.reason}`);
};

// f.sh is blocked when it runs; ok.sh is harmless; x.b64 holds blocked text; n.sh does not exist
const SPEC = { 'p1.txt': 'bad1', 'p2.txt': 'bad2', 'h1.sh': 'bad1', '..x.sh': 'ok', 'src/..x.sh': 'bad', 'f.sh': 'bad', 'ok.sh': 'ok', 'x.b64': 'bad', 'ok.b64': 'ok', 'f.mjs': 'bad', 'sub/f.sh': 'bad', 'src/f.sh': 'bad', 'src/ok.sh': 'ok' };

// ---- the rows of the issue ------------------------------------------------------------------------------------------------

test('h: text echoed / printed into a script that is then run is judged', () => {
  denyBoth((bad) => `echo '${bad}' > n.sh; bash n.sh`);
  denyBoth((bad) => `echo "${bad}" >> n.sh; bash n.sh`);
  denyBoth((bad) => `printf '${bad}\\n' > n.sh && bash n.sh`);
  denyBoth((bad) => `echo '${bad}' >| n.sh; bash n.sh`);
  denyBoth((bad) => `echo '${bad}' &> n.sh; bash n.sh`);
  denyBoth((bad) => `echo -e '#!/bin/sh\\n${bad}' > n.sh; bash n.sh`);
  // printf fills its format from the arguments: the text that runs is not any single word
  denyBoth((bad) => `printf '${bad.replace(/ (\S+)$/, ' %s')}' ${bad.split(' ').pop()} > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '%s %s' '${bad.split(' ')[0]}' '${bad.split(' ').slice(1).join(' ')}' > n.sh; bash n.sh`);
  // a heredoc is the same
  denyBoth((bad) => `cat > n.sh <<EOF\n${bad}\nEOF\nbash n.sh`);
  denyBoth((bad) => `cat > n.sh <<'EOF'\n${bad}\nEOF\nbash n.sh`);
  denyBoth((bad) => `cat <<< '${bad}' > n.sh; bash n.sh`);
  denyBoth((bad) => `echo '${bad}' | tee n.sh >/dev/null; bash n.sh`);
  denyBoth((bad) => `echo '${bad}' | cat > n.sh; bash n.sh`);
});

test('h: a file copied, moved, linked or catted into a script that is then run is judged', () => {
  for (const c of [
    'cp f.sh n.sh; bash n.sh', 'cat f.sh > n.sh && bash n.sh', 'mv f.sh n.sh && bash n.sh', 'ln -s f.sh n.sh; bash n.sh', 'ln f.sh n.sh; bash n.sh',
    'tee n.sh < f.sh >/dev/null; bash n.sh', 'cat f.sh | tee n.sh > /dev/null; bash n.sh', 'cat < f.sh > n.sh; bash n.sh', 'cat ok.sh f.sh > n.sh; bash n.sh',
    'install -m 755 f.sh n.sh; bash n.sh', 'cp -f f.sh n.sh; bash n.sh', 'dd if=f.sh of=n.sh 2>/dev/null; bash n.sh', 'rsync f.sh n.sh; bash n.sh', 'ditto f.sh n.sh; bash n.sh',
    'head -c 99999 f.sh > n.sh; bash n.sh', 'cp -t d f.sh; bash d/f.sh', 'cp f.sh d/; bash d/f.sh', 'cp f.sh d; bash d/f.sh', 'mv f.sh d/n.sh; bash d/n.sh',
    'cp -a src d; bash d/f.sh', 'cp -r src e; bash e/f.sh', 'cp -r src d; bash d/src/f.sh', 'ln -s src e; bash e/f.sh',
    'cd sub && cp ../f.sh n.sh && bash n.sh', 'cd sub; cp f.sh n.sh; bash n.sh', 'cp f.sh n.sh; cd sub; bash ../n.sh',
  ]) denyBoth(c);
  // git mv is a move; a word `mv` elsewhere on a git command does not make it one
  denyBoth('git mv f.sh n.sh; bash n.sh');
  denyBoth('git -C . mv f.sh n.sh; bash n.sh');
  denyBoth((_, mid) => `git checkout mv -- ok.sh; ${mid}; bash ok.sh`);
  denyBoth((_, mid) => `git -c alias.x=mv restore --source=HEAD~1 ok.sh; ${mid}; bash ok.sh`);
  denyBoth((_, mid) => `git clone https://x/mv d; ${mid}; bash d/n.sh`);
  // a symlink's relative source is read from the link's own directory
  denyBoth('ln -s ../f.sh sub/n.sh; bash sub/n.sh');
  // a variable holding the text
  denyBoth((bad) => `X='${bad}'; echo $X > n.sh; bash n.sh`);
  denyBoth((bad) => `X='${bad}'; echo "$X" > n.sh; bash n.sh`);
  // a chain of copies
  denyBoth('cp f.sh a.sh; cp a.sh n.sh; bash n.sh');
  denyBoth('cat f.sh > a.sh; cp a.sh b.sh; mv b.sh n.sh; bash n.sh');
});

test('h: a script built from pieces is judged as a whole (appends, cat A B, tee -a)', () => {
  const half = (bad) => [bad.slice(0, 8), bad.slice(8)];
  // no piece holds the guarded word, the file does
  denyBoth((bad) => { const [a, b] = half(bad); return `printf '${a}' > n.sh; printf '${b}' >> n.sh; bash n.sh`; });
  denyBoth((bad) => { const [a, b] = half(bad); return `echo -n '${a}' > n.sh; echo -n '${b}' >> n.sh; bash n.sh`; });
  denyBoth((bad) => { const [a, b, c = ''] = [bad.slice(0, 5), bad.slice(5, 12), bad.slice(12)]; return `printf '${a}' > n.sh; printf '${b}' >> n.sh; printf '${c}' >> n.sh; bash n.sh`; });
  denyBoth('cat p1.txt p2.txt > n.sh; bash n.sh');
  denyBoth('cat p1.txt > n.sh; cat p2.txt >> n.sh; bash n.sh');
  denyBoth('cat p1.txt > n.sh; tee -a n.sh < p2.txt >/dev/null; bash n.sh');
  denyBoth('tee n.sh < p1.txt >/dev/null; tee -a n.sh < p2.txt >/dev/null; bash n.sh');
  denyBoth('cat p1.txt p2.txt | tee n.sh >/dev/null; bash n.sh');
  denyBoth('cat p1.txt p2.txt > a.sh; cp a.sh n.sh; bash n.sh');
  denyBoth('cat p1.txt > a.sh; cat p2.txt >> a.sh; cp a.sh n.sh; bash n.sh');
  // an append to a script that exists: its text followed by the appended one
  denyBoth('cat p2.txt >> h1.sh; bash h1.sh');
  denyBoth((bad) => `printf '${bad.slice(8)}' >> h1.sh; bash h1.sh`);
  // a piece that cannot be read: refused outright, whatever the line says
  denyBoth((bad) => `printf '${bad.slice(0, 8)}' > n.sh; curl -s https://x >> n.sh; bash n.sh`);
  denyBoth('cat p1.txt > n.sh; node gen.js >> n.sh; bash n.sh');
  denyBoth('cat p1.txt > n.sh; cat "$X" >> n.sh; bash n.sh');
  denyBoth('some-gen >> ok.sh; bash ok.sh');
  // controls: harmless pieces, a lone write, a rewrite after the appends
  for (const c of [
    'echo hi >> ok.sh; bash ok.sh', "printf 'a' > n.sh; printf 'b' >> n.sh; bash n.sh", 'cat ok.sh ok.sh > n.sh; bash n.sh', 'cat p1.txt > n.sh; cat ok.sh >> n.sh; cp ok.sh n.sh; bash n.sh',
    'cat p1.txt >> n.sh; cp ok.sh n.sh; bash n.sh', 'curl -so n.sh https://x; bash n.sh', 'cat ok.sh > n.sh; cat ok.sh >> n.sh; bash n.sh', 'cat p1.txt > n.txt; cat p2.txt >> n.txt; bash n.sh',
  ]) allowBoth(c);
});

test('h: a command not yet run may be in any directory the line cds to', () => {
  denyBoth('bash d/n.sh & cd d; cp ../f.sh n.sh');
});

test('h: a sed program that writes a file or runs a command, with or without a space after the letter', () => {
  for (const mk of [
    (m) => `sed 's/a/b/wn.sh' ok.sh >/dev/null; ${m}; bash n.sh`, (m) => `sed -n 's/a/b/w n.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed -n 'wn.sh' ok.sh; ${m}; bash n.sh`,
    (m) => `sed -n '1wn.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed -n '$wn.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed -e 'p;wn.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed -n '/a/wn.sh' ok.sh; ${m}; bash n.sh`,
    (m) => `gsed 's/a/b/w n.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed 's/a/b/wok.sh' x.b64; ${m}; bash ok.sh`, (m) => `sed 'e' ok.sh; ${m}; bash n.sh`, (m) => `sed 's/a/b/e' ok.sh; ${m}; bash n.sh`,
    (m) => `sed 'e echo hi' ok.sh; ${m}; bash n.sh`,
  ]) denyBoth((_, mid) => mk(mid));
  // a letter inside a pattern or a replacement is not a command
  for (const c of ["sed -n '/error/p' ok.sh", "sed 's/a/export/' ok.sh", "sed 's/a/web/g' ok.sh", "sed -n '1,5p' ok.sh", "sed 'y/abc/xyz/' ok.sh", "sed -n '/web/,/end/p' ok.sh"]) allowBoth((_, _m, mid) => `${c}; ${mid}; bash n.sh`);
  // the files policy: a sed that writes a protected file is not read-only (pre-existing hole)
  const fsOpts = fakeFs(PROJ, { 'f.sh': 'echo hi' }, DIRS);
  for (const prog of ["'s/^//w/home/u/.claude/settings.json'", "'1w/home/u/.claude/settings.json'", "'s/^/x/w /home/u/.claude/settings.json'"]) {
    assert.equal(files(`sed -n ${prog} f.sh`, fsOpts).decision, 'deny', prog);
  }
  // the program attached to an option, or in a script file
  for (const form of ["-e's/^//w/home/u/.claude/settings.json'", "--expression='s/^//w/home/u/.claude/settings.json'", "-ne 's/^//w/home/u/.claude/settings.json'", "-f prog.sed /home/u/.claude/settings.json", "--file=prog.sed ~/.claude/settings.json"]) {
    assert.equal(files(`sed ${form} f.sh`, fsOpts).decision, 'deny', form);
  }
  for (const mk of [
    (m) => `sed -e's/a/b/wn.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed --expression='s/a/b/wn.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed -ne 'wn.sh' ok.sh; ${m}; bash n.sh`,
    (m) => `sed -e p -e wn.sh ok.sh; ${m}; bash n.sh`, (m) => `sed --expression 'wn.sh' ok.sh; ${m}; bash n.sh`, (m) => `sed -f prog.sed ok.sh; ${m}; bash n.sh`, (m) => `sed --file=prog.sed ok.sh; ${m}; bash n.sh`,
  ]) denyBoth((_, mid) => mk(mid));
  allowBoth((_, _m, mid) => `sed -n -e '/error/p' ok.sh; ${mid}; bash n.sh`);
  assert.equal(files("sed -n '/error/p' ~/.claude/pipeline/x.log", fsOpts).decision, 'allow');
  assert.equal(files("sed -n 's/a/export/' ~/.claude/settings.json", fsOpts).decision, 'allow');
});

test('h: curl writes every file its options name; what is not certain is unmodelled', () => {
  for (const mk of [
    (m) => `curl -sSo n.sh https://x; ${m}; bash n.sh`, (m) => `curl -os n.sh https://x; ${m}; bash s`, (m) => `curl -sSLo n.sh https://x; ${m}; bash n.sh`, (m) => `curl -on.sh https://x; ${m}; bash n.sh`,
    (m) => `curl -sD n.sh https://x; ${m}; bash n.sh`, (m) => `curl --dump-header n.sh https://x; ${m}; bash n.sh`, (m) => `curl -c n.sh https://x; ${m}; bash n.sh`,
    (m) => `curl --cookie-jar=n.sh https://x; ${m}; bash n.sh`, (m) => `curl --trace n.sh https://x; ${m}; bash n.sh`, (m) => `curl --stderr n.sh https://x; ${m}; bash n.sh`,
    (m) => `curl --etag-save n.sh https://x; ${m}; bash n.sh`, (m) => `curl --hsts n.sh https://x; ${m}; bash n.sh`, (m) => `curl --alt-svc n.sh https://x; ${m}; bash n.sh`,
    (m) => `curl --libcurl n.sh https://x; ${m}; bash n.sh`, (m) => `curl -sO https://x/n.sh; ${m}; bash n.sh`, (m) => `curl -K cfg https://x; ${m}; bash n.sh`,
    (m) => `curl --config cfg https://x; ${m}; bash n.sh`, (m) => `curl --some-new-option https://x; ${m}; bash n.sh`, (m) => `curl https://x -o n.sh; ${m}; bash n.sh`,
    (m) => `curl -H 'a: b' -o n.sh https://x; ${m}; bash n.sh`, (m) => `curl -sS --output-dir d -O https://x/n.sh; ${m}; bash d/n.sh`,
  ]) denyBoth((_, mid) => mk(mid));
  denyBoth((_, mid) => `curl -sD ok.sh https://x; ${mid}; bash ok.sh`);
  // switches, header / data values and a plain download to stdout write nothing
  for (const c of ['curl -sSL https://x', "curl -H 'x-o: n.sh' https://x", 'curl -d o https://x', 'curl -s -w "%{http_code}" https://x', 'curl --silent --fail https://x']) allowBoth((_, _m, mid) => `${c}; ${mid}; bash n.sh`);
  // tar -c / -r / -u write the archive named by -f
  denyBoth((_, mid) => `tar -cf n.sh d; ${mid}; bash n.sh`);
  denyBoth((_, mid) => `tar cf n.sh d; ${mid}; bash n.sh`);
  allowBoth((_, _m, mid) => `tar -tf a.tar; ${mid}; bash n.sh`);
});

test('h: a {a,b} target is not known until run time', () => {
  denyBoth((bad) => `echo '${bad}' > {x,n}.sh; bash n.sh`);
  denyBoth('cp f.sh {x,n}.sh; bash n.sh');
  allowBoth((_, _m, mid) => `cp ok.sh {x,n}.sh; ${mid}; bash n.sh`);
});

test('h: echo whose escapes cannot all be read is unknown, and the readable ones are still read', () => {
  const hex = (s) => '\\x' + s.charCodeAt(1).toString(16) + s.slice(2);
  denyBoth((bad) => `echo -e '${bad[0]}${hex(bad)} # \\Q' > n.sh; bash n.sh`);
  denyBoth((bad) => `echo -e '${bad}\\cjunk' > n.sh; bash n.sh`);
  denyBoth((bad) => `echo '${bad}\\Q' > n.sh; bash n.sh`); // (the mention makes the unknown content refuse it)
  denyBoth(() => "echo 'C:\\dir' > n.sh; bash n.sh"); // text the line wrote that cannot be worked out exactly: refused outright
});

test('h: what a script judged earlier on the line wrote is still written for the commands after it', () => {
  const mk = { ...SPEC, 'mk.sh': 'cp f.sh n.sh', 'mk2.sh': 'bash mk.sh', 'sub/mk.sh': 'cp ../f.sh n.sh', 'mkok.sh': 'cp ok.sh n.sh', 'mkc.sh': 'curl -so n.sh https://x' };
  denyBoth('bash mk.sh; bash n.sh', mk);
  denyBoth('source mk.sh; bash n.sh', mk);
  denyBoth('. ./mk.sh; bash n.sh', mk);
  denyBoth('./mk.sh; bash n.sh', mk);
  denyBoth('bash mk2.sh; bash n.sh', mk);
  denyBoth('cd sub; bash mk.sh; bash n.sh', mk);
  denyBoth('bash mk.sh && cat n.sh | bash', mk);
  denyBoth((_, mid) => `bash mkc.sh; ${mid}; bash n.sh`, mk);
  denyBoth((bad) => `echo '${bad}' > mk3.sh; bash mk3.sh; bash n.sh`, { ...mk, 'mk3.sh': 'echo hi' });
  allowBoth('bash mkok.sh; bash n.sh', mk);
  allowBoth('bash mk.sh; bash ok.sh', mk);
});

test('h: a writer behind a wrapper is still a writer', () => {
  for (const w of [
    'sudo', 'env X=1', 'nohup', 'timeout 5', 'nice -n 5', 'command', 'busybox', 'time', 'exec', 'stdbuf -o0', 'setsid', 'doas', 'taskset 1',
    'strace', 'chroot /', 'nsenter -t 1', 'chronic', 'watch -n1', 'unknownwrapper --flag',
  ]) denyBoth(`${w} cp f.sh n.sh; bash n.sh`);
  denyBoth('xargs cp f.sh n.sh; bash n.sh');
  denyBoth((bad) => `strace -f tee n.sh <<< '${bad}'; bash n.sh`);
  denyBoth((_, mid) => `unknownwrapper curl -so n.sh https://x; ${mid}; bash n.sh`);
  allowBoth('sudo cp ok.sh n.sh; bash n.sh');
});

test('h: a function body, a trap or an alias runs later than it is written', () => {
  denyBoth('f() { bash n.sh; }; f; cp f.sh n.sh; f');
  denyBoth('function g { bash n.sh; }; g; cp f.sh n.sh; g');
  denyBoth("trap 'bash n.sh' EXIT; cp f.sh n.sh");
  // without a deferred handler a write after the script is after it
  allowBoth('bash n.sh; cp f.sh n.sh');
});

test('h: a target known only in part can only name the files its fixed parts allow', () => {
  // the fixed parts rule it out: no hit, so the pieces of n.sh are all there is
  allowBoth("for f in a b; do echo $f > out-$f.txt; done; printf 'a' > n.sh; printf 'b' >> n.sh; bash n.sh");
  allowBoth("N=1; echo hi > /work/out-$N.txt; printf 'a' > n.sh; printf 'b' >> n.sh; bash n.sh");
  // the fixed parts allow it: it may be the script
  denyBoth('cp f.sh "$D/n.sh"; bash n.sh');
  denyBoth('cp f.sh "$D"/n.sh; bash n.sh');
  denyBoth('cp f.sh $D; bash n.sh');
  denyBoth('cp f.sh n.$E; bash n.sh');
  denyBoth('cp f.sh *.sh; bash n.sh');
  denyBoth('cp f.sh n[a-z]*; bash n.sh');
  allowBoth('cp f.sh out-$E.txt; bash n.sh');
});

test('h: a command we do not model only matters if no exact write of the whole file came after it', () => {
  // a script written in full after the unmodelled command: what it holds is what was written
  allowBoth((_, _m, mid) => `make; ${mid}; printf 'echo hi' > n.sh; bash n.sh`);
  allowBoth((_, _m, mid) => `git merge origin/main; ${mid}; cat > n.sh <<'EOF'\necho hi\nEOF\nbash n.sh`);
  allowBoth((_, _m, mid) => `make; ${mid}; cp ok.sh n.sh; bash n.sh`);
  // ... but not when the program ran after it, or the write only appends (the rest of the file is unknown)
  denyBoth((_, mid) => `printf 'echo hi' > n.sh; make; ${mid}; bash n.sh`);
  denyBoth((_, mid) => `make; ${mid}; printf 'echo hi' >> n.sh; bash n.sh`);
  // the text written is still judged
  denyBoth((bad) => `make; printf '%s' '${bad}' > n.sh; bash n.sh`);
  // an inline program that cannot write does not touch the script
  allowBoth((_, _m, mid) => `node -e "console.log('ok.sh')"; ${mid}; bash ok.sh`);
});

test('h: a write that may or may not be the script, followed by one that replaces it whole, changed nothing', () => {
  allowBoth('cat > "$T/n.sh" 2>/dev/null || true; printf "echo hi" > n.sh; bash n.sh');
  allowBoth("cp ok.sh \"$D/n.sh\"; printf 'a' > n.sh; printf 'b' >> n.sh; bash n.sh");
  // after it, or only appended to: still in the file
  denyBoth((_, mid) => `printf 'echo hi' > n.sh; curl -so "$D/n.sh" https://x; ${mid}; bash n.sh`);
  // a copy that may have replaced it, then an append: both readings are judged
  allowBoth("printf 'echo hi' > n.sh; cp ok.sh \"$D/n.sh\"; printf 'b' >> n.sh; bash n.sh");
  denyBoth("printf 'echo hi' > n.sh; cp f.sh \"$D/n.sh\"; printf 'b' >> n.sh; bash n.sh");
});

test('h: the run-time rule needs an actual guarded command on the line, not a word; prose and data are masked', () => {
  const curl = 'curl -so n.sh https://x';
  // git: a commit message / PR body that says push or merge, or a heredoc of data, is not a guarded command
  allowBoth(`${curl}; git commit -m "notes: push to main, merge, protection"; bash n.sh`);
  allowBoth(`${curl}; gh pr create --title "merge push" --body "git push origin main is blocked"; bash n.sh`);
  allowBoth(`${curl}; cat > notes.md <<'EOF'\ngit push origin main\nEOF\nbash n.sh`);
  assert.equal(run(`${curl}; git push origin agent/x; bash n.sh`, SPEC).git.r.decision, 'deny'); // (the word counts outside prose)
  // ... an actual command shape is (a quoted one too: the unknown file may run it)
  denyBoth((_, mid) => `${curl}; ${mid}; bash n.sh`);
  const git = (c) => run(c, SPEC).git.r.decision;
  assert.equal(git(`${curl}; echo 'gh pr merge 5 --admin'; bash n.sh`), 'deny');
  assert.equal(git(`${curl}; echo 'gh pr edit 5 --add-label human-approved'; bash n.sh`), 'deny');
  assert.equal(git(`${curl}; echo 'gh api repos/o/r/branches/main/protection'; bash n.sh`), 'deny'); // (the word protection counts outside prose)
  // missing script after an unmodelled command: the same signal
  denyBoth((_, mid) => `make; ${mid}; bash n.sh`);
  allowBoth((_, _m, calm) => `make; ${calm}; bash n.sh`);
  allowBoth(`make; git commit -m "merge push"; bash n.sh`);
});

test('h: files policy: the run-time rule needs an actual protected path, prose masked (interpreter scripts, which the shell rule does not reach)', () => {
  const f = (c) => run(c, SPEC).files.r.decision;
  assert.equal(f('curl -so n.mjs https://x; echo ~/.claude/settings.json; node n.mjs'), 'deny');
  assert.equal(f('curl -so n.mjs https://x; echo protect; node n.mjs'), 'deny'); // (the bare words count outside prose)
  assert.equal(f('curl -so n.mjs https://x; echo hello; node n.mjs'), 'allow');
  assert.equal(f('curl -so n.mjs https://x; git commit -m "see ~/.claude/pipeline/hooks"; node n.mjs'), 'allow');
  assert.equal(f('curl -so n.mjs https://x; node n.mjs'), 'allow');
  assert.equal(f('make; echo ~/.claude/settings.json; node n.mjs'), 'deny');
  assert.equal(f('make; echo hello; node n.mjs'), 'allow');
});

test('h: an inline program writes the script only if it names it (literally, in its arguments or in a variable it is given)', () => {
  // judged by its own text: a guarded command in it (string concatenation joined) is refused, a harmless one is not
  denyBoth((bad) => `node -e "fs.writeFileSync('ok.sh', '${bad}')"; bash ok.sh`);
  denyBoth((bad) => `node -e "fs.writeFileSync('ok.sh', '${bad.slice(0, 7)}' + '${bad.slice(7)}')"; bash ok.sh`);
  denyBoth((bad) => `F=ok.sh node -e "fs.writeFileSync(process.env.F, '${bad}')"; bash ok.sh`);
  denyBoth((bad) => `node -e "fs.writeFileSync(process.argv[1], '${bad}')" ok.sh; bash ok.sh`);
  denyBoth((bad) => `python3 -c "open('ok.sh', 'w').write('${bad}')"; bash ok.sh`);
  assert.equal(run((_, mid) => `node -e "fs.writeFileSync('ok.sh', 'x')"; ${mid}; bash ok.sh`, SPEC).git.r.decision, 'allow'); // (not the line's mention: the program's own text)
  allowBoth(`node -e "fs.writeFileSync('ok.sh', 'x')"; bash ok.sh`);
  // a longer name that ends in the script's name is another file (git: the word merge in the program text)
  const only = (c) => run(c, { ...SPEC, 'test.mjs': 'ok' }).git.r.decision;
  assert.equal(only("node -e \"fs.writeFileSync('shell-parse.test.mjs', 'merge')\"; node test.mjs"), 'allow');
  assert.equal(only("node -e \"fs.writeFileSync('./test.mjs', 'merge')\"; node test.mjs"), 'deny');
  // it names other files: not a write to this one (it is still "unmodelled" for a script that is MISSING)
  allowBoth((_, _m, calm) => `node -e "fs.writeFileSync('other.txt', 'x')"; ${calm}; bash ok.sh`);
  assert.equal(run((_, mid) => `node -e "fs.writeFileSync('other.txt', 'x')"; ${mid}; bash ok.sh`, SPEC).git.r.decision, 'allow');
  denyBoth((_, mid) => `node -e "fs.writeFileSync('other.txt', 'x')"; ${mid}; bash n.sh`); // (n.sh is MISSING: an unmodelled program may have made it)
});

test('h: a write that only MAY be the script never makes it "built from pieces": its content is the unknown-content signal', () => {
  const calm = 'printf a > n.sh; curl -so "$D/n.sh" https://x; printf b >> n.sh; bash n.sh';
  allowBoth(calm);
  denyBoth((_, mid) => `printf a > n.sh; curl -so "$D/n.sh" https://x; printf b >> n.sh; ${mid}; bash n.sh`);
  denyBoth('cat p1.txt > n.sh; cp f.sh "$D/n.sh"; cat p2.txt >> n.sh; bash n.sh'); // the maybe-write copies a blocked file
  allowBoth('cat > "$T/n.sh" 2>/dev/null || true; cat ok.sh > n.sh; bash n.sh');
  // an exact write with a piece that cannot be joined is refused whatever the line says
  denyBoth('printf a > n.sh; curl -s https://x >> n.sh; bash n.sh');
});

test('line-writes: namesFile matches a file name as a whole word, escaped (a + or . in the name is a character)', () => {
  assert.equal(namesFile("fs.writeFileSync('ok.sh','x')", 'ok.sh'), true);
  assert.equal(namesFile('fs.writeFileSync(p, x) ./ok.sh', 'ok.sh'), true);
  assert.equal(namesFile('x+y.sh', 'x+y.sh'), true);
  assert.equal(namesFile('xxy.sh', 'x+y.sh'), false);
  assert.equal(namesFile('okxsh', 'ok.sh'), false);
  assert.equal(namesFile('shell-parse.test.mjs', 'test.mjs'), false);
  assert.equal(namesFile('mytest.mjs', 'test.mjs'), false);
  // through the policy: the program names a script whose name holds a regex character
  const spec = { ...SPEC, 'x+y.sh': 'ok' };
  assert.equal(run("node -e \"fs.writeFileSync('x+y.sh', 'merge')\"; bash x+y.sh", spec).git.r.decision, 'deny');
  assert.equal(run("node -e \"fs.writeFileSync('xxy.sh', 'merge')\"; bash x+y.sh", spec).git.r.decision, 'allow');
});

test('h: a file named ..x.sh inside a copied directory is inside it', () => {
  denyBoth('cp -r src e; bash e/..x.sh');
  denyBoth('cp -r src d; bash d/src/..x.sh');
  allowBoth('cp -r src e; bash ../x.sh');
});

test('h: a write through a directory alias reaches the script by its real name (and the other way)', () => {
  const spec = { ...SPEC, 'real/ok.sh': 'ok' };
  // an existing symlink alias/ -> real/
  denyBoth((bad) => `echo '${bad}' > alias/n.sh; bash real/n.sh`, spec, true);
  denyBoth('cp f.sh alias/n.sh; bash real/n.sh', spec, true);
  denyBoth('cp f.sh real/n.sh; bash alias/n.sh', spec, true);
  denyBoth('cp f.sh alias/ok.sh; bash real/ok.sh', spec, true);
  denyBoth('cat f.sh > alias/n.sh && bash real/n.sh', spec, true);
  denyBoth('cp f.sh alias/n.sh; cd real; bash n.sh', spec, true);
  denyBoth((_, mid) => `curl -so alias/n.sh https://x; ${mid}; bash real/n.sh`, spec, true);
  allowBoth('cp ok.sh alias/n.sh; bash real/n.sh', spec, true);
  allowBoth('cp f.sh alias/other.sh; bash real/n.sh', spec, true);
  // a link made on the line
  denyBoth('ln -s real alias2; cp f.sh alias2/n.sh; bash real/n.sh');
  denyBoth('ln -s real alias2; cp f.sh real/n.sh; bash alias2/n.sh');
  denyBoth('ln -s real/ alias2; echo x >/dev/null; cp f.sh alias2/ok.sh; bash real/ok.sh', { ...spec, 'real/ok.sh': 'ok' });
  // a copied directory reached through the alias (no name in common with the script's)
  denyBoth('ln -s real alias2; cp -r src alias2/x; bash real/x/f.sh');
  denyBoth('ln -s real alias2; cp -r src real/x; bash alias2/x/f.sh');
  denyBoth((_, mid) => `ln -s "$R" alias2; tar -xf a.tar -C alias2; ${mid}; bash real/ok.sh`, spec);
  allowBoth('ln -s real alias2; cp ok.sh alias2/n.sh; bash real/n.sh');
  allowBoth('ln -s real alias2; cp f.sh alias2/other.sh; bash real/n.sh');
  // where the model cannot place the link, a write that ends in the script's name counts as reaching it
  denyBoth('ln -s "$R" alias2; cp f.sh alias2/n.sh; bash real/n.sh');
  denyBoth('ln -s "$R" alias2; cp f.sh anywhere/n.sh; bash real/n.sh');
  denyBoth((_, mid) => `ln -s "$R" alias2; curl -so anywhere/n.sh https://x; ${mid}; bash real/n.sh`);
  denyBoth((_, mid) => `ln -s "$R" alias2; tar -xf a.tar; ${mid}; bash real/ok.sh`, spec);
  allowBoth('ln -s "$R" alias2; cp f.sh anywhere/other.sh; bash real/n.sh');
});

test('h: a copy over an existing harmless script is judged on what it copies', () => {
  denyBoth('cp f.sh ok.sh; bash ok.sh');
  denyBoth((bad) => `echo '${bad}' > ok.sh; bash ok.sh`);
  denyBoth('cat f.sh >> ok.sh; bash ok.sh');
  denyBoth('mv f.sh ok.sh && bash ok.sh');
  denyBoth('cp f.sh ok.sh; ./ok.sh');
  // both contents are judged: the harmless current one alone is not the verdict
  allowBoth('cp ok.sh ok.sh.bak; bash ok.sh');
});

test('h: base64 / computed text written into a script is judged by the file it is computed from', () => {
  denyBoth('base64 -d x.b64 > n.sh; bash n.sh');
  denyBoth('base64 -d < x.b64 > n.sh; bash n.sh');
  denyBoth("sed 's/a/b/' x.b64 > n.sh; bash n.sh");
  denyBoth('tr a-z A-Z < x.b64 > n.sh; bash n.sh');
  allowBoth('base64 -d ok.b64 > n.sh; bash n.sh');
});

test('h: content only known at run time is judged like a script named at run time (refused when the line mentions a guarded operation)', () => {
  for (const mk of [
    (m) => `curl -so n.sh https://x; ${m}; bash n.sh`, (m) => `curl -sSLo n.sh https://x; ${m}; bash n.sh`, (m) => `curl --output n.sh https://x; ${m}; bash n.sh`,
    (m) => `curl -O https://x/n.sh; ${m}; bash n.sh`, (m) => `wget -O n.sh https://x; ${m}; bash n.sh`, (m) => `wget https://x/n.sh; ${m}; bash n.sh`,
    (m) => `wget -qO- https://x > n.sh; ${m}; bash n.sh`, (m) => `curl -s https://x > n.sh; ${m}; bash n.sh`, (m) => `node gen.js > n.sh; ${m}; bash n.sh`,
    (m) => `./gen > n.sh; ${m}; bash n.sh`, (m) => `{ echo a; true; } > n.sh; ${m}; bash n.sh`, (m) => `(echo a; true) > n.sh; ${m}; bash n.sh`,
    (m) => `sed -i 's/a/b/' ok.sh; ${m}; bash ok.sh`, (m) => `perl -pi -e 's/a/b/' ok.sh; ${m}; bash ok.sh`, (m) => `tar -xf a.tar; ${m}; bash n.sh`,
    (m) => `tar -xzf a.tgz -C d; ${m}; bash d/n.sh`, (m) => `unzip a.zip -d d; ${m}; bash d/n.sh`, (m) => `git clone https://x/r d; ${m}; bash d/n.sh`,
    (m) => `git checkout other -- ok.sh; ${m}; bash ok.sh`, (m) => `git show HEAD:f.sh > n.sh; ${m}; bash n.sh`, (m) => `echo "$(curl https://x)" > n.sh; ${m}; bash n.sh`,
    (m) => `curl -o "$OUT" https://x; ${m}; bash ok.sh`, (m) => `curl -o $(mktemp) https://x; ${m}; bash ok.sh`,    (m) => `printf '%s' "$X" > n.sh; ${m}; bash n.sh`, (m) => `echo $(curl https://x) > n.sh; ${m}; bash n.sh`,
  ]) denyBoth((_, mid) => mk(mid));
  // the same writes without the mention of a guarded operation are allowed (what a download holds is not known to the guard either way)
  for (const c of ['curl -so n.sh https://x; bash n.sh', 'wget -O n.sh https://x; bash n.sh', 'node gen.js > n.sh; bash n.sh']) allowBoth(c);
});

test('h: a missing script after a command the guard cannot model may have been created by it', () => {
  for (const mk of [
    (m) => `make build; ${m}; bash n.sh`, (m) => `npm run build && ${m} && bash n.sh`, (m) => `node build.js; ${m}; bash n.sh`, (m) => `bash gen.sh; ${m}; bash n.sh`,
    (m) => `node -e "require('fs').writeFileSync('n.sh', 'x')"; ${m}; bash n.sh`, (m) => `./gen; ${m}; ./n.sh`, (m) => `python3 gen.py; ${m}; source n.sh`,
    (m) => `make; ${m}; bash d/n.sh`,
  ]) denyBoth((_, mid) => mk(mid));
  // an existing harmless script is judged on its content: an unmodelled program overwriting it is a residual (documented)
  for (const c of ['npm run build && bash ok.sh', 'make; bash ok.sh', 'node build.js; bash ok.sh']) allowBoth(c);
  // nothing unmodelled before it, or nothing guarded on the line
  for (const c of ['make build; bash n.sh', 'bash n.sh', 'bash n.sh; make']) allowBoth(c);
  allowBoth((_, _m, mid) => `${mid}; bash n.sh`);
  allowBoth((_, _m, mid) => `git status; ${mid}; bash n.sh`);
  // an inline program that names the script file may have written it, whatever else it does
  denyBoth((bad) => `node -e "fs.writeFileSync('ok.sh', '${bad}')"; bash ok.sh`);
  denyBoth((bad) => `python3 -c "open('ok.sh','w').write('${bad}')"; bash ok.sh`);
  allowBoth((_, _m, mid) => `node -e "console.log(1)"; ${mid}; bash ok.sh`);
});

test('h: every way a script is judged sees the line\'s writes', () => {
  denyBoth('cp f.sh n.sh; ./n.sh');
  denyBoth('cp f.sh n.sh; source n.sh');
  denyBoth('cp f.sh n.sh; . ./n.sh');
  denyBoth('cp f.sh n.sh; bash < n.sh');
  denyBoth('cp f.sh n.sh; cat n.sh | bash');
  denyBoth('cp f.sh n.sh; bash <(cat n.sh)');
  denyBoth('cp f.sh n.sh; eval "$(cat n.sh)"');
  denyBoth('cp f.sh n.sh; sh n.sh');
  denyBoth('cp f.sh n.sh; bash -x n.sh');
  denyBoth('cp f.sh n.sh; sudo bash n.sh');
  // a script named through a variable or a glob
  denyBoth('S=n.sh; cp f.sh n.sh; bash $S');
  denyBoth('cp f.sh n.sh; bash n*.sh');
  denyBoth('S=n.sh; cp f.sh $S; bash n.sh');
  denyBoth('cp f.sh n.sh; X=-x; bash $X n.sh');
  // an interpreter file
  denyBoth('cp f.mjs n.mjs; node n.mjs', { ...SPEC, 'f.mjs': 'bad' });
  denyBoth((bad) => `echo "${bad}" > n.mjs; node n.mjs`);
  // a script that runs a script the line created
  const nested = { ...SPEC, 's.sh': 'bash n.sh', 'sub2.sh': 'echo hi' };
  denyBoth('cp f.sh n.sh; bash s.sh', nested);
  denyBoth('cp f.sh n.sh; source s.sh', nested);
  // and one that writes then runs it itself
  const own = { ...SPEC, 'w.sh': 'cp f.sh m.sh; bash m.sh' };
  denyBoth('bash w.sh', own);
  const own2 = { ...SPEC, 'w2.sh': 'cp ../f.sh m.sh; bash m.sh', 'sub/w2.sh': 'cp ../f.sh m.sh; bash m.sh' };
  denyBoth('cd sub; bash w2.sh', own2);
});

test('h: the startup files a shell runs see the line\'s writes', () => {
  const rc = 'source "$NVM_DIR/nvm.sh"\n';
  const spec = { ...SPEC, '/home/u/.bash_profile': rc, '/home/u/.profile': rc, '/home/u/.zshenv': rc };
  denyBoth((bad) => `printf '%s\\n' '${bad}' > d/nvm.sh; NVM_DIR=d bash -l -c :`, spec);
  denyBoth('cp f.sh d/nvm.sh; NVM_DIR=d bash -l -c :', spec);
  denyBoth('cp f.sh d/nvm.sh; export NVM_DIR=d; zsh -c :', spec);
  allowBoth('cp ok.sh d/nvm.sh; NVM_DIR=d bash -l -c :', spec);
  allowBoth('cp f.sh e/other.sh; NVM_DIR=d bash -l -c :', spec);
  // BASH_ENV names a file the line wrote
  denyBoth('cp f.sh env.sh; BASH_ENV=env.sh bash -c :');
  // content only known at run time in a startup file the line writes: the LINE's mention of a guarded operation counts, not the dotfile's text
  denyBoth((_, mid) => `curl -so ~/.zshenv https://x; ${mid}; zsh -c :`, { ...spec, '/home/u/.zshenv': 'echo hi' });
  denyBoth((_, mid) => `curl -so ~/.zshenv https://x; ${mid}; zsh -c :`, SPEC);
  allowBoth('curl -so ~/.zshenv https://x; zsh -c :', { ...spec, '/home/u/.zshenv': 'echo hi' });
  // the line writes the real home's startup file itself (an existing one too)
  denyBoth((bad) => `printf '%s\\n' '${bad}' > ~/.zshenv; zsh -c :`);
  denyBoth('cp f.sh ~/.zshenv; zsh -c :', { ...spec, '/home/u/.zshenv': 'echo hi' });
  denyBoth('cat f.sh >> ~/.bash_profile; bash -l -c :', { ...spec, '/home/u/.bash_profile': 'echo hi' });
  // the real home's startup files are not "scripts something may have created": a login shell after make is fine
  allowBoth((_, _m, mid) => `make; ${mid}; bash -l -c :`, spec);
  allowBoth((_, _m, mid) => `make; ${mid}; bash -l -c :; make; bash -l -c :`, { ...spec, '/home/u/.bash_profile': 'echo hi' });
});

test('h: writes that may run before the script in another order: pipes, background jobs, loops', () => {
  denyBoth('bash n.sh | cp f.sh n.sh');
  denyBoth('cp f.sh n.sh | bash n.sh');
  denyBoth('bash n.sh & cp f.sh n.sh');
  denyBoth('for i in 1 2; do bash n.sh; cp f.sh n.sh; done');
  denyBoth('while true; do bash n.sh; cp f.sh n.sh; done');
  // a write after the script, with nothing that repeats or overlaps: the script ran before it
  allowBoth('bash n.sh; cp f.sh n.sh');
  allowBoth('bash ok.sh; cp f.sh ok.sh');
});

test('h: a write in a conditional or background command still counts (strict)', () => {
  denyBoth('false && cp f.sh n.sh; bash n.sh');
  denyBoth('cp f.sh n.sh || true; bash n.sh');
  denyBoth('(cp f.sh n.sh); bash n.sh');
  denyBoth('cp f.sh n.sh &\nbash n.sh');
  denyBoth("bash -c 'cp f.sh n.sh'; bash n.sh");
});

// ---- controls: no write reaches the script, or what it puts there is harmless -------------------------------------------

test('h controls: unrelated writes and harmless contents are allowed', () => {
  for (const c of [
    'echo hi > out.txt; bash ok.sh', 'cp ok.sh n.sh; bash n.sh', 'cat ok.sh > n.sh && bash n.sh', 'npm run build && bash ok.sh', 'mkdir -p d && cp ok.sh d/ && bash d/ok.sh',
    'cp f.sh n.sh; bash ok.sh', 'cp f.sh elsewhere.txt; bash n.sh', 'cp f.sh sub/n.sh; bash n.sh', 'cd sub; cp ok.sh n.sh; bash n.sh', 'cat f.sh > n.txt; bash ok.sh',
    'cat ok.sh | tee n.sh >/dev/null; bash n.sh', 'tee n.sh < ok.sh >/dev/null; bash n.sh', 'mv ok.sh n.sh && bash n.sh', 'ln -s ok.sh n.sh; bash n.sh',
    'echo hi > n.sh; bash n.sh', 'touch n.sh; bash n.sh', ': > n.sh; bash n.sh', 'cp -r src d; bash d/ok.sh', 'install -m 755 ok.sh n.sh; bash n.sh', 'dd if=ok.sh of=n.sh; bash n.sh',
    'cp f.sh d/n.sh; cd e; bash n.sh', 'cp f.sh $HOME/n.sh; bash n.sh',
  ]) allowBoth(c);
  allowBoth(() => 'printf \'echo hi\' > n.sh; bash n.sh');
  allowBoth(() => 'printf \'echo %s\' hi > n.sh; bash n.sh');
  allowBoth(() => "cat > n.sh <<EOF\necho hi\nEOF\nbash n.sh");
  // the guarded text is only the text of an unrelated file
  allowBoth(() => "echo 'push it' > notes.md; bash ok.sh");
  // a target that is only known at run time may be the script, but what a harmless source puts there is judged as it is
  allowBoth((_, _m, mid) => `cp ok.sh "$D"; ${mid}; bash ok.sh`);
  allowBoth((_, _m, mid) => `cp ok.sh *.txt; ${mid}; bash ok.sh`);
});

// ---- the shared layer --------------------------------------------------------------------------------------------------------

test('line-writes: printfText fills the format from the arguments', () => {
  assert.equal(printfText(['printf', 'a %s b', 'X']), 'a X b');
  assert.equal(printfText(['printf', '%s %s\\n', 'a', 'b']), 'a b\n');
  assert.equal(printfText(['printf', '%s\\n', 'a', 'b']), 'a\nb\n');
  assert.equal(printfText(['printf', '%%s %s', '7']), '%s 7');
  assert.equal(printfText(['printf', 'plain']), 'plain');
  assert.equal(printfText(['printf', '%s']), '');
  assert.equal(printfText(['printf', '--', '%s', 'x']), 'x');
  assert.equal(printfText(['printf', '-v', 'V', '%s', 'x']), ''); // assigns a variable, prints nothing
  // escapes it reads exactly
  assert.equal(printfText(['printf', '\\147it\\x20\\u0070ush']), 'git push');
  assert.equal(printfText(['printf', '\\U00000067it']), 'git');
  // only plain %s / %% are certain: precision, width, %c %d %b, \c, an unknown escape are not
  for (const f of ['%.4s', '%5s', '%-5s', '%c', '%d', '%b', '%q', 'a\\cb', '\\qx', '%']) assert.equal(printfText(['printf', f, 'abcdef']), null, f);
  assert.equal(printfText(['printf', '-x', '%s', 'a']), null);
});

test('h: printf / echo content that is not certain is unknown (judged by the run-time rule); certain escapes are read', () => {
  const hex = (s, f) => f(s.charCodeAt(0)) + s.slice(1);
  const oct = (n) => '\\' + n.toString(8).padStart(3, '0');
  // escapes that spell the first letter
  denyBoth((bad) => `printf '${hex(bad, oct)}' > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '${hex(bad, (c) => '\\x' + c.toString(16))}' > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '${hex(bad, (c) => '\\u00' + c.toString(16))}' > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '${hex(bad, (c) => '\\U000000' + c.toString(16))}' > n.sh; bash n.sh`);
  denyBoth((bad) => `echo -e '${hex(bad, (c) => '\\x' + c.toString(16))}' > n.sh; bash n.sh`);
  denyBoth((bad) => `echo -e '${hex(bad, (c) => '\\0' + c.toString(8))}' > n.sh; bash n.sh`); // bash: \0NNN
  denyBoth((bad) => `echo -e '${hex(bad, oct)}' > n.sh; bash n.sh`); // zsh / dash: \NNN
  denyBoth((bad) => `echo '${hex(bad, (c) => '\\x' + c.toString(16))}' > n.sh; bash n.sh`); // zsh and sh read escapes without -e
  // precision / width / %c / %d / %b / \c / an unknown escape: the text is not certain, so it is unknown (the line mentions the operation)
  denyBoth((bad) => `printf '%.15s' '${bad} junk' > n.sh; bash n.sh`);
  // (git: a destination that merely starts with main counts as the guarded shape)
  assert.equal(run((bad) => `printf '%.15s' '${bad}junk' > n.sh; bash n.sh`, SPEC).git.r.decision, 'deny');
  denyBoth((bad) => `printf '%.4s' '${bad}' > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '%b' '${bad}' > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '%c' '${bad}' > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '\\q${bad}' > n.sh; bash n.sh`);
  denyBoth((bad) => `printf '${bad}\\c' > n.sh; bash n.sh`);
  // without a mention nothing says what it is for, as for any run-time content
  // text the line wrote that cannot be worked out exactly is refused outright, with nothing guarded on the line
  denyBoth("printf '%.2s' hi > n.sh; bash n.sh");
  denyBoth("printf '%d' 5 > n.sh; bash n.sh");
});

test('h: commands on the read-only list that write a named file are writers', () => {
  // uniq IN OUT, sort -o, xxd IN OUT: the file they read ends up in OUT
  denyBoth('uniq f.sh n.sh; bash n.sh');
  denyBoth('uniq -c f.sh n.sh; bash n.sh');
  denyBoth('sort -o n.sh f.sh; bash n.sh');
  denyBoth('sort f.sh --output=n.sh; bash n.sh');
  denyBoth('sort -o n.sh < x.b64; bash n.sh');
  denyBoth('xxd -r x.b64 n.sh; bash n.sh');
  denyBoth('cat f.sh | less -o n.sh; bash n.sh');
  denyBoth('cat f.sh | less --log-file=n.sh; bash n.sh');
  denyBoth('cat f.sh | more -O n.sh; bash n.sh');
  allowBoth('uniq ok.sh n.sh; bash n.sh');
  allowBoth('sort -o n.sh ok.sh; bash n.sh');
  allowBoth('uniq f.sh; bash n.sh');
  // git commands that write a named output: unknown content
  for (const mk of [
    (m) => `git diff --output=n.sh; ${m}; bash n.sh`, (m) => `git log --output=n.sh; ${m}; bash n.sh`, (m) => `git show -o n.sh; ${m}; bash n.sh`,
    (m) => `git archive -o n.sh HEAD; ${m}; bash n.sh`, (m) => `git format-patch -o d HEAD~1; ${m}; bash d/n.sh`, (m) => `git -C d diff --output=n.sh; ${m}; bash d/n.sh`,
    (m) => `git format-patch --output-directory=d HEAD~1; ${m}; bash d/n.sh`,
  ]) denyBoth((_, mid) => mk(mid));
  // the same over an existing script (a modelled writer, not just "something unmodelled ran")
  for (const mk of [
    (m) => `git diff --output=ok.sh; ${m}; bash ok.sh`, (m) => `git archive -o ok.sh HEAD; ${m}; bash ok.sh`, (m) => `git format-patch -o d HEAD~1; ${m}; bash d/ok.sh`,
  ]) denyBoth((_, mid) => mk(mid), { ...SPEC, 'd/ok.sh': 'ok' });
  // any other tool on the list with an output-like option is not trusted to be read-only: a missing script after it may have been created
  for (const mk of [
    (m) => `du --output=n.sh; ${m}; bash n.sh`, (m) => `cut --output-file x f; ${m}; bash n.sh`, (m) => `wc --log-file=n.sh f; ${m}; bash n.sh`, (m) => `tr -o n.sh a b; ${m}; bash n.sh`,
    (m) => `xxd f.sh n.sh; ${m}; bash n.sh`, (m) => `rg --pre ./gen x; ${m}; bash n.sh`,
  ]) denyBoth((_, mid) => mk(mid));
  // ... while the usual options are fine
  for (const c of ['grep -o x f.sh', 'ls -lo', 'git diff --stat', 'git log --oneline', 'sort -u ok.sh', 'uniq -c ok.sh', 'head -n 3 ok.sh', 'stat -f %z ok.sh']) allowBoth((_, _m, mid) => `${c}; ${mid}; bash n.sh`);
});

test('h: the cached verdict of a startup file depends on WHICH writes count, not how many', () => {
  const rc = 'source "$NVM_DIR/nvm.sh"\n';
  const spec = { ...SPEC, '/home/u/.bash_profile': rc, '/home/u/.profile': rc, '/home/u/.zshenv': rc };
  // two shells on one line: the first sees a harmless nvm.sh, the second a blocked one (same number of writes before each)
  denyBoth('cp ok.sh d/nvm.sh; NVM_DIR=d bash -l -c :; cp f.sh d/nvm.sh; NVM_DIR=d bash -l -c :', spec);
  denyBoth('cp ok.sh d/nvm.sh; NVM_DIR=d bash -l -c :; cp f.sh e/nvm.sh; NVM_DIR=e bash -l -c :', spec);
  denyBoth('cp ok.sh BASH_ENV_F; export BASH_ENV=BASH_ENV_F; bash -c :; cp f.sh BASH_ENV_F; bash -c :', spec);
  allowBoth('cp ok.sh d/nvm.sh; NVM_DIR=d bash -l -c :; cp ok.sh d/nvm.sh; NVM_DIR=d bash -l -c :', spec);
  // the same number of writes, different content: two scripts each write once, then start a shell
  const two = { ...spec, 'a.sh': 'cp ok.sh d/nvm.sh; NVM_DIR=d bash -l -c :', 'b.sh': 'cp f.sh d/nvm.sh; NVM_DIR=d bash -l -c :' };
  denyBoth('bash a.sh; bash b.sh', two);
  denyBoth('bash b.sh; bash a.sh', two);
});

test('line-writes: writesOf lists the writes of each command in order', () => {
  const w = writesOf(simpleCommands('echo hi > a.sh; cp f.sh b.sh; make; tee c.sh < f.sh; ln -s f.sh d.sh; curl -o e.sh u; true'));
  const by = (i) => w.recs.filter((r) => r.idx === i);
  assert.deepEqual(by(0).map((r) => [r.dest, r.items.map((x) => x.text ?? x.file ?? '?')]), [['a.sh', ['hi', 'hi\n']]]);
  assert.deepEqual(by(1).map((r) => [r.dest, r.copy, r.items.map((x) => x.file)]), [['b.sh', true, ['f.sh']]]);
  assert.deepEqual([...w.unmodelled], [2]);
  assert.deepEqual(by(3).map((r) => [r.dest, r.items.map((x) => x.file)]), [['c.sh', ['f.sh']]]);
  assert.deepEqual(by(4).map((r) => [r.dest, r.link]), [['d.sh', 'sym']]);
  assert.deepEqual(by(5).map((r) => [r.dest, r.items.map((x) => !!x.unknown)]), [['e.sh', [true]]]);
});

test('line-writes: a command without stream information is never "nothing written"', () => {
  const plain = (l) => simpleCommands(l).map((c) => ({ argv: c.argv, env: c.env, raw: c.raw, depth: c.depth, redirects: c.redirects, sep: c.sep })); // (no `streams`)
  const items = (l) => writesOf(plain(l)).recs.find((r) => r.dest === 'n.sh').items;
  for (const l of ['cat f.sh > n.sh', 'cat -n f.sh g.sh > n.sh', 'head -c 9 f.sh > n.sh', 'tac f.sh >| n.sh', 'cat < f.sh > n.sh', 'tee n.sh < f.sh', 'dd if=f.sh of=n.sh', 'echo hi > n.sh']) {
    const x = items(l);
    assert.ok(x.some((i) => i.unknown) || x.some((i) => i.file === 'f.sh'), l);
  }
  assert.ok(items('cat f.sh g.sh > n.sh').some((i) => i.file === 'f.sh') && items('cat f.sh g.sh > n.sh').some((i) => i.file === 'g.sh'));
  assert.ok(items('cat < f.sh > n.sh').some((i) => i.file === 'f.sh'));
  assert.ok(items('tee n.sh < f.sh').some((i) => i.file === 'f.sh'));
  assert.ok(items('echo git push > n.sh').some((i) => i.text === 'git push'));
  assert.ok(items('sed s/a/b/ f.sh > n.sh').some((i) => i.unknown));
});

test('line-writes: a write on a redirect whose command is a group is unknown; the null device is no write', () => {
  const w = writesOf(simpleCommands('{ echo a; } > n.sh; echo x > /dev/null; echo y 2>&1; echo z >&2'));
  assert.deepEqual(w.recs.map((r) => [r.dest, r.items.map((x) => !!x.unknown)]), [['n.sh', [true]]]);
});

test('line-writes: flowStart finds the first command that may repeat', () => {
  assert.equal(flowStart(simpleCommands('echo a; for i in 1 2; do echo b; done')), 1);
  assert.equal(flowStart(simpleCommands('echo a; echo b')), -1);
  assert.equal(flowStart(simpleCommands('(echo a)')), 0);
});

// ---- L1: false blocks of the replay (126k real commands) ---------------------------------------------------------------------

test('L1: a script written by a heredoc is the heredoc text once, not twice (a variable it assigns once is not "assigned twice")', () => {
  // Why: `cat > n.sh <<EOF` lists the heredoc as what cat prints AND as what it reads, so the joined text was the script twice and `B=...` looked reassigned
  for (const l of ["cat > n.sh <<'EOF'\nB=feature\ngit push origin $B\nEOF\nbash n.sh", "cat > n.sh <<EOF\nB=feature\ngit push origin $B\nEOF\nbash n.sh", "cat <<'EOF' > n.sh\nB=feature\ngit push origin $B\nEOF\nbash n.sh"]) allowBoth(l);
  const recs = writesOf(simpleCommands("cat > n.sh <<'EOF'\nX=1\nEOF")).recs;
  assert.deepEqual(recs.map((r) => r.parts), [[[{ text: 'X=1' }]]]);
  // the pieces are still all there: cat of two files, a file and a heredoc
  denyBoth('cat p1.txt p2.txt > n.sh; bash n.sh');
  denyBoth((bad) => `cat > n.sh <<'EOF'\n${bad}\nEOF\nbash n.sh`);
  assert.equal(writesOf(simpleCommands('cat a.txt a.txt > n.sh')).recs[0].parts.length, 2);
  // a file read twice (named and as stdin) IS written twice: the doubled text forms a command that neither copy holds (the value is the same, the source is not)
  denyBoth('cat rot.txt - < rot.txt > n.sh; bash n.sh', { ...SPEC, 'rot.txt': 'rot' });
  denyBoth('cat rot.txt rot.txt > n.sh; bash n.sh', { ...SPEC, 'rot.txt': 'rot' });
});

test('L1: a worktree / clone / extract into a relative directory whose place is unknown reaches only scripts whose path holds that directory', () => {
  // Why: `cd d && git worktree list | head -3 && git worktree add -q -b x .wt2 origin/main; cd .wt2 && node /abs/other/script.mjs`: the pipeline makes the directory of the
  // add unknown, and an add into a relative `.wt2` was taken to reach EVERY script, even one outside any directory called .wt2
  const unknownDir = (tail) => (_b, mid) => `cd /work/repo && git worktree list | head -3 && ${tail.replace('MID', mid)}`;
  const gitOnly = (l) => run(l, SPEC).git.r.decision;
  assert.equal(gitOnly(unknownDir('git worktree add -q -b x sub origin/main; MID; node /work/repo/ok.sh')(null, MID_GIT)), 'allow');
  assert.equal(gitOnly(unknownDir('git clone https://x/y.git sub; MID; bash /work/repo/ok.sh')(null, MID_GIT)), 'allow');
  assert.equal(gitOnly(unknownDir('git worktree add -q -b x src/zzz origin/main; MID; bash /work/repo/src/ok.sh')(null, MID_GIT)), 'allow'); // (src/ok.sh is not below src/zzz)
  // the script IS below that directory (or the directory is `.` / `..` / unknown): still refused
  assert.equal(gitOnly(unknownDir('git worktree add -q -b x sub origin/main; MID; bash /work/repo/sub/n.sh')(null, MID_GIT)), 'deny');
  assert.equal(gitOnly(unknownDir('git worktree add -q -b x a/b origin/main; MID; bash /work/repo/a/b/c/n.sh')(null, MID_GIT)), 'deny');
  assert.equal(gitOnly(unknownDir('git clone https://x/y.git .; MID; bash /work/repo/ok.sh')(null, MID_GIT)), 'deny');
  assert.equal(gitOnly(unknownDir('git clone https://x/y.git ../sub; MID; bash /work/repo/sub/n.sh')(null, MID_GIT)), 'deny');
  assert.equal(gitOnly(unknownDir('git clone https://x/y.git sub/../; MID; bash /work/repo/ok.sh')(null, MID_GIT)), 'deny'); // (`..` leaves sub)
  assert.equal(gitOnly(unknownDir('git worktree add -q -b x a/../src origin/main; MID; bash /work/repo/src/n.sh')(null, MID_GIT)), 'deny');
  assert.equal(gitOnly(unknownDir('git clone https://x/y.git sub\\\\..\\\\x; MID; bash /work/repo/ok.sh')(null, MID_GIT)), 'deny');
  assert.equal(gitOnly(unknownDir('git clone https://x/y.git $D; MID; bash /work/repo/ok.sh')(null, MID_GIT)), 'deny');
});

test('L1: an archive extracted into a relative directory of unknown place still reaches every script (members can escape the directory)', () => {
  // Why: only a worktree add / clone is known to stay inside its directory; tar -P / absolute or `../` members and symlink members write elsewhere
  const unknownDir = (tail, mid) => `cd /work/repo && git worktree list | head -3 && ${tail.replace('MID', mid)}`;
  const gitOnly = (l) => run(l, SPEC).git.r.decision;
  for (const tail of ['tar -xf a.tar -C sub; MID; bash /work/repo/ok.sh', 'tar -xzf a.tgz -C sub; MID; bash /work/repo/ok.sh', 'unzip a.zip -d sub; MID; bash /work/repo/ok.sh', 'bsdtar -xf a.tar -C sub; MID; bash /work/repo/src/ok.sh']) {
    assert.equal(gitOnly(unknownDir(tail, MID_GIT)), 'deny', tail);
  }
  assert.equal(gitOnly(unknownDir('git clone https://x/y.git sub; MID; bash /work/repo/ok.sh', MID_GIT)), 'allow'); // (the narrowing stays for a clone)
});

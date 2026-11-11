// isPipelineTool is an ALLOW check ("this is the trusted pipeline CLI, run it freely"), so a false match fails open. On macOS / Windows the spelling is
// case-folded, which is wrong on a case-sensitive volume: there a differently-cased pipeline folder is a different, agent-writable one and must not be trusted.
// The disk decides (sameFileStrict / insideStrict: identity when both stats answer, else the exact normalised spelling, never a fold); the protect checks (a false match denies) stay on the spelling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateBashForFiles } from '../pipeline/hooks/lib/files-policy.mjs';

const HOME = '/home/u';
const opts = { home: HOME, env: {}, platform: 'darwin', cwd: '/repo', realpath: (p) => p, existsSync: () => false };
const run = (command) => evaluateBashForFiles(command, opts).decision;

// A fake volume: statSync knows only what `inodeOf` answers for (a bigint inode, or undefined = absent). sameFileStrict asks the disk only when `platform` is
// the running one, so the test presents itself as darwin for its duration.
function onFakeVolume(inodeOf, body) {
  const origStat = fs.statSync;
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  fs.statSync = (p) => {
    const ino = inodeOf(String(p));
    if (ino === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { dev: 1n, ino };
  };
  Object.defineProperty(process, 'platform', { ...origPlatform, value: 'darwin' });
  try { body(); } finally { fs.statSync = origStat; Object.defineProperty(process, 'platform', origPlatform); }
}
// case-sensitive: every exact spelling in `files` is its own file
const caseSensitive = (files) => { const m = new Map(files.map((f, i) => [f, BigInt(i + 1)])); return (p) => m.get(p); };
// case-insensitive: spellings that fold to the same text are one file
const caseInsensitive = (files) => { const m = new Map(files.map((f, i) => [f.toLowerCase(), BigInt(i + 1)])); return (p) => m.get(p.toLowerCase()); };

const CLAUDE = `${HOME}/.claude`;
const REAL_CLI = `${CLAUDE}/pipeline/bin/pipeline.mjs`;
const FAKE_CLI = `${CLAUDE}/PIPELINE/bin/pipeline.mjs`;
const REAL_HOOK = `${CLAUDE}/pipeline/hooks/guard-files.mjs`;
const FAKE_HOOK = `${CLAUDE}/PIPELINE/hooks/guard-files.mjs`;
const ALL = [CLAUDE, `${CLAUDE}/pipeline`, `${CLAUDE}/pipeline/bin`, REAL_CLI, `${CLAUDE}/pipeline/hooks`, REAL_HOOK];
const ALL_FAKE = [`${CLAUDE}/PIPELINE`, `${CLAUDE}/PIPELINE/bin`, FAKE_CLI, `${CLAUDE}/PIPELINE/hooks`, FAKE_HOOK];

test('a differently-cased pipeline.mjs is not the trusted CLI when the disk says it is another file', () => {
  onFakeVolume(caseSensitive([...ALL, ...ALL_FAKE]), () => {
    assert.equal(run(`node ${REAL_CLI} preflight`), 'allow', 'the real CLI stays trusted');
    assert.equal(run(`node ${FAKE_CLI} preflight`), 'deny', 'the agent-writable look-alike is not');
    assert.equal(run(`${FAKE_CLI} preflight`), 'deny', 'run directly, same');
  });
});

test('a differently-cased pipeline/hooks folder is not the trusted hooks folder when the disk says it is another folder', () => {
  onFakeVolume(caseSensitive([...ALL, ...ALL_FAKE]), () => {
    assert.equal(run(`node ${REAL_HOOK}`), 'allow', 'the real hooks folder stays trusted');
    assert.equal(run(`node ${FAKE_HOOK}`), 'deny');
  });
});

test('on a case-insensitive volume the other spelling is the same file and stays trusted', () => {
  onFakeVolume(caseInsensitive(ALL), () => {
    assert.equal(run(`node ${FAKE_CLI} preflight`), 'allow');
    assert.equal(run(`node ${FAKE_HOOK}`), 'allow');
  });
});

// An ALLOW check must not be looser than exact when the disk cannot answer: a stat error, or nothing there, leaves only the exact (non-folded) spelling.
const denies = (p) => (p.startsWith(`${CLAUDE}/PIPELINE`) ? Object.assign(new Error('EACCES'), { code: 'EACCES' }) : null);
// everything real exists; any stat of a differently-cased spelling throws EACCES (identity unreadable)
const realButFakeUnreadable = () => { const ok = caseSensitive(ALL); return (p) => { const e = denies(p); if (e) throw e; return ok(p); }; };

test('a differently-cased pipeline.mjs whose stat throws EACCES is not trusted (no fold on a stat error)', () => {
  onFakeVolume(realButFakeUnreadable(), () => {
    assert.equal(run(`node ${REAL_CLI} preflight`), 'allow', 'the exact spelling stays trusted');
    assert.equal(run(`node ${FAKE_CLI} preflight`), 'deny');
    assert.equal(run(`${FAKE_CLI} preflight`), 'deny');
  });
});

test('a differently-cased pipeline/hooks folder whose stat throws EACCES is not trusted', () => {
  onFakeVolume(realButFakeUnreadable(), () => {
    assert.equal(run(`node ${REAL_HOOK}`), 'allow');
    assert.equal(run(`node ${FAKE_HOOK}`), 'deny');
  });
});

test('a real pipeline.mjs whose own stat throws EACCES is still trusted by its exact spelling', () => {
  const ok = caseSensitive(ALL);
  onFakeVolume((p) => { if (p === REAL_CLI || p === REAL_HOOK) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return ok(p); }, () => {
    assert.equal(run(`node ${REAL_CLI} preflight`), 'allow');
    assert.equal(run(`node ${REAL_HOOK}`), 'allow');
  });
});

test('when neither spelling exists, only the exact spelling is trusted, never a case-folded one', () => {
  onFakeVolume(() => undefined, () => {
    assert.equal(run(`node ${REAL_CLI} preflight`), 'allow');
    assert.equal(run(`node ${FAKE_CLI} preflight`), 'deny');
    assert.equal(run(`node ${REAL_HOOK}`), 'allow');
    assert.equal(run(`node ${FAKE_HOOK}`), 'deny');
  });
});

// The raw-text route (a backslash anywhere on the line, for a Windows `node C:\...\pipeline.mjs`) must reach the same strict decision: the path it matches
// goes through the same check, it never trusts the case-folded regex match.
test('a backslash on the line does not turn a differently-cased look-alike into the trusted CLI or hooks folder', () => {
  onFakeVolume(caseSensitive([...ALL, ...ALL_FAKE]), () => {
    assert.equal(run(`node ${REAL_CLI} preflight a\\ b`), 'allow', 'the real CLI with a backslash stays trusted');
    assert.equal(run(`node ${REAL_HOOK} a\\ b`), 'allow');
    assert.equal(run(`node ${FAKE_CLI} preflight a\\ b`), 'deny');
    assert.equal(run(`node "${FAKE_CLI}" preflight a\\ b`), 'deny');
    assert.equal(run(`node ${FAKE_HOOK} a\\ b`), 'deny');
  });
});

test('a backslash on the line, with a differently-cased look-alike whose stat throws EACCES or is absent, is not trusted', () => {
  onFakeVolume(realButFakeUnreadable(), () => {
    assert.equal(run(`node ${REAL_CLI} preflight a\\ b`), 'allow');
    assert.equal(run(`node ${FAKE_CLI} preflight a\\ b`), 'deny');
    assert.equal(run(`node ${FAKE_HOOK} a\\ b`), 'deny');
  });
  onFakeVolume(() => undefined, () => {
    assert.equal(run(`node ${REAL_CLI} preflight a\\ b`), 'allow');
    assert.equal(run(`node ${FAKE_CLI} preflight a\\ b`), 'deny');
    assert.equal(run(`node ${FAKE_HOOK} a\\ b`), 'deny');
  });
});

test('a backslash on the line, on a case-insensitive volume, keeps the other spelling trusted', () => {
  onFakeVolume(caseInsensitive(ALL), () => {
    assert.equal(run(`node ${FAKE_CLI} preflight a\\ b`), 'allow');
    assert.equal(run(`node ${FAKE_HOOK} a\\ b`), 'allow');
  });
});

test('a backslash on the line, with a hooks path that climbs out with .., is not trusted on any platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const o = { ...opts, platform };
    const go = (command) => evaluateBashForFiles(command, o).decision;
    assert.equal(go(`node ${CLAUDE}/pipeline/hooks/../../../../tmp/x.mjs a\\ b`), 'deny', `${platform}: climbs out of the hooks folder`);
    assert.equal(go(`node "${CLAUDE}/pipeline/hooks/../../../../tmp/x.mjs" a\\ b`), 'deny', `${platform}: quoted`);
  }
});

// Parser differential: on POSIX a backslash is an ESCAPE, not a separator. The shell runs `hooks/\.\./\.\./x.mjs` as `hooks/../../x.mjs`, but the raw-text fallback
// (meant for a Windows `node C:\...\pipeline.mjs`) rewrites the backslashes to slashes and saw `hooks//.//./...`, inside the hooks folder. The fallback is win32 only,
// and even there a `.` / `..` segment in the matched path is refused (a trusted tool path never needs one).
test('on darwin and linux an escaped-dot path out of the hooks or bin folder is not trusted (a backslash is an escape there, not a separator)', () => {
  const climbs = [
    `${CLAUDE}/pipeline/hooks/\\.\\./\\.\\./\\.\\./tmp/x.mjs`,
    `${CLAUDE}/pipeline/hooks/\\.\\./\\.\\./\\.\\./\\.\\./tmp/x.mjs`,
    `${CLAUDE}/pipeline/hooks/.\\./.\\./.\\./tmp/x.mjs`,
    `${CLAUDE}/pipeline/hooks/\\../\\../\\../tmp/x.mjs`,
    `${CLAUDE}/pipeline/bin/\\.\\./\\.\\./x.mjs`,
    `${CLAUDE}/pipeline/bin/\\.\\./\\.\\./\\.\\./tmp/x.mjs`,
  ];
  for (const platform of ['darwin', 'linux']) {
    const go = (command) => evaluateBashForFiles(command, { ...opts, platform }).decision;
    for (const p of climbs) {
      assert.equal(go(`node ${p}`), 'deny', `${platform}: ${p}`);
      assert.equal(go(`node "${p}"`), 'deny', `${platform}: double-quoted ${p}`);
      assert.equal(go(`node '${p}'`), 'deny', `${platform}: single-quoted ${p}`);
      assert.equal(go(`node ${p} preflight`), 'deny', `${platform}: with an argument ${p}`);
    }
    assert.equal(go(`node ${REAL_CLI} preflight a\\ b`), 'allow', `${platform}: the real CLI with a backslash elsewhere stays trusted`);
  }
});

// The raw-text route exists for the PowerShell tool ONLY (where a backslash is a path separator). Git Bash drops an unquoted backslash and runs the drive-relative file
// (R8-B1), a word cut short at an escaped space is not the operand the shell runs (R8-F1), and off Windows a backslash a variable carries is a name character (R8-F2).
const WIN = { home: 'C:\\Users\\u', env: {}, platform: 'win32', cwd: 'C:\\repo', realpath: (p) => p, existsSync: () => false };
const bashW = (command) => evaluateBashForFiles(command, WIN).decision; // the Bash tool (Git Bash) on Windows
const psW = (command) => evaluateBashForFiles(command, { ...WIN, shell: 'powershell' }).decision; // the PowerShell tool
const WCLI = 'C:\\Users\\u\\.claude\\pipeline\\bin\\pipeline.mjs';
const WHOOKS = 'C:\\Users\\u\\.claude\\pipeline\\hooks';

test('on win32 a genuine PowerShell backslash path to the CLI or a hook stays trusted, one with a . or .. segment is not', () => {
  assert.equal(psW(`node ${WCLI} preflight`), 'allow');
  assert.equal(psW(`node "${WCLI}" preflight`), 'allow');
  assert.equal(psW(`node '${WCLI}' preflight`), 'allow');
  assert.equal(psW(`node ${WHOOKS}\\guard-files.mjs`), 'allow');
  assert.equal(psW(`node ${WHOOKS}\\..\\..\\..\\tmp\\x.mjs`), 'deny');
  assert.equal(psW(`node "${WHOOKS}\\..\\..\\..\\tmp\\x.mjs"`), 'deny');
  assert.equal(psW('node C:\\Users\\u\\.claude\\pipeline\\bin\\..\\..\\x.mjs'), 'deny');
  assert.equal(psW(`node ${WHOOKS}\\.\\.\\.\\tmp\\x.mjs`), 'deny');
  assert.equal(psW(`node ${WHOOKS}\\.\\guard-files.mjs`), 'deny');
  assert.equal(psW(`node ${WHOOKS}\\sub\\..\\guard-files.mjs`), 'deny');
});

test('on win32 the PowerShell route decides on the whole operand: anything PowerShell would expand, join or end early is not trusted', () => {
  assert.equal(psW(`node ${WCLI}x`), 'deny', 'a different file name');
  assert.equal(psW(`node ${WCLI}"x`), 'deny', 'a quote inside the word');
  assert.equal(psW(`node "${WCLI}"x`), 'deny', 'text glued to the closing quote');
  assert.equal(psW(`node '${WCLI}''x'`), 'deny', 'a doubled single quote continues the word');
  assert.equal(psW(`node "${WHOOKS}\\$env:X\\guard-files.mjs"`), 'deny', 'an interpolated variable');
  assert.equal(psW(`node ${WHOOKS}\\g\`uard-files.mjs`), 'deny', 'a backtick escape');
  assert.equal(psW(`node ${WHOOKS}\\`), 'deny', 'a folder, not a file');
});

test('R8-B1: on win32 under Bash an unquoted backslash path runs a drive-relative file, so it is not the trusted CLI or hook', () => {
  assert.equal(bashW(`node ${WCLI}`), 'deny');
  assert.equal(bashW(`node ${WCLI} preflight`), 'deny');
  assert.equal(bashW(`node ${WHOOKS}\\guard-files.mjs`), 'deny');
  assert.equal(bashW(`node ${WHOOKS}\\..\\..\\..\\tmp\\x.mjs`), 'deny');
  // a quoted one keeps its backslashes (a real Windows path), and the forward-slash spelling is the normal Bash form
  assert.equal(bashW(`node "${WCLI}" preflight`), 'allow');
  assert.equal(bashW('node C:/Users/u/.claude/pipeline/bin/pipeline.mjs preflight'), 'allow');
  assert.equal(bashW('node C:/Users/u/.claude/pipeline/hooks/guard-files.mjs'), 'allow');
});

test('R8-F1: on win32 a path cut short at an escaped space is not the trusted tool (Bash and PowerShell)', () => {
  const fwd = 'node C:/Users/u/.claude/pipeline/hooks/a\\ ../../../../../../repo/evil.mjs C:/Users/u/.claude/settings.json';
  const back = `node ${WHOOKS}\\a\\ ..\\..\\..\\..\\..\\..\\repo\\evil.mjs C:\\Users\\u\\.claude\\settings.json`;
  const hook = 'node C:/Users/u/.claude/pipeline/hooks/guard-files.mjs\\ /../../../repo/evil.mjs C:/Users/u/.claude/settings.json';
  for (const c of [fwd, back, hook]) {
    assert.equal(bashW(c), 'deny', `Bash: ${c}`);
    assert.equal(psW(c), 'deny', `PowerShell: ${c}`);
  }
});

test('R8-F2: off Windows a backslash a variable carries is a name character, so the path is not the trusted hooks folder', () => {
  for (const platform of ['darwin', 'linux']) {
    const go = (command) => evaluateBashForFiles(command, { ...opts, platform }).decision;
    assert.equal(go("D='a\\b'; node /home/u/.claude/pipeline/hooks/$D/../../x.mjs"), 'deny', `${platform}: two levels`);
    assert.equal(go("D='a\\b'; node /home/u/.claude/pipeline/hooks/$D/../../../../../../x.mjs"), 'deny', `${platform}: six levels`);
    assert.equal(go("D='a\\b'; node \"/home/u/.claude/pipeline/hooks/${D}/../../x.mjs\""), 'deny', `${platform}: quoted, braced`);
    assert.equal(go("D='a\\b'; node /home/u/.claude/pipeline/bin/pipeline.mjs preflight"), 'allow', `${platform}: a variable the operand does not use`);
  }
});

test('the real CLI and a real hook stay trusted through Bash forward-slash paths on every platform', () => {
  for (const platform of ['darwin', 'linux']) {
    const go = (command) => evaluateBashForFiles(command, { ...opts, platform }).decision;
    assert.equal(go(`node ${REAL_CLI} preflight`), 'allow', `${platform}: CLI`);
    assert.equal(go(`node ${REAL_HOOK}`), 'allow', `${platform}: hook`);
  }
  assert.equal(bashW('node C:/Users/u/.claude/pipeline/bin/pipeline.mjs preflight'), 'allow', 'win32: CLI');
  assert.equal(bashW('node C:/Users/u/.claude/pipeline/hooks/guard-files.mjs'), 'allow', 'win32: hook');
});

// A text read from disk is never PowerShell input: the shell setting belongs to the top-level tool call only. The implicit startup file (~/.zshenv, run by `zsh -c :`) is judged with
// `_depth: 0` and the line's options spread in, so a `shell: 'powershell'` that leaked there would trust a backslash CLI line that zsh itself reads as a drive-relative file.
test('a startup file read from disk is judged as Bash even when the top-level tool is PowerShell', () => {
  const startup = `node ${WCLI} preflight\n`;
  const readText = (p) => (/\.zshenv$/.test(String(p)) ? startup : null);
  const o = { ...WIN, readText, readHead: () => null };
  assert.equal(evaluateBashForFiles('zsh -c :', { ...o, shell: 'bash' }).decision, 'deny', 'Bash: the startup line is a drive-relative file');
  assert.equal(evaluateBashForFiles('zsh -c :', { ...o, shell: 'powershell' }).decision, 'deny', 'PowerShell top level: the startup text is still Bash');
  assert.equal(evaluateBashForFiles(`node ${WCLI} preflight`, { ...o, shell: 'powershell' }).decision, 'allow', 'the top-level PowerShell line itself stays trusted');
});

// PowerShell reads the typographic quotes U+2018-U+201E as quote characters, so `‘..’` is `..` to it. The operand is therefore judged by an ALLOWLIST of plain ASCII path characters
// (anything else, every non-ASCII character included, is refused), not by a list of characters known to be special.
const SMART = ['\u2018', '\u2019', '\u201A', '\u201B', '\u201C', '\u201D', '\u201E', '\u201F'];
test('on win32 the PowerShell route refuses typographic quotes and any non-ASCII character in the operand', () => {
  for (const q of SMART) {
    assert.equal(psW(`node ${WHOOKS}\\${q}..${q}\\${q}..${q}\\${q}..${q}\\tmp\\x.mjs`), 'deny', `U+${q.codePointAt(0).toString(16)} dot segments`);
    assert.equal(psW(`node "${WHOOKS}\\${q}..${q}\\${q}..${q}\\tmp\\x.mjs"`), 'deny', `U+${q.codePointAt(0).toString(16)} dot segments, ASCII-quoted`);
    assert.equal(psW(`node ${q}${WCLI}${q} preflight`), 'deny', `U+${q.codePointAt(0).toString(16)} around the operand`);
    assert.equal(psW(`node ${WHOOKS}\\guard${q}files.mjs`), 'deny', `U+${q.codePointAt(0).toString(16)} inside a name`);
  }
  assert.equal(psW(`node ${WHOOKS}\\\u2018..\u2019\\guard-files.mjs`), 'deny', 'mixed quotes');
  assert.equal(psW(`node ${WHOOKS}\\\u201C..\u201D\\guard-files.mjs`), 'deny', 'double typographic quotes');
  assert.equal(psW(`node ${WHOOKS}\\\u201A..\u201B\\guard-files.mjs`), 'deny', 'low and reversed quotes');
  assert.equal(psW(`node ${WHOOKS}\\gu\u00E4rd-files.mjs`), 'deny', 'a non-ASCII letter in a segment');
  assert.equal(psW(`node ${WHOOKS}\\guard-files.mjs\u00A0x`), 'deny', 'a no-break space ends no word');
  assert.equal(psW(`node "${WHOOKS}\\guard-files.mjs"\u00A0x`), 'deny', 'a no-break space after the closing quote');
  // genuine plain ASCII spellings (bare, single- or double-quoted, both separators) stay trusted
  assert.equal(psW(`node ${WCLI} preflight`), 'allow');
  assert.equal(psW(`node "${WCLI}" preflight`), 'allow');
  assert.equal(psW(`node '${WCLI}' preflight`), 'allow');
  assert.equal(psW(`node ${WHOOKS}\\guard-files.mjs`), 'allow');
  assert.equal(psW(`node "${WHOOKS}\\guard-files.mjs"`), 'allow');
  assert.equal(psW('node C:/Users/u/.claude/pipeline/bin/pipeline.mjs preflight'), 'allow', 'forward slashes');
});

// R9-B1: the unknown-directory re-run (`cd $DEST; ...`) judges the SAME top-level text with another working directory, so it keeps the tool's shell; only text read from disk is forced to Bash.
test('R9-B1: on win32 a PowerShell `cd $DEST; node <CLI>` line stays trusted (the cd re-run keeps the PowerShell shell)', () => {
  assert.equal(psW(`cd $DEST; node ${WCLI} preflight`), 'allow');
  assert.equal(psW(`cd $DEST; node "${WCLI}" preflight`), 'allow');
  assert.equal(psW(`cd $DEST; node ${WHOOKS}\\guard-files.mjs`), 'allow');
  assert.equal(bashW(`cd $DEST; node ${WCLI} preflight`), 'deny', 'Bash: still a drive-relative file');
  assert.equal(psW(`cd $DEST; node ${WHOOKS}\\..\\..\\..\\tmp\\x.mjs`), 'deny', 'a climbing path is still refused after the cd');
});

// R9-F1: under PowerShell the Bash-parsed argv word is never the operand (that parser drops unquoted backslashes, so `hooks/x\..\..\repo\evil.mjs` reads as one plain name inside hooks).
test('R9-F1: on win32 a mixed-separator PowerShell path that climbs out of hooks with backslash .. segments is not trusted', () => {
  const up = '\\..\\..\\..\\..\\..\\..\\repo\\evil.mjs';
  const bare = `node C:/Users/u/.claude/pipeline/hooks/x${up} C:/Users/u/.claude/settings.json`;
  const quoted = `node "C:/Users/u/.claude/pipeline/hooks/x${up}" C:/Users/u/.claude/settings.json`;
  const single = `node 'C:/Users/u/.claude/pipeline/hooks/x${up}' C:/Users/u/.claude/settings.json`;
  for (const c of [bare, quoted, single]) assert.equal(psW(c), 'deny', c);
  assert.equal(psW('node C:/Users/u/.claude/pipeline/bin/pipeline.mjs preflight'), 'allow', 'forward slashes');
  assert.equal(psW('node "C:/Users/u/.claude/pipeline/hooks/guard-files.mjs"'), 'allow', 'quoted forward slashes');
  assert.equal(psW(`node ${WCLI} preflight`), 'allow');
});

// R9-F2: an operand that still holds a run-time part is not a trusted tool path (an unset variable is an empty segment, so `$U/$U/$U/../../..` climbs out of hooks).
test('R9-F2: a hooks path with an unexpanded $VAR, ${VAR}, $( ), backtick or mid-path ~ is not trusted on any platform', () => {
  for (const [platform, home, base] of [['darwin', '/home/u', '/home/u'], ['linux', '/home/u', '/home/u'], ['win32', 'C:\\Users\\u', 'C:/Users/u']]) {
    const go = (command) => evaluateBashForFiles(command, { ...opts, home, platform, cwd: platform === 'win32' ? 'C:\\repo' : '/repo' }).decision;
    const h = `${base}/.claude/pipeline/hooks`;
    const rest = `${base}/.claude/settings.json`;
    assert.equal(go(`node ${h}/$U/$U/$U/../../../repo/evil.mjs ${rest}`), 'deny', `${platform}: $U`);
    assert.equal(go(`node ${h}/\${U}/\${U}/\${U}/../../../repo/evil.mjs ${rest}`), 'deny', `${platform}: \${U}`);
    assert.equal(go(`node "${h}/$U/$U/$U/../../../repo/evil.mjs" ${rest}`), 'deny', `${platform}: quoted $U`);
    assert.equal(go(`node ${h}/$(true)/../../repo/evil.mjs ${rest}`), 'deny', `${platform}: $( )`);
    assert.equal(go(`node ${h}/\`true\`/../../repo/evil.mjs ${rest}`), 'deny', `${platform}: backtick`);
    assert.equal(go(`node ${h}/~/../../repo/evil.mjs ${rest}`), 'deny', `${platform}: ~ mid-path`);
    assert.equal(go(`node ${h}/guard-files.mjs`), 'allow', `${platform}: the plain hook stays trusted`);
  }
  assert.equal(evaluateBashForFiles('node C:/Users/u/.claude/pipeline/hooks/%U%/%U%/%U%/../../../repo/evil.mjs C:/Users/u/.claude/settings.json', WIN).decision, 'deny', 'win32: %VAR%');
});

// R9-F3: PowerShell text is cut into commands by the Bash parser, where a backslash escapes. A backslash directly before ; | & a quote, a backtick or a line end hides a PowerShell
// statement inside one apparently read-only command, so such a PowerShell line is refused whole.
test('R9-F3: a PowerShell line with a backslash before ; | & a quote, a backtick or a line end is refused', () => {
  const S = 'C:\\Users\\u\\.claude\\settings.json';
  const lines = [
    `node ${WHOOKS}\\guard-files.mjs \\; Set-Content ${S} x`,
    `echo x \\; Set-Content ${S} x`,
    `echo "a\\" ; Set-Content ${S} x ; \\"b"`,
    `echo x \\| Set-Content ${S}`,
    `echo x \\& Set-Content ${S} x`,
    `echo 'a\\' ; Set-Content ${S} x ; \\'b'`,
    `echo x \\\`; Set-Content ${S} x`,
    `echo x \\\nSet-Content ${S} x`,
    `echo x \\\r\nSet-Content ${S} x`,
    `node ${WHOOKS}\\guard-files.mjs ${S} \\`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  assert.equal(psW(`node ${WHOOKS}\\guard-files.mjs ${S}`), 'allow', 'the same line without the trailing backslash');
  // ordinary backslash paths with no such sequence are judged as before
  assert.equal(psW(`node ${WCLI} preflight`), 'allow');
  assert.equal(psW('echo C:\\Users\\u\\repo\\x.txt; ls C:\\Users\\u\\repo'), 'allow');
  assert.equal(psW('Get-Content C:\\Users\\u\\repo\\x.txt | Select-Object -First 3'), 'allow');
  // Bash is untouched: there the backslash IS an escape and the parser reads the line as the shell does
  assert.equal(bashW('echo x \\; ls'), 'allow');
});

// A denylist of escaped characters missed `\$`: PowerShell runs `\$(Set-Content ...)` (the backslash is an ordinary character, `$(` a subexpression) while the Bash parser reads `\$` as a
// literal `$`. Deny by default: on a PowerShell line a backslash must be followed by a plain path character, else no command on the line is read-only.
test('a PowerShell line with a backslash before any character but a plain path character is refused', () => {
  const S = 'C:\\Users\\u\\.claude\\settings.json';
  const lines = [
    `node ${WHOOKS}\\guard-files.mjs \\$(Set-Content ${S} x)`,
    `echo \\$(Set-Content ${S} x)`,
    `echo x \\@(Set-Content ${S} x)`,
    `echo x \\{ Set-Content ${S} x }`,
    `echo x \\< ${S}`,
    `echo x \\> ${S}`,
    `echo x \\(Set-Content ${S} x)`,
    `echo x \\# ; Set-Content ${S} x`,
    `echo x \\ ; Set-Content ${S} x`,
    `echo x \\* ${S}`,
    `echo x \\[0] ${S}`,
    `echo x \\! ${S}`,
    `echo x \\= ${S}`,
    `echo x \\, ${S}`,
    `echo x \\\\server\\share ${S}`,
    `echo x \\/y ${S}`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  // ordinary backslash paths (CLI and hook, bare and ASCII-quoted, with arguments) stay allowed
  assert.equal(psW(`node ${WCLI} preflight --json`), 'allow');
  assert.equal(psW(`node "${WCLI}" preflight --json`), 'allow');
  assert.equal(psW(`node '${WCLI}' preflight`), 'allow');
  assert.equal(psW(`node ${WHOOKS}\\guard-files.mjs`), 'allow');
  assert.equal(psW(`node "${WHOOKS}\\guard-files.mjs" --flag value`), 'allow');
  assert.equal(psW(`node '${WHOOKS}\\guard-files.mjs' x`), 'allow');
  assert.equal(psW('Get-Content C:\\Users\\u\\repo\\a-b_c.d\\x.txt | Select-Object -First 3'), 'allow');
  // Bash is untouched: there `\$` is a literal dollar sign and the parser judges the line as the shell does
  assert.equal(bashW('echo \\$HOME'), 'allow');
  assert.equal(bashW('echo x \\( \\) \\{ \\<'), 'allow');
});

// R10-B1 / R10-F1 / R10-F3: the Bash parser can miss a statement PowerShell runs, and the destination-only filter (cp / rsync / install) and the early allow never ask isReadOnly. So on a PowerShell line the
// decision is made once, for the whole line: it names a protected path (also with PowerShell's backticks removed) AND holds anything outside a plain ASCII allowlist = refused outright.
test('R10-B1: a PowerShell cp / rsync / install line with an escaped `;` and a protected write is refused', () => {
  const S = 'C:/Users/u/.claude/settings.json';
  for (const c of [`cp a b \\; Set-Content ${S} x`, `rsync a b \\; Set-Content ${S} x`, `install a b \\; Set-Content ${S} x`, `cp -t d a \\| Set-Content ${S} x`]) assert.equal(psW(c), 'deny', c);
});

test('R10-F1: a PowerShell line that hides a statement behind typographic quotes, a here-string or a block comment is refused', () => {
  const S = 'C:/Users/u/.claude/settings.json';
  const lines = [
    `echo \u2018 " \u2019 ; Set-Content ${S} x ; echo \u2018 " \u2019`,
    `echo \u201C ' \u201D ; Set-Content ${S} x ; echo \u201C ' \u201D`,
    `echo @"\n" '\n"@ ; Set-Content ${S} x ; echo '' #'`,
    `echo @'\n" '\n'@ ; Set-Content ${S} x`,
    `echo x <# #>; Set-Content ${S} x`,
    `echo x <#\n#>; Set-Content ${S} x`,
    `echo x --% ; Set-Content ${S} x`,
    `echo x\r Set-Content ${S} x`,
    `echo x\u00A0; Set-Content ${S} x`,
    `cp a b <# #>; Set-Content ${S} x`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  // the same lines without the protected path are judged as before
  assert.equal(psW('echo \u2018 " \u2019 ; Get-ChildItem C:/repo ; echo \u2018 " \u2019'), 'allow');
  assert.equal(psW('echo x <# #>; Get-ChildItem C:/repo'), 'allow');
  // Bash is untouched
  assert.equal(bashW(`echo \u2018 x \u2019 ${S}`), 'allow');
  assert.equal(bashW(`echo x <# #>; echo ${S}`), 'allow');
});

test('R10-F3: a PowerShell backtick may spell a protected path, so a line with one that names it (backticks removed) is refused', () => {
  const lines = [
    'Set-Content C:/Users/u/.c`laude/settings.json x',
    'Set-Content C:/Users/u/.claude/set`tings.json x',
    'cp a C:/Users/u/.cl`aude/settings.json',
    'echo x ; Set-Content "C:/Users/u/.c`laude/settings.json" x',
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', c);
  // a backtick on a line that names nothing protected is judged as before; so is Bash with a backtick and a protected read
  assert.equal(psW('Write-Output "a`nb"'), 'allow');
  assert.equal(bashW('echo `true` C:/Users/u/.claude/settings.json'), 'allow');
});

// R10 security review: inside a double-quoted string a backtick escape DECODES (`u{2E} is '.'), it is not simply dropped, so neither the raw text nor the backtick-stripped text holds `.claude`.
test('R10 security review: PowerShell backtick escapes are decoded', () => {
  const deny = [
    'Set-Content "C:/Users/u/`u{2E}claude/settings.json" x', // `u{2E} = '.'
    'Set-Content "C:/Users/u/.cl`u{61}ude/settings.json" x', // a letter
    'Set-Content "C:/Users/u/.claude/settings.js`u{6f}n" x', // lower hex
    'Set-Content "C:/Users/u/.claude/settings.js`u{6F}n" x', // upper hex
    'Set-Content "C:/Users/u/`u{2e}claude/settings.json" x',
    'Set-Content "C:/Users/u/`u{002E}claude/settings.json" x', // leading zeros
    'Set-Content "C:/Users/u/`u{00002E}claude/settings.json" x', // six digits
    'Set-Content "C:/Users/u/`u{2E}c`laude/set`u{74}ings.json" x', // mixed with a plain backtick letter escape
    'Set-Content "C:/Users/u/.claude/`u{73}ettings.json" x',
    'cp a "C:/Users/u/`u{2E}claude/settings.json"',
    'Set-Content "C:/Users/u/`u{2E}claude/settings.json`0" x', // a control-character escape beside it
    'Set-Content "C:/Users/u/`u{2E}claude`/settings.json" x',
  ];
  for (const c of deny) assert.equal(psW(c), 'deny', c);
  // a `u{ with no closing brace or an invalid code point is refused with a protected path on the line
  for (const c of ['Set-Content "C:/Users/u/.claude/`u{2E settings.json" x', 'Set-Content "C:/Users/u/.claude/`u{ZZ}.json" x', 'Set-Content "C:/Users/u/.claude/`u{110000}.json" x', 'Set-Content "C:/Users/u/.claude/`u{}.json" x']) assert.equal(psW(c), 'deny', c);
  // a `u{..} line that names nothing protected is judged as before
  assert.equal(psW('Write-Output "caf`u{E9}"'), 'allow');
  assert.equal(psW('Set-Content "C:/repo/`u{61}.txt" x'), 'allow');
  // Bash is untouched
  assert.equal(bashW('echo "C:/Users/u/`u{2E}claude/settings.json"'), 'allow');
});

test('R10: a plain PowerShell read of a protected file is still allowed', () => {
  assert.equal(psW('Get-Content C:/Users/u/.claude/settings.json'), 'allow');
  assert.equal(psW('Get-Content C:\\Users\\u\\.claude\\settings.json | Select-Object -First 3'), 'allow');
  assert.equal(psW('cat C:/Users/u/.claude/settings.json; ls C:/repo'), 'allow');
  assert.equal(psW('Set-Content C:/Users/u/.claude/settings.json x'), 'deny');
});

// R10-F2: a glob in the operand is a part only known at run time too (zsh `**/` matches zero folders), so a trusted tool path holds none.
test('R10-F2: a hooks path with a glob character is not a trusted tool on any platform', () => {
  for (const [platform, home, base] of [['darwin', '/home/u', '/home/u'], ['linux', '/home/u', '/home/u'], ['win32', 'C:\\Users\\u', 'C:/Users/u']]) {
    const go = (command) => evaluateBashForFiles(command, { ...opts, home, platform, cwd: platform === 'win32' ? 'C:\\repo' : '/repo' }).decision;
    const h = `${base}/.claude/pipeline/hooks`;
    const rest = `${base}/.claude/settings.json`;
    assert.equal(go(`node ${h}/**/**/**/../../../tmp/evil.mjs ${rest}`), 'deny', `${platform}: **/`);
    assert.equal(go(`node "${h}/**/**/**/../../../tmp/evil.mjs" ${rest}`), 'deny', `${platform}: quoted **/`);
    for (const g of ['*', '?', '[a]', '{a,b}', '(x)', '#x', '^x']) assert.equal(go(`node ${h}/${g}/../../../tmp/evil.mjs ${rest}`), 'deny', `${platform}: ${g}`);
    for (const g of ['*', '**', '?', '[a-z]']) assert.equal(go(`node ${h}/${g}/../guard-files.mjs ${rest}`), 'deny', `${platform}: ${g} then .. (stays inside hooks lexically)`);
    assert.equal(go(`node ${h}/guard-files.mjs ${rest}`), 'allow', `${platform}: the plain hook stays trusted`);
  }
});

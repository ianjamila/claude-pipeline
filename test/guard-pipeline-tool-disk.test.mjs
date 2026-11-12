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

// R11-F1: `{` and `}` are not plain text: a script block glued to a read-only command (a delay-bind block, a calculated property) runs a write the parser reads as three ordinary words, and a `}#` starts a
// comment PowerShell sees but the guard's lexer does not. The plain test is a character allowlist, so anything not listed is "not plain".
test('R11-F1: a PowerShell script block glued to a read-only command that holds a protected write is refused', () => {
  const S = 'C:/Users/u/.claude/settings.json';
  const lines = [
    `Get-ChildItem C:/repo | Get-Content -Path {Set-Content ${S} x}`,
    `echo a | sort {Set-Content ${S} x}`,
    `diff a b -Property {Set-Content ${S} x}`,
    `echo {a}# '\nSet-Content ${S} x #'`,
    `echo {a}# '\r\nSet-Content ${S} x #'`,
    `Get-Content -Path { Set-Content ${S} x }`, // a spaced block refuses too (fail closed)
    `echo $(Set-Content ${S} x)`,
    `echo a & Set-Content ${S} x`,
    `echo a > ${S}`,
    `echo a * ${S} ?`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
});

test('R11-F1: a PowerShell line with braces that names no protected path and runs in no protected directory is allowed; Bash is unchanged', () => {
  const S = 'C:/Users/u/.claude/settings.json';
  assert.equal(psW('Get-ChildItem C:/repo | sort {$_.Name}'), 'allow');
  assert.equal(psW('echo a | sort {Get-Date}'), 'allow');
  assert.equal(psW('Get-Content -Path {x}'), 'allow');
  assert.equal(psW(`Get-Content ${S}`), 'allow'); // plain read still allowed
  assert.equal(psW(`Get-Content ${S} | Select-Object -First 3`), 'allow');
  // a bare variable name stays plain (the trusted `cd $DEST; node <CLI>` line); `${`, `$(` and `$$` do not
  assert.equal(psW(`cd $DEST; Get-Content ${S}`), 'allow');
  for (const c of [`echo \${a} ; Set-Content ${S} x`, `echo $(a) ; Set-Content ${S} x`, `echo $$ ; Set-Content ${S} x`]) assert.equal(psW(c), 'deny', c);
  // the Bash route is untouched
  assert.equal(bashW(`echo {a} ${S}`), 'allow');
  assert.equal(bashW(`cat ${S} | sort {x}`), 'allow');
  assert.equal(bashW(`echo a | sort {x} ; ls C:/repo`), 'allow');
  assert.equal(bashW(`echo {a}# ' ${S}`), 'allow');
});

// R11-F2: the whole-line refusal must also fire when the raw text does not spell the protected path: a directory in play (cwd or a `cd` target) below ~/.claude, or a relative word that lands in
// a protected file from one of the directories in play (`..\settings.json` after `cd .../plugins`).
test('R11-F2: a PowerShell line that hides a relative write behind a cd below ~/.claude is refused', () => {
  const P = 'C:/Users/u/.claude/plugins';
  const lines = [
    `cd ${P}; echo \u2018 " \u2019 ; Set-Content ../settings.json x ; echo \u2018 " \u2019`,
    `cd ${P}; echo x <# #>; Set-Content ../settings.json x`,
    `cd ${P}; echo @"\n" '\n"@ ; Set-Content ../settings.json x ; echo '' #'`,
    `cd ${P}; echo @'\n" '\n'@ ; Set-Content ../settings.json x`,
    `cd ${P}; cp a b \\; Set-Content ../settings.json x`,
    `cd ${P}; echo a | sort {Set-Content ../settings.json x}`,
    `cd ${P}; echo x <# #>; Set-Content ..\\settings.json x`,
    `cd C:/repo; echo x <# #>; Set-Content C:/Users/u/.claude/plugins/../settings.json x`,
    `cd C:/Users/u/.claude; cd plugins; echo x <# #>; Set-Content ../settings.json x`,
    `cd C:/Users/u; echo x <# #>; Set-Content .claude/settings.json x`,
    `cd C:/Users/u/repo; echo x <# #>; Set-Content ..\\.claude\\settings.json x`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  // the same line run from a cwd below ~/.claude
  const inTree = { ...WIN, shell: 'powershell', cwd: 'C:\\Users\\u\\.claude\\plugins' };
  assert.equal(evaluateBashForFiles('echo x <# #>; Set-Content ../settings.json x', inTree).decision, 'deny');
});

test('R11-F2: the same non-plain lines are allowed when no directory in play is protected and no word reaches a protected file; Bash is unchanged', () => {
  assert.equal(psW('cd C:/repo; echo x <# #>; Set-Content ../out.txt x'), 'deny', 'R14: a directory change and a write on one PowerShell line is refused whatever the target (was allow)');
  assert.equal(psW('echo \u2018 " \u2019 ; Set-Content out.txt x'), 'allow');
  assert.equal(psW('cd C:/repo; echo x <# #>; Get-ChildItem sub'), 'allow');
  // Bash: the same text is judged by the Bash parser only
  assert.equal(bashW('cd C:/Users/u/.claude/plugins; echo x <# #>; ls ../settings.json'), 'allow');
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

// R12-F2: every directory-changing command is a cd to the guard: chdir (a zsh builtin too), Push-Location, Pop-Location and PowerShell's one-word `cd..` / `cd\`.
test('R12-F2: chdir, Push-Location, Pop-Location and cd.. / cd\\ move the directory the later relative write is judged from', () => {
  const P = 'C:/Users/u/.claude/plugins';
  const lines = [
    `Push-Location ${P}; Set-Content ../settings.json x`,
    `PUSHD ${P}; Set-Content ../settings.json x`,
    `Push-Location -Path ${P}; Set-Content ../settings.json x`,
    `chdir ${P}; Set-Content ../settings.json x`,
    'Pop-Location; echo x > ../settings.json', // (the directory popped to is only known at run time, like popd's)
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  const fromRepoUnderHome = { ...WIN, shell: 'powershell', cwd: 'C:\\Users\\u\\repo' };
  assert.equal(evaluateBashForFiles('cd..; Set-Content .claude/settings.json x', fromRepoUnderHome).decision, 'deny', 'cd.. from C:/Users/u/repo');
  assert.equal(evaluateBashForFiles('cd ..; Set-Content .claude/settings.json x', fromRepoUnderHome).decision, 'deny', 'cd .. (the spaced form)');
  assert.equal(evaluateBashForFiles('CD..; Set-Content .claude/settings.json x', fromRepoUnderHome).decision, 'deny', 'CD..');
  assert.equal(evaluateBashForFiles('cd\\; Set-Content Users/u/.claude/settings.json x', fromRepoUnderHome).decision, 'deny', 'cd\\ (the drive root)');
  // darwin Bash: chdir is a zsh builtin
  assert.equal(run('chdir ~/.claude/plugins; echo x > ../settings.json'), 'deny');
  assert.equal(run(`chdir ${HOME}/.claude/plugins; echo x > ../settings.json`), 'deny');
  // unrelated directories stay allowed
  assert.equal(psW('Push-Location C:/repo; Set-Content ../out.txt x'), 'deny', 'R14: a directory change and a write on one PowerShell line is refused whatever the target (was allow)');
  assert.equal(psW('chdir C:/repo; Set-Content out.txt x'), 'deny', 'R14: a directory change and a write on one PowerShell line is refused whatever the target (was allow)');
  assert.equal(run('chdir /repo/sub; echo x > ../out.txt'), 'allow');
});

// R12-F1: on a non-plain PowerShell line the parsed cd list is not the one PowerShell runs (a quote the Bash parser opens swallows a real cd).
test('R12-F1: a PowerShell cd hidden in text the guard parses as one quoted word is refused', () => {
  const Q = '\u2018 " \u2019';
  const lines = [
    `echo ${Q} ; cd C:/Users/u/.claude/plugins ; Set-Content ../settings.json x ; echo ${Q}`,
    `echo <# ' #> ; cd C:/Users/u/.claude/plugins ; Set-Content ../settings.json x ; echo <# ' #>`,
    `echo ${Q} ; cd C:/Users/u ; Set-Content .claude/settings.json x ; echo ${Q}`,
    `echo ${Q} ; chdir C:/Users/u ; Set-Content .claude/settings.json x ; echo ${Q}`,
    `echo ${Q} ; SL C:/Users/u ; Set-Content .claude/settings.json x ; echo ${Q}`,
    `echo ${Q} ; cd.. ; Set-Content .claude/settings.json x ; echo ${Q}`,
    `echo ${Q} ; c\`d C:/Users/u ; Set-Content .claude/settings.json x ; echo ${Q}`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  assert.equal(psW(`echo ${Q} ; Set-Content out.txt x`), 'allow');
});

// R12-F3: the trusted pipeline CLI keeps working under PowerShell; the refusal names the character that caused it.
test('R12-F3: trusted pipeline CLI lines with ~, 2>&1, a redirection to a plain file and && are plain under PowerShell', () => {
  const CLI = 'C:/Users/u/.claude/pipeline/bin/pipeline.mjs';
  // R13-F3 reverses the former `allow` here: a native command (node) gets `~` literally under PowerShell, so a tilde operand is no longer a trusted tool path (see the R13-F3 test)
  assert.equal(psW('node ~/.claude/pipeline/bin/pipeline.mjs preflight'), 'deny');
  assert.equal(psW(`node ${CLI} merge --pr 12 2>&1`), 'allow');
  assert.equal(psW(`node ${CLI} merge --pr 12 > out.txt`), 'allow');
  assert.equal(psW(`node ${CLI} merge --pr 12 >> out.txt`), 'allow');
  assert.equal(psW(`node ${CLI} merge --pr 12 2> err.txt`), 'allow');
  assert.equal(psW(`node ${CLI} preflight && node ${CLI} config`), 'allow');
  assert.equal(psW(`node ${CLI} preflight || node ${CLI} config`), 'allow');
  assert.equal(psW('Get-Content ~/.claude/settings.json'), 'allow');
  assert.equal(psW('Get-Content ~\\.claude\\settings.json'), 'allow');
  // still refused: a write, a lone & (the call operator), a redirection to a protected file or to a non-plain target
  assert.equal(psW('Set-Content ~/.claude/settings.json x'), 'deny');
  assert.equal(psW(`node ${CLI} preflight & Set-Content C:/Users/u/.claude/settings.json x`), 'deny');
  assert.equal(psW('Get-Content C:/Users/u/.claude/settings.json > C:/Users/u/.claude/settings.json'), 'deny');
  assert.equal(psW(`node ${CLI} preflight > $x`), 'deny');
  assert.equal(psW(`node ${CLI} preflight > ~/.claude/settings.json`), 'deny');
  assert.equal(psW(`node ${CLI} merge --pr 12 2>&1 & Set-Content ${CLI} x`), 'deny');
});

test('R12-F3: the PowerShell refusal names the first offending character, a directory change it could not read, or the folder below ~/.claude', () => {
  const CLI = 'C:/Users/u/.claude/pipeline/bin/pipeline.mjs';
  const why = (c) => evaluateBashForFiles(c, { ...WIN, shell: 'powershell' });
  const paren = why(`node ${CLI} merge --pr 12 --body "fixed (see #45)"`);
  assert.equal(paren.decision, 'deny');
  assert.match(paren.reason, /`\(`/, paren.reason);
  assert.doesNotMatch(paren.reason, /typographic quote, a backtick/, 'the stale list of causes is gone');
  const hidden = why(`echo \u2018 " \u2019 ; cd C:/Users/u ; Set-Content .claude/settings.json x ; echo \u2018 " \u2019`);
  assert.equal(hidden.decision, 'deny');
  assert.match(hidden.reason, /a directory change the guard could not read/, hidden.reason);
  const below = why('cd C:/Users/u/.claude/plugins; echo x <# #>; Get-ChildItem sub');
  assert.equal(below.decision, 'deny');
  assert.match(below.reason, /runs in a folder below ~\/\.claude/, below.reason);
});

// R13 (push security review): a hidden directory change is refused outright on a not-plain PowerShell line, a location cmdlet with parameters is an unknown cd, and a tilde tool path is not trusted.
test('R13-F1: a not-plain PowerShell line holding a directory-change word the guard cannot account for is refused (module-qualified, .NET, decoys)', () => {
  const Q = '\u2018 " \u2019';
  const P = 'C:/Users/u/.claude/plugins';
  const lines = [
    `echo ${Q} ; Microsoft.PowerShell.Management\\Set-Location ${P} ; Set-Content ../settings.json x ; echo ${Q}`,
    `echo ${Q} ; Microsoft.PowerShell.Management\\Push-Location ${P} ; Set-Content ../settings.json x ; echo ${Q}`,
    `echo ${Q} ; [IO.Directory]::SetCurrentDirectory('${P}') ; Set-Content ../settings.json x ; echo ${Q}`,
    `echo ${Q} ; [Environment]::CurrentDirectory = '${P}' ; Set-Content ../settings.json x ; echo ${Q}`,
    `echo ${Q} ; [system.io.directory]::setcurrentdirectory('${P}') ; Set-Content ../settings.json x ; echo ${Q}`,
    // a decoy cd the parser reads as a command, so the old count matched: the real one hides in a quote the parser swallows
    `cd C:/repo ; echo ${Q} ; cd ${P} ; Set-Content ../settings.json x ; echo ${Q}`,
    `cd C:/repo ; echo <# ' #> ; Microsoft.PowerShell.Management\\Set-Location ${P} ; Set-Content ../settings.json x ; echo <# ' #>`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  const why = evaluateBashForFiles(lines[0], { ...WIN, shell: 'powershell' });
  assert.match(why.reason, /a directory change the guard could not read/, why.reason);
});

test('R13-F2: a PowerShell location cmdlet with a parameter is an unknown cd, not a guessed target', () => {
  const lines = [
    'Set-Location -Path:C:/Users/u/.claude/plugins; Set-Content ../settings.json x',
    'Push-Location -StackName s C:/Users/u/.claude/plugins; Set-Content ../settings.json x',
    'Set-Location -LiteralPath C:/Users/u/.claude/plugins; Set-Content ../settings.json x',
    'Set-Location -Pa C:/Users/u/.claude/plugins; Set-Content ../settings.json x',
    'sl -Path:C:/Users/u/.claude/plugins; Set-Content ../settings.json x',
    'Push-Location -PassThru -StackName s C:/Users/u/.claude/plugins; Set-Content ../settings.json x',
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  // a harmless switch alone keeps the target readable; no protected folder is involved
  assert.equal(psW('Set-Location -PassThru C:/repo; Set-Content ../out.txt x'), 'deny', 'R14: a directory change and a write on one PowerShell line is refused whatever the target (was allow)');
});

test('R13-F3: under PowerShell a tilde operand is not a trusted tool path (a native command gets `~` literally); Bash keeps it', () => {
  // `node ~/...` can run <cwd>/~/.claude/pipeline/bin/pipeline.mjs, an agent-writable look-alike, so it is NOT trusted: the line names a protected path and the command is not read-only.
  assert.equal(psW('node ~/.claude/pipeline/bin/pipeline.mjs preflight'), 'deny');
  assert.equal(psW("node '~/.claude/pipeline/bin/pipeline.mjs' preflight"), 'deny');
  assert.equal(psW('node "~/.claude/pipeline/bin/pipeline.mjs" preflight'), 'deny');
  // a tilde after a quote is literal in PowerShell, so the line is not plain
  assert.equal(psW("Get-Content '~/.claude/settings.json'"), 'deny');
  // the cmdlet read of the same file stays allowed (a cmdlet expands ~ to the home)
  assert.equal(psW('Get-Content ~/.claude/settings.json'), 'allow');
  // Bash / zsh route: unchanged
  assert.equal(bashW('node ~/.claude/pipeline/bin/pipeline.mjs preflight'), 'allow');
  assert.equal(run('node ~/.claude/pipeline/bin/pipeline.mjs preflight'), 'allow');
});

// R14 (push security review of b67aa0f): after a directory only known at run time, on the PowerShell route ANY command that is not read-only may write the unknown folder, and every line is scanned for directory changes.
test('R14-F1/F2: after an unknown PowerShell directory every non-read-only command is a possible write there; reads stay allowed', () => {
  const U = 'Set-Location -Path:C:/Users/u/.claude/plugins';
  const lines = [
    `${U}; Set-Content -Path:../settings.json x`,
    `${U}; Set-Content -LiteralPath:../settings.json x`,
    `${U}; Set-Content -FilePath ../settings.json x`,
    `${U}; Invoke-WebRequest http://x -OutFile ../settings.json`,
    `${U}; iwr http://x -OutFile ../settings.json`,
    `${U}; Copy-Item a ../settings.json`,
    `${U}; Move-Item a ../settings.json`,
    `${U}; Rename-Item a ../settings.json`,
    `${U}; Export-Csv -Path ../settings.json`,
    `${U}; Expand-Archive a.zip -DestinationPath ../x`,
    `${U}; Start-Transcript -Path ../settings.json`,
    `${U}; Set-ItemProperty -Path ../settings.json -Name x -Value y`,
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  assert.equal(psW('Set-Location -Path:C:/repo; Get-Content ../x.txt'), 'allow', 'a read after an unknown cd stays allowed');
  assert.equal(psW(`${U}; Get-ChildItem ../x`), 'allow');
});

test('R14-F3: every PowerShell line is scanned for directory changes (module-qualified, .NET); a plain cd and a file called cd.txt are not tripped', () => {
  const P = 'C:/Users/u/.claude/plugins';
  const lines = [
    `Microsoft.PowerShell.Management\\Set-Location ${P}; Set-Content ../settings.json x`,
    `Microsoft.PowerShell.Management\\Push-Location ${P}; Set-Content ../settings.json x`,
    `[System.IO.Directory]::SetCurrentDirectory('${P}'); Set-Content ../settings.json x`,
    `iex 'cd ${P}'; Set-Content ../settings.json x`,
    // the folder is only named at run time, so the line spells no protected path: only the cd scan can refuse it
    'Microsoft.PowerShell.Management\\Set-Location $env:CLAUDE_CONFIG_DIR; Set-Content settings.json x',
    'Microsoft.PowerShell.Management\\Push-Location $env:CLAUDE_CONFIG_DIR; Add-Content -Path:settings.json x',
    "iex 'cd $env:CLAUDE_CONFIG_DIR'; Set-Content settings.json x",
    'Microsoft.PowerShell.Management\\Set-Location $env:CLAUDE_CONFIG_DIR; Set-Content out.txt x',
    'Microsoft.PowerShell.Management\\Set-Location $env:CLAUDE_CONFIG_DIR; Invoke-WebRequest http://x -OutFile out.txt',
    "iex 'cd $env:CLAUDE_CONFIG_DIR'; Set-Content out.txt x",
    // a directory change the parse does not read as a cd command (run from a string): the folder is unknown, so a non-read-only command is refused
    "iex 'cd C:/other'; Set-Content out.txt x",
    'Invoke-Expression "Set-Location C:/other"; Invoke-WebRequest http://x -OutFile out.txt',
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  assert.equal(psW('cd C:/repo; Set-Content out.txt x'), 'deny', 'R14: a directory change and a write on one PowerShell line is refused whatever the target (was allow)');
  assert.equal(psW('Get-Content cd.txt'), 'allow');
  assert.equal(psW('Set-Content cd.txt x'), 'allow', 'cd.txt is a file name, not a directory change');
  assert.equal(psW('Set-Content out.cd x'), 'allow');
});

// R13 round-13 review: the raw-text cd reading adds to the parsed operand (never replaces it) and only where a backslash is a separator; a redirection to a backslash target keeps the line not plain;
// a location command fed by the pipeline or without an operand, and a drive function (`C:`), are unknown cds under PowerShell.
test('R13-B1/F2: a backslash path after a cd option (-PassThru, -P) is read, quoted or not; an escape off Windows keeps the parsed target', () => {
  const Q = 'C:\\Users\\u\\.claude\\plugins';
  assert.equal(psW(`Set-Location -PassThru '${Q}'; Set-Content ../settings.json x`), 'deny', 'PowerShell, quoted');
  assert.equal(psW(`Set-Location -PassThru ${Q}; Set-Content ../settings.json x`), 'deny', 'PowerShell, unquoted');
  assert.equal(bashW(`cd -P '${Q}'; echo x > ../settings.json`), 'deny', 'Git Bash on win32, quoted');
  assert.equal(run('cd ~/.claude/skil\\ls; echo x > ../settings.json'), 'deny', 'darwin: the backslash is an escape, the directory is ~/.claude/skills');
  assert.equal(evaluateBashForFiles('cd ~/.claude/skil\\ls; echo x > ../settings.json', { ...opts, platform: 'linux' }).decision, 'deny', 'linux');
  // unrelated directories stay allowed
  assert.equal(psW("Set-Location -PassThru 'C:\\repo\\sub'; Set-Content ../out.txt x"), 'deny', 'R14: a directory change and a write on one PowerShell line is refused whatever the target (was allow)');
  assert.equal(bashW("cd -P 'C:\\repo\\sub'; echo x > ../out.txt"), 'allow');
});

test('R13-F1: a PowerShell redirection to an unquoted backslash target is judged (the line is not plain)', () => {
  assert.equal(psW('echo x > C:\\Users\\u\\.claude\\settings.json'), 'deny');
  assert.equal(psW('echo x >> C:\\Users\\u\\.claude\\settings.json'), 'deny');
  assert.equal(psW('echo x 2> C:\\Users\\u\\.claude\\settings.json'), 'deny');
  assert.equal(psW('cd C:/Users/u; echo x > .claude\\settings.json'), 'deny');
  assert.equal(psW('echo x > "C:\\Users\\u\\.claude\\settings.json"'), 'deny', 'quoted, as before');
  // the existing allowed forms stay allowed
  assert.equal(psW('echo x > out.txt'), 'allow');
  assert.equal(psW('echo x > C:/repo/out.txt'), 'allow');
});

test('R13-F3: a PowerShell location command fed by the pipeline, or without an operand, is an unknown cd; Bash `cd` still means home', () => {
  const lines = [
    'echo C:/Users/u | Set-Location; Set-Content .claude/settings.json x',
    'echo C:/Users/u | sl; Set-Content .claude/settings.json x',
    'echo C:/Users/u | chdir; Set-Content .claude/settings.json x',
    'echo C:/Users/u | Push-Location; Set-Content .claude/settings.json x',
    'echo C:/Users/u/.claude | cd; Set-Content settings.json x',
    'Set-Location; Set-Content .claude/settings.json x',
  ];
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  assert.equal(psW('Set-Location C:/repo; Set-Content out.txt x'), 'deny', 'R14: a directory change and a write on one PowerShell line is refused whatever the target (was allow)');
  assert.equal(run('cd; echo x > .claude/settings.json'), 'deny', 'Bash: a bare cd is the home');
  assert.equal(run('cd /repo; echo x > out.txt'), 'allow');
});

test('R13-F4: a PowerShell drive function (`C:`) is an unknown cd', () => {
  const fromD = { ...WIN, shell: 'powershell', cwd: 'D:\\repo' };
  assert.equal(evaluateBashForFiles('C:; Set-Content Users/u/.claude/settings.json x', fromD).decision, 'deny');
  assert.equal(evaluateBashForFiles('c:; Set-Content Users/u/.claude/settings.json x', fromD).decision, 'deny');
  assert.equal(evaluateBashForFiles('D:; Set-Content out.txt x', fromD).decision, 'deny', 'any drive function: the folder it lands in is unknown');
  assert.equal(evaluateBashForFiles('Set-Content out.txt x', fromD).decision, 'allow');
});

// R14 round-14 review (owner's choice: ONE fail-closed rule on the PowerShell route instead of four point patches):
//  1. a line that changes the directory (a cd word anywhere in the text, quoted or run from a string, or a drive word `C:`) AND holds a command that is not read-only (or a redirection) is refused, whatever the target;
//  2. a whitespace-delimited word holding both a backslash and a quote (unless it is one fully quoted run) on a line with a non-read-only command or a redirection is refused.
// A line of read-only commands, and a lone directory change, stay allowed.
const DENY_CD = /a directory change and a write cannot share one command line/;
const DENY_MIX = /a word that mixes a backslash and a quote cannot be read safely/;
const psWhy = (command, extra = {}) => evaluateBashForFiles(command, { ...WIN, shell: 'powershell', ...extra });

test('R14-B1: a trailing switch after a cd operand (-PassThru) cannot hide the real directory from a write on the same line', () => {
  const lines = [
    'Set-Location C:\\Users\\u\\.claude -PassThru; Set-Content settings.json x',
    'Set-Location ..\\Users\\u\\.claude\\pipeline -PassThru; Set-Content hooks/guard-files.mjs x',
    'cd ..\\Users\\u\\.claude\\pipeline -PassThru; Set-Content hooks/guard-files.mjs x',
  ];
  for (const c of lines) {
    const r = psWhy(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, DENY_CD, r.reason);
  }
});

test('R14-F1: a trailing redirection after a cd operand (> f, 2> f, 2>&1) cannot hide the real directory from a write on the same line', () => {
  const lines = [
    'Set-Location ..\\Users\\u\\.claude\\pipeline > out.txt; Set-Content hooks/guard-files.mjs x',
    'Set-Location ..\\Users\\u\\.claude\\pipeline 2> e.txt; Set-Content hooks/guard-files.mjs x',
    'Set-Location ..\\Users\\u\\.claude\\pipeline 2>&1; Set-Content hooks/guard-files.mjs x',
    'Set-Location ..\\Users\\u\\.claude\\pipeline >> out.txt; Set-Content hooks/guard-files.mjs x',
  ];
  for (const c of lines) {
    const r = psWhy(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, DENY_CD, r.reason);
  }
});

test('R14-F2: a drive function run through iex / dot-source (not as the first word of a command) is a directory change too', () => {
  const fromD = { cwd: 'D:\\repo' };
  const lines = [
    "iex 'C:'; Set-Content Users/u/.claude/settings.json x",
    'iex C:; Set-Content Users/u/.claude/settings.json x',
    '. C:; Set-Content Users/u/.claude/settings.json x',
    'Invoke-Expression "C:"; Set-Content Users/u/.claude/settings.json x',
  ];
  for (const c of lines) {
    const r = psWhy(c, fromD);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, DENY_CD, r.reason);
  }
  // a path that merely starts with a drive letter is not a drive word
  assert.equal(psWhy('Set-Content C:/repo/out.txt x', fromD).decision, 'allow');
  assert.equal(psWhy('Set-Content C:\\repo\\out.txt x', fromD).decision, 'allow');
  assert.equal(psWhy('Set-Content out.txt c:x', fromD).decision, 'allow');
});

test('R14-F3: a word holding a backslash and an inner quote (.cl"aude"\\settings.json) on a line that writes is refused, as a redirection target, a cd operand and a plain operand', () => {
  const lines = [
    'cd C:/Users/u; echo x > .cl"aude"\\settings.json',
    'echo x > ..\\Users\\u\\.cl"aude"\\settings.json',
    'Set-Location ..\\Users\\u\\.cl"aude"\\pipeline; Set-Content hooks/guard-files.mjs x',
    'Set-Content ..\\Users\\u\\.cl"aude"\\settings.json x',
    "Set-Content ..\\Users\\u\\.cl'aude'\\settings.json x",
  ];
  for (const c of lines) {
    const r = psWhy(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, c.startsWith('Set-Location') || c.startsWith('cd ') ? /a directory change and a write|mixes a backslash and a quote/ : DENY_MIX, r.reason);
  }
  assert.match(psWhy('Set-Content ..\\Users\\u\\.cl"aude"\\settings.json x').reason, DENY_MIX);
  // a whole-word quoted path is one fully quoted run (spaces included), and a line of reads is untouched
  assert.equal(psW("Set-Content 'C:\\repo\\a b.txt' x"), 'allow');
  assert.equal(psW('Set-Content "C:\\repo\\out.txt" x'), 'allow');
  assert.equal(psW('Get-Content ..\\Users\\u\\.cl"aude"\\settings.json'), 'allow', 'read-only commands only: the rule does not apply');
});

test('R14 one rule: a directory change plus a write on one PowerShell line is refused whatever the target; reads and a lone directory change stay allowed', () => {
  for (const c of ['cd C:/repo; Set-Content out.txt x', "Set-Location -PassThru 'C:\\repo\\sub'; Set-Content ../out.txt x", 'cd C:/repo; echo x > out.txt', "iex 'cd C:/repo'; Set-Content out.txt x"]) {
    const r = psWhy(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, DENY_CD, r.reason);
  }
  for (const c of ['Set-Location C:/repo/sub; Get-ChildItem', 'cd ..; ls', 'Set-Location C:/repo/sub', 'Set-Location -PassThru C:/repo', 'Get-Content cd.txt', 'Set-Content cd.txt x']) {
    assert.equal(psW(c), 'allow', JSON.stringify(c));
  }
  // the trusted pipeline CLI after a cd still runs (it is read-only to the guard)
  assert.equal(psW(`cd C:/repo; node C:\\Users\\u\\.claude\\pipeline\\bin\\pipeline.mjs preflight`), 'allow');
  // Bash route unchanged
  assert.equal(bashW('cd C:/repo; echo x > out.txt'), 'allow');
});

// R15 round-15 review: the entry condition of the R14 rule (`writes`) must not trust the guard's own parse on a line PowerShell reads differently (psUnparsed): there a line counts as writing
// unless its raw text is provably read-only.
test('R15-B1: a backslash before the separator (the Bash parse folds the rest of the line into the cd operand) cannot hide the write from the directory-change rule', () => {
  const lines = [
    'Set-Location ..\\Users\\u\\.cl"aude"\\pipeline\\; Set-Content hooks/guard-files.mjs x',
    'cd ..\\Users\\u\\.cl"aude"\\pipeline\\; Set-Content hooks/guard-files.mjs x',
    'Set-Location C:/repo\\; Set-Content out.txt x',
  ];
  for (const c of lines) {
    const r = psWhy(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, DENY_CD, r.reason);
  }
  // a read-only tail after such a separator stays allowed (nothing writes)
  assert.equal(psW('Set-Location C:/repo\\; Get-ChildItem'), 'allow');
});

test('R15-F1: a # inside a typographic-quoted string (a comment to the guard, text to PowerShell) cannot hide the write from the R14 refusals', () => {
  const cdLines = [
    'Set-Location ..\\Users\\u\\.cl"aude"\\pipeline; echo \u2018a #b\u2019; Set-Content hooks/guard-files.mjs x',
    'cd C:/repo; echo \u201C#x\u201D; Set-Content out.txt x',
    'Set-Location C:/repo; echo \u2018a #b\u2019; Set-Content out.txt x',
  ];
  for (const c of cdLines) {
    const r = psWhy(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, DENY_CD, r.reason);
  }
  const mixLines = [
    'echo \u201C#x\u201D; Set-Content ..\\Users\\u\\.cl"aude"\\settings.json x',
    'echo \u2018a #b\u2019; Set-Content ..\\Users\\u\\.cl\'aude\'\\settings.json x',
  ];
  for (const c of mixLines) {
    const r = psWhy(c);
    assert.equal(r.decision, 'deny', JSON.stringify(c));
    assert.match(r.reason, DENY_MIX, r.reason);
  }
  // reads on such a line stay allowed
  assert.equal(psW('Set-Location C:/repo/sub; echo \u2018a #b\u2019; Get-ChildItem'), 'allow');
  assert.equal(psW('echo \u201C#x\u201D; Get-Content ..\\Users\\u\\.cl"aude"\\settings.json'), 'allow');
  // Bash route unchanged
  assert.equal(bashW('cd C:/repo; echo \u2018a #b\u2019; echo y > out.txt'), 'allow');
});

// R15 push security review on c3919bf: a quoted `<#` and `#>` must not let the block-comment cut swallow a write between them; block comments are cut only from text with no quote character at all.
test('R15 push review: a quoted <# ... #> pair hides a write', () => {
  const q = ['\u2018', '\u2019', '\u201C', '\u201D', "'", '"', '\u201A', '\u201E'];
  const lines = [];
  for (const a of q) {
    for (const b of q) {
      lines.push(`cd C:/x; echo ${a}<#${b}; Set-Content ..\\Users\\u\\.cl"aude"\\settings.json x; echo ${a}#>${b}`);
      lines.push(`echo ${a}<#${b}; Set-Content ..\\Users\\u\\.cl'aude'\\settings.json x; echo ${a}#>${b}`);
    }
  }
  lines.push('cd C:/x; echo `<#`; Set-Content ..\\Users\\u\\.cl"aude"\\settings.json x; echo `#>`');
  for (const c of lines) assert.equal(psW(c), 'deny', JSON.stringify(c));
  // an unquoted terminated block comment on a line of reads/plain writes is still cut and allowed (R11-F2)
  assert.equal(psW('cd C:/repo; echo x <# #>; Get-ChildItem sub'), 'allow');
});

// Why: some commands run a string or a program text that the shell parser cannot unwrap (`node -e`, `python -c`,
// `perl -e`, `osascript -e`, a build tool's `--cmd`, or a script FILE written in another language). For those
// the guard falls back to looking for the guarded command strings themselves: a git push to main or a force push,
// an admin merge, an approval label being added, a guard label being removed, `protect --apply`, `disableAllHooks`.
// A text scan stops accidents and casual circumvention, not an author who builds the command at run time.
import { commandName } from './shell-parse.mjs';

const APPROVAL = /human-approved|test-change-approved/i;
const GUARD = /needs-human|pipeline-blocked|awaiting-review|pipeline-pause|pipeline-rollback/i;
const FORCE_FLAGS = /(?:^|\s)(?:\+\S+|-f|--force\S*|--all|--mirror|--delete)(?=\s|$)/i;
const PROTECTED_DEST = /(?:^|[\s:+])(?:refs\/heads\/)?(?:main|master)(?=\s|$)/i;

// Readers and tools whose arguments are data, not commands; judged by their own rules or not at all.
export const CATCH_ALL_EXEMPT = new Set([
  'git', 'gh', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'less', 'more', 'bat', 'ls', 'wc',
  'diff', 'cmp', 'stat', 'file', 'cd', 'pushd', 'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'true', 'false', ':', 'test', '[',
]);

// Flags whose value is a message, a title or a test name: prose that may quote a command without running it.
const MESSAGE_FLAGS = new Set(['-m', '--message', '--body', '--title', '-t', '--grep', '--notes', '-b', '-F', '--description', '--subject', '--reason', '-n', '-d', '-g', '--testNamePattern', '--test-name-pattern']);

// One command-like segment of `text` with quotes, brackets and commas turned into spaces, so the array spelling
// \`spawnSync('git', ['push', 'origin', 'main'])\` reads like \`git push origin main\`.
const segmentsOf = (text) => String(text).split(/[\n;&|]+/).map((seg) => seg.replace(/["'`[\](){},\\]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);

// The reason `text` (an argument, or a script file's content) contains a guarded command, or null.
export function guardedCommandText(text) {
  const t = String(text ?? '');
  if (!t) return null;
  if (t.includes('disableAllHooks')) return 'it mentions disableAllHooks, which would switch the pipeline hooks off';
  for (const seg of segmentsOf(t)) {
    const push = /(?:^|[\s=])git(?:\s+-\S+(?:\s+\S+)?)*\s+push(?=\s|$)(.*)$/i.exec(seg);
    if (push && (FORCE_FLAGS.test(push[1]) || PROTECTED_DEST.test(push[1]))) return 'it runs a git push to main/master or a force push';
    if (/(?:^|[\s=])gh(?:\s+-\S+(?:\s+\S+)?)*\s+pr\s+merge(?=\s|$).*--admin\b/i.test(seg)) return 'it runs `gh pr merge --admin`';
    if (APPROVAL.test(seg) && /(?:--add-label|--label|\s-l\s|\blabels?\b|\bgh\b)/i.test(seg)) return 'it adds an owner-only approval label';
    if (GUARD.test(seg) && /(?:--remove-label|\bDELETE\b|-X\s*DELETE|\bremoveLabel)/i.test(seg)) return 'it removes a guard label';
    if (/\bprotect\b.*--apply\b/i.test(seg)) return 'it runs `pipeline protect --apply`';
  }
  return null;
}

// The words of `argv` that are not the value of a message-like flag.
export function dataLessArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.split('=')[0];
    if (MESSAGE_FLAGS.has(name)) { if (!a.includes('=')) i++; continue; }
    if (/^-[mtFbn].+/.test(a) && !a.startsWith('--') && MESSAGE_FLAGS.has(a.slice(0, 2))) continue; // -m"text", -tpattern
    out.push(a);
  }
  return out;
}

// Catch-all for any command that is not exempt: does one of its arguments (unquoted by the parser) contain a guarded command?
export function catchAllReason(argv) {
  if (!argv.length || CATCH_ALL_EXEMPT.has(commandName(argv[0]))) return null;
  const args = dataLessArgs(argv.slice(1));
  for (const a of [...args, args.join(' ')]) {
    if (a.length < 8) continue;
    const r = guardedCommandText(a);
    if (r) return r;
  }
  return null;
}

// PR comments rendered from the review state. Pure string builders: no IO, no clock. Each comment
// starts with an HTML-comment marker so the pipeline can find and update its own comment in place.
//
// Anything that came from a model, the diff or a report (titles, reasons, excerpts, URLs, exit codes)
// is untrusted text. Every such value goes through defuse(): "<!--" and "-->" become entities so a
// finding can never forge or close a marker the pipeline looks for, and "@" becomes the fullwidth
// commercial at (U+FF20) so it can never notify anyone (it looks the same, also inside code).
// Single-line values are flattened, and pipes in table cells become &#124;.
import { encodeForComment } from './state.mjs';
import { skipOf } from './verify-steps.mjs';

export const MARKERS = {
  triage: '<!-- claude-pipeline:triage -->',
  summary: '<!-- claude-pipeline:summary -->',
  needsHuman: '<!-- claude-pipeline:needs-human -->',
  blocked: '<!-- claude-pipeline:blocked -->',
  awaitingReview: '<!-- claude-pipeline:awaiting-review -->',
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- text hygiene ---------------------------------------------------------------------------

export const defuse = (s) => s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').replace(/@/g, '\uFF20');
export const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const clip = (s, max) => {
  const chars = Array.from(s); // by code point, so an emoji is never cut in half
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s;
};
// One line of prose for a list item.
export const line = (s, max = Infinity) => defuse(clip(flat(s), max));
// One markdown table cell.
export const cell = (s, max = Infinity) => line(s, max).replace(/\|/g, '&#124;');

// ---- triage comment -------------------------------------------------------------------------

const TRIAGE_HEADER = '| Round | ID | Bucket | Finding | Decision | By | Conf. | Reason |';

// An owner ruling shows the owner's own words (the cell is longer than the usual 120 so the quote is not cut off).
const OWNER_REASON_MAX = 360;
const ownerReason = (final) => (typeof final?.ownerQuote === 'string' && final.ownerQuote !== ''
  ? `owner (chat): ${final.ownerQuote}${final.reason ? ` — ${final.reason}` : ''}`
  : null);

function triageRow(n, item) {
  const { final, judge, arbiter } = item;
  let decision = 'pending';
  if (final) decision = `${final.decision ?? 'unknown'}${final.needsHuman ? ' (needs human)' : ''}`;
  else if (judge) decision = `${judge.decision} (pending)`;
  const by = final?.by ?? '—';
  const conf = arbiter?.confidence ?? judge?.confidence ?? '—';
  const reason = ownerReason(final) ?? final?.reason ?? judge?.reason ?? '';
  const finding = item.title || item.file || '';
  return `| ${cell(n)} | ${cell(item.id)} | ${cell(item.bucket)} | ${cell(finding, 80)} | ${cell(decision)} | ${cell(by)} | ${cell(conf)} | ${cell(reason, final?.ownerQuote ? OWNER_REASON_MAX : 120)} |`;
}

export function triageComment(state) {
  const rounds = state.rounds ?? [];
  const rows = rounds.flatMap((r) => (r.items ?? []).map((item) => triageRow(r.n, item)));
  const out = [MARKERS.triage, '', '### Pipeline review triage', '', TRIAGE_HEADER, '|---|---|---|---|---|---|---|---|', ...rows];
  if (rounds.length === 0) out.push('', '_No review rounds recorded yet._');
  else if (rows.length === 0) out.push('', '_Codex raised no findings._');
  out.push('', encodeForComment(state));
  return out.join('\n');
}

// ---- summary comment ------------------------------------------------------------------------

function entriesOf(state) {
  return (state.rounds ?? []).flatMap((r) => (r.items ?? []).map((item) => ({ item, n: item.round ?? r.n })));
}

// The same finding can come back in a later round with the same fingerprint (reused from the
// cache); list it once, at its first appearance.
function unique(entries) {
  const seen = new Set();
  return entries.filter(({ item }) => {
    const key = item.fingerprint || item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findingLabel(item) {
  const where = item.file ? ` (${line(item.file)}${item.line ? `:${line(item.line)}` : ''})` : '';
  return `**${line(item.id)}** ${line(item.title, 100)}${where}`;
}

const codexView = (item) =>
  `Codex: ${line(item.bucket)}${item.category ? ` (${line(item.category)})` : ''} — ${line(item.codexReasoning || item.detail, 200)}`;
const opusView = (item) => (item.judge ? `Opus: ${line(item.judge.decision)} (${line(item.judge.reason)})` : 'Opus: not triaged');

function fmtModels(p) {
  const m = p.models;
  if (typeof m === 'string') return line(m);
  if (Array.isArray(m)) return m.map((x) => (isObject(x) ? `${line(x.model)}×${line(x.count)}` : line(x))).join(', ');
  if (isObject(m)) return Object.entries(m).map(([model, count]) => `${line(model)}×${line(count)}`).join(', ');
  if (p.model) return p.count != null ? `${line(p.model)}×${line(p.count)}` : line(p.model);
  return 'unknown';
}

function outliersSection(entries, modelProofs) {
  const out = [];
  const arbitrated = entries.filter(({ item }) => item.arbiter);
  for (const { item } of unique(arbitrated)) {
    const a = item.arbiter;
    out.push(`- ${findingLabel(item)} · ${codexView(item)} · ${opusView(item)} · Fable: ${line(a.ruling)} (${line(a.confidence)}) — ${line(a.reasoning)}`);
  }
  for (const { item } of unique(entries.filter(({ item: i }) => !i.arbiter && i.judge))) {
    const j = item.judge;
    const decision = item.final?.decision ?? j.decision;
    const strong = item.bucket === 'BLOCKING' && (j.decision === 'REJECT' || j.decision === 'FOLLOW-UP');
    const closeCall = item.final?.by !== 'test' && decision === 'REJECT' && j.confidence !== 'high';
    if (!strong && !closeCall) continue;
    const settled = item.final ? `final: ${line(item.final.decision ?? 'unknown')} by ${line(item.final.by)}` : 'final: pending';
    out.push(`- ${findingLabel(item)} · ${codexView(item)} · ${opusView(item)} · ${settled} _(${strong ? 'strong disagreement' : 'close call'})_`);
  }
  for (const { item } of unique(entries.filter(({ item: i }) => i.final?.ownerQuote))) {
    out.push(`- ${findingLabel(item)} · Owner (chat): ${line(item.final.decision)} — "${line(item.final.ownerQuote, 300)}"`);
  }
  for (const p of modelProofs) {
    out.push(`- Fable proof: ${line(p.transcript)}, models ${fmtModels(p)}, effort ${line(p.effort ?? 'high')}`);
  }
  return out.length ? out.join('\n') : '_None_';
}

// A follow-up becomes a link only when the URL is plainly a github.com one (no spaces, brackets,
// parentheses, angle brackets or "@" that could end the link early or smuggle in another). Anything
// else is shown as defused plain text, never as a link.
const GITHUB_URL = /^https:\/\/github\.com\/[^\s()<>[\]@]*$/;

function followupLine(f, fallbackItem) {
  if (typeof f === 'string') return `- ${line(f)}`;
  const rawUrl = f.url ?? null;
  const url = typeof rawUrl === 'string' && GITHUB_URL.test(rawUrl) ? rawUrl : null;
  const title = f.title ?? fallbackItem?.title ?? (f.number ? `#${f.number}` : (rawUrl ?? 'follow-up'));
  const label = line(title, 100).replace(/[[\]]/g, '');
  const id = f.id ?? fallbackItem?.id;
  // Not a link: show it in a code span so it can neither autolink nor carry markdown of its own.
  const shown = rawUrl ? ` — \`${line(rawUrl).replace(/`/g, "'")}\`` : '';
  const text = url ? `[${label}](${url})` : `${label}${shown}`;
  return `- ${id ? `**${line(id)}** ` : ''}${text}`;
}

function followupsSection(entries, followups) {
  let lines = followups.map((f) => followupLine(f));
  if (lines.length === 0) {
    // Fall back to the issues recorded on the items themselves.
    lines = unique(entries.filter(({ item }) => item.final?.decision === 'FOLLOW-UP' && item.followupIssue)).map(({ item }) =>
      followupLine(isObject(item.followupIssue) ? item.followupIssue : { url: item.followupIssue }, item),
    );
  }
  if (lines.length === 0) return '_None_';
  return [...lines, '', 'Promote one by relabelling `agent-suggestion` → `agent-build`.'].join('\n');
}

// The body of the summary comment without its marker (the run record's writer composes marker + status block + this +
// record marker; see summary-comment.mjs).
export function summarySections(state, { outcome, built, followups = [], modelProofs = [] }) {
  const entries = entriesOf(state);
  const implemented = unique(entries.filter(({ item }) => item.final?.decision === 'ACCEPT' && item.implemented)).map(
    ({ item, n }) => `- ${findingLabel(item)} (round ${n})`,
  );
  const rejected = unique(entries.filter(({ item }) => item.final?.decision === 'REJECT' && !item.final.needsHuman)).map(({ item }) => {
    const why = item.final.by === 'light-lane' ? 'not triaged — light lane' : line(item.final.reason);
    return `- ${findingLabel(item)} — ${why}`;
  });
  const section = (heading, body) => `${heading}\n\n${body}`;
  return [
    section('### Outliers', outliersSection(entries, modelProofs)),
    '',
    section('### What was built', built ? defuse(String(built).trim()) : '_Not provided_'),
    '',
    section('### Suggestions implemented', implemented.length ? implemented.join('\n') : '_None_'),
    '',
    section('### Follow-up issues', followupsSection(entries, followups)),
    '',
    section('### Rejected ideas', rejected.length ? rejected.join('\n') : '_None_'),
    '',
    section('### Outcome', `**${line(outcome)}**`),
  ].join('\n');
}

export function summaryComment(state, opts) {
  return [MARKERS.summary, '', summarySections(state, opts)].join('\n');
}

// ---- needs-human, blocked, awaiting-review --------------------------------------------------

const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : v == null ? 'not run' : line(v));

export function needsHumanComment({ reasons, hits = [], verified, reviewed }) {
  const why = [].concat(reasons ?? []).map((r) => line(r)).filter(Boolean);
  const paragraph =
    `This PR was stopped for a human decision: ${why.length ? why.join('; ') : 'no reason recorded'}. ` +
    `Verified: ${yesNo(verified)}. Reviewed: ${yesNo(reviewed)}.`;
  const out = [MARKERS.needsHuman, '', paragraph];
  if (hits.length) {
    out.push('');
    for (const h of hits) out.push(isObject(h) ? `- ${line(h.rule)} — ${line(h.file)}` : `- ${line(h)}`);
  }
  out.push('', 'To approve: review, add the `human-approved` label, then merge.');
  return out.join('\n');
}

// The longest backtick run inside the excerpt decides how long the fence must be, so a failing
// test's output can never close its own code block.
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

const MAX_EXCERPT_LINES = 60;
const MAX_EXCERPT_CHARS = 6000;

function excerptOf(step) {
  const raw = String(step.errorExcerpt ?? '').trimEnd();
  return defuse(raw.split('\n').slice(0, MAX_EXCERPT_LINES).join('\n').slice(0, MAX_EXCERPT_CHARS));
}

export function blockedComment(report) {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const head = report?.git?.head ? ` at \`${line(String(report.git.head).slice(0, 7))}\`` : '';
  const mode = report?.mode ? ` (${line(report.mode)})` : '';
  const out = [
    MARKERS.blocked,
    '',
    '### Pipeline blocked — verification failed',
    '',
    `Verification${mode} did not pass${head}. The PR is labelled \`pipeline-blocked\` and will not merge until it does.`,
    '',
  ];
  if (steps.length === 0) {
    out.push('_No step results in the report._');
  } else {
    out.push('| Step | Status | Duration | Command |', '|---|---|---|---|');
    for (const s of steps) {
      const skip = skipOf(s);
      const ran = s.status !== 'not-run' && !skip && Number.isFinite(s.durationMs);
      const duration = ran ? `${(s.durationMs / 1000).toFixed(1)}s` : '—';
      const command = s.command ? cell(s.command) : '';
      // A skipped step reads "skipped (reason)", also for the legacy pass+skipped:true row: it did not run, so it is not a pass.
      const status = skip ? cell(`skipped${skip.reason ? ` (${clip(flat(skip.reason), 80)})` : ''}`) : cell(s.status);
      out.push(`| ${cell(s.name)} | ${status} | ${duration} | ${command} |`);
    }
    for (const s of steps.filter((x) => x.status === 'fail' && excerptOf(x))) {
      const code = s.exitCode == null ? '' : ` (exit ${line(s.exitCode)})`;
      out.push('', `<details><summary>${line(s.name)} output${code}</summary>`, '', fenced(excerptOf(s)), '', '</details>');
    }
  }
  return out.join('\n');
}

export function awaitingReviewComment(reason) {
  const why = line(reason).replace(/[.\s]+$/, '');
  return [
    MARKERS.awaitingReview,
    '',
    '### Awaiting cross-model review',
    '',
    `The cross-model Codex review could not run: ${why || 'no reason given'}.`,
    '',
    'The PR is built and verified and is labelled `awaiting-review`. It will not merge without that review. ' +
      'Say "resume pipeline reviews" in a Claude Code session on this repository to continue.',
  ].join('\n');
}

// ---- agent log ------------------------------------------------------------------------------

// Every field is sanitised: one line, markers and mentions defused, pipes escaped (the log is read
// by people and may be pasted into a table).
export function agentLogLine({ date, pr, title, risk, rounds, arbiterCalls, outcome }) {
  const f = (v) => line(v).replace(/\|/g, '&#124;');
  return `- ${f(date)} · #${f(pr)} · ${f(title)} · risk ${f(risk)} · rounds ${f(rounds)} · arbiter ${f(arbiterCalls)} · ${f(outcome)}`;
}

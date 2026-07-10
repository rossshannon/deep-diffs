#!/usr/bin/env node
/**
 * deep-diffs-git — turn a file's git history into a deep-diff HTML report.
 *
 * Chains diffs across the file's revisions in git; regions that have been
 * edited repeatedly are highlighted with increasing intensity — a heatmap
 * of cumulative editorial activity.
 *
 * Technique: Ross Shannon, "Deep Diffs: Visually Exploring the History of
 * a Document" (AVI 2010).
 * https://rossshannon.com/publications/softcopies/Shannon2010DeepDiffs.pdf
 *
 * Zero dependencies beyond the deep-diffs library itself (and git).
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { computeDeepDiff, renderWithMarkers } from '../src/deep-diff.js';
import DiffMatchPatch from 'diff-match-patch';

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const USAGE = `Usage: deep-diffs-git <file> [options]

Turn a file's git history into a self-contained deep-diff HTML report.

Options:
  --out <path>          Output HTML file (default: <file>.deep-diff.html)
  --max-revisions <n>   Cap on revisions; evenly sampled from history (default: 30)
  --since <date>        Only consider commits since this date (passed to git log)
  --mode <depth|age>    Initial heat mode: edit depth or recency (default: depth)
  --note <text>         A note shown in the report header (e.g. provenance)
  --open                Print the file:// URL of the report when done
  -h, --help            Show this help
`;

function die(msg) {
  process.stderr.write(`deep-diffs-git: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    file: null,
    out: null,
    maxRevisions: 30,
    since: null,
    mode: 'depth',
    note: null,
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (name) => {
      if (i + 1 >= argv.length) die(`missing value for ${name}`);
      return argv[++i];
    };
    switch (a) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--out':
        opts.out = next(a);
        break;
      case '--max-revisions': {
        const n = Number.parseInt(next(a), 10);
        if (!Number.isInteger(n) || n < 2) die('--max-revisions must be an integer >= 2');
        opts.maxRevisions = n;
        break;
      }
      case '--since':
        opts.since = next(a);
        break;
      case '--mode': {
        const m = next(a);
        if (m !== 'depth' && m !== 'age') die(`--mode must be "depth" or "age", got "${m}"`);
        opts.mode = m;
        break;
      }
      case '--note':
        opts.note = next(a);
        break;
      case '--open':
        opts.open = true;
        break;
      default:
        if (a.startsWith('-')) die(`unknown option ${a}\n\n${USAGE}`);
        if (opts.file) die(`unexpected extra argument "${a}" (already got file "${opts.file}")`);
        opts.file = a;
    }
  }
  if (!opts.file) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args, cwd, { buffer = false } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: buffer ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') die('git executable not found on PATH');
    die(`failed to run git: ${res.error.message}`);
  }
  return res;
}

function findRepoRoot(fileAbs) {
  // The file may have been deleted from the worktree; fall back to cwd.
  const startDir = existsSync(path.dirname(fileAbs)) ? path.dirname(fileAbs) : process.cwd();
  const res = git(['rev-parse', '--show-toplevel'], startDir);
  if (res.status !== 0) {
    die(`"${fileAbs}" is not inside a git repository`);
  }
  return res.stdout.trim();
}

/**
 * Undo git's C-style path quoting (`"caf\303\251.txt"`), which git applies
 * in --name-only output to paths with non-ASCII or special characters.
 * Escapes are byte-level, so decode to bytes first and re-read as UTF-8.
 */
function unquoteGitPath(p) {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const src = Buffer.from(p.slice(1, -1), 'utf8');
  const esc = { 97: 7, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11, 92: 92, 34: 34 }; // a b f n r t v \ "
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 92 /* backslash */ && i + 1 < src.length) {
      const c = src[i + 1];
      if (c >= 48 && c <= 55) { // \ooo octal byte
        let val = 0;
        let j = i + 1;
        while (j < src.length && j - i <= 3 && src[j] >= 48 && src[j] <= 55) {
          val = val * 8 + (src[j] - 48);
          j++;
        }
        out.push(val);
        i = j - 1;
        continue;
      }
      if (esc[c] !== undefined) {
        out.push(esc[c]);
        i++;
        continue;
      }
    }
    out.push(b);
  }
  return Buffer.from(out).toString('utf8');
}

/**
 * Walk the log for a file (following renames). Returns commits oldest-first:
 * [{ sha, author, date, subject, path }]
 */
function fileHistory(repoRoot, relPath, since) {
  // NUL field separators: author names and subjects may contain tabs (git
  // permits interior tabs in idents), but neither can contain NUL.
  const logArgs = [
    'log', '--follow', '--format=%H%x00%an%x00%aI%x00%s',
  ];
  if (since) logArgs.push(`--since=${since}`);
  logArgs.push('--', relPath);

  const res = git(logArgs, repoRoot);
  if (res.status !== 0) die(`git log failed: ${res.stderr.trim()}`);

  const commits = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sha, author, date, subject] = line.split('\0');
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    commits.push({ sha, author, date, subject, path: relPath });
  }
  commits.reverse(); // oldest first

  // Resolve the file's historical path per commit (renames via --follow).
  // core.quotePath=false keeps non-ASCII path bytes raw; unquoteGitPath
  // below handles any paths git still C-quotes (quotes, control chars).
  const nameArgs = ['-c', 'core.quotePath=false', 'log', '--follow', '--name-only', '--format=%%%H'];
  if (since) nameArgs.push(`--since=${since}`);
  nameArgs.push('--', relPath);
  const nameRes = git(nameArgs, repoRoot);
  if (nameRes.status === 0) {
    const bySha = new Map(commits.map((c) => [c.sha, c]));
    let current = null;
    for (const line of nameRes.stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const m = /^%([0-9a-f]{40})$/.exec(t);
      if (m) {
        current = bySha.get(m[1]) || null;
      } else if (current) {
        current.path = unquoteGitPath(t); // path of the file as of that commit
        current = null;                   // only the first (and only) path per block
      }
    }
  }
  return commits;
}

/** Evenly sample up to max entries, always keeping the first and last. */
function sampleEvenly(items, max) {
  if (items.length <= max) return items;
  const picked = [];
  const seen = new Set();
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (items.length - 1)) / (max - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      picked.push(items[idx]);
    }
  }
  return picked;
}

/** Fetch the file's content at a commit. Returns string, or null if unusable. */
function contentAt(repoRoot, commit, fallbackPaths) {
  const candidates = [commit.path, ...fallbackPaths.filter((p) => p !== commit.path)];
  for (const p of candidates) {
    const res = git(['show', `${commit.sha}:${p}`], repoRoot, { buffer: true });
    if (res.status !== 0) continue;
    const buf = res.stdout;
    // Binary sniff, same heuristic as git's: NUL byte in the first 8000 bytes.
    const probe = buf.subarray(0, 8000);
    if (probe.includes(0)) return null;
    return buf.toString('utf8');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Report data
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const short = (sha) => sha.slice(0, 7);

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Per-revision churn (chars inserted/deleted vs the previous *shown* revision),
 * used for the ledger dots. texts[i] corresponds to commits[i].
 */
function computeChurn(texts) {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 1;
  const churn = [{ inserted: texts[0].length, deleted: 0 }]; // baseline
  for (let i = 1; i < texts.length; i++) {
    const diffs = dmp.diff_main(texts[i - 1], texts[i]);
    dmp.diff_cleanupSemantic(diffs);
    let inserted = 0;
    let deleted = 0;
    for (const [op, t] of diffs) {
      if (op === 1) inserted += t.length;
      else if (op === -1) deleted += t.length;
    }
    churn.push({ inserted, deleted });
  }
  return churn;
}

/**
 * Slice the final text into segments at marker boundaries. Each segment knows
 * every marker covering it, so we can emit flat, well-formed HTML with exact
 * depth classes and tooltip metadata (rather than relying on tag nesting,
 * which gets malformed when markers partially overlap).
 */
function segmentize(text, markers) {
  const bounds = new Set([0, text.length]);
  for (const m of markers) {
    bounds.add(Math.max(0, m.start));
    bounds.add(Math.min(text.length, m.end + 1));
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    if (a >= b) continue;
    const covering = markers.filter((m) => m.start <= a && m.end >= b - 1);
    segments.push({ start: a, end: b, covering });
  }
  return segments;
}

function renderDocument(text, markers, commits) {
  const segments = segmentize(text, markers);
  const maxRev = commits.length - 1;
  let html = '';
  for (const seg of segments) {
    const raw = text.slice(seg.start, seg.end);
    if (seg.covering.length === 0 || !/\S/.test(raw)) {
      // Don't paint whitespace-only segments — stray slivers between
      // paragraphs add noise without information.
      html += escapeHtml(raw);
      continue;
    }
    // Keep newline-containing edge whitespace outside the painted tag,
    // otherwise it renders as thin highlighted slivers at paragraph
    // boundaries. (Plain inserted spaces mid-line stay painted.)
    let lead = '';
    let tail = '';
    let core = raw;
    const lm = core.match(/^\s*/)[0];
    if (lm.includes('\n')) { lead = lm; core = core.slice(lm.length); }
    const tm = core.match(/\s*$/)[0];
    if (tm.includes('\n')) { tail = tm; core = core.slice(0, core.length - tm.length); }
    const content = escapeHtml(core);
    html += escapeHtml(lead);
    const depth = Math.min(seg.covering.length, 6);
    const introduced = Math.max(...seg.covering.map((m) => m.revision));
    const touched = Math.max(...seg.covering.map((m) => m.lastTouched));
    const revs = [...new Set(seg.covering.map((m) => m.revision))].sort((a, b) => a - b);

    // Age bucket 1 (old) .. 6 (recent), from the most recent touch.
    const age = maxRev <= 1 ? 6 : 1 + Math.round((5 * (touched - 1)) / (maxRev - 1));

    const cIntro = commits[introduced];
    const cTouch = commits[touched];
    let tip = `introduced in ${short(cIntro.sha)} · ${cIntro.subject}`;
    if (touched !== introduced && cTouch) {
      tip += `\nlast reworked in ${short(cTouch.sha)} · ${cTouch.subject}`;
    }
    tip += `\nedited ×${seg.covering.length}`;

    html += `<ins class="dd" data-d="${depth}" data-a="${age}" data-rev="${introduced}"` +
      ` data-revs="${revs.join(',')}" data-touched="${touched}" data-tip="${escapeHtml(tip)}">` +
      `${content}</ins>` + escapeHtml(tail);
  }
  return html;
}

function renderLedger(commits, churn, markers) {
  const maxChurn = Math.max(1, ...churn.map((c) => c.inserted + c.deleted));
  const survivors = new Map(); // revision -> chars still visible in final text
  for (const m of markers) {
    survivors.set(m.revision, (survivors.get(m.revision) || 0) + m.length);
  }
  return commits
    .map((c, i) => {
      const { inserted, deleted } = churn[i];
      const total = inserted + deleted;
      // sqrt scale into 5 heat buckets so a couple of huge commits don't flatten the rest
      const bucket = (i === 0 || total === 0) ? 0 : Math.max(1, Math.ceil(5 * Math.sqrt(total / maxChurn)));
      let label;
      let full;
      if (i === 0) {
        label = `baseline · ${inserted.toLocaleString('en')} chars`;
        full = 'Oldest shown revision — everything starts unhighlighted here';
      } else if (total === 0) {
        label = 'no text change';
        full = 'No change to the file text (e.g. a rename)';
      } else {
        label = `+${inserted.toLocaleString('en')} −${deleted.toLocaleString('en')}`;
        full = `${inserted.toLocaleString('en')} chars inserted, ${deleted.toLocaleString('en')} deleted vs the previous shown revision`;
      }
      return `<li class="commit" data-rev="${i}" tabindex="0">
  <span class="dot m${bucket}" title="${escapeHtml(full)}"></span>
  <span class="c-body">
    <span class="c-top"><code class="sha">${escapeHtml(short(c.sha))}</code> <span class="subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</span></span>
    <span class="c-meta" title="${escapeHtml(full)}">${escapeHtml(c.author)} · ${escapeHtml(fmtDate(c.date))} · ${escapeHtml(label)}</span>
  </span>
</li>`;
    })
    .join('\n');
}

/**
 * The depth legend is rendered with the library's own renderWithMarkers —
 * nested synthetic markers produce genuinely nested tags, exactly as the
 * paper describes.
 */
function renderDepthLegend() {
  const chips = [];
  for (let d = 1; d <= 6; d++) {
    const label = d === 6 ? '×6+' : `×${d}`;
    const markers = Array.from({ length: d }, () => ({
      start: 0, end: label.length - 1, enabled: true,
    }));
    const html = renderWithMarkers(label, markers, { tagName: 'ins', className: `dd d${d}` });
    chips.push(`<span class="chip">${html}</span>`);
  }
  return chips.join('');
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function buildHtml({ fileLabel, repoName, commits, totalCommits, mode, note, docHtml, ledgerHtml }) {
  const first = commits[0];
  const last = commits[commits.length - 1];
  const span = `${fmtDate(first.date)} – ${fmtDate(last.date)}`;
  const sampledNote = commits.length < totalCommits
    ? `${commits.length} of ${totalCommits} commits (evenly sampled)`
    : `${commits.length} commits`;

  return `<!DOCTYPE html>
<html lang="en" data-mode="${mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deep diff · ${escapeHtml(fileLabel)}</title>
<style>
:root {
  --bg: #faf8f4; --fg: #23201a; --muted: #7a7468; --rule: #e6e1d6;
  --card: #ffffff; --accent: #b4531f; --chrome-bg: #f2efe8;
  --d1:#fdf2c3; --d2:#fbdf90; --d3:#f8c260; --d4:#f09c44; --d5:#e26f39; --d6:#cc4b2e;
  --a1:#e3e7ea; --a2:#d3dfe8; --a3:#cfe3d6; --a4:#f4e3a5; --a5:#f6c47e; --a6:#ef9450;
  --d6fg:#fff7ef; --a6fg:#2b1a10;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#16181c; --fg:#dcd8cf; --muted:#8f8a80; --rule:#2c2f35;
    --card:#1d2025; --accent:#e08050; --chrome-bg:#1a1d21;
    --d1:rgba(250,204,21,.14); --d2:rgba(250,190,40,.26); --d3:rgba(248,155,40,.38);
    --d4:rgba(243,112,50,.50); --d5:rgba(235,80,50,.62); --d6:rgba(220,50,45,.74);
    --a1:rgba(148,163,184,.16); --a2:rgba(125,155,200,.22); --a3:rgba(110,180,150,.24);
    --a4:rgba(240,200,90,.30); --a5:rgba(245,150,70,.44); --a6:rgba(240,90,45,.60);
    --d6fg:#f6ede6; --a6fg:#f6ede6;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.page { max-width: 1160px; margin: 0 auto; padding: 2.2rem 2rem 3rem; }
header.report {
  border-bottom: 1px solid var(--rule); padding-bottom: 1.2rem; margin-bottom: 1.8rem;
}
.eyebrow {
  font-size: .72rem; letter-spacing: .18em; text-transform: uppercase;
  color: var(--accent); font-weight: 600; margin: 0 0 .35rem;
}
h1.file {
  margin: 0 0 .4rem; font-size: 1.7rem; font-weight: 650;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: -.01em;
}
.meta { color: var(--muted); font-size: .88rem; margin: 0; }
.meta b { color: var(--fg); font-weight: 600; }
.note {
  margin: .8rem 0 0; font-size: .84rem; color: var(--muted);
  border-left: 3px solid var(--accent); padding: .15rem .7rem;
}
.controls {
  display: flex; flex-wrap: wrap; gap: 1.2rem; align-items: center;
  margin-top: 1.1rem;
}
.toggle { display: inline-flex; border: 1px solid var(--rule); border-radius: 999px; overflow: hidden; background: var(--chrome-bg); }
.toggle button {
  border: 0; background: transparent; color: var(--muted); font: inherit; font-size: .8rem;
  padding: .3rem .85rem; cursor: pointer;
}
:root[data-mode="depth"] .toggle button[data-set="depth"],
:root[data-mode="age"] .toggle button[data-set="age"] {
  background: var(--fg); color: var(--bg);
}
.legend { display: inline-flex; align-items: center; gap: .5rem; font-size: .78rem; color: var(--muted); }
.legend .chip ins.dd { padding: .18rem .45rem; border-radius: 3px; font-variant-numeric: tabular-nums; }
/* legend chips are genuinely nested (renderWithMarkers); paint only the outer
   layer so translucent dark-mode colours don't stack into mud */
.legend .chip ins.dd ins.dd { padding: 0; border-radius: 0; background: transparent !important; }
:root[data-mode="age"] #legend-depth { display: none; }
:root[data-mode="depth"] #legend-age { display: none; }
.agebar {
  display: inline-block; width: 130px; height: 12px; border-radius: 6px; vertical-align: -1px;
  background: linear-gradient(to right, var(--a1), var(--a2), var(--a3), var(--a4), var(--a5), var(--a6));
}
main { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 3rem; align-items: start; }
article.doc {
  font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  font-size: 1.02rem; line-height: 1.72; max-width: 68ch;
  white-space: pre-wrap; overflow-wrap: break-word;
}
ins.dd { text-decoration: none; border-radius: 2px; padding: 0 .04em; transition: outline-color .15s; }
:root[data-mode="depth"] ins.dd[data-d="1"], ins.dd.d1 { background: var(--d1); }
:root[data-mode="depth"] ins.dd[data-d="2"], ins.dd.d2 { background: var(--d2); }
:root[data-mode="depth"] ins.dd[data-d="3"], ins.dd.d3 { background: var(--d3); }
:root[data-mode="depth"] ins.dd[data-d="4"], ins.dd.d4 { background: var(--d4); }
:root[data-mode="depth"] ins.dd[data-d="5"], ins.dd.d5 { background: var(--d5); }
:root[data-mode="depth"] ins.dd[data-d="6"], ins.dd.d6 { background: var(--d6); color: var(--d6fg); }
:root[data-mode="age"] ins.dd[data-a="1"] { background: var(--a1); }
:root[data-mode="age"] ins.dd[data-a="2"] { background: var(--a2); }
:root[data-mode="age"] ins.dd[data-a="3"] { background: var(--a3); }
:root[data-mode="age"] ins.dd[data-a="4"] { background: var(--a4); }
:root[data-mode="age"] ins.dd[data-a="5"] { background: var(--a5); }
:root[data-mode="age"] ins.dd[data-a="6"] { background: var(--a6); color: var(--a6fg); }
/* legend chips keep depth colours in both modes */
ins.dd.d1 { background: var(--d1); } ins.dd.d2 { background: var(--d2); }
ins.dd.d3 { background: var(--d3); } ins.dd.d4 { background: var(--d4); }
ins.dd.d5 { background: var(--d5); } ins.dd.d6 { background: var(--d6); color: var(--d6fg); }
article.doc ins.dd:hover { outline: 2px solid var(--accent); outline-offset: 1px; cursor: help; }
article.doc.focus ins.dd:not(.hit) { opacity: .35; }
article.doc ins.dd.hit { outline: 2px solid var(--accent); outline-offset: 1px; }
aside.ledger { position: sticky; top: 1.2rem; max-height: calc(100vh - 2.4rem); overflow: auto; }
aside.ledger h2 {
  font-size: .72rem; letter-spacing: .16em; text-transform: uppercase;
  color: var(--muted); font-weight: 600; margin: 0 0 .7rem;
}
aside.ledger .hint { font-size: .74rem; color: var(--muted); margin: -.3rem 0 .7rem; }
ol.commits { list-style: none; margin: 0; padding: 0; }
li.commit {
  display: flex; gap: .6rem; align-items: flex-start;
  padding: .5rem .6rem; border-radius: 8px; cursor: default;
}
li.commit:hover, li.commit:focus-visible { background: var(--chrome-bg); outline: none; }
.dot { flex: none; width: 11px; height: 11px; border-radius: 50%; margin-top: .32rem; border: 1px solid rgba(0,0,0,.12); }
@media (prefers-color-scheme: dark) { .dot { border-color: rgba(255,255,255,.15); } }
.dot.m0 { background: transparent; border: 2px solid var(--muted); }
.dot.m1 { background: var(--d1); } .dot.m2 { background: var(--d2); }
.dot.m3 { background: var(--d3); } .dot.m4 { background: var(--d5); }
.dot.m5 { background: var(--d6); }
.c-body { min-width: 0; display: block; }
.c-top { display: flex; gap: .5rem; align-items: baseline; min-width: 0; }
code.sha { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .78rem; color: var(--accent); flex: none; }
.subject { font-size: .84rem; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-meta { display: block; font-size: .74rem; color: var(--muted); margin-top: .1rem; }
footer.report {
  border-top: 1px solid var(--rule); margin-top: 2.6rem; padding-top: 1rem;
  font-size: .8rem; color: var(--muted);
}
footer.report a { color: var(--accent); }
#tip {
  position: fixed; z-index: 10; max-width: 340px; padding: .45rem .65rem;
  background: var(--fg); color: var(--bg); border-radius: 6px;
  font: .76rem/1.45 system-ui, sans-serif; white-space: pre-line;
  pointer-events: none; opacity: 0; transition: opacity .12s; box-shadow: 0 4px 14px rgba(0,0,0,.25);
}
#tip.show { opacity: 1; }
@media (max-width: 980px) {
  main { grid-template-columns: 1fr; }
  aside.ledger { position: static; max-height: none; }
}
</style>
</head>
<body>
<div class="page">
<header class="report">
  <p class="eyebrow">Deep diff report</p>
  <h1 class="file">${escapeHtml(fileLabel)}</h1>
  <p class="meta"><b>${escapeHtml(repoName)}</b> · ${escapeHtml(sampledNote)} · ${escapeHtml(span)}</p>
  ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
  <div class="controls">
    <span class="toggle" role="group" aria-label="Heat mode">
      <button type="button" data-set="depth">Edit depth</button>
      <button type="button" data-set="age">Recency</button>
    </span>
    <span class="legend" id="legend-depth">times edited ${renderDepthLegend()}</span>
    <span class="legend" id="legend-age">older <span class="agebar"></span> newer</span>
  </div>
</header>
<main>
  <article class="doc" id="doc">${docHtml}</article>
  <aside class="ledger">
    <h2>Commit ledger · oldest first</h2>
    <p class="hint">Hover a commit to spotlight what it changed.</p>
    <ol class="commits" id="commits">
${ledgerHtml}
    </ol>
  </aside>
</main>
<footer class="report">
  Generated by <code>deep-diffs-git</code>. Repeatedly edited regions glow hotter — a heatmap of
  cumulative editorial activity. Technique from Ross Shannon,
  <a href="https://rossshannon.com/publications/softcopies/Shannon2010DeepDiffs.pdf">&ldquo;Deep Diffs: Visually
  Exploring the History of a Document&rdquo;</a> (AVI&nbsp;2010).
</footer>
</div>
<div id="tip" role="tooltip"></div>
<script>
(function () {
  var root = document.documentElement;
  document.querySelectorAll('.toggle button').forEach(function (btn) {
    btn.addEventListener('click', function () { root.dataset.mode = btn.dataset.set; });
  });

  var tip = document.getElementById('tip');
  var doc = document.getElementById('doc');
  doc.addEventListener('mouseover', function (e) {
    var el = e.target.closest('ins.dd');
    if (!el || !el.dataset.tip) return;
    tip.textContent = el.dataset.tip;
    tip.classList.add('show');
  });
  doc.addEventListener('mousemove', function (e) {
    if (!tip.classList.contains('show')) return;
    var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 12);
    var y = e.clientY + 18;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 10;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  doc.addEventListener('mouseout', function (e) {
    if (!e.target.closest || !e.target.closest('ins.dd')) return;
    tip.classList.remove('show');
  });

  // Hovering a ledger row spotlights the text that commit introduced or reworked.
  var segs = Array.prototype.slice.call(doc.querySelectorAll('ins.dd'));
  function focusRev(rev) {
    var any = false;
    segs.forEach(function (s) {
      var hit = (',' + s.dataset.revs + ',').indexOf(',' + rev + ',') !== -1 ||
                s.dataset.touched === String(rev);
      s.classList.toggle('hit', hit);
      any = any || hit;
    });
    doc.classList.toggle('focus', any);
  }
  function clearFocus() {
    segs.forEach(function (s) { s.classList.remove('hit'); });
    doc.classList.remove('focus');
  }
  document.querySelectorAll('li.commit').forEach(function (row) {
    row.addEventListener('mouseenter', function () { focusRev(row.dataset.rev); });
    row.addEventListener('mouseleave', clearFocus);
    row.addEventListener('focus', function () { focusRev(row.dataset.rev); });
    row.addEventListener('blur', clearFocus);
  });
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const fileAbs = path.resolve(process.cwd(), opts.file);
  const repoRoot = findRepoRoot(fileAbs);
  const relPath = path.relative(repoRoot, fileAbs).split(path.sep).join('/');
  if (relPath.startsWith('..')) die(`"${opts.file}" is outside the repository at ${repoRoot}`);

  const history = fileHistory(repoRoot, relPath, opts.since);
  if (history.length === 0) {
    die(`no git history found for "${relPath}"${opts.since ? ` since ${opts.since}` : ''} — is the file tracked?`);
  }
  if (history.length === 1) {
    die(`"${relPath}" has only one revision — nothing to deep-diff yet`);
  }

  const sampled = sampleEvenly(history, opts.maxRevisions);
  const knownPaths = [...new Set([relPath, ...history.map((c) => c.path)])];

  // Fetch contents, dropping revisions that are binary, missing or empty
  // (e.g. empty commits) while keeping commits[] aligned with texts[].
  const commits = [];
  const texts = [];
  for (const c of sampled) {
    const content = contentAt(repoRoot, c, knownPaths);
    if (content === null) {
      process.stderr.write(`deep-diffs-git: skipping ${short(c.sha)} (binary or file missing at that commit)\n`);
      continue;
    }
    if (content.trim().length === 0) {
      process.stderr.write(`deep-diffs-git: skipping ${short(c.sha)} (file empty at that commit)\n`);
      continue;
    }
    commits.push(c);
    texts.push(content.trim());
  }

  if (texts.length < 2) {
    die(`fewer than two usable text revisions of "${relPath}" — nothing to deep-diff`);
  }

  // texts[i] <-> commits[i]; computeDeepDiff marker.revision r means the
  // insertion first appeared in texts[r], i.e. commits[r] (baseline is 0).
  const { text, markers } = computeDeepDiff(texts, { skipEmpty: true });
  const churn = computeChurn(texts);

  const docHtml = renderDocument(text, markers, commits);
  const ledgerHtml = renderLedger(commits, churn, markers);

  const html = buildHtml({
    fileLabel: relPath,
    repoName: path.basename(repoRoot),
    commits,
    totalCommits: history.length,
    mode: opts.mode,
    note: opts.note,
    docHtml,
    ledgerHtml,
  });

  const outPath = path.resolve(process.cwd(), opts.out || `${opts.file}.deep-diff.html`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  const hot = markers.length;
  process.stdout.write(
    `deep-diffs-git: ${commits.length} revisions of ${relPath} → ${hot} highlighted regions\n` +
    `deep-diffs-git: wrote ${outPath}\n`
  );
  if (opts.open) {
    process.stdout.write(`open: file://${outPath}\n`);
  }
}

main();

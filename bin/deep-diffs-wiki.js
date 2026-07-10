#!/usr/bin/env node
/**
 * deep-diffs-wiki — turn a live Wikipedia article's revision history into a
 * deep-diff HTML report.
 *
 * This is the paper's original use case: chaining diffs across an article's
 * revisions so that regions edited repeatedly glow with increasing intensity —
 * a heatmap of cumulative editorial activity. An "authors" lens additionally
 * tints each highlight by who introduced that wording (the History Flow
 * fusion, on real data).
 *
 * Technique: Ross Shannon, Aaron Quigley & Paddy Nixon, "Deep Diffs: Visually
 * Exploring the History of a Document" (AVI 2010).
 * https://rossshannon.com/publications/softcopies/Shannon2010DeepDiffs.pdf
 *
 * Zero dependencies beyond the deep-diffs library itself; revisions are
 * fetched from the MediaWiki Action API with the global fetch.
 *
 * @license MIT
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { computeDeepDiff } from '../src/deep-diff.js';
import DiffMatchPatch from 'diff-match-patch';

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const USAGE = `Usage: deep-diffs-wiki <article title> [options]

Turn a Wikipedia article's revision history into a self-contained
deep-diff HTML report. Revisions are fetched live from the MediaWiki API.

Options:
  --lang <code>           Wikipedia language edition (default: en)
  --max-revisions <n>     Cap on revisions; evenly sampled from the article's
                          full history, always keeping first + latest (default: 30)
  --out <path>            Output HTML file (default: <Article_title>.deep-diff.html)
  --mode <m>              Initial heat mode: depth | age | authors (default: depth)
  --strip-markup          Light wikitext cleanup: drop templates, refs, tables,
                          file links; keep readable prose. Approximate. (default: on)
  --no-strip-markup       Diff the raw wikitext instead
  --open                  Print the file:// URL of the report when done
  -h, --help              Show this help
`;

const USER_AGENT = 'deep-diffs-wiki/1.0 (https://github.com/rossshannon/deep-diffs)';
const MAX_META_REVISIONS = 10000;   // metadata pagination cap (20 API pages)
const MAX_CONTENT_CHARS = 400000;   // per-revision content cap (~800 KB UTF-16)
const REQUEST_GAP_MS = 120;         // polite pause between sequential requests

function die(msg) {
  process.stderr.write(`deep-diffs-wiki: ${msg}\n`);
  process.exit(1);
}

function warn(msg) {
  process.stderr.write(`deep-diffs-wiki: ${msg}\n`);
}

function parseArgs(argv) {
  const opts = {
    title: [],
    lang: 'en',
    maxRevisions: 30,
    out: null,
    mode: 'depth',
    stripMarkup: true,
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
      case '--lang': {
        const l = next(a);
        if (!/^[a-z][a-z0-9-]{0,12}$/i.test(l)) die(`implausible language code "${l}"`);
        opts.lang = l.toLowerCase();
        break;
      }
      case '--max-revisions': {
        const n = Number.parseInt(next(a), 10);
        if (!Number.isInteger(n) || n < 2) die('--max-revisions must be an integer >= 2');
        opts.maxRevisions = n;
        break;
      }
      case '--out':
        opts.out = next(a);
        break;
      case '--mode': {
        const m = next(a);
        if (!['depth', 'age', 'authors'].includes(m)) {
          die(`--mode must be "depth", "age" or "authors", got "${m}"`);
        }
        opts.mode = m;
        break;
      }
      case '--strip-markup':
        opts.stripMarkup = true;
        break;
      case '--no-strip-markup':
        opts.stripMarkup = false;
        break;
      case '--open':
        opts.open = true;
        break;
      default:
        if (a.startsWith('-')) die(`unknown option ${a}\n\n${USAGE}`);
        opts.title.push(a);
    }
  }
  if (opts.title.length === 0) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  opts.title = opts.title.join(' ');
  return opts;
}

// ---------------------------------------------------------------------------
// MediaWiki API client
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One GET against the Action API. Sequential callers only — this client is
 * deliberately rate-limit friendly: maxlag=5 (defer to replication lag),
 * a descriptive User-Agent, and backoff on 429/maxlag.
 */
async function api(lang, params) {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({
    format: 'json',
    formatversion: '2',
    maxlag: '5',
    ...params,
  })) {
    url.searchParams.set(k, v);
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      die(`network error talking to ${url.host}: ${err.message}`);
    }
    if (res.status === 429 || res.status === 503) {
      const wait = Math.max(2, Number(res.headers.get('retry-after')) || 0) * 1000;
      warn(`HTTP ${res.status} from API — backing off ${wait / 1000}s (attempt ${attempt}/4)`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) die(`API request failed: HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (json.error) {
      if (json.error.code === 'maxlag') {
        warn(`API replication lag — backing off 5s (attempt ${attempt}/4)`);
        await sleep(5000);
        continue;
      }
      die(`API error ${json.error.code}: ${json.error.info}`);
    }
    return json;
  }
  die('API kept rate-limiting after 4 attempts — try again later');
}

/**
 * Fetch the article's full revision metadata, oldest first, following
 * redirects. Returns { title, redirectedFrom, revs, truncated } where each
 * rev is { revid, timestamp, user, size }.
 */
async function fetchHistory(title, lang) {
  const revs = [];
  let resolvedTitle = null;
  let redirectedFrom = null;
  let rvcontinue = null;
  let truncated = false;

  while (true) {
    const params = {
      action: 'query',
      titles: title,
      redirects: '1',
      prop: 'revisions',
      rvprop: 'ids|timestamp|user|size',
      rvlimit: '500',
      rvdir: 'newer',
      rvslots: 'main',
    };
    if (rvcontinue) params.rvcontinue = rvcontinue;
    const json = await api(lang, params);

    const query = json.query || {};
    const page = (query.pages || [])[0];
    if (!page) die(`unexpected API response for "${title}"`);
    if (page.invalid) die(`"${title}" is not a valid article title${page.invalidreason ? `: ${page.invalidreason}` : ''}`);
    if (page.missing) {
      die(`article "${page.title || title}" not found on ${lang}.wikipedia.org`);
    }
    if (!resolvedTitle) {
      resolvedTitle = page.title;
      const redirect = (query.redirects || [])[0];
      if (redirect) {
        redirectedFrom = redirect.from;
        warn(`"${redirect.from}" redirects to "${redirect.to}" — following`);
      }
    }

    for (const r of page.revisions || []) {
      revs.push({
        revid: r.revid,
        timestamp: r.timestamp,
        user: r.userhidden ? null : (r.user ?? null),
        size: r.size ?? 0,
      });
    }

    rvcontinue = json.continue?.rvcontinue;
    if (!rvcontinue) break;
    if (revs.length >= MAX_META_REVISIONS) {
      truncated = true;
      warn(`history longer than ${MAX_META_REVISIONS} revisions — sampling the first ${MAX_META_REVISIONS} plus the latest`);
      break;
    }
    await sleep(REQUEST_GAP_MS);
  }

  // If we had to stop early, still honour "always keep first + latest":
  // fetch the newest revision's metadata separately and append it.
  if (truncated) {
    await sleep(REQUEST_GAP_MS);
    const json = await api(lang, {
      action: 'query',
      titles: resolvedTitle,
      redirects: '1',
      prop: 'revisions',
      rvprop: 'ids|timestamp|user|size',
      rvlimit: '1',
      rvdir: 'older',
    });
    const latest = (json.query?.pages?.[0]?.revisions || [])[0];
    if (latest && !revs.some((r) => r.revid === latest.revid)) {
      revs.push({
        revid: latest.revid,
        timestamp: latest.timestamp,
        user: latest.userhidden ? null : (latest.user ?? null),
        size: latest.size ?? 0,
      });
    }
  }

  return { title: resolvedTitle, redirectedFrom, revs, truncated };
}

/**
 * Fetch one revision's content + full metadata by revid. Returns
 * { revid, timestamp, user, comment, content } or null when the revision
 * is unusable (suppressed text, non-wikitext content model, missing).
 */
async function fetchRevision(lang, revid) {
  const json = await api(lang, {
    action: 'query',
    revids: String(revid),
    prop: 'revisions',
    rvprop: 'ids|timestamp|user|comment|content',
    rvslots: 'main',
  });

  if (json.query?.badrevids) {
    warn(`revision ${revid} no longer exists (deleted) — skipping`);
    return null;
  }
  const rev = (json.query?.pages?.[0]?.revisions || [])[0];
  if (!rev) {
    warn(`revision ${revid} not returned by API — skipping`);
    return null;
  }
  const slot = rev.slots?.main || {};
  if (rev.texthidden || slot.texthidden) {
    warn(`revision ${revid} has suppressed text — skipping`);
    return null;
  }
  if (slot.contentmodel && slot.contentmodel !== 'wikitext') {
    warn(`revision ${revid} has content model "${slot.contentmodel}" — skipping`);
    return null;
  }
  let content = slot.content;
  if (typeof content !== 'string') {
    warn(`revision ${revid} returned no content — skipping`);
    return null;
  }
  if (content.length > MAX_CONTENT_CHARS) {
    warn(`revision ${revid} is very large (${content.length.toLocaleString('en')} chars) — truncating to ${MAX_CONTENT_CHARS.toLocaleString('en')}`);
    content = content.slice(0, MAX_CONTENT_CHARS);
  }
  return {
    revid: rev.revid,
    timestamp: rev.timestamp,
    user: rev.userhidden ? null : (rev.user ?? null),
    comment: rev.commenthidden ? null : (rev.comment ?? ''),
    content,
  };
}

// ---------------------------------------------------------------------------
// Wikitext cleanup (approximate, deterministic)
// ---------------------------------------------------------------------------

/**
 * Remove every balanced `open`...`close` block, tolerating nesting
 * ({{templates in templates}}, tables in tables). Stray closers with no
 * opener are kept as literal text; an unclosed opener swallows the rest of
 * the block-free tail — acceptable for an avowedly approximate cleanup.
 */
function stripBalanced(text, open, close) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith(open, i)) {
      depth++;
      i += open.length - 1;
      continue;
    }
    if (depth > 0 && text.startsWith(close, i)) {
      depth--;
      i += close.length - 1;
      continue;
    }
    if (depth === 0) out += text[i];
  }
  return out;
}

/**
 * Remove [[File:...]], [[Image:...]], [[Media:...]] links, whose captions may
 * themselves contain nested [[links]] — so bracket-match rather than regex.
 */
function stripFileLinks(text) {
  const opener = /\[\[\s*(?:file|image|media)\s*:/iy;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('[[', i)) {
      opener.lastIndex = i;
      if (opener.test(text)) {
        let depth = 0;
        let j = i;
        while (j < text.length) {
          if (text.startsWith('[[', j)) { depth++; j += 2; continue; }
          if (text.startsWith(']]', j)) { depth--; j += 2; if (depth === 0) break; continue; }
          j++;
        }
        i = j; // skip the whole link (or the rest of the text if unbalanced)
        continue;
      }
    }
    out += text[i++];
  }
  return out;
}

/**
 * Light wikitext-to-prose cleanup. Deliberately approximate: inline
 * templates ({{convert|...}} etc.) vanish rather than render, but the
 * running prose — which is what deep diffs track — survives intact.
 */
function stripWikitext(text) {
  let t = text;

  // Structural blocks first (they may contain everything else).
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<(ref|gallery|timeline|math|score|syntaxhighlight|source|imagemap|mapframe)\b[^>]*\/>/gi, '');
  t = t.replace(/<(ref|gallery|timeline|math|score|syntaxhighlight|source|imagemap|mapframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  t = stripBalanced(t, '{{', '}}');
  t = stripBalanced(t, '{|', '|}');
  t = stripFileLinks(t);

  // Links. Category links go entirely; old-style interwiki language links
  // ([[fr:Bateau de Thésée]] on their own line) go too. Lowercase-only
  // prefixes so [[Dune: Part Two]]-style article links survive.
  t = t.replace(/\[\[\s*category\s*:[^[\]]*\]\]/gi, '');
  t = t.replace(/^\[\[[a-z]{2,3}(?:-[a-z]+)*:[^[\]]*\]\][ \t]*$/gm, '');
  t = t.replace(/\[\[(?:[^[\]|]*\|)?([^[\]]*)\]\]/g, '$1'); // [[a|b]] -> b, [[a]] -> a
  t = t.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]*)\]/gi, '$1'); // [url label] -> label
  t = t.replace(/\[https?:\/\/[^\s\]]+\]/gi, ''); // bare [url]

  // Inline HTML and typography.
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/?[a-z][^>]*>/gi, ''); // remaining tags: keep inner text
  t = t.replace(/'{2,}/g, ''); // bold/italic quotes
  t = t.replace(/^=+\s*(.*?)\s*=+\s*$/gm, '$1'); // == Heading == -> Heading
  t = t.replace(/^[*#:;]+\s*/gm, ''); // list/indent markers
  t = t.replace(/__[A-Z_]+__/g, ''); // magic words (__TOC__ ...)
  t = t.replace(/&nbsp;/gi, ' ');
  t = t.replace(/&ndash;/gi, '–').replace(/&mdash;/gi, '—');
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
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

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const displayUser = (rev) => rev.user ?? '(username removed)';

/**
 * Edit summaries arrive as raw wikitext. Render them roughly the way
 * Wikipedia does: section markers become arrows, links become their labels.
 */
function cleanSummary(comment) {
  return comment
    .replace(/\/\*\s*(.*?)\s*\*\//g, '→$1:')
    .replace(/\[\[(?:[^[\]|]*\|)?([^[\]]*)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const displayComment = (rev) =>
  rev.comment === null
    ? '(edit summary removed)'
    : (cleanSummary(rev.comment) || '(no edit summary)');

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

/**
 * Per-revision churn (chars inserted/deleted vs the previous *shown*
 * revision), for the ledger dots. texts[i] corresponds to revisions[i].
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
 * Rank contributors by how many characters of their insertions survive into
 * the final text, and hand the top `max` a palette slot. Everyone else is
 * bucketed as "others". Returns { index: Map<user, 0..max-1>, top: [user] }.
 */
function rankAuthors(markers, revisions, max = 8) {
  const survived = new Map();
  for (const m of markers) {
    const rev = revisions[m.revision];
    if (!rev) continue;
    const user = displayUser(rev);
    survived.set(user, (survived.get(user) || 0) + m.length);
  }
  const top = [...survived.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([user]) => user);
  return { index: new Map(top.map((u, i) => [u, i])), top };
}

/**
 * Slice the final text into segments at marker boundaries. Each segment
 * knows every marker covering it, so we can emit flat, well-formed HTML
 * with exact depth classes and tooltip metadata.
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

function renderDocument(text, markers, revisions, authorIndex) {
  const segments = segmentize(text, markers);
  const maxRev = revisions.length - 1;
  let html = '';
  for (const seg of segments) {
    const raw = text.slice(seg.start, seg.end);
    if (seg.covering.length === 0 || !/\S/.test(raw)) {
      html += escapeHtml(raw);
      continue;
    }
    // Keep newline-containing edge whitespace outside the painted tag, so
    // paragraph boundaries don't render as thin highlighted slivers.
    let lead = '';
    let tail = '';
    let core = raw;
    const lm = core.match(/^\s*/)[0];
    if (lm.includes('\n')) { lead = lm; core = core.slice(lm.length); }
    const tm = core.match(/\s*$/)[0];
    if (tm.includes('\n')) { tail = tm; core = core.slice(0, core.length - tm.length); }
    html += escapeHtml(lead);

    const depth = Math.min(seg.covering.length, 6);
    const introduced = Math.max(...seg.covering.map((m) => m.revision));
    const touched = Math.max(...seg.covering.map((m) => m.lastTouched));
    const revs = [...new Set(seg.covering.map((m) => m.revision))].sort((a, b) => a - b);

    // Age bucket 1 (old) .. 6 (recent), from the most recent touch.
    const age = maxRev <= 1 ? 6 : 1 + Math.round((5 * (touched - 1)) / (maxRev - 1));

    const rIntro = revisions[introduced];
    const rTouch = revisions[touched];
    const user = displayUser(rIntro);
    const au = authorIndex.has(user) ? authorIndex.get(user) : 'x';

    let tip = `added ${fmtDate(rIntro.timestamp)} by ${user} · “${displayComment(rIntro)}”`;
    if (touched !== introduced && rTouch) {
      tip += `\nlast reworked ${fmtDate(rTouch.timestamp)} by ${displayUser(rTouch)} · “${displayComment(rTouch)}”`;
    }
    tip += `\nedited ×${seg.covering.length}`;

    html += `<ins class="dd" data-d="${depth}" data-a="${age}" data-au="${au}" data-rev="${introduced}"` +
      ` data-revs="${revs.join(',')}" data-touched="${touched}" data-tip="${escapeHtml(tip)}">` +
      `${escapeHtml(core)}</ins>` + escapeHtml(tail);
  }
  return html;
}

function renderLedger(revisions, churn, authorIndex, lang, markers) {
  const maxChurn = Math.max(1, ...churn.map((c) => c.inserted + c.deleted));
  // Revisions with no surviving insertions (and no surviving last-touch):
  // hovering them spotlights nothing, so say why.
  const survives = new Set();
  for (const m of markers) {
    survives.add(m.revision);
    survives.add(m.lastTouched);
  }
  return revisions
    .map((r, i) => {
      const { inserted, deleted } = churn[i];
      const total = inserted + deleted;
      // sqrt scale into 5 heat buckets so one huge rewrite doesn't flatten the rest
      const bucket = (i === 0 || total === 0) ? 0 : Math.max(1, Math.ceil(5 * Math.sqrt(total / maxChurn)));
      let label;
      let full;
      if (i === 0) {
        label = `baseline · ${inserted.toLocaleString('en')} chars`;
        full = 'Oldest sampled revision — everything starts unhighlighted here';
      } else if (total === 0) {
        label = 'no text change';
        full = 'No change to the readable text vs the previous sampled revision';
      } else {
        label = `+${inserted.toLocaleString('en')} −${deleted.toLocaleString('en')}`;
        full = `${inserted.toLocaleString('en')} chars inserted, ${deleted.toLocaleString('en')} deleted vs the previous sampled revision`;
      }
      if (i > 0 && total > 0 && !survives.has(i)) {
        label += ' · nothing survives';
        full += '. None of this revision’s wording survives in the current text.';
      }
      const user = displayUser(r);
      const au = authorIndex.has(user) ? authorIndex.get(user) : null;
      const swatch = au === null ? '' : `<i class="au-dot" data-au="${au}"></i>`;
      const href = `https://${encodeURIComponent(lang)}.wikipedia.org/w/index.php?oldid=${encodeURIComponent(r.revid)}`;
      return `<li class="commit" data-rev="${i}" tabindex="0">
  <span class="dot m${bucket}" title="${escapeHtml(full)}"></span>
  <span class="c-body">
    <span class="c-top"><a class="sha" href="${escapeHtml(href)}">${escapeHtml(fmtDate(r.timestamp))}</a> <span class="subject" title="${escapeHtml(displayComment(r))}">${escapeHtml(displayComment(r))}</span></span>
    <span class="c-meta" title="${escapeHtml(full)}">${swatch}${escapeHtml(user)} · ${escapeHtml(label)}</span>
  </span>
</li>`;
    })
    .join('\n');
}

function renderDepthLegend() {
  const chips = [];
  for (let d = 1; d <= 6; d++) {
    const label = d === 6 ? '×6+' : `×${d}`;
    chips.push(`<span class="chip"><ins class="dd lg" data-d="${d}">${label}</ins></span>`);
  }
  return chips.join('');
}

function renderAuthorLegend(topAuthors) {
  const chips = topAuthors.map((u, i) =>
    `<span class="au-chip"><i class="au-dot" data-au="${i}"></i>${escapeHtml(u)}</span>`);
  chips.push('<span class="au-chip"><i class="au-dot" data-au="x"></i>others</span>');
  return chips.join('');
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function buildHtml({ title, lang, revisions, totalRevisions, contributors, mode, note, docHtml, ledgerHtml, authorLegend }) {
  const first = revisions[0];
  const last = revisions[revisions.length - 1];
  const span = `${fmtDate(first.timestamp)} – ${fmtDate(last.timestamp)}`;
  const sampledNote = revisions.length < totalRevisions
    ? `${revisions.length} of ${totalRevisions.toLocaleString('en')} revisions (evenly sampled)`
    : `${revisions.length} revisions`;
  const articleUrl = `https://${encodeURIComponent(lang)}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

  return `<!DOCTYPE html>
<html lang="en" data-mode="${mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deep diff · ${escapeHtml(title)}</title>
<style>
:root {
  --bg: #faf8f4; --fg: #23201a; --muted: #7a7468; --rule: #e6e1d6;
  --card: #ffffff; --accent: #b4531f; --chrome-bg: #f2efe8;
  --d1:#fdf2c3; --d2:#fbdf90; --d3:#f8c260; --d4:#f09c44; --d5:#e26f39; --d6:#cc4b2e;
  --a1:#e3e7ea; --a2:#d3dfe8; --a3:#cfe3d6; --a4:#f4e3a5; --a5:#f6c47e; --a6:#ef9450;
  --d6fg:#fff7ef; --a6fg:#2b1a10;
  /* Author hues: Okabe–Ito derived, as space-separated RGB triplets so they
     compose as rgb(var(--auN) / alpha). --aux = the "others" bucket. */
  --au0: 0 114 178;    /* blue */
  --au1: 230 159 0;    /* orange */
  --au2: 0 158 115;    /* bluish green */
  --au3: 213 94 0;     /* vermillion */
  --au4: 86 180 233;   /* sky blue */
  --au5: 204 121 167;  /* reddish purple */
  --au6: 136 118 43;   /* olive (yellow, darkened for light bg) */
  --au7: 108 91 173;   /* violet */
  --aux: 128 124 116;  /* others: warm grey */
  --ascale: 1;
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
    --au0: 78 156 222;
    --au1: 235 172 32;
    --au2: 46 178 134;
    --au3: 232 116 34;
    --au4: 108 190 238;
    --au5: 222 138 182;
    --au6: 190 170 80;
    --au7: 146 128 214;
    --aux: 138 134 126;
    --ascale: .86;
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
  margin: 0 0 .4rem; font-size: 1.9rem; font-weight: 650;
  font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  letter-spacing: -.01em;
}
h1.file a { color: inherit; text-decoration: none; }
h1.file a:hover { text-decoration: underline; text-decoration-color: var(--accent); }
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
:root[data-mode="age"] .toggle button[data-set="age"],
:root[data-mode="authors"] .toggle button[data-set="authors"] {
  background: var(--fg); color: var(--bg);
}
.legend { display: inline-flex; align-items: center; gap: .5rem; font-size: .78rem; color: var(--muted); flex-wrap: wrap; }
.legend .chip ins.dd { padding: .18rem .45rem; border-radius: 3px; font-variant-numeric: tabular-nums; }
:root:not([data-mode="depth"]) #legend-depth { display: none; }
:root:not([data-mode="age"]) #legend-age { display: none; }
:root:not([data-mode="authors"]) #legend-authors { display: none; }
.agebar {
  display: inline-block; width: 130px; height: 12px; border-radius: 6px; vertical-align: -1px;
  background: linear-gradient(to right, var(--a1), var(--a2), var(--a3), var(--a4), var(--a5), var(--a6));
}
.au-chip { display: inline-flex; align-items: center; gap: .32rem; margin-right: .35rem; }
.au-dot {
  display: inline-block; width: 10px; height: 10px; border-radius: 3px;
  vertical-align: -1px; margin-right: .3rem; flex: none;
}
.au-chip .au-dot { margin-right: 0; }
${[0, 1, 2, 3, 4, 5, 6, 7, 'x'].map((i) => `.au-dot[data-au="${i}"] { background: rgb(var(--au${i}) / .85); }`).join('\n')}
main { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 3rem; align-items: start; }
article.doc {
  font-family: Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  font-size: 1.02rem; line-height: 1.72; max-width: 68ch;
  white-space: pre-wrap; overflow-wrap: break-word;
}
ins.dd { text-decoration: none; border-radius: 2px; padding: 0 .04em; transition: outline-color .15s; }
ins.dd[data-d="1"] { --dd: 1; } ins.dd[data-d="2"] { --dd: 2; }
ins.dd[data-d="3"] { --dd: 3; } ins.dd[data-d="4"] { --dd: 4; }
ins.dd[data-d="5"] { --dd: 5; } ins.dd[data-d="6"] { --dd: 6; }
:root[data-mode="depth"] ins.dd[data-d="1"], ins.dd.lg[data-d="1"] { background: var(--d1); }
:root[data-mode="depth"] ins.dd[data-d="2"], ins.dd.lg[data-d="2"] { background: var(--d2); }
:root[data-mode="depth"] ins.dd[data-d="3"], ins.dd.lg[data-d="3"] { background: var(--d3); }
:root[data-mode="depth"] ins.dd[data-d="4"], ins.dd.lg[data-d="4"] { background: var(--d4); }
:root[data-mode="depth"] ins.dd[data-d="5"], ins.dd.lg[data-d="5"] { background: var(--d5); }
:root[data-mode="depth"] ins.dd[data-d="6"], ins.dd.lg[data-d="6"] { background: var(--d6); color: var(--d6fg); }
:root[data-mode="age"] ins.dd[data-a="1"] { background: var(--a1); }
:root[data-mode="age"] ins.dd[data-a="2"] { background: var(--a2); }
:root[data-mode="age"] ins.dd[data-a="3"] { background: var(--a3); }
:root[data-mode="age"] ins.dd[data-a="4"] { background: var(--a4); }
:root[data-mode="age"] ins.dd[data-a="5"] { background: var(--a5); }
:root[data-mode="age"] ins.dd[data-a="6"] { background: var(--a6); color: var(--a6fg); }
/* Authors lens: hue = who introduced the wording, opacity deepens with edit
   depth — deep diffs fused with History Flow. */
${[0, 1, 2, 3, 4, 5, 6, 7, 'x'].map((i) =>
  `:root[data-mode="authors"] ins.dd[data-au="${i}"] { background: rgb(var(--au${i}) / calc((.13 + var(--dd, 1) * .065) * var(--ascale))); }`
).join('\n')}
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
a.sha { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .76rem; color: var(--accent); flex: none; text-decoration: none; }
a.sha:hover { text-decoration: underline; }
.subject { font-size: .84rem; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-meta { display: flex; align-items: center; font-size: .74rem; color: var(--muted); margin-top: .1rem; min-width: 0; }
.c-meta .au-dot { width: 8px; height: 8px; }
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
  <p class="eyebrow">Deep diff report · Wikipedia</p>
  <h1 class="file"><a href="${escapeHtml(articleUrl)}">${escapeHtml(title)}</a></h1>
  <p class="meta"><b>${escapeHtml(lang)}.wikipedia.org</b> · ${escapeHtml(sampledNote)} · ${escapeHtml(span)} · ${contributors.toLocaleString('en')} contributors across the full history</p>
  ${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}
  <div class="controls">
    <span class="toggle" role="group" aria-label="Heat mode">
      <button type="button" data-set="depth">Edit depth</button>
      <button type="button" data-set="age">Recency</button>
      <button type="button" data-set="authors">Authors</button>
    </span>
    <span class="legend" id="legend-depth">times edited ${renderDepthLegend()}</span>
    <span class="legend" id="legend-age">older <span class="agebar"></span> newer</span>
    <span class="legend" id="legend-authors">${authorLegend}</span>
  </div>
</header>
<main>
  <article class="doc" id="doc">${docHtml}</article>
  <aside class="ledger">
    <h2>Revision ledger · oldest first</h2>
    <p class="hint">Hover a revision to spotlight what it changed. Dates link to the revision on Wikipedia.</p>
    <ol class="commits" id="commits">
${ledgerHtml}
    </ol>
  </aside>
</main>
<footer class="report">
  Generated by <code>deep-diffs-wiki</code> from the live MediaWiki API. Repeatedly edited
  regions glow hotter — a heatmap of cumulative editorial activity; the Authors lens tints
  each region by who introduced its wording. Technique from Ross Shannon, Aaron Quigley
  &amp; Paddy Nixon, <a href="https://rossshannon.com/publications/softcopies/Shannon2010DeepDiffs.pdf">&ldquo;Deep
  Diffs: Visually Exploring the History of a Document&rdquo;</a> (AVI&nbsp;2010) — Wikipedia
  edit histories were the paper&rsquo;s original motivating corpus.
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

  // Hovering a ledger row spotlights the text that revision introduced or reworked.
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  process.stderr.write(`deep-diffs-wiki: fetching history of "${opts.title}" from ${opts.lang}.wikipedia.org …\n`);
  const history = await fetchHistory(opts.title, opts.lang);
  if (history.revs.length < 2) {
    die(`"${history.title}" has only ${history.revs.length} revision(s) — nothing to deep-diff yet`);
  }

  const sampledMeta = sampleEvenly(history.revs, opts.maxRevisions);
  process.stderr.write(
    `deep-diffs-wiki: ${history.revs.length.toLocaleString('en')} revisions — fetching content for ${sampledMeta.length} sampled revisions …\n`
  );

  // Fetch content sequentially (rate-limit friendly), dropping revisions
  // that are suppressed/deleted/empty while keeping revisions[] and texts[]
  // aligned so marker.revision indexes stay meaningful.
  const revisions = [];
  const texts = [];
  for (const meta of sampledMeta) {
    await sleep(REQUEST_GAP_MS);
    const rev = await fetchRevision(opts.lang, meta.revid);
    if (!rev) continue;
    const text = opts.stripMarkup ? stripWikitext(rev.content) : rev.content.trim();
    if (text.length === 0) {
      warn(`revision ${meta.revid} is empty${opts.stripMarkup ? ' after markup stripping' : ''} (blanking vandalism?) — skipping`);
      continue;
    }
    revisions.push(rev);
    texts.push(text);
  }

  if (texts.length < 2) {
    die(`fewer than two usable revisions of "${history.title}" — nothing to deep-diff`);
  }

  // texts[i] <-> revisions[i]; marker.revision r means the insertion first
  // appeared in texts[r], i.e. revisions[r] (baseline is 0).
  const { text, markers } = computeDeepDiff(texts, { skipEmpty: true });
  const churn = computeChurn(texts);
  const { index: authorIndex, top: topAuthors } = rankAuthors(markers, revisions);

  const contributors = new Set(
    history.revs.filter((r) => r.user !== null).map((r) => r.user)
  ).size;

  const generated = new Date().toISOString().slice(0, 10);
  const noteParts = [`Fetched live from the MediaWiki API on ${fmtDate(generated)}.`];
  if (history.redirectedFrom) noteParts.push(`Redirected from “${history.redirectedFrom}”.`);
  if (opts.stripMarkup) {
    noteParts.push('Wikitext lightly stripped for readability (templates, refs, tables and file links removed — approximate).');
  } else {
    noteParts.push('Raw wikitext, unstripped.');
  }
  if (history.truncated) {
    noteParts.push(`History longer than ${MAX_META_REVISIONS.toLocaleString('en')} revisions; sampled from the first ${MAX_META_REVISIONS.toLocaleString('en')} plus the latest.`);
  }

  const docHtml = renderDocument(text, markers, revisions, authorIndex);
  const ledgerHtml = renderLedger(revisions, churn, authorIndex, opts.lang, markers);
  const authorLegend = renderAuthorLegend(topAuthors);

  const html = buildHtml({
    title: history.title,
    lang: opts.lang,
    revisions,
    totalRevisions: history.revs.length,
    contributors,
    mode: opts.mode,
    note: noteParts.join(' '),
    docHtml,
    ledgerHtml,
    authorLegend,
  });

  const slug = history.title.replace(/[^\p{L}\p{N}._-]+/gu, '_');
  const outPath = path.resolve(process.cwd(), opts.out || `${slug}.deep-diff.html`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  process.stdout.write(
    `deep-diffs-wiki: ${revisions.length} revisions of “${history.title}” → ${markers.length} highlighted regions\n` +
    `deep-diffs-wiki: wrote ${outPath}\n`
  );
  if (opts.open) {
    process.stdout.write(`open: file://${outPath}\n`);
  }
}

main();

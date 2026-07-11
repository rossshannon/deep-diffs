/**
 * Tests for the pure, network-free parts of bin/deep-diffs-wiki.js: CLI arg
 * parsing, wikitext cleanup, HTML escaping, sampling, and the
 * revision-index bookkeeping that maps deep-diff markers back to revisions.
 *
 * Deliberately excludes anything that talks to the network (fetchHistory,
 * fetchRevision, api()) — those are exercised by hand against the live
 * MediaWiki API, not by this suite. Uses Node's built-in test runner
 * (node --test), same as the rest of the project.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeDeepDiff } from '../src/deep-diff.js';
import {
  parseArgs,
  stripWikitext,
  escapeHtml,
  fmtDate,
  displayUser,
  cleanSummary,
  displayComment,
  sampleEvenly,
  computeChurn,
  rankAuthors,
  segmentize,
  renderDocument,
  renderLedger,
} from '../bin/deep-diffs-wiki.js';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/deep-diffs-wiki.js');

// ============================================================================
// parseArgs
// ============================================================================

describe('parseArgs', () => {
  it('applies defaults and joins multi-word titles', () => {
    const opts = parseArgs(['Dune', '(novel)']);
    assert.strictEqual(opts.title, 'Dune (novel)');
    assert.strictEqual(opts.lang, 'en');
    assert.strictEqual(opts.maxRevisions, 30);
    assert.strictEqual(opts.out, null);
    assert.strictEqual(opts.mode, 'depth');
    assert.strictEqual(opts.stripMarkup, true);
    assert.strictEqual(opts.open, false);
  });

  it('lowercases --lang', () => {
    const opts = parseArgs(['Article', '--lang', 'FR']);
    assert.strictEqual(opts.lang, 'fr');
  });

  it('parses --max-revisions, --out, --mode, --open, --no-strip-markup', () => {
    const opts = parseArgs([
      'Article', '--max-revisions', '5', '--out', 'x.html',
      '--mode', 'authors', '--open', '--no-strip-markup',
    ]);
    assert.strictEqual(opts.maxRevisions, 5);
    assert.strictEqual(opts.out, 'x.html');
    assert.strictEqual(opts.mode, 'authors');
    assert.strictEqual(opts.open, true);
    assert.strictEqual(opts.stripMarkup, false);
  });

  it('rejects an implausible --lang via the CLI process (exit 1, no crash)', () => {
    const res = spawnSync(process.execPath, [CLI_PATH, 'Article', '--lang', 'not-a-lang-code-way-too-long'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /implausible language code/);
  });

  it('rejects --max-revisions below 2 via the CLI process (exit 1, no crash)', () => {
    const res = spawnSync(process.execPath, [CLI_PATH, 'Article', '--max-revisions', '1'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /--max-revisions must be an integer >= 2/);
  });

  it('prints usage and exits 0 for --help, without touching the network', () => {
    const res = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Usage: deep-diffs-wiki/);
  });
});

// ============================================================================
// stripWikitext — including pathological / adversarial input
// ============================================================================

describe('stripWikitext', () => {
  it('drops templates, tables, refs and file links while keeping prose', () => {
    const wiki = "{{Infobox test|x=1}}\n\n== Section ==\nSome '''prose''' with a [[link]] and a "
      + '[[File:x.jpg|thumb|caption [[nested]]]] and <ref name="a">{{cite web|title=t}}</ref> tail.\n'
      + '[[Category:Test]]\n';
    const out = stripWikitext(wiki);
    assert.doesNotMatch(out, /\{\{|\}\}/);
    assert.doesNotMatch(out, /<ref|<\/ref>/);
    assert.doesNotMatch(out, /\[\[|\]\]/);
    assert.doesNotMatch(out, /Category/);
    assert.match(out, /Section/);
    assert.match(out, /Some prose with a link/);
    assert.match(out, /tail\.$/);
  });

  it('keeps article titles with a colon (namespace-prefix stripping is lowercase-only)', () => {
    const out = stripWikitext('See [[Dune: Part Two]] for the film.');
    assert.match(out, /Dune: Part Two/);
  });

  it('strips real interwiki language links but leaves capitalized-prefix titles alone', () => {
    const out = stripWikitext('intro\n[[fr:Bateau de Thésée]]\nmore text');
    assert.doesNotMatch(out, /Bateau de Thésée/);
    assert.match(out, /intro/);
    assert.match(out, /more text/);
  });

  it('never throws on an unbalanced (unclosed) template', () => {
    assert.doesNotThrow(() => stripWikitext('before {{template that never closes and eats the tail'));
  });

  it('never throws on a nested [[File:...]] with a nested [[link]] caption', () => {
    const out = stripWikitext('a [[File:x.jpg|thumb|see [[Some Article|also]] here]] b');
    assert.doesNotMatch(out, /File:/);
    assert.match(out, /^a  b$/);
  });

  it('handles a self-closing <ref/> and a <ref name=.../> with attributes', () => {
    const out = stripWikitext('x <ref name="a" /> y <ref/> z');
    assert.strictEqual(out, 'x  y  z');
  });

  it('handles a template inside a <ref>...</ref>', () => {
    const out = stripWikitext('text <ref>{{cite web|title=Example|url=http://x}}</ref> tail');
    assert.doesNotMatch(out, /cite web/);
    assert.match(out, /text.*tail/s);
  });

  it('does not hang or throw on many unclosed <ref> tags (vandalism-shaped input)', () => {
    const adversarial = '<ref>a'.repeat(20000); // ~120,000 chars, none of them ever close
    const t0 = Date.now();
    const out = stripWikitext(adversarial);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `stripWikitext took ${elapsed}ms on unclosed <ref> input — expected well under 2s (was quadratic pre-fix)`);
    assert.strictEqual(typeof out, 'string');
  });

  it('does not hang or throw on many unclosed HTML comments (vandalism-shaped input)', () => {
    const adversarial = '<!--a'.repeat(20000);
    const t0 = Date.now();
    const out = stripWikitext(adversarial);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `stripWikitext took ${elapsed}ms on unclosed comment input — expected well under 2s (was quadratic pre-fix)`);
    assert.strictEqual(typeof out, 'string');
  });

  it('still finds a well-formed ref/comment/gallery pair nested inside a run of otherwise-unclosed same-name tags', () => {
    // The first <ref> never closes; a later, unrelated <gallery> pair should
    // still be recognised and stripped (matches the original regex's
    // leftmost-match-then-retry semantics, just without the O(n^2) cost).
    const out = stripWikitext('<ref>dangling forever <gallery>drop me</gallery> tail text');
    assert.doesNotMatch(out, /gallery/);
    assert.match(out, /tail text/);
  });

  it('is a no-op-ish trim on plain prose with no markup', () => {
    assert.strictEqual(stripWikitext('  Just plain prose.  '), 'Just plain prose.');
  });
});

// ============================================================================
// sampleEvenly
// ============================================================================

describe('sampleEvenly', () => {
  it('returns everything unchanged when there are fewer items than max', () => {
    const items = [0, 1];
    assert.deepStrictEqual(sampleEvenly(items, 30), items);
  });

  it('returns everything unchanged when there are exactly max items', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    assert.deepStrictEqual(sampleEvenly(items, 30), items);
  });

  it('keeps exactly first and last for max = 2', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    assert.deepStrictEqual(sampleEvenly(items, 2), [0, 99]);
  });

  it('keeps first, a midpoint, and last for max = 3', () => {
    const items = Array.from({ length: 101 }, (_, i) => i);
    assert.deepStrictEqual(sampleEvenly(items, 3), [0, 50, 100]);
  });

  it('always returns exactly `max` items (no duplicate-index drops) across a range of sizes', () => {
    for (let len = 3; len <= 200; len++) {
      for (let max = 2; max <= Math.min(len - 1, 50); max++) {
        const items = Array.from({ length: len }, (_, i) => i);
        const picked = sampleEvenly(items, max);
        assert.strictEqual(picked.length, max, `len=${len} max=${max}`);
        assert.strictEqual(picked[0], 0, `len=${len} max=${max} first`);
        assert.strictEqual(picked[picked.length - 1], len - 1, `len=${len} max=${max} last`);
      }
    }
  });
});

// ============================================================================
// escaping / formatting / display helpers
// ============================================================================

describe('escapeHtml', () => {
  it('escapes &, <, >, " but leaves other characters (incl. apostrophes) alone', () => {
    assert.strictEqual(escapeHtml(`<b class="x">Tom & Jerry's "diner"</b>`),
      '&lt;b class=&quot;x&quot;&gt;Tom &amp; Jerry\'s &quot;diner&quot;&lt;/b&gt;');
  });

  it('coerces non-strings', () => {
    assert.strictEqual(escapeHtml(42), '42');
  });
});

describe('displayUser / displayComment / cleanSummary', () => {
  it('shows a placeholder for a suppressed (userhidden) username', () => {
    assert.strictEqual(displayUser({ user: null }), '(username removed)');
  });

  it('passes through a normal username unescaped (callers must escapeHtml it)', () => {
    assert.strictEqual(displayUser({ user: 'Alice' }), 'Alice');
  });

  it('shows a placeholder for a suppressed (commenthidden) edit summary', () => {
    assert.strictEqual(displayComment({ comment: null }), '(edit summary removed)');
  });

  it('shows a placeholder for a present-but-empty edit summary', () => {
    assert.strictEqual(displayComment({ comment: '' }), '(no edit summary)');
  });

  it('renders a section-marker comment with an arrow', () => {
    assert.strictEqual(cleanSummary('/* History */ fixed a typo'), '→History: fixed a typo');
  });

  it('strips wikilinks in edit summaries down to their label', () => {
    assert.strictEqual(cleanSummary('see [[Some Page|the page]] for detail'), 'see the page for detail');
  });

  it('collapses internal whitespace', () => {
    assert.strictEqual(cleanSummary('a   b\n\tc'), 'a b c');
  });
});

describe('fmtDate', () => {
  it('formats a valid ISO timestamp', () => {
    assert.strictEqual(fmtDate('2020-01-02T03:04:05Z'), '2 Jan 2020');
  });

  it('falls back to the raw string for an invalid date', () => {
    assert.strictEqual(fmtDate('not-a-date'), 'not-a-date');
  });
});

// ============================================================================
// computeChurn
// ============================================================================

describe('computeChurn', () => {
  it('reports the baseline length with zero deletions for revision 0', () => {
    const churn = computeChurn(['hello', 'hello world']);
    assert.deepStrictEqual(churn[0], { inserted: 5, deleted: 0 });
  });

  it('reports insert/delete counts between consecutive sampled texts', () => {
    const churn = computeChurn(['hello', 'goodbye']);
    assert.strictEqual(churn.length, 2);
    assert.ok(churn[1].inserted > 0);
    assert.ok(churn[1].deleted > 0);
  });
});

// ============================================================================
// marker.revision -> revisions[] index mapping (0-based, baseline = 0)
// ============================================================================

describe('marker.revision indexing end-to-end (computeDeepDiff -> renderDocument/renderLedger)', () => {
  // Three "sampled revisions" as the CLI would build them: texts[i] <-> revisions[i].
  const revisions = [
    { revid: 1, timestamp: '2020-01-01T00:00:00Z', user: 'Alice', comment: 'created' },
    { revid: 2, timestamp: '2020-02-01T00:00:00Z', user: 'Bob', comment: 'expanded' },
    { revid: 3, timestamp: '2020-03-01T00:00:00Z', user: 'Alice', comment: 'polished' },
  ];
  const texts = ['Hello world.', 'Hello brave new world.', 'Hello brave new shiny world.'];

  it('attributes insertions to the 0-based revision index that introduced them (never revision 0, the baseline)', () => {
    const { markers } = computeDeepDiff(texts, { skipEmpty: true });
    assert.ok(markers.length > 0);
    for (const m of markers) {
      assert.ok(m.revision >= 1 && m.revision <= texts.length - 1,
        `marker.revision ${m.revision} should index into revisions[1..${texts.length - 1}]`);
      assert.ok(revisions[m.revision], `revisions[${m.revision}] must exist`);
    }
  });

  it('renderDocument looks up the introducing/last-touched revision by that same 0-based index', () => {
    const { text, markers } = computeDeepDiff(texts, { skipEmpty: true });
    const { index: authorIndex } = rankAuthors(markers, revisions);
    const html = renderDocument(text, markers, revisions, authorIndex);
    // "brave new" was introduced in revisions[1] (Bob); its data-rev should be 1, not 2 (1-based would be wrong).
    assert.match(html, /data-rev="1"[^>]*>brave new <\/ins>/);
    // "shiny " was introduced in revisions[2] (Alice, the latest revision).
    assert.match(html, /data-rev="2"[^>]*>shiny <\/ins>/);
  });

  it('renderLedger indexes revisions by array position, not revid, and flags revisions with nothing surviving', () => {
    const churn = computeChurn(texts);
    const { markers } = computeDeepDiff(texts, { skipEmpty: true });
    const { index: authorIndex } = rankAuthors(markers, revisions);
    const html = renderLedger(revisions, churn, authorIndex, 'en', markers);
    // One <li> per revision, data-rev is the 0-based array index (0, 1, 2) — not the revid (1, 2, 3).
    assert.match(html, /data-rev="0"/);
    assert.match(html, /data-rev="1"/);
    assert.match(html, /data-rev="2"/);
    assert.doesNotMatch(html, /data-rev="3"/);
    // Every revision here has surviving text, so the "nothing survives" callout should not appear.
    assert.doesNotMatch(html, /nothing survives/);
  });

  it('escapes a hostile username/edit-summary everywhere they are interpolated (attributes, tooltips, subject line)', () => {
    const hostileRevisions = [
      { revid: 1, timestamp: '2020-01-01T00:00:00Z', user: '<script>1</script>', comment: '"onmouseover=alert(1)' },
      { revid: 2, timestamp: '2020-02-01T00:00:00Z', user: 'Bob"><img src=x>', comment: '/* <b>x</b> */ edited' },
    ];
    const hostileTexts = ['base text', 'base text plus more'];
    const { text, markers } = computeDeepDiff(hostileTexts, { skipEmpty: true });
    const churn = computeChurn(hostileTexts);
    const { index: authorIndex } = rankAuthors(markers, hostileRevisions);
    const docHtml = renderDocument(text, markers, hostileRevisions, authorIndex);
    const ledgerHtml = renderLedger(hostileRevisions, churn, authorIndex, 'en', markers);
    for (const html of [docHtml, ledgerHtml]) {
      assert.doesNotMatch(html, /<script>/);
      assert.doesNotMatch(html, /<img /);
      // A raw, unescaped double-quote immediately followed by an HTML/JS
      // metacharacter would indicate an attribute-breakout; escapeHtml turns
      // every literal `"` into `&quot;`, so none should survive verbatim.
      assert.doesNotMatch(html, /"onmouseover/);
      assert.doesNotMatch(html, /Bob">/);
    }
  });
});

// ============================================================================
// segmentize (used by renderDocument)
// ============================================================================

describe('segmentize', () => {
  it('tiles the whole text and each segment knows the markers covering it', () => {
    const text = 'abcdef';
    const markers = [{ start: 1, end: 3, revision: 1, lastTouched: 1 }];
    const segs = segmentize(text, markers);
    assert.strictEqual(segs[0].start, 0);
    assert.strictEqual(segs[segs.length - 1].end, text.length);
    const covered = segs.find((s) => s.start === 1 && s.end === 4);
    assert.ok(covered);
    assert.strictEqual(covered.covering.length, 1);
  });
});

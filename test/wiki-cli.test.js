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
  collapseReverts,
  ageBucket,
  isRevertFlagged,
  pickSamplePoints,
  findRestoredAttribution,
  attributionFor,
  formatAttribution,
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
    assert.strictEqual(opts.keepReverts, false);
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

  it('parses --keep-reverts', () => {
    const opts = parseArgs(['Article', '--keep-reverts']);
    assert.strictEqual(opts.keepReverts, true);
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
    assert.match(res.stdout, /--keep-reverts/);
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
// collapseReverts — History Flow's collapse rule, run before sampling
// ============================================================================

describe('collapseReverts', () => {
  it('collapses a sha1 revert cycle at the very start of the history', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] }, // creation
      { revid: 2, sha1: 'B', tags: [] }, // vandalism
      { revid: 3, sha1: 'A', tags: [] }, // revert back to A
      { revid: 4, sha1: 'C', tags: [] }, // later legit edit
      { revid: 5, sha1: 'D', tags: [] }, // latest
    ];
    const { revs: out, collapsedByCycle, droppedByTag } = collapseReverts(revs);
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 4, 5]);
    assert.strictEqual(collapsedByCycle, 2);
    assert.strictEqual(droppedByTag, 0);
  });

  it('collapses a sha1 revert cycle in the middle of the history', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] },
      { revid: 2, sha1: 'B', tags: [] },
      { revid: 3, sha1: 'X', tags: [] }, // vandalism
      { revid: 4, sha1: 'B', tags: [] }, // revert back to B
      { revid: 5, sha1: 'D', tags: [] }, // latest
    ];
    const { revs: out, collapsedByCycle } = collapseReverts(revs);
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 2, 5]);
    assert.strictEqual(collapsedByCycle, 2);
  });

  it('collapses a sha1 cycle touching the very end, but always keeps the latest revision', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] },
      { revid: 2, sha1: 'B', tags: [] }, // vandalism
      { revid: 3, sha1: 'A', tags: [] }, // current text happens to match revid 1's
    ];
    const { revs: out, collapsedByCycle } = collapseReverts(revs);
    // revid 2 (the vandalism) is still dropped, but revid 3 — the article's
    // actual current text — must survive even though it duplicates revid 1's
    // sha1; only revid 2 counts as collapsed.
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 3]);
    assert.strictEqual(collapsedByCycle, 1);
  });

  it('handles repeated revert cycles, continuing to scan from the surviving state after each collapse', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] },
      { revid: 2, sha1: 'B', tags: [] }, // vandalism 1
      { revid: 3, sha1: 'A', tags: [] }, // revert 1
      { revid: 4, sha1: 'C', tags: [] }, // legit edit
      { revid: 5, sha1: 'D', tags: [] }, // vandalism 2
      { revid: 6, sha1: 'C', tags: [] }, // revert 2 (back to revid 4's state)
      { revid: 7, sha1: 'E', tags: [] }, // latest
    ];
    const { revs: out, collapsedByCycle } = collapseReverts(revs);
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 4, 7]);
    assert.strictEqual(collapsedByCycle, 4);
  });

  it('never lets a revision with no sha1 (suppressed text) falsely match, and does not crash', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] },
      { revid: 2, sha1: null, tags: [] },
      { revid: 3, sha1: 'B', tags: [] },
      { revid: 4, sha1: null, tags: [] },
    ];
    const { revs: out, collapsedByCycle, droppedByTag } = collapseReverts(revs);
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 2, 3, 4]);
    assert.strictEqual(collapsedByCycle, 0);
    assert.strictEqual(droppedByTag, 0);
  });

  it('drops a revision tagged mw-reverted independently of the sha1 rule', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] },
      { revid: 2, sha1: 'B', tags: ['mw-reverted'] }, // not a byte-identical revert, but tagged
      { revid: 3, sha1: 'C', tags: [] },
    ];
    const { revs: out, collapsedByCycle, droppedByTag } = collapseReverts(revs);
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 3]);
    assert.strictEqual(collapsedByCycle, 0);
    assert.strictEqual(droppedByTag, 1);
  });

  it('never drops the first or last revision via the tag rule, even if tagged mw-reverted', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: ['mw-reverted'] },
      { revid: 2, sha1: 'B', tags: [] },
      { revid: 3, sha1: 'C', tags: ['mw-reverted'] },
    ];
    const { revs: out, droppedByTag } = collapseReverts(revs);
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 2, 3]);
    assert.strictEqual(droppedByTag, 0);
  });

  it('does not double-count a revision dropped by the sha1 rule against the tag count', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] },
      { revid: 2, sha1: 'B', tags: ['mw-reverted'] }, // vandalism, also tagged
      { revid: 3, sha1: 'A', tags: ['mw-reverted'] }, // revert, also tagged
      { revid: 4, sha1: 'C', tags: [] },
    ];
    const { revs: out, collapsedByCycle, droppedByTag } = collapseReverts(revs);
    assert.deepStrictEqual(out.map((r) => r.revid), [1, 4]);
    assert.strictEqual(collapsedByCycle, 2);
    assert.strictEqual(droppedByTag, 0); // already gone via the sha1 pass, not re-counted
  });

  it('--keep-reverts passthrough: leaves the timeline untouched with zero counts', () => {
    const revs = [
      { revid: 1, sha1: 'A', tags: [] },
      { revid: 2, sha1: 'B', tags: ['mw-reverted'] },
      { revid: 3, sha1: 'A', tags: [] },
    ];
    const { revs: out, collapsedByCycle, droppedByTag } = collapseReverts(revs, { keepReverts: true });
    assert.deepStrictEqual(out, revs);
    assert.strictEqual(collapsedByCycle, 0);
    assert.strictEqual(droppedByTag, 0);
  });

  it('is a no-op on a history with fewer than two revisions', () => {
    const revs = [{ revid: 1, sha1: 'A', tags: [] }];
    const { revs: out, collapsedByCycle, droppedByTag } = collapseReverts(revs);
    assert.deepStrictEqual(out, revs);
    assert.strictEqual(collapsedByCycle, 0);
    assert.strictEqual(droppedByTag, 0);
  });
});

// ============================================================================
// isRevertFlagged — the janitorial-edit detector behind sample-point
// skipping and honest attribution
// ============================================================================

describe('isRevertFlagged', () => {
  it('flags mw-undo, mw-rollback and mw-manual-revert tags', () => {
    for (const tag of ['mw-undo', 'mw-rollback', 'mw-manual-revert']) {
      assert.strictEqual(isRevertFlagged({ tags: [tag], comment: '' }), true, tag);
    }
  });

  it('does not flag unrelated tags', () => {
    assert.strictEqual(isRevertFlagged({ tags: ['wikieditor', 'mobile edit'], comment: 'clarified wording' }), false);
  });

  it('flags via comment heuristic when no revert tag is present (manual revert, no tooling)', () => {
    assert.strictEqual(isRevertFlagged({ tags: [], comment: 'Reverted good faith edits by 1.2.3.4' }), true);
    assert.strictEqual(isRevertFlagged({ tags: [], comment: 'Undid revision 12345 by Someone' }), true);
    assert.strictEqual(isRevertFlagged({ tags: [], comment: 'rv unexplained blanking' }), true);
    assert.strictEqual(isRevertFlagged({ tags: [], comment: 'rollback vandalism' }), true);
  });

  it('is case-insensitive in the comment heuristic', () => {
    assert.strictEqual(isRevertFlagged({ tags: [], comment: 'REVERTED vandalism' }), true);
  });

  it('does not flag an edit summary with no revert-shaped wording', () => {
    assert.strictEqual(isRevertFlagged({ tags: [], comment: 'expanded the lede with a source' }), false);
  });

  it('documented false-positive tolerance: "undo" matches as a bare prefix, so unrelated words containing it also flag', () => {
    // Accepted tradeoff (see the comment above REVERT_COMMENT_RE in the
    // source): this only ever affects display, never which text survives.
    assert.strictEqual(isRevertFlagged({ tags: [], comment: 'clarified an undocumented edge case' }), true);
  });

  it('a null (suppressed) comment cannot trigger the comment heuristic, only tags', () => {
    assert.strictEqual(isRevertFlagged({ tags: [], comment: null }), false);
    assert.strictEqual(isRevertFlagged({ tags: ['mw-rollback'], comment: null }), true);
  });

  it('does not throw on missing tags/comment fields', () => {
    assert.doesNotThrow(() => isRevertFlagged({}));
    assert.strictEqual(isRevertFlagged({}), false);
  });
});

// ============================================================================
// pickSamplePoints — revert-aware sample selection, run in place of
// sampleEvenly on the collapsed revision timeline
// ============================================================================

describe('pickSamplePoints', () => {
  const flaggedByTag = (r) => Array.isArray(r.tags) && r.tags.includes('REVERT');
  const mk = (n, revertIdx = []) =>
    Array.from({ length: n }, (_, i) => ({ revid: i, tags: revertIdx.includes(i) ? ['REVERT'] : [] }));

  it('matches sampleEvenly\'s picks exactly when nothing is revert-flagged', () => {
    const revs = mk(20);
    const points = pickSamplePoints(revs, 5, flaggedByTag);
    const viaSampleEvenly = sampleEvenly(revs, 5);
    assert.deepStrictEqual(points.map((p) => p.rev), viaSampleEvenly);
  });

  it('substitutes a revert-flagged candidate for its nearest preceding non-flagged revision', () => {
    // sampleIndices(6, 3) picks [0, 3, 5]; flag index 3 only.
    const revs = mk(6, [3]);
    const points = pickSamplePoints(revs, 3, flaggedByTag);
    assert.deepStrictEqual(points.map((p) => p.index), [0, 2, 5]);
    assert.ok(points.every((p) => !flaggedByTag(p.rev)));
  });

  it('never substitutes the final candidate — the report must always end on the true current state', () => {
    // sampleIndices(4, 2) picks [0, 3]; flag index 3, the final revision.
    const revs = mk(4, [3]);
    const points = pickSamplePoints(revs, 2, flaggedByTag);
    assert.deepStrictEqual(points.map((p) => p.index), [0, 3]);
    assert.strictEqual(flaggedByTag(points[1].rev), true);
  });

  it('falls back to the original (flagged) candidate when every revision back to the previous pick is flagged', () => {
    // sampleIndices(8, 3) picks [0, 4, 7]; flag 1..4 so the walk-back from 4
    // exhausts every predecessor down to (but not past) index 0.
    const revs = mk(8, [1, 2, 3, 4]);
    const points = pickSamplePoints(revs, 3, flaggedByTag);
    assert.deepStrictEqual(points.map((p) => p.index), [0, 4, 7]);
    assert.strictEqual(flaggedByTag(points[1].rev), true, 'no better substitute existed, so the flagged one survives');
  });

  it('never produces duplicate or out-of-order indices, with or without reverts scattered through the history', () => {
    for (let len = 4; len <= 60; len += 7) {
      for (let max = 2; max <= Math.min(len - 1, 15); max++) {
        const revs = mk(len, Array.from({ length: len }, (_, i) => i).filter((i) => i % 3 === 1));
        const points = pickSamplePoints(revs, max, flaggedByTag);
        const idxs = points.map((p) => p.index);
        assert.strictEqual(idxs.length, max, `len=${len} max=${max}`);
        for (let i = 1; i < idxs.length; i++) {
          assert.ok(idxs[i] > idxs[i - 1], `indices must strictly increase: ${idxs} (len=${len} max=${max})`);
        }
        assert.strictEqual(idxs[0], 0);
        assert.strictEqual(idxs[idxs.length - 1], len - 1);
      }
    }
  });

  it('reports span as the count of revisions absorbed since the previous sample point, inclusive of itself', () => {
    const revs = mk(6, [3]); // picks become [0, 2, 5], see above
    const points = pickSamplePoints(revs, 3, flaggedByTag);
    assert.deepStrictEqual(points.map((p) => p.span), [1, 2, 3]); // 0-(-1)=1, 2-0=2, 5-2=3
    // Spans always sum to the full length of the timeline.
    assert.strictEqual(points.reduce((a, p) => a + p.span, 0), 6);
  });

  it('returns every revision, each with span 1, when there are no more revisions than max', () => {
    const revs = mk(3);
    const points = pickSamplePoints(revs, 10, flaggedByTag);
    assert.strictEqual(points.length, 3);
    assert.deepStrictEqual(points.map((p) => p.span), [1, 1, 1]);
  });
});

// ============================================================================
// findRestoredAttribution / attributionFor / formatAttribution — honest
// attribution for a revert-flagged sampled revision
// ============================================================================

describe('findRestoredAttribution', () => {
  const collapsedRevs = [
    { revid: 1, sha1: 'A', user: 'Alice', timestamp: '2020-01-01T00:00:00Z', comment: 'created' },
    { revid: 2, sha1: 'B', user: 'Bob', timestamp: '2020-02-01T00:00:00Z', comment: 'expanded' },
    { revid: 3, sha1: 'C', user: 'Carol', timestamp: '2020-03-01T00:00:00Z', comment: 'polished' },
    { revid: 4, sha1: 'B', user: 'VanFinda', timestamp: '2020-04-01T00:00:00Z', comment: 'Reverted edits by X' },
  ];

  it('finds the nearest earlier kept revision with a byte-identical sha1 (a full revert)', () => {
    const found = findRestoredAttribution({ revid: 4, sha1: 'B' }, collapsedRevs);
    assert.strictEqual(found.revid, 2);
    assert.strictEqual(found.user, 'Bob');
  });

  it('returns null when no earlier revision shares this sha1 (a partial revert after intervening edits)', () => {
    const found = findRestoredAttribution({ revid: 4, sha1: 'Z' }, collapsedRevs);
    assert.strictEqual(found, null);
  });

  it('returns null when the revision has no sha1 at all', () => {
    const found = findRestoredAttribution({ revid: 4, sha1: null }, collapsedRevs);
    assert.strictEqual(found, null);
  });

  it('picks the nearest match, not an earlier one, when the sha1 recurs more than once', () => {
    const revs = [
      { revid: 1, sha1: 'A', user: 'Alice', timestamp: '2020-01-01T00:00:00Z', comment: '' },
      { revid: 2, sha1: 'A', user: 'Alice2', timestamp: '2020-01-15T00:00:00Z', comment: '' },
      { revid: 3, sha1: 'A', user: 'VanFinda', timestamp: '2020-02-01T00:00:00Z', comment: 'revert' },
    ];
    const found = findRestoredAttribution({ revid: 3, sha1: 'A' }, revs);
    assert.strictEqual(found.revid, 2, 'should match the nearest prior occurrence, not revid 1');
  });
});

describe('attributionFor', () => {
  it('passes an ordinary (non-revert-flagged) revision through unchanged', () => {
    const rev = { user: 'Alice', timestamp: '2020-01-01T00:00:00Z', comment: 'created', revertFlagged: false, restoredFrom: null };
    assert.deepStrictEqual(attributionFor(rev), {
      user: 'Alice', timestamp: '2020-01-01T00:00:00Z', comment: 'created', revertLabel: false, restored: false,
    });
  });

  it('keeps a revert-flagged revision\'s own metadata but sets revertLabel when there is no byte-identical match (a partial revert)', () => {
    const rev = { user: 'VanFinda', timestamp: '2026-07-04T00:00:00Z', comment: 'Reverting vandalism', revertFlagged: true, restoredFrom: null };
    const attr = attributionFor(rev);
    assert.strictEqual(attr.user, 'VanFinda');
    assert.strictEqual(attr.revertLabel, true);
    assert.strictEqual(attr.restored, false);
  });

  it('credits the earlier restored-from revision\'s metadata when the content is byte-identical to it (the reported bug\'s exact case)', () => {
    const rev = {
      user: 'VanFinda',
      timestamp: '2026-07-04T01:43:57Z',
      comment: 'Interceptor: Reverting non-constructive edits',
      revertFlagged: true,
      restoredFrom: { user: '~2026-38176-45', timestamp: '2026-07-03T12:14:22Z', comment: '' },
    };
    const attr = attributionFor(rev);
    assert.strictEqual(attr.user, '~2026-38176-45');
    assert.strictEqual(attr.timestamp, '2026-07-03T12:14:22Z');
    assert.strictEqual(attr.restored, true);
    assert.strictEqual(attr.revertLabel, false);
    assert.notStrictEqual(attr.user, 'VanFinda', 'the reverting editor must not be credited with the restored wording');
  });
});

describe('formatAttribution', () => {
  const revisions = [
    { timestamp: '2020-01-01T00:00:00Z', span: 1 },
    { timestamp: '2020-06-01T00:00:00Z', span: 1 },
    { timestamp: '2020-07-01T00:00:00Z', span: 14 },
  ];

  it('states a restored attribution explicitly, including when the revert happened', () => {
    const rev = revisions[2];
    const attr = { user: 'OldAuthor', timestamp: '2020-05-01T00:00:00Z', restored: true, revertLabel: false };
    const out = formatAttribution(rev, attr, revisions, 2);
    assert.match(out, /^OldAuthor \(state restored by a revert on 1 Jul 2020\)$/);
  });

  it('prefixes/suffixes a plain revert-flagged attribution with the ↩ glyph, without inventing a restored date', () => {
    const rev = revisions[2];
    const attr = { user: 'VanFinda', timestamp: '2020-07-01T00:00:00Z', restored: false, revertLabel: true };
    const out = formatAttribution(rev, attr, revisions, 2);
    assert.match(out, /^↩ VanFinda \(revert\)/);
  });

  it('adds a composite-step span note when this sample absorbed more than one revision since the previous sample', () => {
    const rev = revisions[2]; // span 14
    const attr = { user: 'VanFinda', timestamp: '2020-07-01T00:00:00Z', restored: false, revertLabel: false };
    const out = formatAttribution(rev, attr, revisions, 2);
    assert.strictEqual(out, 'VanFinda (+13 other revisions since 1 Jun 2020)');
  });

  it('uses singular "revision" for exactly one other absorbed revision', () => {
    const rev = { timestamp: '2020-07-01T00:00:00Z', span: 2 };
    const revs = [revisions[0], revisions[1], rev];
    const attr = { user: 'Bob', timestamp: '2020-07-01T00:00:00Z', restored: false, revertLabel: false };
    const out = formatAttribution(rev, attr, revs, 2);
    assert.strictEqual(out, 'Bob (+1 other revision since 1 Jun 2020)');
  });

  it('omits the span note for the baseline (index 0), and for a step with no absorbed span', () => {
    const attr = { user: 'Alice', timestamp: '2020-01-01T00:00:00Z', restored: false, revertLabel: false };
    assert.strictEqual(formatAttribution(revisions[0], attr, revisions, 0), 'Alice');
    assert.strictEqual(
      formatAttribution(revisions[1], { ...attr, user: 'Bob' }, revisions, 1),
      'Bob',
    );
  });
});

// ============================================================================
// ageBucket — fixed real-time buckets for the Recency lens
// ============================================================================

describe('ageBucket', () => {
  const DAY = 86400000;
  const now = Date.parse('2026-07-12T00:00:00Z');
  const daysAgo = (n) => new Date(now - n * DAY).toISOString();

  it('buckets a same-day edit as the hottest bucket (6)', () => {
    assert.strictEqual(ageBucket(daysAgo(0), now), 6);
  });

  it('buckets exactly at a boundary into the newer (inclusive) side', () => {
    assert.strictEqual(ageBucket(daysAgo(90), now), 6);
    assert.strictEqual(ageBucket(daysAgo(91), now), 5);
    assert.strictEqual(ageBucket(daysAgo(365), now), 5);
    assert.strictEqual(ageBucket(daysAgo(366), now), 4);
  });

  it('buckets a multi-year-old edit as cool, regardless of how recently the article was sampled', () => {
    assert.strictEqual(ageBucket(daysAgo(365 * 3), now), 3); // 2-5yr
    assert.strictEqual(ageBucket(daysAgo(365 * 7), now), 2); // 5-10yr
    assert.strictEqual(ageBucket(daysAgo(365 * 23), now), 1); // 23-year-old article, oldest bucket
  });

  it('falls back to the oldest/coolest bucket for an unparseable timestamp', () => {
    assert.strictEqual(ageBucket('not-a-date', now), 1);
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

  it('buckets the Recency lens (data-a) by each region\'s real last-touched date, not its rank among sampled revisions', () => {
    const { text, markers } = computeDeepDiff(texts, { skipEmpty: true });
    const { index: authorIndex } = rankAuthors(markers, revisions);
    // "now" far in the future relative to all three fixed 2020 timestamps:
    // every region here is 5+ years old, so every region should land in the
    // single oldest bucket (1) — a real calendar distinction the old
    // index-based scheme (which always used the full 1..6 spread across
    // whatever was sampled) could never make.
    const farFuture = Date.parse('2032-06-01T00:00:00Z');
    const html = renderDocument(text, markers, revisions, authorIndex, farFuture);
    const buckets = [...html.matchAll(/data-a="(\d)"/g)].map((m) => Number(m[1]));
    assert.ok(buckets.length > 0);
    assert.ok(buckets.every((b) => b === 1), `expected every region to bucket as oldest (1) far in the future, got ${buckets}`);
  });

  it('buckets the Recency lens closer to "now" than to the far future — different nowMs values give different buckets', () => {
    const { text, markers } = computeDeepDiff(texts, { skipEmpty: true });
    const { index: authorIndex } = rankAuthors(markers, revisions);
    // "now" a few days after the most recent (2020-03-01) revision: that
    // region's real-world age is tiny, so it should land in the hottest bucket.
    const shortlyAfter = Date.parse('2020-03-05T00:00:00Z');
    const html = renderDocument(text, markers, revisions, authorIndex, shortlyAfter);
    assert.match(html, /data-a="6"[^>]*>shiny <\/ins>/);
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

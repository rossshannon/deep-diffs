/**
 * Comprehensive test suite for deep-diffs
 * 
 * Uses Node.js built-in test runner (node --test)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeDeepDiff,
  renderWithMarkers,
  deepDiffHtml,
  getDefaultStyles,
  computeHeatSegments,
  normalizeMarkers
} from '../src/deep-diff.js';

// ============================================================================
// computeDeepDiff - Core Algorithm Tests
// ============================================================================

describe('computeDeepDiff', () => {
  
  describe('basic functionality', () => {
    
    it('returns original text and no markers for single revision', () => {
      const result = computeDeepDiff(['hello world']);
      assert.strictEqual(result.text, 'hello world');
      assert.deepStrictEqual(result.markers, []);
    });

    it('returns empty result for empty input', () => {
      const result = computeDeepDiff([]);
      assert.strictEqual(result.text, '');
      assert.deepStrictEqual(result.markers, []);
    });

    it('handles two identical revisions with no markers', () => {
      const result = computeDeepDiff(['hello', 'hello']);
      assert.strictEqual(result.text, 'hello');
      assert.strictEqual(result.markers.length, 0);
    });

    it('trims whitespace from revisions', () => {
      const result = computeDeepDiff(['  hello  ', '  hello world  ']);
      assert.strictEqual(result.text, 'hello world');
    });

  });

  describe('simple insertions', () => {

    it('detects insertion at end', () => {
      const result = computeDeepDiff(['hello', 'hello world']);
      assert.strictEqual(result.text, 'hello world');
      assert.strictEqual(result.markers.length, 1);
      
      const marker = result.markers[0];
      const markedText = result.text.slice(marker.start, marker.end + 1);
      assert.strictEqual(markedText, ' world');
    });

    it('detects insertion at beginning', () => {
      const result = computeDeepDiff(['world', 'hello world']);
      assert.strictEqual(result.markers.length, 1);
      
      const marker = result.markers[0];
      const markedText = result.text.slice(marker.start, marker.end + 1);
      assert.strictEqual(markedText, 'hello ');
    });

    it('detects insertion in middle', () => {
      const result = computeDeepDiff(['helloworld', 'hello world']);
      assert.strictEqual(result.markers.length, 1);
      
      const marker = result.markers[0];
      const markedText = result.text.slice(marker.start, marker.end + 1);
      assert.strictEqual(markedText, ' ');
    });

    it('detects multiple separate insertions', () => {
      const result = computeDeepDiff([
        'The cat sat.',
        'The big cat sat here.'
      ]);
      assert.strictEqual(result.markers.length, 2);
    });

  });

  describe('simple deletions', () => {

    it('handles deletion at end (no markers created)', () => {
      const result = computeDeepDiff(['hello world', 'hello']);
      assert.strictEqual(result.text, 'hello');
      assert.strictEqual(result.markers.length, 0);
    });

    it('handles deletion at beginning', () => {
      const result = computeDeepDiff(['hello world', 'world']);
      assert.strictEqual(result.text, 'world');
      assert.strictEqual(result.markers.length, 0);
    });

    it('handles complete replacement', () => {
      const result = computeDeepDiff(['hello', 'goodbye']);
      assert.strictEqual(result.text, 'goodbye');
      assert.strictEqual(result.markers.length, 1);
      
      const marker = result.markers[0];
      const markedText = result.text.slice(marker.start, marker.end + 1);
      assert.strictEqual(markedText, 'goodbye');
    });

  });

  describe('marker shifting (insert before existing marker)', () => {

    it('shifts marker right when text inserted before it', () => {
      const revisions = [
        'cat sat',
        'cat sat here',
        'the cat sat here'
      ];
      const result = computeDeepDiff(revisions);
      
      const hereMarker = result.markers.find(m => {
        const text = result.text.slice(m.start, m.end + 1);
        return text.includes('here');
      });
      
      assert.ok(hereMarker, 'marker containing "here" should exist');
      assert.ok(hereMarker.start >= 11, 'marker should have shifted right');
    });

    it('shifts multiple markers when text inserted at beginning', () => {
      const revisions = [
        'a b c',
        'a X b Y c',
        'START a X b Y c'
      ];
      const result = computeDeepDiff(revisions);

      // New markers are added for the "START " prefix at position 0
      // Existing markers from revision 2 should shift past "START " (6 chars)
      const shiftedMarkers = result.markers.filter(m => m.start > 0);
      assert.ok(shiftedMarkers.length > 0, 'should have shifted markers');
      shiftedMarkers.forEach(m => {
        assert.ok(m.start >= 6, 'existing markers should have shifted past "START "');
      });
    });

  });

  describe('marker shifting (delete before existing marker)', () => {

    it('shifts marker left when text deleted before it', () => {
      const revisions = [
        'hello world',
        'hello world!',
        'world!'
      ];
      const result = computeDeepDiff(revisions);
      
      const exclamationMarker = result.markers.find(m => {
        const text = result.text.slice(m.start, m.end + 1);
        return text.includes('!');
      });
      
      assert.ok(exclamationMarker, 'marker containing "!" should exist');
      assert.strictEqual(exclamationMarker.start, 5, 'marker should shift to position 5');
    });

  });

  describe('marker expansion (insert within existing marker)', () => {

    it('expands marker when text inserted within it', () => {
      const revisions = [
        'hello',
        'hello world',
        'hello big world'
      ];
      const result = computeDeepDiff(revisions);
      
      const worldMarker = result.markers.find(m => {
        const text = result.text.slice(m.start, m.end + 1);
        return text.includes('world');
      });
      
      assert.ok(worldMarker, 'marker containing "world" should exist');
      const markedText = result.text.slice(worldMarker.start, worldMarker.end + 1);
      assert.ok(markedText.includes('big'), 'marker should have expanded to include "big"');
    });

  });

  describe('marker contraction (delete within existing marker)', () => {

    it('contracts marker when text deleted within it', () => {
      const revisions = [
        'hello',
        'hello beautiful world',
        'hello world'
      ];
      const result = computeDeepDiff(revisions);
      
      const worldMarker = result.markers.find(m => {
        const text = result.text.slice(m.start, m.end + 1);
        return text.includes('world');
      });
      
      assert.ok(worldMarker, 'marker should still exist');
      const markedText = result.text.slice(worldMarker.start, worldMarker.end + 1);
      assert.ok(!markedText.includes('beautiful'), 'marker should have contracted');
    });

    it('disables marker when completely subsumed by deletion', () => {
      const revisions = [
        'hello',
        'hello beautiful',
        'hello'
      ];
      const result = computeDeepDiff(revisions);
      
      assert.strictEqual(result.markers.length, 0, 'subsumed marker should be removed');
    });

  });

  describe('cumulative changes (nested markers)', () => {

    it('creates markers for repeatedly changed regions', () => {
      const revisions = [
        'I said hello.',
        'I said hi.',
        'I said hey.',
        'I said yo.'
      ];
      const result = computeDeepDiff(revisions);

      assert.ok(result.markers.length >= 1, 'should have markers');

      // The algorithm creates markers for each minimal change
      // "yo" may be covered by multiple single-character markers
      const yoStart = result.text.indexOf('yo');
      const markersInYoRegion = result.markers.filter(m =>
        m.start >= yoStart && m.end <= yoStart + 1
      );
      assert.ok(markersInYoRegion.length >= 1, 'should have marker(s) in the "yo" region');
    });

    it('matches the original test case behaviour', () => {
      const revisions = [
        'Metamorphosis in biology is physical development.',
        'Metamorphosis in cosmology is a physical development.',
        'Metamorphosis in cosmology is physical development.',
        'Metamorphosis in cosmology is physical development. I put in a new sentence here, yo.',
        'Metamorphosis in cosmology is physical development. I put in a new bunch of words here, yo.',
        'Metamorphosis in cosmology is physical development. I put in a new collection of words here, yo.'
      ];

      const result = computeDeepDiff(revisions);

      // "cosmology" region: only "cosm" is marked (replacing "bi" from "biology")
      const cosmologyStart = result.text.indexOf('cosmology');
      const hasCosmologyRegionMarker = result.markers.some(m =>
        m.start >= cosmologyStart && m.start <= cosmologyStart + 8
      );
      assert.ok(hasCosmologyRegionMarker, 'should have marker in "cosmology" region');

      const hasCollectionMarker = result.markers.some(m => {
        const text = result.text.slice(m.start, m.end + 1);
        return text.includes('collection');
      });
      assert.ok(hasCollectionMarker, 'should have marker on "collection"');
    });

  });

  describe('options', () => {

    it('skips empty revisions by default', () => {
      const revisions = ['hello', '', '', 'hello world'];
      const result = computeDeepDiff(revisions);
      assert.strictEqual(result.text, 'hello world');
      assert.strictEqual(result.markers.length, 1);
    });

    it('includes empty revisions when skipEmpty is false', () => {
      const revisions = ['hello', ''];
      const result = computeDeepDiff(revisions, { skipEmpty: false });
      assert.strictEqual(result.text, '');
    });

    it('respects timeout option without throwing', () => {
      const result = computeDeepDiff(['hello', 'world'], { timeout: 0.5 });
      assert.ok(result.text);
    });

  });

  describe('edge cases', () => {

    it('handles unicode characters', () => {
      const result = computeDeepDiff(['hello', 'hello 世界']);
      assert.strictEqual(result.text, 'hello 世界');
      assert.strictEqual(result.markers.length, 1);
    });

    it('handles emoji', () => {
      const result = computeDeepDiff(['hello', 'hello 👋']);
      assert.strictEqual(result.text, 'hello 👋');
      assert.ok(result.markers.length >= 1);
    });

    it('never splits surrogate pairs when emoji share a high surrogate', () => {
      // 🙂 and 🙁 share the high surrogate \ud83d, so diff-match-patch
      // factors it into the common prefix and the diff carries a lone low
      // surrogate. Markers must widen back to the code point boundary.
      const result = computeDeepDiff(['hi 🙂 there', 'hi 🙁 there']);
      for (const m of result.markers) {
        const slice = result.text.slice(m.start, m.end + 1);
        assert.ok(!/^[\udc00-\udfff]/.test(slice), 'must not start mid-pair');
        assert.ok(!/[\ud800-\udbff]$/.test(slice), 'must not end mid-pair');
      }
      const covering = result.markers.find(m =>
        result.text.slice(m.start, m.end + 1).includes('🙁'));
      assert.ok(covering, 'replacement emoji should be covered whole');
    });

    it('drops degenerate markers (end < start) instead of emitting unbalanced tags', () => {
      // A zero-length marker used to emit its close tag before its open tag
      // on the fast path ('ab</ins><ins class="deep-diff">c') and leak onto
      // the following text on the dataAttributes path.
      for (const dataAttributes of [false, true]) {
        const html = renderWithMarkers('abc', [{ start: 2, end: 1, enabled: true }],
          { dataAttributes });
        assert.strictEqual(html, 'abc');
      }
    });

    it('render snaps caller-supplied markers off surrogate halves', () => {
      // Marker [4,4] covers only the low surrogate of 🙁; rendering must
      // move the tag boundary off the intra-pair position.
      const html = renderWithMarkers('hi 🙁 there',
        [{ start: 4, end: 4, enabled: true }]);
      assert.strictEqual(html, 'hi <ins class="deep-diff">🙁</ins> there');
    });

    it('returns markers in deterministic (start, end, revision) order', () => {
      const revs = ['aaaa bbbb cccc', 'aaaa bbbb ccccXX', 'YYaaaa bbbb ccccXX'];
      const a = computeDeepDiff(revs).markers;
      const b = computeDeepDiff([...revs, revs[2]]).markers;
      assert.deepStrictEqual(
        a.map(m => [m.start, m.end, m.revision]),
        b.map(m => [m.start, m.end, m.revision]),
        'appending a no-op revision must not reorder markers'
      );
      const sorted = [...a].sort((x, y) =>
        x.start - y.start || x.end - y.end || x.revision - y.revision);
      assert.deepStrictEqual(a, sorted, 'markers should be sorted');
    });

    it('handles newlines', () => {
      const result = computeDeepDiff(['line1', 'line1\nline2']);
      assert.ok(result.text.includes('\n'));
    });

    it('handles very long text', () => {
      const longText = 'a'.repeat(10000);
      const result = computeDeepDiff([longText, longText + 'b']);
      assert.strictEqual(result.markers.length, 1);
    });

    it('handles many revisions', () => {
      const revisions = [];
      let text = 'start';
      for (let i = 0; i < 50; i++) {
        text += ' word' + i;
        revisions.push(text);
      }
      const result = computeDeepDiff(revisions);
      assert.ok(result.markers.length > 0);
    });

  });

});

// ============================================================================
// renderWithMarkers - Rendering Tests
// ============================================================================

describe('renderWithMarkers', () => {

  describe('basic rendering', () => {

    it('returns text unchanged when no markers', () => {
      const html = renderWithMarkers('hello world', []);
      assert.strictEqual(html, 'hello world');
    });

    it('wraps single marker in tags', () => {
      const markers = [{ start: 0, end: 4, enabled: true }];
      const html = renderWithMarkers('hello world', markers);
      assert.strictEqual(html, '<ins class="deep-diff">hello</ins> world');
    });

    it('wraps marker at end of text', () => {
      const markers = [{ start: 6, end: 10, enabled: true }];
      const html = renderWithMarkers('hello world', markers);
      assert.strictEqual(html, 'hello <ins class="deep-diff">world</ins>');
    });

    it('wraps entire text', () => {
      const markers = [{ start: 0, end: 4, enabled: true }];
      const html = renderWithMarkers('hello', markers);
      assert.strictEqual(html, '<ins class="deep-diff">hello</ins>');
    });

  });

  describe('HTML escaping', () => {

    it('escapes angle brackets', () => {
      const html = renderWithMarkers('<script>alert("xss")</script>', []);
      assert.ok(!html.includes('<script>'));
      assert.ok(html.includes('&lt;script&gt;'));
    });

    it('escapes ampersands', () => {
      const html = renderWithMarkers('Tom & Jerry', []);
      assert.ok(html.includes('&amp;'));
    });

    it('escapes quotes', () => {
      const html = renderWithMarkers('He said "hello"', []);
      assert.ok(html.includes('&quot;'));
    });

    it('escapes within marked regions', () => {
      const markers = [{ start: 0, end: 2, enabled: true }];
      const html = renderWithMarkers('<b>', markers);
      assert.ok(html.includes('&lt;b&gt;'));
    });

  });

  describe('multiple markers', () => {

    it('renders non-overlapping markers', () => {
      const markers = [
        { start: 0, end: 4, enabled: true },
        { start: 6, end: 10, enabled: true }
      ];
      const html = renderWithMarkers('hello world', markers);
      assert.ok(html.includes('<ins class="deep-diff">hello</ins>'));
      assert.ok(html.includes('<ins class="deep-diff">world</ins>'));
    });

    it('renders nested/overlapping markers', () => {
      const markers = [
        { start: 0, end: 10, enabled: true },
        { start: 6, end: 10, enabled: true }
      ];
      const html = renderWithMarkers('hello world', markers);
      
      const insCount = (html.match(/<ins/g) || []).length;
      assert.strictEqual(insCount, 2, 'should have 2 opening ins tags');
    });

  });

  describe('options', () => {

    it('uses custom tag name', () => {
      const markers = [{ start: 0, end: 4, enabled: true }];
      const html = renderWithMarkers('hello', markers, { tagName: 'mark' });
      assert.ok(html.includes('<mark'));
      assert.ok(html.includes('</mark>'));
      assert.ok(!html.includes('<ins'));
    });

    it('uses custom class name', () => {
      const markers = [{ start: 0, end: 4, enabled: true }];
      const html = renderWithMarkers('hello', markers, { className: 'changed' });
      assert.ok(html.includes('class="changed"'));
      assert.ok(!html.includes('deep-diff'));
    });

    it('omits class when className is empty', () => {
      const markers = [{ start: 0, end: 4, enabled: true }];
      const html = renderWithMarkers('hello', markers, { className: '' });
      assert.ok(html.includes('<ins>'));
      assert.ok(!html.includes('class='));
    });

  });

  describe('edge cases', () => {

    it('handles empty text', () => {
      const html = renderWithMarkers('', []);
      assert.strictEqual(html, '');
    });

    it('handles marker at position 0 with length 1', () => {
      const markers = [{ start: 0, end: 0, enabled: true }];
      const html = renderWithMarkers('a', markers);
      assert.strictEqual(html, '<ins class="deep-diff">a</ins>');
    });

    it('filters disabled markers', () => {
      const markers = [
        { start: 0, end: 4, enabled: false },
        { start: 6, end: 10, enabled: true }
      ];
      const html = renderWithMarkers('hello world', markers);
      
      const insCount = (html.match(/<ins/g) || []).length;
      assert.strictEqual(insCount, 1, 'should only render enabled markers');
    });

  });

});

// ============================================================================
// deepDiffHtml - Integration Tests
// ============================================================================

describe('deepDiffHtml', () => {

  it('combines compute and render', () => {
    const html = deepDiffHtml(['hello', 'hello world']);
    assert.ok(html.includes('<ins'));
    assert.ok(html.includes('world'));
  });

  it('passes options through', () => {
    const html = deepDiffHtml(['hello', 'hello world'], { 
      tagName: 'mark',
      className: 'diff'
    });
    assert.ok(html.includes('<mark'));
    assert.ok(html.includes('class="diff"'));
  });

  it('handles the full original test case', () => {
    const revisions = [
      'Metamorphosis is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. Metamorphosis usually accompanies a change of habitat or of habits. In some species, however, it is merely development through a series of forms which may represent ancestral stages of the species; see ontogeny recapitulates phylogeny.',
      'Metamorphosis in biology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. It was once thought that in those cases where the animal habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.',
      'Metamorphosis in cosmology is a physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. It was once thought that in those cases where the animal habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.',
      'Metamorphosis in cosmology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. I put in a new sentence here, yo. It was once thought that in those cases where the animal habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.',
      'Metamorphosis in cosmology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. I put in a new bunch of words here, yo. It was once thought that in those cases where the animal habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.',
      'Metamorphosis in cosmology is physical development of the individual after birth or hatching involving significant change in form as well as growth and differentiation. It usually accompanies a change of habitat or of habits but may occur without such change. I put in a new collection of words here, yo. It was once thought that in those cases where the animal habitat remains unchanged metamorphosis followed a series of forms representing evolutionary ancestors of the species in question (see ontogeny recapitulates phylogeny), but this is no longer thought to be the case.'
    ];

    const html = deepDiffHtml(revisions);
    
    assert.ok(html.includes('<ins'));
    // Note: "cosmology" may be split by tags (e.g., <ins>cosm</ins>ology)
    // because only the changed portion "cosm" (replacing "bi" from "biology") is marked
    const textContent = html.replace(/<[^>]+>/g, '');
    assert.ok(textContent.includes('cosmology'), 'text should contain cosmology');
    assert.ok(textContent.includes('collection'), 'text should contain collection');
    
    const opens = (html.match(/<ins/g) || []).length;
    const closes = (html.match(/<\/ins>/g) || []).length;
    assert.strictEqual(opens, closes, 'ins tags should be balanced');
  });

});

// ============================================================================
// getDefaultStyles - CSS Generation Tests
// ============================================================================

describe('getDefaultStyles', () => {

  it('generates valid CSS', () => {
    const css = getDefaultStyles();
    assert.ok(css.includes('.deep-diff'));
    assert.ok(css.includes('background-color'));
    assert.ok(css.includes('rgba'));
  });

  it('generates base style', () => {
    const css = getDefaultStyles(1);
    assert.ok(css.includes('.deep-diff {'));
  });

  it('generates nested selectors up to maxDepth', () => {
    const css = getDefaultStyles(3);
    
    assert.ok(css.includes('.deep-diff {'));
    assert.ok(css.includes('.deep-diff .deep-diff {'));
    assert.ok(css.includes('.deep-diff .deep-diff .deep-diff {'));
  });

  it('increases intensity with nesting depth', () => {
    const css = getDefaultStyles(3);
    
    const opacities = css.match(/rgba\([^)]+,\s*([\d.]+)\)/g);
    assert.ok(opacities.length >= 3, 'should have multiple rgba values');
  });

  it('respects maxDepth parameter', () => {
    const css2 = getDefaultStyles(2);
    const css5 = getDefaultStyles(5);
    
    assert.ok(css5.length > css2.length, 'more depth should produce more CSS');
  });

  it('defaults to depth 5', () => {
    const cssDefault = getDefaultStyles();
    const css5 = getDefaultStyles(5);
    
    assert.strictEqual(cssDefault, css5);
  });

});

// ============================================================================
// Marker class behaviour (via computeDeepDiff internals)
// ============================================================================

describe('Marker behaviour', () => {

  it('markers have correct structure', () => {
    const { markers } = computeDeepDiff(['a', 'ab']);
    
    assert.ok(markers.length > 0);
    const marker = markers[0];
    
    assert.ok('start' in marker);
    assert.ok('end' in marker);
    assert.ok('enabled' in marker);
    assert.strictEqual(typeof marker.start, 'number');
    assert.strictEqual(typeof marker.end, 'number');
    assert.strictEqual(typeof marker.enabled, 'boolean');
  });

  it('marker.enabled is true for active markers', () => {
    const { markers } = computeDeepDiff(['a', 'ab']);
    
    markers.forEach(m => {
      assert.strictEqual(m.enabled, true);
    });
  });

  it('disabled markers are filtered from results', () => {
    const { markers } = computeDeepDiff([
      'hello',
      'hello world',
      'hello'
    ]);
    
    markers.forEach(m => {
      assert.strictEqual(m.enabled, true, 'returned markers should be enabled');
    });
  });

});

// ============================================================================
// Performance / Stress Tests
// ============================================================================

describe('performance', () => {

  it('handles 100 revisions in reasonable time', () => {
    const revisions = [''];
    for (let i = 0; i < 100; i++) {
      revisions.push(revisions[revisions.length - 1] + ' word' + i);
    }
    
    const start = Date.now();
    const result = computeDeepDiff(revisions);
    const elapsed = Date.now() - start;
    
    assert.ok(elapsed < 5000, 'should complete in < 5s, took ' + elapsed + 'ms');
    assert.ok(result.markers.length > 0);
  });

  it('handles large text (100KB)', () => {
    const largeText = 'Lorem ipsum dolor sit amet. '.repeat(4000);
    const modified = largeText + ' ADDED';
    
    const start = Date.now();
    const result = computeDeepDiff([largeText, modified]);
    const elapsed = Date.now() - start;
    
    assert.ok(elapsed < 5000, 'should complete in < 5s, took ' + elapsed + 'ms');
    assert.ok(result.markers.length > 0);
  });

});

// ============================================================================
// Result metadata
// ============================================================================

describe('result metadata', () => {

  it('reports revisionCount for multiple revisions', () => {
    const result = computeDeepDiff(['a', 'ab', 'abc']);
    assert.strictEqual(result.revisionCount, 3);
  });

  it('reports revisionCount 1 for a single revision', () => {
    const result = computeDeepDiff(['solo']);
    assert.strictEqual(result.revisionCount, 1);
  });

  it('reports revisionCount 0 for empty input', () => {
    const result = computeDeepDiff([]);
    assert.strictEqual(result.revisionCount, 0);
  });

  it('counts only revisions that survive filtering', () => {
    const result = computeDeepDiff(['a', '', 'a b']);
    assert.strictEqual(result.revisionCount, 2);
  });

  it('records birth revision on markers (1-based)', () => {
    const { markers } = computeDeepDiff(['hello', 'hello world']);
    assert.strictEqual(markers[0].revision, 1);
    assert.strictEqual(markers[0].lastTouched, 1);
  });

  it('updates lastTouched when a later revision edits the region', () => {
    // ' world' (rev 1) is expanded by 'big ' (rev 2)
    const { markers } = computeDeepDiff(['hello', 'hello world', 'hello big world']);
    const worldMarker = markers.find(m => m.revision === 1);
    assert.ok(worldMarker);
    assert.strictEqual(worldMarker.lastTouched, 2);
    const bigMarker = markers.find(m => m.revision === 2);
    assert.ok(bigMarker);
    assert.strictEqual(bigMarker.lastTouched, 2);
  });

});

// ============================================================================
// Deletion tombstones (trackDeletions)
// ============================================================================

describe('deletion tombstones (trackDeletions)', () => {

  it('does not add a deletions property by default', () => {
    const result = computeDeepDiff(['hello world', 'hello']);
    assert.ok(!('deletions' in result));
  });

  it('returns an empty deletions array for a single revision', () => {
    const result = computeDeepDiff(['solo'], { trackDeletions: true });
    assert.deepStrictEqual(result.deletions, []);
  });

  it('returns an empty deletions array when nothing was deleted', () => {
    const result = computeDeepDiff(['hello', 'hello world'], { trackDeletions: true });
    assert.deepStrictEqual(result.deletions, []);
  });

  it('records a deletion at the end of the text', () => {
    const result = computeDeepDiff(['hello world', 'hello'], { trackDeletions: true });
    assert.deepStrictEqual(result.deletions, [
      { index: 5, text: ' world', revision: 1 }
    ]);
  });

  it('records a deletion at the beginning of the text', () => {
    const result = computeDeepDiff(['hello world', 'world'], { trackDeletions: true });
    assert.deepStrictEqual(result.deletions, [
      { index: 0, text: 'hello ', revision: 1 }
    ]);
  });

  it('records multiple deletions in one revision', () => {
    const result = computeDeepDiff(
      ['AA one two BB three', 'one two three'],
      { trackDeletions: true }
    );
    assert.deepStrictEqual(result.deletions, [
      { index: 0, text: 'AA ', revision: 1 },
      { index: 8, text: 'BB ', revision: 1 }
    ]);
  });

  it('records a replacement as tombstone at the replacement point', () => {
    const result = computeDeepDiff(['the cat sat', 'the dog sat'], { trackDeletions: true });
    assert.deepStrictEqual(result.deletions, [
      { index: 4, text: 'cat', revision: 1 }
    ]);
    // The replacement text is a normal insertion marker
    assert.strictEqual(result.markers.length, 1);
    assert.strictEqual(result.text.slice(result.markers[0].start, result.markers[0].end + 1), 'dog');
  });

  it('leaves the tombstone in place when text is later inserted at the same point', () => {
    // rev1 deletes 'two ' at index 4; rev2 inserts 'BIG ' at index 4.
    // The tombstone stays at 4, so the ghost reads chronologically
    // (deleted text before its replacement).
    const result = computeDeepDiff(
      ['one two three', 'one three', 'one BIG three'],
      { trackDeletions: true }
    );
    assert.deepStrictEqual(result.deletions, [
      { index: 4, text: 'two ', revision: 1 }
    ]);
  });

  it('shifts tombstone right through an earlier insertion', () => {
    // Tombstone born at index 3 in 'aa cc'; 'XX ' inserted at 0 shifts it to 6
    const result = computeDeepDiff(
      ['aa bb cc', 'aa cc', 'XX aa cc'],
      { trackDeletions: true }
    );
    assert.deepStrictEqual(result.deletions, [
      { index: 6, text: 'bb ', revision: 1 }
    ]);
  });

  it('shifts tombstone left through an earlier deletion', () => {
    // Tombstone born at index 5 in 'XX aa'; deleting 'XX ' shifts it to 2
    const result = computeDeepDiff(
      ['XX aa bb', 'XX aa', 'aa'],
      { trackDeletions: true }
    );
    const rev1 = result.deletions.find(d => d.revision === 1);
    assert.deepStrictEqual(rev1, { index: 2, text: ' bb', revision: 1 });
  });

  it('collapses a tombstone swallowed by a later deletion, stacking at one index', () => {
    // rev1 deletes 'cc ' (tombstone at 6 in 'aa bb dd');
    // rev2 deletes ' bb dd' [2..7], which straddles index 6 -> collapse to 2
    const result = computeDeepDiff(
      ['aa bb cc dd', 'aa bb dd', 'aa'],
      { trackDeletions: true }
    );
    assert.deepStrictEqual(result.deletions, [
      { index: 2, text: 'cc ', revision: 1 },
      { index: 2, text: ' bb dd', revision: 2 }
    ]);
  });

  it('sorts deletions by index, then revision', () => {
    const result = computeDeepDiff(
      ['XX aa bb', 'XX aa', 'aa'],
      { trackDeletions: true }
    );
    // rev2 deleted 'XX ' at 0; rev1 tombstone shifted to 2
    assert.deepStrictEqual(result.deletions, [
      { index: 0, text: 'XX ', revision: 2 },
      { index: 2, text: ' bb', revision: 1 }
    ]);
  });

  it('never leaves a tombstone point between the halves of a surrogate pair', () => {
    // 🙂 and 🙃 share the high surrogate \ud83d, so the diff deletes/inserts
    // lone low surrogates and the raw deletion point lands mid-pair in the
    // final text. The point must snap left, in front of the whole emoji.
    const result = computeDeepDiff(['x 🙂 y', 'x 🙃 y'], { trackDeletions: true });
    for (const d of result.deletions) {
      const before = result.text.charCodeAt(d.index - 1);
      const at = result.text.charCodeAt(d.index);
      assert.ok(
        !(before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff),
        `tombstone index ${d.index} sits between surrogate halves`
      );
    }
    assert.strictEqual(result.deletions[0].index, 2); // before the 🙃, not inside it
  });

});

// ============================================================================
// renderWithMarkers - renderDeletions (ghosts)
// ============================================================================

describe('renderWithMarkers renderDeletions', () => {

  it('interleaves a ghost <del> at the tombstone position', () => {
    const { text, markers, deletions } = computeDeepDiff(
      ['hello world', 'hello'],
      { trackDeletions: true }
    );
    const html = renderWithMarkers(text, markers, { renderDeletions: deletions });
    assert.strictEqual(html, 'hello<del class="deep-diff-ghost"> world</del>');
  });

  it('renders the ghost before text inserted at the same point (replacement)', () => {
    const { text, markers, deletions } = computeDeepDiff(
      ['the cat sat', 'the dog sat'],
      { trackDeletions: true }
    );
    const html = renderWithMarkers(text, markers, { renderDeletions: deletions });
    assert.strictEqual(
      html,
      'the <del class="deep-diff-ghost">cat</del><ins class="deep-diff">dog</ins> sat'
    );
  });

  it('escapes HTML in ghost text', () => {
    const html = renderWithMarkers('hello', [], {
      renderDeletions: [{ index: 5, text: ' <b>"&</b>', revision: 1 }]
    });
    assert.ok(html.includes('&lt;b&gt;&quot;&amp;&lt;/b&gt;'));
    assert.ok(!html.includes('<b>'));
  });

  it('renders stacked ghosts at one index in revision order', () => {
    const html = renderWithMarkers('aa', [], {
      renderDeletions: [
        { index: 2, text: 'second', revision: 2 },
        { index: 2, text: 'first', revision: 1 }
      ]
    });
    assert.strictEqual(
      html,
      'aa<del class="deep-diff-ghost">first</del><del class="deep-diff-ghost">second</del>'
    );
  });

  it('clamps out-of-range tombstone positions to the text bounds', () => {
    const html = renderWithMarkers('ab', [], {
      renderDeletions: [{ index: 999, text: 'x', revision: 1 }]
    });
    assert.strictEqual(html, 'ab<del class="deep-diff-ghost">x</del>');
  });

  it('never renders a ghost between the halves of a surrogate pair', () => {
    // Caller-supplied tombstone whose point sits inside 🙃 (indices 2..3):
    // the <del> must move in front of the pair, on both render paths.
    for (const dataAttributes of [false, true]) {
      const html = renderWithMarkers('x 🙃 y', [], {
        renderDeletions: [{ index: 3, text: '\ude42', revision: 1 }],
        dataAttributes
      });
      assert.ok(html.includes('🙃'), 'pair must stay intact: ' + JSON.stringify(html));
    }
    // End-to-end: shared high surrogate replacement via deepDiffHtml
    const html = deepDiffHtml(['x 🙂 y', 'x 🙃 y'], { renderDeletions: true });
    assert.ok(html.includes('🙃'), 'pair must stay intact: ' + JSON.stringify(html));
    assert.ok(html.includes('deep-diff-ghost'), 'ghost must still render');
  });

  it('empty renderDeletions array leaves output byte-identical to default', () => {
    const markers = [{ start: 0, end: 4, enabled: true }];
    const a = renderWithMarkers('hello world', markers);
    const b = renderWithMarkers('hello world', markers, { renderDeletions: [] });
    assert.strictEqual(a, b);
  });

  it('adds data-revision to ghosts when dataAttributes is on', () => {
    const html = renderWithMarkers('ab', [], {
      renderDeletions: [{ index: 1, text: 'x', revision: 3 }],
      dataAttributes: true
    });
    assert.strictEqual(html, 'a<del class="deep-diff-ghost" data-revision="3">x</del>b');
  });

  it('deepDiffHtml renderDeletions: true auto-enables tracking', () => {
    const html = deepDiffHtml(['hello world', 'hello'], { renderDeletions: true });
    assert.strictEqual(html, 'hello<del class="deep-diff-ghost"> world</del>');
  });

  it('deepDiffHtml respects an explicit trackDeletions: false', () => {
    const html = deepDiffHtml(['hello world', 'hello'], {
      renderDeletions: true,
      trackDeletions: false
    });
    assert.strictEqual(html, 'hello');
  });

});

// ============================================================================
// renderWithMarkers - dataAttributes
// ============================================================================

describe('renderWithMarkers dataAttributes', () => {

  it('default output is byte-identical with dataAttributes false or omitted', () => {
    const markers = [
      { start: 0, end: 10, enabled: true, revision: 1, lastTouched: 1 },
      { start: 6, end: 10, enabled: true, revision: 2, lastTouched: 2 }
    ];
    const a = renderWithMarkers('hello world', markers);
    const b = renderWithMarkers('hello world', markers, { dataAttributes: false });
    assert.strictEqual(a, b);
    assert.strictEqual(a,
      '<ins class="deep-diff">hello <ins class="deep-diff">world</ins></ins>');
  });

  it('emits data-revision, data-last-touched, and data-depth', () => {
    const markers = [{ start: 0, end: 4, enabled: true, revision: 3, lastTouched: 5 }];
    const html = renderWithMarkers('hello', markers, { dataAttributes: true });
    assert.strictEqual(html,
      '<ins class="deep-diff" data-revision="3" data-last-touched="5" data-depth="1">hello</ins>');
  });

  it('data-depth increases with nesting', () => {
    const markers = [
      { start: 0, end: 10, enabled: true, revision: 1, lastTouched: 1 },
      { start: 6, end: 10, enabled: true, revision: 2, lastTouched: 2 }
    ];
    const html = renderWithMarkers('hello world', markers, { dataAttributes: true });
    assert.strictEqual(html,
      '<ins class="deep-diff" data-revision="1" data-last-touched="1" data-depth="1">hello ' +
      '<ins class="deep-diff" data-revision="2" data-last-touched="2" data-depth="2">world</ins></ins>');
  });

  it('closes and reopens tags at partial overlaps to keep attribution correct', () => {
    const markers = [
      { start: 0, end: 5, enabled: true, revision: 1, lastTouched: 1 },
      { start: 3, end: 8, enabled: true, revision: 2, lastTouched: 2 }
    ];
    const html = renderWithMarkers('abcdefghij', markers, { dataAttributes: true });
    assert.strictEqual(html,
      '<ins class="deep-diff" data-revision="1" data-last-touched="1" data-depth="1">abc' +
      '<ins class="deep-diff" data-revision="2" data-last-touched="2" data-depth="2">def</ins></ins>' +
      '<ins class="deep-diff" data-revision="2" data-last-touched="2" data-depth="1">ghi</ins>j');
  });

  it('defaults missing revision metadata to 0', () => {
    const markers = [{ start: 0, end: 1, enabled: true }];
    const html = renderWithMarkers('ab', markers, { dataAttributes: true });
    assert.ok(html.includes('data-revision="0"'));
    assert.ok(html.includes('data-last-touched="0"'));
  });

  it('respects custom tagName and className', () => {
    const markers = [{ start: 0, end: 1, enabled: true, revision: 1, lastTouched: 1 }];
    const html = renderWithMarkers('ab', markers, {
      dataAttributes: true, tagName: 'mark', className: 'hot'
    });
    assert.strictEqual(html,
      '<mark class="hot" data-revision="1" data-last-touched="1" data-depth="1">ab</mark>');
  });

  it('keeps tags balanced across messy overlaps', () => {
    const markers = [
      { start: 0, end: 7, enabled: true, revision: 1, lastTouched: 1 },
      { start: 2, end: 9, enabled: true, revision: 2, lastTouched: 2 },
      { start: 4, end: 5, enabled: true, revision: 3, lastTouched: 3 },
      { start: 4, end: 5, enabled: true, revision: 4, lastTouched: 4 }
    ];
    const html = renderWithMarkers('abcdefghij', markers, { dataAttributes: true });
    const opens = (html.match(/<ins/g) || []).length;
    const closes = (html.match(/<\/ins>/g) || []).length;
    assert.strictEqual(opens, closes);
    assert.strictEqual(html.replace(/<[^>]+>/g, ''), 'abcdefghij');
  });

  it('escapes text content', () => {
    const markers = [{ start: 0, end: 2, enabled: true, revision: 1 }];
    const html = renderWithMarkers('<b>', markers, { dataAttributes: true });
    assert.ok(html.includes('&lt;b&gt;'));
  });

});

// ============================================================================
// computeHeatSegments
// ============================================================================

describe('computeHeatSegments', () => {

  it('returns [] for empty text', () => {
    assert.deepStrictEqual(computeHeatSegments('', []), []);
  });

  it('returns a single depth-0 segment when there are no markers', () => {
    assert.deepStrictEqual(computeHeatSegments('hello', []), [
      { start: 0, end: 5, depth: 0, revision: 0, lastTouched: 0 }
    ]);
  });

  it('splits around a single marker', () => {
    const markers = [{ start: 2, end: 3, enabled: true, revision: 1, lastTouched: 1 }];
    assert.deepStrictEqual(computeHeatSegments('abcdef', markers), [
      { start: 0, end: 2, depth: 0, revision: 0, lastTouched: 0 },
      { start: 2, end: 4, depth: 1, revision: 1, lastTouched: 1 },
      { start: 4, end: 6, depth: 0, revision: 0, lastTouched: 0 }
    ]);
  });

  it('handles nested markers', () => {
    const markers = [
      { start: 0, end: 10, enabled: true, revision: 1, lastTouched: 1 },
      { start: 6, end: 10, enabled: true, revision: 2, lastTouched: 2 }
    ];
    assert.deepStrictEqual(computeHeatSegments('hello world', markers), [
      { start: 0, end: 6, depth: 1, revision: 1, lastTouched: 1 },
      { start: 6, end: 11, depth: 2, revision: 2, lastTouched: 2 }
    ]);
  });

  it('handles partial overlaps', () => {
    const markers = [
      { start: 0, end: 5, enabled: true, revision: 1, lastTouched: 1 },
      { start: 3, end: 8, enabled: true, revision: 2, lastTouched: 2 }
    ];
    assert.deepStrictEqual(computeHeatSegments('abcdefghij', markers), [
      { start: 0, end: 3, depth: 1, revision: 1, lastTouched: 1 },
      { start: 3, end: 6, depth: 2, revision: 2, lastTouched: 2 },
      { start: 6, end: 9, depth: 1, revision: 2, lastTouched: 2 },
      { start: 9, end: 10, depth: 0, revision: 0, lastTouched: 0 }
    ]);
  });

  it('merges adjacent markers with identical metadata into one segment', () => {
    const markers = [
      { start: 0, end: 2, enabled: true, revision: 1, lastTouched: 1 },
      { start: 3, end: 5, enabled: true, revision: 1, lastTouched: 1 }
    ];
    assert.deepStrictEqual(computeHeatSegments('abcdef', markers), [
      { start: 0, end: 6, depth: 1, revision: 1, lastTouched: 1 }
    ]);
  });

  it('keeps adjacent markers from different revisions as separate segments', () => {
    const markers = [
      { start: 0, end: 2, enabled: true, revision: 1, lastTouched: 1 },
      { start: 3, end: 5, enabled: true, revision: 2, lastTouched: 2 }
    ];
    assert.deepStrictEqual(computeHeatSegments('abcdef', markers), [
      { start: 0, end: 3, depth: 1, revision: 1, lastTouched: 1 },
      { start: 3, end: 6, depth: 1, revision: 2, lastTouched: 2 }
    ]);
  });

  it('counts duplicate ranges as depth 2 with the max revision', () => {
    const markers = [
      { start: 1, end: 3, enabled: true, revision: 1, lastTouched: 1 },
      { start: 1, end: 3, enabled: true, revision: 4, lastTouched: 5 }
    ];
    assert.deepStrictEqual(computeHeatSegments('abcde', markers), [
      { start: 0, end: 1, depth: 0, revision: 0, lastTouched: 0 },
      { start: 1, end: 4, depth: 2, revision: 4, lastTouched: 5 },
      { start: 4, end: 5, depth: 0, revision: 0, lastTouched: 0 }
    ]);
  });

  it('ignores disabled markers', () => {
    const markers = [
      { start: 0, end: 4, enabled: false, revision: 1, lastTouched: 1 }
    ];
    assert.deepStrictEqual(computeHeatSegments('hello', markers), [
      { start: 0, end: 5, depth: 0, revision: 0, lastTouched: 0 }
    ]);
  });

  it('treats markers without an enabled flag as active', () => {
    const segments = computeHeatSegments('hello', [{ start: 0, end: 4, revision: 2 }]);
    assert.deepStrictEqual(segments, [
      { start: 0, end: 5, depth: 1, revision: 2, lastTouched: 2 }
    ]);
  });

  it('segments tile the text exactly', () => {
    const { text, markers } = computeDeepDiff([
      'The cat sat.',
      'The big cat sat here.',
      'The very big cat sat over here.'
    ]);
    const segments = computeHeatSegments(text, markers);
    assert.strictEqual(segments[0].start, 0);
    assert.strictEqual(segments[segments.length - 1].end, text.length);
    for (let i = 1; i < segments.length; i++) {
      assert.strictEqual(segments[i].start, segments[i - 1].end, 'segments must be contiguous');
    }
    segments.forEach(s => assert.ok(s.end > s.start, 'segments must be non-empty'));
  });

});

// ============================================================================
// normalizeMarkers
// ============================================================================

describe('normalizeMarkers', () => {

  it('merges overlapping markers from the same revision', () => {
    const merged = normalizeMarkers([
      { start: 0, end: 5, enabled: true, revision: 1, lastTouched: 1 },
      { start: 3, end: 8, enabled: true, revision: 1, lastTouched: 1 }
    ]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].start, 0);
    assert.strictEqual(merged[0].end, 8);
    assert.strictEqual(merged[0].revision, 1);
  });

  it('merges adjacent markers (gap 0) at the default joinGap', () => {
    const merged = normalizeMarkers([
      { start: 0, end: 2, enabled: true, revision: 1, lastTouched: 1 },
      { start: 3, end: 5, enabled: true, revision: 1, lastTouched: 1 }
    ]);
    assert.strictEqual(merged.length, 1);
    assert.deepStrictEqual([merged[0].start, merged[0].end], [0, 5]);
  });

  it('does not merge markers separated by a gap larger than joinGap', () => {
    const markers = [
      { start: 0, end: 2, enabled: true, revision: 1, lastTouched: 1 },
      { start: 4, end: 6, enabled: true, revision: 1, lastTouched: 1 }
    ];
    assert.strictEqual(normalizeMarkers(markers).length, 2);
    assert.strictEqual(normalizeMarkers(markers, { joinGap: 1 }).length, 1);
  });

  it('never merges markers from different revisions, even when overlapping', () => {
    const merged = normalizeMarkers([
      { start: 0, end: 5, enabled: true, revision: 1, lastTouched: 1 },
      { start: 0, end: 5, enabled: true, revision: 2, lastTouched: 2 }
    ]);
    assert.strictEqual(merged.length, 2);
  });

  it('takes the max lastTouched of merged markers', () => {
    const merged = normalizeMarkers([
      { start: 0, end: 2, enabled: true, revision: 1, lastTouched: 4 },
      { start: 3, end: 5, enabled: true, revision: 1, lastTouched: 2 }
    ]);
    assert.strictEqual(merged[0].lastTouched, 4);
  });

  it('drops disabled markers', () => {
    const merged = normalizeMarkers([
      { start: 0, end: 2, enabled: false, revision: 1, lastTouched: 1 },
      { start: 4, end: 6, enabled: true, revision: 1, lastTouched: 1 }
    ]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].start, 4);
  });

  it('does not mutate the input array or its markers', () => {
    const original = [
      { start: 3, end: 5, enabled: true, revision: 1, lastTouched: 1 },
      { start: 0, end: 2, enabled: true, revision: 1, lastTouched: 1 }
    ];
    const snapshot = JSON.stringify(original);
    normalizeMarkers(original);
    assert.strictEqual(JSON.stringify(original), snapshot);
  });

  it('returns markers sorted by start position', () => {
    const merged = normalizeMarkers([
      { start: 10, end: 12, enabled: true, revision: 2, lastTouched: 2 },
      { start: 0, end: 2, enabled: true, revision: 1, lastTouched: 1 }
    ]);
    assert.deepStrictEqual(merged.map(m => m.start), [0, 10]);
  });

  it('computeDeepDiff normalize option merges same-revision fragments', () => {
    // 'abbb' -> 'aXbbbY' fragments into two single-char markers [1,1] and [5,5]
    const plain = computeDeepDiff(['abbb', 'aXbbbY']);
    assert.strictEqual(plain.markers.length, 2);

    const kept = computeDeepDiff(['abbb', 'aXbbbY'], { normalize: true });
    assert.strictEqual(kept.markers.length, 2, 'gap of 3 chars should not merge at joinGap 0');

    const merged = computeDeepDiff(['abbb', 'aXbbbY'], { normalize: { joinGap: 3 } });
    assert.strictEqual(merged.markers.length, 1);
    assert.deepStrictEqual([merged.markers[0].start, merged.markers[0].end], [1, 5]);
  });

});

// ============================================================================
// renderWithMarkers - word boundary snapping
// ============================================================================

describe('renderWithMarkers boundary: word', () => {

  it('snaps marker edges outward to whole words', () => {
    // marker covers 'or' inside 'world'
    const markers = [{ start: 7, end: 8, enabled: true }];
    const html = renderWithMarkers('hello world', markers, { boundary: 'word' });
    assert.strictEqual(html, 'hello <ins class="deep-diff">world</ins>');
  });

  it('leaves edges resting on whitespace alone', () => {
    const markers = [{ start: 5, end: 10, enabled: true }]; // ' world'
    const charHtml = renderWithMarkers('hello world', markers);
    const wordHtml = renderWithMarkers('hello world', markers, { boundary: 'word' });
    assert.strictEqual(wordHtml, charHtml);
  });

  it('does not swallow punctuation', () => {
    // marker on 'a' of 'bar' in 'foo, bar!' snaps to 'bar' but not to '!' or ' '
    const markers = [{ start: 6, end: 6, enabled: true }];
    const html = renderWithMarkers('foo, bar!', markers, { boundary: 'word' });
    assert.strictEqual(html, 'foo, <ins class="deep-diff">bar</ins>!');
  });

  it('treats underscores and digits as word characters', () => {
    const markers = [{ start: 4, end: 4, enabled: true }];
    const html = renderWithMarkers('foo_bar1 baz', markers, { boundary: 'word' });
    assert.strictEqual(html, '<ins class="deep-diff">foo_bar1</ins> baz');
  });

  it('does not mutate the markers array', () => {
    const marker = { start: 7, end: 8, enabled: true, revision: 1, lastTouched: 1 };
    renderWithMarkers('hello world', [marker], { boundary: 'word' });
    assert.strictEqual(marker.start, 7);
    assert.strictEqual(marker.end, 8);
  });

  it('keeps tags balanced when snapping makes markers coincide', () => {
    const markers = [
      { start: 0, end: 1, enabled: true },
      { start: 3, end: 4, enabled: true }
    ];
    const html = renderWithMarkers('hello', markers, { boundary: 'word' });
    assert.strictEqual(html,
      '<ins class="deep-diff"><ins class="deep-diff">hello</ins></ins>');
  });

  it('composes with dataAttributes', () => {
    const markers = [{ start: 7, end: 8, enabled: true, revision: 2, lastTouched: 3 }];
    const html = renderWithMarkers('hello world', markers, {
      boundary: 'word', dataAttributes: true
    });
    assert.strictEqual(html,
      'hello <ins class="deep-diff" data-revision="2" data-last-touched="3" data-depth="1">world</ins>');
  });

  it("default boundary 'char' output is unchanged", () => {
    const markers = [{ start: 7, end: 8, enabled: true }];
    const html = renderWithMarkers('hello world', markers, { boundary: 'char' });
    assert.strictEqual(html, 'hello w<ins class="deep-diff">or</ins>ld');
  });

});

// ============================================================================
// getDefaultStyles - options object, palettes, dark mode
// ============================================================================

describe('getDefaultStyles options', () => {

  it('treats a number argument as { maxDepth }', () => {
    assert.strictEqual(getDefaultStyles(3), getDefaultStyles({ maxDepth: 3 }));
  });

  it('supports all four palettes', () => {
    for (const palette of ['green', 'amber', 'ocean', 'heat']) {
      const css = getDefaultStyles({ palette });
      assert.ok(css.includes('.deep-diff {'), `${palette} should generate base rule`);
    }
  });

  it('different palettes produce different ramps', () => {
    assert.notStrictEqual(
      getDefaultStyles({ palette: 'green' }),
      getDefaultStyles({ palette: 'heat' })
    );
  });

  it('throws on an unknown palette', () => {
    assert.throws(() => getDefaultStyles({ palette: 'magenta' }), RangeError);
  });

  it('throws on an unknown mode', () => {
    assert.throws(() => getDefaultStyles({ mode: 'age' }), RangeError);
    assert.doesNotThrow(() => getDefaultStyles({ mode: 'depth' }));
  });

  it('includes ghost styling for deletion tombstones', () => {
    const css = getDefaultStyles();
    assert.ok(css.includes('.deep-diff-ghost'));
    assert.ok(css.includes('line-through'));
  });

  it('nudges text colour at high depths for readability', () => {
    const css = getDefaultStyles({ maxDepth: 6 });
    assert.ok(/color: #/.test(css), 'deep depths should set an explicit text colour');
  });

  it('clamps depths beyond the ramp to the last stop', () => {
    const css = getDefaultStyles({ maxDepth: 10 });
    assert.ok(css.includes(('.deep-diff ').repeat(9) + '.deep-diff {'),
      'should emit a 10-deep selector');
  });

  it('darkMode emits a prefers-color-scheme block and data-theme overrides', () => {
    const css = getDefaultStyles({ darkMode: true });
    assert.ok(css.includes('@media (prefers-color-scheme: dark)'));
    assert.ok(css.includes('[data-theme="dark"] .deep-diff {'));
    assert.ok(css.includes('[data-theme="dark"] .deep-diff-ghost'));
  });

  it('omits dark rules by default', () => {
    const css = getDefaultStyles();
    assert.ok(!css.includes('@media'));
    assert.ok(!css.includes('data-theme'));
  });

});

// ============================================================================
// transformMarkers - boundary regressions (hand-computed positions)
// ============================================================================

describe('transformMarkers boundary regressions', () => {

  it('insert at exactly marker.start shifts the marker (does not expand)', () => {
    // rev1: 'brave ' marked at [6,11]; rev2 inserts 'XX ' at index 6
    const { markers } = computeDeepDiff([
      'Hello world',
      'Hello brave world',
      'Hello XX brave world'
    ]);
    const braveMarker = markers.find(m => m.revision === 1);
    assert.deepStrictEqual([braveMarker.start, braveMarker.end], [9, 14]);
    assert.strictEqual(braveMarker.lastTouched, 1, 'a pure shift is not a touch');
    const xxMarker = markers.find(m => m.revision === 2);
    assert.deepStrictEqual([xxMarker.start, xxMarker.end], [6, 8]);
  });

  it('insert at exactly marker.end + 1 leaves the marker unchanged', () => {
    // rev1: 'X' marked at [1,1]; rev2 inserts 'Y' at index 2
    const { markers } = computeDeepDiff(['ab', 'aXb', 'aXYb']);
    const xMarker = markers.find(m => m.revision === 1);
    assert.deepStrictEqual([xMarker.start, xMarker.end], [1, 1]);
    const yMarker = markers.find(m => m.revision === 2);
    assert.deepStrictEqual([yMarker.start, yMarker.end], [2, 2]);
  });

  it('deletion ending at exactly marker.start - 1 shifts left by its full length', () => {
    // rev1: 'XYZ' marked at [2,4]; rev2 deletes 'b' at index 1
    const { markers } = computeDeepDiff(['ab', 'abXYZ', 'aXYZ']);
    assert.strictEqual(markers.length, 1);
    assert.deepStrictEqual([markers[0].start, markers[0].end], [1, 3]);
  });

  it('deletion starting at exactly marker.end contracts by one', () => {
    // rev1: 'XYZ' marked at [1,3]; rev2 deletes 'Z' at index 3
    const { markers } = computeDeepDiff(['ab', 'aXYZb', 'aXYb']);
    assert.strictEqual(markers.length, 1);
    assert.deepStrictEqual([markers[0].start, markers[0].end], [1, 2]);
    assert.strictEqual(markers[0].lastTouched, 2);
  });

  it('deletion starting at exactly marker.end + 1 leaves the marker unchanged', () => {
    // rev1: 'X' marked at [1,1]; rev2 deletes 'b' at index 2
    const { markers } = computeDeepDiff(['abc', 'aXbc', 'aXc']);
    assert.strictEqual(markers.length, 1);
    assert.deepStrictEqual([markers[0].start, markers[0].end], [1, 1]);
    assert.strictEqual(markers[0].lastTouched, 1);
  });

  it('replacement strictly inside a marker contracts then expands (nesting)', () => {
    // rev1: 'QQ RR SS ' marked at [2,10]; rev2 replaces 'RR' with 'XX'
    const { markers } = computeDeepDiff(['a b', 'a QQ RR SS b', 'a QQ XX SS b']);
    const outer = markers.find(m => m.revision === 1);
    assert.deepStrictEqual([outer.start, outer.end], [2, 10]);
    assert.strictEqual(outer.lastTouched, 2);
    const inner = markers.find(m => m.revision === 2);
    assert.deepStrictEqual([inner.start, inner.end], [5, 6]);
  });

  it('replacement at a marker start displaces the old marker past the new text', () => {
    // rev1: 'cat ' marked at [4,7]. rev2 replaces 'cat' with 'dog':
    // the delete contracts the marker to [4,4] (the trailing space), then
    // the insert at index 4 shifts it to [7,7]. The replacement text gets
    // its own rev-2 marker at [4,6] — adjacent, not nested.
    const { markers } = computeDeepDiff(['the sat', 'the cat sat', 'the dog sat']);
    const old = markers.find(m => m.revision === 1);
    assert.deepStrictEqual([old.start, old.end], [7, 7]);
    assert.strictEqual(old.lastTouched, 2);
    const fresh = markers.find(m => m.revision === 2);
    assert.deepStrictEqual([fresh.start, fresh.end], [4, 6]);
  });

  it('deletion exactly covering a marker disables it', () => {
    // rev1: 'cat' fully replaced in rev2 -> old marker gone, new marker only
    const { markers, text } = computeDeepDiff(['the sat', 'the cat, sat', 'the sat']);
    assert.strictEqual(text, 'the sat');
    assert.strictEqual(markers.length, 0);
  });

});

// ============================================================================
// trackReplacements - replacement-aware marker transform
// ----------------------------------------------------------------------------
// Adjacent DELETE+INSERT pairs are treated as replacements: markers
// overlapping the deleted range are remapped (proportionally, rounded
// outward) onto the inserted text instead of being killed/contracted, and
// the fresh insertion marker stacks on top. All positions below are
// hand-computed from the documented semantics against verified dmp diffs.
// ============================================================================

describe('trackReplacements', () => {

  const opts = { timeout: 0, trackReplacements: true };

  // Max marker depth over the inclusive range [start, end] of result.text.
  const maxDepthOver = (result, start, end) => {
    let max = 0;
    const segments = computeHeatSegments(result.text, result.markers);
    for (const s of segments) {
      if (s.start <= end && s.end - 1 >= start) max = Math.max(max, s.depth);
    }
    return max;
  };

  const pin = (marker, [start, end, revision, lastTouched, slice], text) => {
    assert.deepStrictEqual(
      { start: marker.start, end: marker.end, revision: marker.revision, lastTouched: marker.lastTouched },
      { start, end, revision, lastTouched },
      `expected marker [${start},${end}] rev=${revision} lt=${lastTouched}, got ${JSON.stringify(marker)}`);
    assert.strictEqual(text.slice(marker.start, marker.end + 1), slice);
  };

  const byPosThenRev = markers =>
    markers.slice().sort((a, b) => a.start - b.start || a.end - b.end || a.revision - b.revision);

  it('living-draft gesture: rework of the same word stacks depth instead of resetting', () => {
    const revs = ['The quick brown fox', 'The quick red fox', 'The quick crimson fox'];

    // Default: rev1's "red" marker is exactly covered by the DELETE and
    // killed; "crimson" gets a fresh depth-1 marker. Heat resets.
    const plain = computeDeepDiff(revs, { timeout: 0 });
    const colorStart = plain.text.indexOf('crimson');
    assert.strictEqual(maxDepthOver(plain, colorStart, colorStart + 6), 1);

    // trackReplacements: the "red" marker (born rev 1) rides onto "crimson"
    // and the fresh rev-2 marker stacks on top of it.
    const tracked = computeDeepDiff(revs, opts);
    assert.strictEqual(tracked.text, 'The quick crimson fox');
    assert.ok(maxDepthOver(tracked, colorStart, colorStart + 6) >= 2,
      'reworked colour word should be depth >= 2 by revision 3');

    const ms = byPosThenRev(tracked.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [10, 16, 1, 2, 'crimson'], tracked.text); // remapped, identity kept
    pin(ms[1], [10, 16, 2, 2, 'crimson'], tracked.text); // fresh insertion marker
  });

  it('default output is byte-identical whether the option is omitted or false', () => {
    const sets = [
      ['The quick brown fox', 'The quick red fox', 'The quick crimson fox'],
      ['ab', 'aXYZb', 'aPQb'],
      ['hello', 'hello world', 'hello'],
      ['mmmm rstu oooo', 'mmmm QQQQrstu oooo', 'mmmm WWrstu oooo']
    ];
    for (const revs of sets) {
      assert.deepStrictEqual(
        computeDeepDiff(revs, { timeout: 0, trackReplacements: false }),
        computeDeepDiff(revs, { timeout: 0 }),
        `explicit false must equal omitted for ${JSON.stringify(revs)}`);
    }
  });

  it('diffs without replacement pairs behave identically with the option on', () => {
    // Pure insertions and pure deletions only - no adjacent DELETE+INSERT.
    const sets = [
      ['hello', 'hello world', 'hello big world'],   // inserts only
      ['hello big world', 'hello world', 'hello'],   // deletes only
      ['a b c', 'a X b Y c', 'a X b c']
    ];
    for (const revs of sets) {
      assert.deepStrictEqual(
        computeDeepDiff(revs, opts),
        computeDeepDiff(revs, { timeout: 0 }),
        `no-replacement chain must be unaffected for ${JSON.stringify(revs)}`);
    }
  });

  it('pure delete (no adjacent insert) still kills a fully covered marker', () => {
    // rev1 marker 'XYZ' [1,3]; rev2 diff [EQ 'a'][DEL 'XYZ'][EQ 'b'] - the
    // DELETE has no adjacent INSERT, so the marker dies as in default mode.
    const r = computeDeepDiff(['ab', 'aXYZb', 'ab'], opts);
    assert.strictEqual(r.text, 'ab');
    assert.strictEqual(r.markers.length, 0);
  });

  it('a DELETE and an INSERT separated by an EQUAL are not a replacement', () => {
    // rev2 diff: [EQ 'a'][DEL 'X'][EQ 'b c'][INS 'Y'][EQ 'd'] - unrelated
    // edits. The 'X' marker is killed; only the fresh 'Y' marker remains.
    const r = computeDeepDiff(['ab cd', 'aXb cd', 'ab cYd'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 1);
    pin(ms[0], [4, 4, 2, 2, 'Y'], r.text);
  });

  it('marker exactly equal to the deleted range remaps to exactly the inserted range (shorter insert)', () => {
    // rev1 marker 'XYZ' [1,3]; rev2 diff [EQ 'a'][DEL 'XYZ'][INS 'PQ'][EQ 'b'].
    // 100% coverage of the deleted span -> whole inserted span [1,2].
    const r = computeDeepDiff(['ab', 'aXYZb', 'aPQb'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [1, 2, 1, 2, 'PQ'], r.text); // remapped: birth rev 1, touched rev 2
    pin(ms[1], [1, 2, 2, 2, 'PQ'], r.text); // fresh insertion marker stacks
    assert.strictEqual(maxDepthOver(r, 1, 2), 2);
  });

  it('marker exactly equal to the deleted range remaps whole when the insert is longer', () => {
    // rev1 marker 'X' [1,1]; rev2 [EQ 'a'][DEL 'X'][INS 'PQRS'][EQ 'b'].
    // dl=1, il=4: mapped span = [floor(0*4/1), ceil(1*4/1)-1] = [0,3].
    const r = computeDeepDiff(['ab', 'aXb', 'aPQRSb'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [1, 4, 1, 2, 'PQRS'], r.text);
    pin(ms[1], [1, 4, 2, 2, 'PQRS'], r.text);
  });

  it('marker head outside the replacement stays put; tail remaps proportionally', () => {
    // rev1 marker 'XY' [1,2]; rev2 'aXYcd' -> 'aXQQd' diffs as
    // [EQ 'aX'][DEL 'Yc'][INS 'QQ'][EQ 'd']: deleted [2,3], dl=2, il=2.
    // Overlap is the first deleted char (rel 0..0) -> mapped [0,0], so the
    // marker keeps its head 'X' at 1 and ends at 2 + 0 = 2: 'XQ'.
    const r = computeDeepDiff(['acd', 'aXYcd', 'aXQQd'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [1, 2, 1, 2, 'XQ'], r.text);
    pin(ms[1], [2, 3, 2, 2, 'QQ'], r.text);
  });

  it('marker tail outside the replacement shifts by the net delta; head remaps proportionally', () => {
    // rev1 marker 'YZ' [2,3]; rev2 'aXYZd' -> 'aPQZd' diffs as
    // [EQ 'a'][DEL 'XY'][INS 'PQ'][EQ 'Zd']: deleted [1,2], dl=2, il=2.
    // Marker covered the second deleted char (rel 1..1) -> mapped [1,1], so
    // start = 1 + 1 = 2; tail 'Z' past the delete shifts by delta 0: 'QZ'.
    const r = computeDeepDiff(['aXd', 'aXYZd', 'aPQZd'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [1, 2, 2, 2, 'PQ'], r.text); // fresh insertion marker
    pin(ms[1], [2, 3, 1, 2, 'QZ'], r.text); // remapped tail-outside marker
  });

  it('multiple markers over one replacement remap independently and proportionally', () => {
    // rev1 marker 'X' [1,1], rev2 marker 'Y' [2,2]; rev3 replaces 'XY' with
    // 'PQRS' (dl=2, il=4). X covered the first half of the delete -> first
    // half of the insert [1,2]; Y the second half -> [3,4]. Fresh rev-3
    // marker covers all of 'PQRS'.
    const r = computeDeepDiff(['ab', 'aXb', 'aXYb', 'aPQRSb'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 3);
    pin(ms[0], [1, 2, 1, 3, 'PQ'], r.text);
    pin(ms[1], [1, 4, 3, 3, 'PQRS'], r.text);
    pin(ms[2], [3, 4, 2, 3, 'RS'], r.text);
  });

  it('insert shorter than delete: outward rounding keeps every marker at least one char, stacking', () => {
    // rev1 marker 'X' [1,1], rev2 marker 'Y' [2,2]; rev3 replaces 'XY' with
    // 'Q' (dl=2, il=1). Both proportional images round outward to [1,1], so
    // both survive on 'Q' and stack with the fresh rev-3 marker: depth 3.
    const r = computeDeepDiff(['ab', 'aXb', 'aXYb', 'aQb'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 3);
    pin(ms[0], [1, 1, 1, 3, 'Q'], r.text);
    pin(ms[1], [1, 1, 2, 3, 'Q'], r.text);
    pin(ms[2], [1, 1, 3, 3, 'Q'], r.text);
    assert.strictEqual(maxDepthOver(r, 1, 1), 3);
  });

  it('replacement strictly inside a marker matches the default contract-then-expand result', () => {
    // rev1 marker 'WXYZ' [1,4]; rev2 replaces the interior 'XY' with 'PQR'.
    // The default path already nests here (contract then expand); the
    // replacement path must produce the identical outcome: head and tail
    // intact, interior passing through the whole inserted span.
    const revs = ['ad', 'aWXYZd', 'aWPQRZd'];
    const tracked = computeDeepDiff(revs, opts);
    const plain = computeDeepDiff(revs, { timeout: 0 });
    assert.deepStrictEqual(tracked, plain);
    const ms = byPosThenRev(tracked.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [1, 5, 1, 2, 'WPQRZ'], tracked.text);
    pin(ms[1], [2, 4, 2, 2, 'PQR'], tracked.text);
  });

  it('replacement at the very start of the text (index 0) remaps in place', () => {
    // rev1 marker 'BB' [0,1]; rev2 diff [DEL 'BB'][INS 'CC'][EQ ' rest'].
    const r = computeDeepDiff(['AA rest', 'BB rest', 'CC rest'], opts);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [0, 1, 1, 2, 'CC'], r.text);
    pin(ms[1], [0, 1, 2, 2, 'CC'], r.text);
  });

  it('chain of six successive replacements of one word accumulates depth monotonically', () => {
    const chain = ['w AAA z', 'w BBB z', 'w CCC z', 'w DDD z', 'w EEE z', 'w FFF z', 'w GGG z'];
    let prevDepth = 0;
    for (let k = 2; k <= chain.length; k++) {
      const r = computeDeepDiff(chain.slice(0, k), opts);
      const depth = maxDepthOver(r, 2, 4); // the reworked word sits at [2,4]
      assert.ok(depth >= prevDepth, `depth must never reset (prefix ${k}: ${depth} < ${prevDepth})`);
      assert.strictEqual(depth, k - 1,
        `after ${k - 1} replacement(s) the word should be ${k - 1} deep, got ${depth}`);
      prevDepth = depth;
    }
    // Every surviving marker keeps its birth revision: one per revision 1..6.
    const final = computeDeepDiff(chain, opts);
    assert.deepStrictEqual(
      final.markers.map(m => m.revision).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6]);
    final.markers.forEach(m => {
      assert.strictEqual(m.lastTouched, 6, 'every marker was reworked by the last revision');
      assert.strictEqual(final.text.slice(m.start, m.end + 1), 'GGG');
    });
  });

  it('remapped markers never split surrogate pairs (final snapping still applies)', () => {
    // 🙂/🙁/🙃 share the high surrogate \ud83d, so each replacement's
    // DELETE+INSERT pair carries lone low surrogates. The remap operates on
    // code units; the final snapping pass must still widen marker edges off
    // intra-pair positions.
    const r = computeDeepDiff(['hi 🙂 there', 'hi 🙁 there', 'hi 🙃 there'], opts);
    assert.strictEqual(r.text, 'hi 🙃 there');
    assert.strictEqual(r.markers.length, 2);
    for (const m of r.markers) {
      const slice = r.text.slice(m.start, m.end + 1);
      assert.strictEqual(slice, '🙃', 'marker must cover the whole emoji');
      assert.ok(!/^[\udc00-\udfff]/.test(slice), 'must not start mid-pair');
      assert.ok(!/[\ud800-\udbff]$/.test(slice), 'must not end mid-pair');
    }
    assert.deepStrictEqual(r.markers.map(m => m.revision).sort((a, b) => a - b), [1, 2],
      'reworked emoji should be depth 2');
  });

  it('composes with trackDeletions: the replacement still records a tombstone', () => {
    const r = computeDeepDiff(['ab', 'aXYZb', 'aPQb'],
      { ...opts, trackDeletions: true });
    assert.deepStrictEqual(r.deletions, [{ index: 1, text: 'XYZ', revision: 2 }]);
    const ms = byPosThenRev(r.markers);
    assert.strictEqual(ms.length, 2);
    pin(ms[0], [1, 2, 1, 2, 'PQ'], r.text);
    pin(ms[1], [1, 2, 2, 2, 'PQ'], r.text);
  });

  it('composes with normalize: remapped and fresh markers are different revisions, never merged', () => {
    const r = computeDeepDiff(['ab', 'aXYZb', 'aPQb'], { ...opts, normalize: true });
    assert.strictEqual(r.markers.length, 2, 'normalize must not collapse the depth stack');
    assert.deepStrictEqual(r.markers.map(m => m.revision).sort((a, b) => a - b), [1, 2]);
    assert.strictEqual(maxDepthOver(r, 1, 2), 2);
  });

  it('deepDiffHtml passes trackReplacements through (nested tags over the rework)', () => {
    const revs = ['The quick brown fox', 'The quick red fox', 'The quick crimson fox'];
    const plain = deepDiffHtml(revs, { timeout: 0, dataAttributes: true });
    const tracked = deepDiffHtml(revs, { timeout: 0, dataAttributes: true, trackReplacements: true });
    assert.ok(!plain.includes('data-depth="2"'), 'default stays depth 1');
    assert.ok(tracked.includes('data-depth="2"'), 'tracked rework should nest to depth 2');
    // Tags stay balanced
    const opens = (tracked.match(/<ins/g) || []).length;
    const closes = (tracked.match(/<\/ins>/g) || []).length;
    assert.strictEqual(opens, closes);
  });

});

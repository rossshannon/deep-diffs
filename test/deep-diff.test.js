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
  getDefaultStyles 
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

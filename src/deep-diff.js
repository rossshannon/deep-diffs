/**
 * DeepDiff - Cumulative change visualisation across multiple text revisions
 * 
 * Original algorithm by Ross Shannon (c. 2014)
 * Modernised implementation 2026
 * 
 * @license MIT
 */

import DiffMatchPatch from 'diff-match-patch';

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

/**
 * A marker representing a changed region across revisions.
 * As text is inserted/deleted in subsequent revisions, markers
 * shift, expand, or contract to track "the same" logical region.
 */
class Marker {
  constructor(start, end) {
    this.start = start;
    this.end = end;
    this.enabled = true;
  }

  get length() {
    return this.end - this.start + 1;  // Inclusive indices
  }

  shift(delta) {
    this.start += delta;
    this.end += delta;
  }

  expand(delta) {
    this.end += delta;
  }

  contract(delta) {
    this.end -= delta;
    if (this.length <= 0) {
      this.enabled = false; // Marker has been subsumed by deletion
    }
  }
}

/**
 * Compute cumulative diff markers across a sequence of text revisions.
 * 
 * @param {string[]} revisions - Array of text versions, oldest first
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipEmpty - Skip empty revisions (vandalism filtering)
 * @param {number} options.timeout - Diff computation timeout in seconds
 * @returns {{ text: string, markers: Marker[] }}
 */
export function computeDeepDiff(revisions, options = {}) {
  const { skipEmpty = true, timeout = 1 } = options;

  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = timeout;
  dmp.Diff_EditCost = 4;

  // Filter revisions
  const texts = revisions
    .map(r => r.trim())
    .filter(r => !skipEmpty || r.length > 0);

  if (texts.length < 2) {
    return { text: texts[0] || '', markers: [] };
  }

  const markers = [];

  // Process each revision pair
  for (let i = 1; i < texts.length; i++) {
    const diffs = dmp.diff_main(texts[i - 1], texts[i]);
    dmp.diff_cleanupSemantic(diffs);
    dmp.diff_cleanupEfficiency(diffs);

    // Transform existing markers through this diff
    transformMarkers(markers, diffs);

    // Add new markers for insertions in this revision
    addInsertionMarkers(markers, diffs);
  }

  return {
    text: texts[texts.length - 1],
    markers: markers.filter(m => m.enabled)
  };
}

/**
 * Transform existing markers based on a diff operation set.
 * Markers shift, expand, or contract as text is inserted/deleted.
 */
function transformMarkers(markers, diffs) {
  // Sort by start position for consistent processing
  markers.sort((a, b) => a.start - b.start);

  for (const marker of markers) {
    if (!marker.enabled) continue;

    let index = 0;

    for (const [op, text] of diffs) {
      const len = text.length;

      if (op === DIFF_INSERT) {
        if (index <= marker.start) {
          // Insertion before or at marker start: shift right
          marker.shift(len);
        } else if (index > marker.start && index <= marker.end) {
          // Insertion within marker: expand
          marker.expand(len);
        }
        index += len;
      } else if (op === DIFF_DELETE) {
        const delEnd = index + len - 1;  // Inclusive end of deletion

        if (delEnd < marker.start) {
          // Deletion entirely before marker: shift left
          marker.shift(-len);
        } else if (index > marker.end) {
          // Deletion entirely after marker: no change
        } else if (index <= marker.start && delEnd >= marker.end) {
          // Deletion encompasses entire marker: disable it
          marker.enabled = false;
        } else if (index <= marker.start && delEnd < marker.end) {
          // Deletion overlaps start of marker
          const preOverlap = marker.start - index;  // Part before marker
          const overlap = delEnd - marker.start + 1;  // Part inside marker
          marker.shift(-preOverlap);
          marker.contract(overlap);
        } else if (index > marker.start && delEnd >= marker.end) {
          // Deletion overlaps end of marker
          const overlap = marker.end - index + 1;
          marker.contract(overlap);
        } else {
          // Deletion entirely within marker: contract
          marker.contract(len);
        }
        // Note: index doesn't advance for deletions (text removed from old)
      } else {
        // DIFF_EQUAL
        index += len;
      }
    }
  }
}

/**
 * Add new markers for all insertions in a diff set.
 */
function addInsertionMarkers(markers, diffs) {
  let index = 0;

  for (const [op, text] of diffs) {
    if (op === DIFF_INSERT) {
      markers.push(new Marker(index, index + text.length - 1));
      index += text.length;
    } else if (op === DIFF_EQUAL) {
      index += text.length;
    }
    // DIFF_DELETE doesn't advance index in new text
  }
}

/**
 * Render text with markers as HTML with nested <ins> tags.
 * Overlapping markers create nested tags, which CSS can style
 * with increasing intensity.
 * 
 * @param {string} text - The final text
 * @param {Marker[]} markers - Active markers
 * @param {Object} options - Rendering options
 * @param {string} options.tagName - HTML tag to use (default: 'ins')
 * @param {string} options.className - CSS class for tags
 * @returns {string} HTML string
 */
export function renderWithMarkers(text, markers, options = {}) {
  const { tagName = 'ins', className = 'deep-diff' } = options;

  // Filter to only enabled markers
  const activeMarkers = markers.filter(m => m.enabled);

  if (activeMarkers.length === 0) return escapeHtml(text);

  // Build list of boundary events
  const events = [];
  for (const marker of activeMarkers) {
    events.push({ index: marker.start, type: 'open' });
    events.push({ index: marker.end + 1, type: 'close' });
  }

  // Sort: by index, then closes before opens at same position
  events.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return a.type === 'close' ? -1 : 1;
  });

  // Build output by interleaving text and tags
  const chars = [...text];
  const openTag = className 
    ? `<${tagName} class="${className}">` 
    : `<${tagName}>`;
  const closeTag = `</${tagName}>`;

  let result = '';
  let pos = 0;

  for (const event of events) {
    // Add text up to this event
    if (event.index > pos) {
      result += escapeHtml(chars.slice(pos, event.index).join(''));
      pos = event.index;
    }
    // Add tag
    result += event.type === 'open' ? openTag : closeTag;
  }

  // Add remaining text
  if (pos < chars.length) {
    result += escapeHtml(chars.slice(pos).join(''));
  }

  return result;
}

/**
 * Convenience function: compute deep diff and render as HTML.
 */
export function deepDiffHtml(revisions, options = {}) {
  const { text, markers } = computeDeepDiff(revisions, options);
  return renderWithMarkers(text, markers, options);
}

/**
 * Get CSS for styling nested markers with increasing intensity.
 */
export function getDefaultStyles(maxDepth = 5) {
  const baseColor = [144, 238, 144]; // Light green
  let css = `.deep-diff { background-color: rgba(${baseColor.join(',')}, 0.3); }\n`;

  for (let i = 2; i <= maxDepth; i++) {
    const intensity = Math.min(0.3 + (i - 1) * 0.15, 0.9);
    css += `.deep-diff `.repeat(i).trim() + 
           ` { background-color: rgba(${baseColor.join(',')}, ${intensity}); }\n`;
  }

  return css;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Default export for simple usage
export default { computeDeepDiff, renderWithMarkers, deepDiffHtml, getDefaultStyles };

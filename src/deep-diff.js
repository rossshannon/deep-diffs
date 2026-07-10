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
  constructor(start, end, revision = 0) {
    this.start = start;
    this.end = end;
    this.enabled = true;
    this.revision = revision;      // Revision index (1-based) that created this marker
    this.lastTouched = revision;   // Most recent revision that modified this region
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
 * Coordinate semantics: marker `start`/`end` are inclusive UTF-16 code unit
 * offsets into the final revision's text. Tombstone `index` (when
 * `trackDeletions` is on) is a zero-width point between characters, also in
 * final-text coordinates (`index === text.length` means "at the very end").
 *
 * @param {string[]} revisions - Array of text versions, oldest first
 * @param {Object} [options] - Configuration options
 * @param {boolean} [options.skipEmpty=true] - Skip empty revisions (vandalism filtering)
 * @param {number} [options.timeout=1] - Diff computation timeout in seconds
 * @param {boolean} [options.trackDeletions=false] - Record a zero-width tombstone
 *   `{ index, text, revision }` for every deletion. Tombstone positions are
 *   transformed through all subsequent revisions (shifted by earlier
 *   inserts/deletes; collapsed to the deletion point when a later deletion
 *   swallows them). Adds a `deletions` array (sorted by index, then revision)
 *   to the result.
 * @param {boolean|{joinGap?: number}} [options.normalize=false] - Merge markers
 *   born in the same revision that overlap or sit within `joinGap` characters
 *   of each other (see {@link normalizeMarkers}). `true` is shorthand for
 *   `{ joinGap: 0 }`. Markers from different revisions are never merged.
 * @returns {{ text: string, markers: Marker[], revisionCount: number, deletions?: Tombstone[] }}
 */
export function computeDeepDiff(revisions, options = {}) {
  const {
    skipEmpty = true,
    timeout = 1,
    trackDeletions = false,
    normalize = false
  } = options;

  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = timeout;
  dmp.Diff_EditCost = 4;

  // Filter revisions
  const texts = revisions
    .map(r => r.trim())
    .filter(r => !skipEmpty || r.length > 0);

  if (texts.length < 2) {
    const result = { text: texts[0] || '', markers: [], revisionCount: texts.length };
    if (trackDeletions) result.deletions = [];
    return result;
  }

  const markers = [];
  const deletions = trackDeletions ? [] : null;

  // Process each revision pair
  for (let i = 1; i < texts.length; i++) {
    const diffs = dmp.diff_main(texts[i - 1], texts[i]);
    dmp.diff_cleanupSemantic(diffs);
    dmp.diff_cleanupEfficiency(diffs);

    // Transform existing markers through this diff
    transformMarkers(markers, diffs, i);

    if (deletions) {
      // Transform existing tombstones first, then record this revision's
      // deletions (new tombstones are already in revision-i coordinates).
      transformTombstones(deletions, diffs);
      addDeletionTombstones(deletions, diffs, i);
    }

    // Add new markers for insertions in this revision
    addInsertionMarkers(markers, diffs, i);
  }

  const finalText = texts[texts.length - 1];

  let finalMarkers = markers.filter(m => m.enabled);

  // diff-match-patch diffs at the UTF-16 code-unit level, so a diff boundary
  // can land between the halves of a surrogate pair (e.g. two emoji sharing
  // a high surrogate). Widen marker edges off intra-pair positions so a
  // marker never begins or ends mid-code-point.
  for (const marker of finalMarkers) {
    marker.start = snapStartToCodePoint(finalText, marker.start);
    marker.end = snapEndToCodePoint(finalText, marker.end);
  }

  if (normalize) {
    finalMarkers = normalizeMarkers(finalMarkers, normalize === true ? undefined : normalize);
  }

  // Deterministic ordering: transformMarkers re-sorts its working array in
  // place on every revision, which would otherwise leak an unstable,
  // creation-dependent order into the public result.
  finalMarkers.sort((a, b) =>
    a.start - b.start || a.end - b.end || a.revision - b.revision
  );

  const result = {
    text: finalText,
    markers: finalMarkers,
    revisionCount: texts.length
  };

  if (deletions) {
    deletions.sort((a, b) => a.index - b.index || a.revision - b.revision);
    result.deletions = deletions;
  }

  return result;
}

/**
 * Transform existing markers based on a diff operation set.
 * Markers shift, expand, or contract as text is inserted/deleted.
 *
 * Boundary semantics (locked in by regression tests):
 * - Insert at exactly `marker.start` shifts the marker right (the inserted
 *   text is treated as adjacent, not "within"; a fresh marker covers it).
 * - Insert at exactly `marker.end + 1` leaves the marker unchanged.
 * - Delete ending at exactly `marker.start - 1` shifts the marker left.
 * - Delete starting at exactly `marker.end` contracts the marker by one.
 */
function transformMarkers(markers, diffs, revision = 0) {
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
          marker.lastTouched = revision;
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
          marker.lastTouched = revision;
        } else if (index > marker.start && delEnd >= marker.end) {
          // Deletion overlaps end of marker
          const overlap = marker.end - index + 1;
          marker.contract(overlap);
          marker.lastTouched = revision;
        } else {
          // Deletion entirely within marker: contract
          marker.contract(len);
          marker.lastTouched = revision;
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
function addInsertionMarkers(markers, diffs, revision = 0) {
  let index = 0;

  for (const [op, text] of diffs) {
    if (op === DIFF_INSERT) {
      markers.push(new Marker(index, index + text.length - 1, revision));
      index += text.length;
    } else if (op === DIFF_EQUAL) {
      index += text.length;
    }
    // DIFF_DELETE doesn't advance index in new text
  }
}

/**
 * Transform existing deletion tombstones through a diff operation set.
 *
 * A tombstone is a zero-width point `p` between characters. Point semantics:
 * - Insert strictly before `p` shifts it right; an insert at exactly `p`
 *   leaves it in place, so the ghost renders BEFORE text later inserted at
 *   the same point (chronological reading order for replacements).
 * - Delete entirely before `p` shifts it left.
 * - Delete whose range straddles `p` collapses it to the deletion point.
 */
function transformTombstones(tombstones, diffs) {
  for (const tombstone of tombstones) {
    let index = 0;

    for (const [op, text] of diffs) {
      const len = text.length;

      if (op === DIFF_INSERT) {
        if (index < tombstone.index) {
          tombstone.index += len;
        }
        index += len;
      } else if (op === DIFF_DELETE) {
        if (index + len <= tombstone.index) {
          // Deletion entirely before tombstone: shift left
          tombstone.index -= len;
        } else if (index < tombstone.index) {
          // Deletion range straddles the tombstone: collapse to deletion point
          tombstone.index = index;
        }
        // Deletion at or after the tombstone point: no change.
        // Index doesn't advance (deleted text absent from new coordinates).
      } else {
        // DIFF_EQUAL
        index += len;
      }
    }
  }
}

/**
 * Record a tombstone for every deletion in a diff set, positioned at the
 * deletion point in new-text coordinates. Tombstones from different
 * revisions that end up at the same index are kept separate ("stacked") and
 * later sorted by (index, revision) so ghosts render in chronological order.
 */
function addDeletionTombstones(tombstones, diffs, revision = 0) {
  let index = 0;

  for (const [op, text] of diffs) {
    if (op === DIFF_DELETE) {
      tombstones.push({ index, text, revision });
      // Index doesn't advance (deleted text absent from new coordinates)
    } else {
      // DIFF_INSERT and DIFF_EQUAL both occupy new-text coordinates
      index += text.length;
    }
  }
}

/**
 * Render text with markers as HTML with nested <ins> tags.
 * Overlapping markers create nested tags, which CSS can style
 * with increasing intensity.
 *
 * @param {string} text - The final text
 * @param {Marker[]} markers - Active markers
 * @param {Object} [options] - Rendering options
 * @param {string} [options.tagName='ins'] - HTML tag to use
 * @param {string} [options.className='deep-diff'] - CSS class for tags
 * @param {boolean} [options.dataAttributes=false] - Emit data-revision,
 *   data-last-touched, and data-depth on each marker tag. Uses a stack-based
 *   renderer that closes/reopens tags at partial overlaps so every character
 *   is attributed to the correct marker (a marker may therefore emit more
 *   than one tag). Default output is byte-identical to previous releases.
 * @param {'char'|'word'} [options.boundary='char'] - With 'word', marker
 *   edges are visually snapped outward to word boundaries before tags are
 *   built. Snapping operates on copies; the markers array is not mutated.
 * @param {Tombstone[]} [options.renderDeletions] - Deletion tombstones (from
 *   computeDeepDiff's trackDeletions option) to interleave as
 *   `<del class="deep-diff-ghost">text</del>` at their positions. Ghosts at a
 *   marker boundary render after closing tags and before opening tags.
 * @returns {string} HTML string
 */
export function renderWithMarkers(text, markers, options = {}) {
  const {
    tagName = 'ins',
    className = 'deep-diff',
    dataAttributes = false,
    boundary = 'char',
    renderDeletions = null
  } = options;

  // Filter to only enabled markers
  let activeMarkers = markers.filter(m => m.enabled);

  // Never place a tag between the halves of a surrogate pair, even for
  // caller-supplied markers. Snapping operates on copies.
  activeMarkers = activeMarkers.map(m => {
    const start = snapStartToCodePoint(text, m.start);
    const end = snapEndToCodePoint(text, m.end);
    return start === m.start && end === m.end ? m : { ...m, start, end };
  });

  // Word-boundary snapping operates on copies; never mutates the input.
  if (boundary === 'word') {
    activeMarkers = snapToWordBoundaries(text, activeMarkers);
  }

  const ghosts = Array.isArray(renderDeletions)
    ? renderDeletions
        .map(g => ({
          index: Math.max(0, Math.min(g.index, text.length)),
          text: String(g.text ?? ''),
          revision: g.revision ?? 0
        }))
        .sort((a, b) => a.index - b.index || a.revision - b.revision)
    : [];

  if (dataAttributes) {
    return renderNested(text, activeMarkers, ghosts, { tagName, className });
  }

  if (activeMarkers.length === 0 && ghosts.length === 0) return escapeHtml(text);

  // Build list of boundary events.
  // Event type doubles as sort priority: closes, then ghosts, then opens.
  const CLOSE = 0, GHOST = 1, OPEN = 2;
  const events = [];
  for (const marker of activeMarkers) {
    events.push({ index: marker.start, type: OPEN });
    events.push({ index: marker.end + 1, type: CLOSE });
  }
  for (const ghost of ghosts) {
    events.push({ index: ghost.index, type: GHOST, ghost });
  }

  // Sort: by index, then closes before ghosts before opens at same position
  events.sort((a, b) => a.index - b.index || a.type - b.type);

  // Build output by interleaving text and tags.
  // Marker indices are UTF-16 code unit offsets (as produced by
  // diff-match-patch), so slice the string directly — splitting into
  // code points would misalign tags around astral characters.
  const openTag = className
    ? `<${tagName} class="${className}">`
    : `<${tagName}>`;
  const closeTag = `</${tagName}>`;

  let result = '';
  let pos = 0;

  for (const event of events) {
    // Add text up to this event
    if (event.index > pos) {
      result += escapeHtml(text.slice(pos, event.index));
      pos = event.index;
    }
    // Add tag
    if (event.type === GHOST) {
      result += ghostHtml(event.ghost, false);
    } else {
      result += event.type === OPEN ? openTag : closeTag;
    }
  }

  // Add remaining text
  if (pos < text.length) {
    result += escapeHtml(text.slice(pos));
  }

  return result;
}

/**
 * Stack-based renderer used when data attributes are requested. Unlike the
 * fast path, this tracks marker identity: when a partially-overlapping
 * marker ends, inner tags are closed and reopened so attribution stays
 * correct. `data-depth` reflects the nesting depth at each emitted open tag,
 * so a marker split by a partial overlap may emit tags at different depths.
 */
function renderNested(text, markers, ghosts, { tagName, className }) {
  const classAttr = className ? ` class="${className}"` : '';
  const closeTag = `</${tagName}>`;
  const openTagFor = (m, depth) =>
    `<${tagName}${classAttr} data-revision="${m.revision ?? 0}"` +
    ` data-last-touched="${m.lastTouched ?? m.revision ?? 0}" data-depth="${depth}">`;

  // Open longer markers first so shorter ones nest inside; break ties by
  // birth revision so older markers sit outside newer ones.
  const sorted = [...markers].sort((a, b) =>
    a.start - b.start || b.end - a.end || (a.revision ?? 0) - (b.revision ?? 0)
  );

  const cuts = new Set();
  for (const m of sorted) {
    cuts.add(m.start);
    cuts.add(m.end + 1);
  }
  for (const g of ghosts) cuts.add(g.index);
  const points = [...cuts].sort((a, b) => a - b);

  let out = '';
  let pos = 0;
  let mi = 0;
  let gi = 0;
  const stack = [];

  for (const p of points) {
    if (p > pos) {
      out += escapeHtml(text.slice(pos, p));
      pos = p;
    }

    // Close markers that end before p; inner still-active markers are
    // closed too and reopened afterwards to keep tags balanced.
    if (stack.some(m => m.end + 1 <= p)) {
      const reopen = [];
      while (stack.some(m => m.end + 1 <= p)) {
        const top = stack.pop();
        out += closeTag;
        if (top.end + 1 > p) reopen.push(top);
      }
      for (let i = reopen.length - 1; i >= 0; i--) {
        stack.push(reopen[i]);
        out += openTagFor(reopen[i], stack.length);
      }
    }

    // Ghosts at p (after closes, before opens)
    while (gi < ghosts.length && ghosts[gi].index <= p) {
      if (ghosts[gi].index === p) out += ghostHtml(ghosts[gi], true);
      gi++;
    }

    // Open markers starting at p
    while (mi < sorted.length && sorted[mi].start === p) {
      const m = sorted[mi++];
      stack.push(m);
      out += openTagFor(m, stack.length);
    }
  }

  if (pos < text.length) {
    out += escapeHtml(text.slice(pos));
  }

  // Defensive: close anything left open (markers extending past the text)
  while (stack.length) {
    stack.pop();
    out += closeTag;
  }

  return out;
}

/**
 * Render a deletion tombstone as a ghost element.
 */
function ghostHtml(ghost, dataAttributes) {
  const attrs = dataAttributes ? ` data-revision="${ghost.revision}"` : '';
  return `<del class="deep-diff-ghost"${attrs}>${escapeHtml(ghost.text)}</del>`;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * If `start` sits on the low half of a surrogate pair, move it left onto the
 * high half so the whole code point is included.
 */
function snapStartToCodePoint(text, start) {
  if (
    start > 0 && start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    return start - 1;
  }
  return start;
}

/**
 * If `end` (inclusive) sits on the high half of a surrogate pair, move it
 * right onto the low half so the whole code point is included.
 */
function snapEndToCodePoint(text, end) {
  if (
    end >= 0 && end < text.length - 1 &&
    isHighSurrogate(text.charCodeAt(end)) &&
    isLowSurrogate(text.charCodeAt(end + 1))
  ) {
    return end + 1;
  }
  return end;
}

/** Word characters: Unicode letters, digits, and underscore. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Return copies of markers whose edges are snapped outward to word
 * boundaries. An edge is only moved when it falls strictly inside a word
 * (word character on both sides); edges resting on whitespace or
 * punctuation are left alone. Input markers are never mutated.
 */
function snapToWordBoundaries(text, markers) {
  return markers.map(m => {
    let start = m.start;
    let end = m.end;
    while (
      start > 0 && start < text.length &&
      WORD_CHAR.test(text[start]) && WORD_CHAR.test(text[start - 1])
    ) {
      start--;
    }
    while (
      end >= 0 && end < text.length - 1 &&
      WORD_CHAR.test(text[end]) && WORD_CHAR.test(text[end + 1])
    ) {
      end++;
    }
    return {
      start,
      end,
      enabled: true,
      revision: m.revision,
      lastTouched: m.lastTouched
    };
  });
}

/**
 * Flatten overlapping markers into non-overlapping heat segments covering
 * the whole text — the canonical input for canvas minimaps and heat strips.
 *
 * Segments use half-open ranges: `start` inclusive, `end` EXCLUSIVE (unlike
 * markers, whose `end` is inclusive). Segments tile the text exactly: the
 * first starts at 0, each starts where the previous ended, and the last
 * ends at `text.length`. Unmarked stretches get `depth: 0, revision: 0,
 * lastTouched: 0`. Adjacent segments with identical depth/revision/
 * lastTouched are merged. Markers with `enabled === false` are ignored
 * (markers missing the flag count as active).
 *
 * @param {string} text - The final text
 * @param {Marker[]} markers - Markers (any overlap structure)
 * @returns {Array<{start: number, end: number, depth: number, revision: number, lastTouched: number}>}
 */
export function computeHeatSegments(text, markers) {
  const len = text.length;
  if (len === 0) return [];

  const active = markers.filter(m => m.enabled !== false && m.end >= m.start);

  const cuts = new Set([0, len]);
  for (const m of active) {
    cuts.add(Math.max(0, Math.min(m.start, len)));
    cuts.add(Math.max(0, Math.min(m.end + 1, len)));
  }
  const points = [...cuts].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];

    let depth = 0;
    let revision = 0;
    let lastTouched = 0;
    for (const m of active) {
      // Coverage is uniform within a segment because every marker boundary
      // is a cut point.
      if (m.start <= start && m.end >= end - 1) {
        depth++;
        revision = Math.max(revision, m.revision ?? 0);
        lastTouched = Math.max(lastTouched, m.lastTouched ?? m.revision ?? 0);
      }
    }

    const prev = segments[segments.length - 1];
    if (prev && prev.depth === depth && prev.revision === revision &&
        prev.lastTouched === lastTouched) {
      prev.end = end;
    } else {
      segments.push({ start, end, depth, revision, lastTouched });
    }
  }

  return segments;
}

/**
 * Merge markers born in the SAME revision that overlap or sit within
 * `joinGap` characters of each other. Diff cleanup can fragment one
 * conceptual edit into several small markers; this rejoins them. Markers
 * from different revisions are never merged — cross-revision stacking IS
 * the depth signal.
 *
 * Gap is measured as the number of unmarked characters between two markers
 * (adjacent markers have gap 0 and merge at the default joinGap of 0). A
 * merged marker spans min(start)..max(end) and takes the max lastTouched.
 * Markers with `enabled === false` are dropped. Returns a NEW array sorted
 * by (start, revision); the input array and its markers are not mutated.
 *
 * @param {Marker[]} markers - Markers to normalize
 * @param {Object} [options]
 * @param {number} [options.joinGap=0] - Max unmarked characters between
 *   same-revision markers that still merge
 * @returns {Marker[]} New array of merged markers
 */
export function normalizeMarkers(markers, { joinGap = 0 } = {}) {
  const active = markers.filter(m => m.enabled !== false && m.end >= m.start);

  const byRevision = new Map();
  for (const m of active) {
    const rev = m.revision ?? 0;
    if (!byRevision.has(rev)) byRevision.set(rev, []);
    byRevision.get(rev).push(m);
  }

  const result = [];
  for (const [rev, group] of byRevision) {
    group.sort((a, b) => a.start - b.start || a.end - b.end);

    let current = null;
    for (const m of group) {
      if (current && m.start - current.end - 1 <= joinGap) {
        current.end = Math.max(current.end, m.end);
        current.lastTouched = Math.max(current.lastTouched, m.lastTouched ?? rev);
      } else {
        if (current) result.push(current);
        current = new Marker(m.start, m.end, rev);
        current.lastTouched = m.lastTouched ?? rev;
      }
    }
    if (current) result.push(current);
  }

  result.sort((a, b) => a.start - b.start || a.revision - b.revision || a.end - b.end);
  return result;
}

/**
 * Convenience function: compute deep diff and render as HTML.
 *
 * Accepts the union of computeDeepDiff and renderWithMarkers options. As a
 * convenience, `renderDeletions: true` enables deletion tracking (unless
 * `trackDeletions` was set explicitly) and pipes the computed tombstones
 * into the renderer.
 */
export function deepDiffHtml(revisions, options = {}) {
  const computeOptions = { ...options };
  if (options.renderDeletions === true && options.trackDeletions === undefined) {
    computeOptions.trackDeletions = true;
  }

  const result = computeDeepDiff(revisions, computeOptions);

  const renderOptions = { ...options };
  if (options.renderDeletions === true) {
    renderOptions.renderDeletions = result.deletions || [];
  }

  return renderWithMarkers(result.text, result.markers, renderOptions);
}

/**
 * Hand-tuned colour ramps, indexed by nesting depth (1-based; depths beyond
 * the last stop clamp to it). `fg` nudges text colour where the background
 * gets too intense for the page's default text colour.
 */
const STYLE_PALETTES = {
  green: {
    light: [
      { bg: 'rgba(187, 242, 191, 0.45)' },
      { bg: 'rgba(134, 226, 143, 0.55)' },
      { bg: 'rgba(94, 204, 108, 0.62)' },
      { bg: 'rgba(61, 179, 80, 0.7)' },
      { bg: 'rgba(34, 148, 58, 0.8)', fg: '#f0fdf4' },
      { bg: 'rgba(17, 116, 42, 0.88)', fg: '#f0fdf4' }
    ],
    dark: [
      { bg: 'rgba(34, 84, 46, 0.45)' },
      { bg: 'rgba(41, 110, 58, 0.55)' },
      { bg: 'rgba(48, 138, 70, 0.62)' },
      { bg: 'rgba(62, 170, 88, 0.7)', fg: '#052e10' },
      { bg: 'rgba(94, 205, 117, 0.8)', fg: '#052e10' },
      { bg: 'rgba(134, 235, 150, 0.9)', fg: '#052e10' }
    ]
  },
  amber: {
    light: [
      { bg: 'rgba(254, 236, 189, 0.5)' },
      { bg: 'rgba(252, 217, 138, 0.6)' },
      { bg: 'rgba(247, 190, 92, 0.66)' },
      { bg: 'rgba(235, 156, 58, 0.72)' },
      { bg: 'rgba(204, 118, 32, 0.82)', fg: '#fffbeb' },
      { bg: 'rgba(163, 88, 18, 0.9)', fg: '#fffbeb' }
    ],
    dark: [
      { bg: 'rgba(102, 72, 20, 0.45)' },
      { bg: 'rgba(133, 94, 24, 0.55)' },
      { bg: 'rgba(166, 118, 28, 0.62)' },
      { bg: 'rgba(202, 145, 36, 0.7)', fg: '#2a1c02' },
      { bg: 'rgba(233, 176, 56, 0.82)', fg: '#2a1c02' },
      { bg: 'rgba(250, 204, 94, 0.9)', fg: '#2a1c02' }
    ]
  },
  ocean: {
    light: [
      { bg: 'rgba(191, 233, 250, 0.5)' },
      { bg: 'rgba(145, 213, 246, 0.6)' },
      { bg: 'rgba(99, 185, 238, 0.66)' },
      { bg: 'rgba(62, 152, 222, 0.72)' },
      { bg: 'rgba(38, 116, 196, 0.82)', fg: '#eff8ff' },
      { bg: 'rgba(24, 86, 162, 0.9)', fg: '#eff8ff' }
    ],
    dark: [
      { bg: 'rgba(23, 58, 94, 0.5)' },
      { bg: 'rgba(28, 78, 124, 0.6)' },
      { bg: 'rgba(34, 100, 155, 0.66)' },
      { bg: 'rgba(46, 128, 190, 0.72)', fg: '#041627' },
      { bg: 'rgba(74, 160, 220, 0.82)', fg: '#041627' },
      { bg: 'rgba(122, 195, 245, 0.9)', fg: '#041627' }
    ]
  },
  heat: {
    light: [
      { bg: 'rgba(254, 240, 178, 0.5)' },
      { bg: 'rgba(253, 211, 120, 0.6)' },
      { bg: 'rgba(250, 168, 84, 0.68)' },
      { bg: 'rgba(240, 118, 60, 0.75)', fg: '#fff7ed' },
      { bg: 'rgba(217, 70, 43, 0.84)', fg: '#fff7ed' },
      { bg: 'rgba(176, 32, 32, 0.92)', fg: '#fff7ed' }
    ],
    dark: [
      { bg: 'rgba(92, 66, 16, 0.5)' },
      { bg: 'rgba(128, 82, 20, 0.6)' },
      { bg: 'rgba(166, 92, 28, 0.68)' },
      { bg: 'rgba(203, 98, 40, 0.76)', fg: '#2b0d02' },
      { bg: 'rgba(235, 116, 60, 0.85)', fg: '#2b0d02' },
      { bg: 'rgba(250, 152, 92, 0.92)', fg: '#2b0d02' }
    ]
  }
};

/**
 * Build the depth-selector rules for one ramp.
 */
function depthRules(stops, maxDepth, prefix = '') {
  let css = '';
  for (let d = 1; d <= maxDepth; d++) {
    const stop = stops[Math.min(d, stops.length) - 1];
    const selector =
      (prefix ? prefix + ' ' : '') + '.deep-diff' + ' .deep-diff'.repeat(d - 1);
    const fg = stop.fg ? ` color: ${stop.fg};` : '';
    css += `${selector} { background-color: ${stop.bg};${fg} }\n`;
  }
  return css;
}

/**
 * Ghost (deletion tombstone) styling: muted, struck through.
 */
function ghostRule(variant, prefix = '') {
  const p = prefix ? prefix + ' ' : '';
  if (variant === 'light') {
    return `${p}.deep-diff-ghost { color: rgba(153, 27, 27, 0.62); background-color: rgba(254, 226, 226, 0.45); text-decoration: line-through; text-decoration-color: rgba(153, 27, 27, 0.4); text-decoration-thickness: 1px; }\n`;
  }
  return `${p}.deep-diff-ghost { color: rgba(252, 165, 165, 0.62); background-color: rgba(127, 29, 29, 0.3); text-decoration-color: rgba(252, 165, 165, 0.45); }\n`;
}

/**
 * Get CSS for styling nested markers with increasing intensity, plus the
 * `.deep-diff-ghost` deletion style.
 *
 * Accepts either the legacy `maxDepth` number, or an options object:
 *
 * @param {number|Object} [optionsOrMaxDepth=5] - Max nesting depth, or
 *   `{ maxDepth, palette, mode, darkMode }`
 * @param {number} [optionsOrMaxDepth.maxDepth=5] - Max nesting depth
 * @param {'green'|'amber'|'ocean'|'heat'} [optionsOrMaxDepth.palette='green']
 *   Hand-tuned colour ramp
 * @param {'depth'} [optionsOrMaxDepth.mode='depth'] - Ramp mode (reserved)
 * @param {boolean} [optionsOrMaxDepth.darkMode=false] - Also emit a
 *   `@media (prefers-color-scheme: dark)` block and `[data-theme="dark"]`
 *   overrides using ramps designed for dark backgrounds
 * @returns {string} CSS string
 */
export function getDefaultStyles(optionsOrMaxDepth = 5) {
  const opts = typeof optionsOrMaxDepth === 'number'
    ? { maxDepth: optionsOrMaxDepth }
    : optionsOrMaxDepth || {};
  const { maxDepth = 5, palette = 'green', mode = 'depth', darkMode = false } = opts;

  if (!Object.hasOwn(STYLE_PALETTES, palette)) {
    throw new RangeError(
      `Unknown palette "${palette}". Expected one of: ${Object.keys(STYLE_PALETTES).join(', ')}`
    );
  }
  if (mode !== 'depth') {
    throw new RangeError(`Unknown mode "${mode}". Expected 'depth'`);
  }

  const ramps = STYLE_PALETTES[palette];
  let css = depthRules(ramps.light, maxDepth) + ghostRule('light');

  if (darkMode) {
    const darkCss = depthRules(ramps.dark, maxDepth) + ghostRule('dark');
    const indented = darkCss
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => '  ' + line)
      .join('\n');
    css += `@media (prefers-color-scheme: dark) {\n${indented}\n}\n`;
    css += depthRules(ramps.dark, maxDepth, '[data-theme="dark"]');
    css += ghostRule('dark', '[data-theme="dark"]');
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
export default {
  computeDeepDiff,
  renderWithMarkers,
  deepDiffHtml,
  getDefaultStyles,
  computeHeatSegments,
  normalizeMarkers
};

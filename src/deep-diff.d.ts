/**
 * A marker representing a changed region across revisions.
 *
 * `start`/`end` are inclusive UTF-16 code unit offsets into the final
 * revision's text.
 */
export interface Marker {
  /** Start position (inclusive) */
  start: number;
  /** End position (inclusive) */
  end: number;
  /** Whether the marker is still active */
  enabled: boolean;
  /**
   * Revision index (1-based) that created this marker. Always present on
   * markers returned by computeDeepDiff; optional on hand-built markers.
   */
  revision?: number;
  /**
   * Most recent revision index that modified this region (expanded or
   * contracted it). Equals `revision` until a later edit touches the region.
   */
  lastTouched?: number;
  /** Length of the marked region */
  readonly length?: number;
}

/**
 * A zero-width "tombstone" recording text deleted in some revision.
 *
 * `index` is a point between characters in FINAL-text coordinates
 * (0 = before the first character, text.length = after the last).
 * Tombstone positions are transformed through all revisions after the
 * deletion: shifted by earlier inserts/deletes, or collapsed to the deletion
 * point when a later deletion swallows them. Multiple tombstones may share
 * an index ("stacking"); they are sorted by (index, revision) so ghosts
 * render in chronological order. Points that would fall between the halves
 * of a surrogate pair are snapped left, in front of the whole code point.
 */
export interface Tombstone {
  /** Zero-width position in final-text coordinates */
  index: number;
  /** The deleted text */
  text: string;
  /** Revision index (1-based) in which the deletion occurred */
  revision: number;
}

/**
 * A non-overlapping heat segment produced by computeHeatSegments.
 *
 * NOTE: unlike Marker, segments use half-open ranges — `end` is EXCLUSIVE.
 * Segments tile the text exactly (first starts at 0, last ends at
 * text.length, no gaps).
 */
export interface HeatSegment {
  /** Start position (inclusive) */
  start: number;
  /** End position (EXCLUSIVE) */
  end: number;
  /** Number of markers covering this segment (0 = unmarked) */
  depth: number;
  /** Max birth revision among covering markers (0 when depth is 0) */
  revision: number;
  /** Max lastTouched among covering markers (0 when depth is 0) */
  lastTouched: number;
}

/**
 * Result of computing deep diff across revisions.
 */
export interface DeepDiffResult {
  /** The final revision text */
  text: string;
  /** Array of active markers */
  markers: Marker[];
  /** Number of revisions actually processed (after filtering) */
  revisionCount: number;
  /**
   * Deletion tombstones in final-text coordinates, sorted by
   * (index, revision). Only present when `trackDeletions: true`.
   */
  deletions?: Tombstone[];
}

/**
 * Options for normalizeMarkers.
 */
export interface NormalizeOptions {
  /**
   * Maximum number of unmarked characters between two same-revision markers
   * that still merge. Adjacent markers have gap 0 (default: 0).
   */
  joinGap?: number;
}

/**
 * Options for computing deep diff.
 */
export interface ComputeOptions {
  /** Skip empty revisions (default: true) */
  skipEmpty?: boolean;
  /** Diff computation timeout in seconds (default: 1) */
  timeout?: number;
  /**
   * Record a zero-width tombstone for every deletion and expose them as
   * `result.deletions` (default: false).
   */
  trackDeletions?: boolean;
  /**
   * Merge fragmented markers born in the same revision (see
   * normalizeMarkers). `true` is shorthand for `{ joinGap: 0 }`
   * (default: false).
   */
  normalize?: boolean | NormalizeOptions;
  /**
   * Treat an adjacent DELETE+INSERT pair in a revision's diff as a
   * replacement: markers overlapping the deleted range are remapped
   * proportionally (rounded outward) onto the inserted text — keeping their
   * birth `revision`, updating `lastTouched` — instead of being killed or
   * contracted. The insertion still gets its own fresh marker, so the
   * remapped marker and the new one stack: "delete a phrase and retype it"
   * deepens heat instead of resetting it. Pure deletions still kill or
   * contract as usual. Recommended for fine-grained (keystroke-level)
   * snapshot histories; leave off for coarse committed revisions
   * (default: false — default output is unchanged).
   */
  trackReplacements?: boolean;
}

/**
 * Options for rendering markers as HTML.
 */
export interface RenderOptions {
  /** HTML tag to use for markers (default: 'ins') */
  tagName?: string;
  /** CSS class for marker tags (default: 'deep-diff') */
  className?: string;
  /**
   * Emit data-revision, data-last-touched, and data-depth on each marker
   * tag (default: false — default output is byte-identical to previous
   * releases). Uses a stack-based renderer that closes/reopens tags at
   * partial overlaps so every character is attributed to the correct
   * marker.
   */
  dataAttributes?: boolean;
  /**
   * With 'word', marker edges are visually snapped outward to word
   * boundaries before tags are built; the markers array is never mutated
   * (default: 'char').
   */
  boundary?: 'char' | 'word';
  /**
   * Deletion tombstones (from computeDeepDiff's `trackDeletions`) to
   * interleave as `<del class="deep-diff-ghost">text</del>` at their
   * positions (escaped). Ghosts at a marker boundary render after closing
   * tags and before opening tags.
   */
  renderDeletions?: Tombstone[];
}

/**
 * Combined options for deepDiffHtml.
 *
 * `renderDeletions: true` is a convenience that enables `trackDeletions`
 * (unless explicitly set) and pipes the computed tombstones into the
 * renderer.
 */
export type DeepDiffHtmlOptions =
  ComputeOptions &
  Omit<RenderOptions, 'renderDeletions'> & {
    renderDeletions?: boolean | Tombstone[];
  };

/**
 * Options object form for getDefaultStyles.
 */
export interface StyleOptions {
  /** Maximum nesting depth to generate styles for (default: 5) */
  maxDepth?: number;
  /** Hand-tuned colour ramp (default: 'green') */
  palette?: 'green' | 'amber' | 'ocean' | 'heat';
  /** Ramp mode; only 'depth' is currently supported (default: 'depth') */
  mode?: 'depth';
  /**
   * Also emit a `@media (prefers-color-scheme: dark)` block plus
   * `[data-theme="dark"]` overrides with ramps designed for dark
   * backgrounds (default: false).
   */
  darkMode?: boolean;
}

/**
 * Compute cumulative diff markers across a sequence of text revisions.
 *
 * @param revisions - Array of text versions, oldest first
 * @param options - Configuration options
 * @returns Final text, markers, revision count, and (optionally) deletions
 */
export function computeDeepDiff(
  revisions: string[],
  options?: ComputeOptions
): DeepDiffResult;

/**
 * Render text with markers as HTML with nested tags.
 *
 * @param text - The final text
 * @param markers - Array of markers to render (enabled ones are rendered)
 * @param options - Rendering options
 * @returns HTML string with nested marker tags
 */
export function renderWithMarkers(
  text: string,
  markers: Marker[],
  options?: RenderOptions
): string;

/**
 * Flatten overlapping markers into non-overlapping heat segments covering
 * the whole text — the canonical input for canvas minimaps and heat strips.
 * Returns [] for empty text; otherwise segments tile the text exactly.
 *
 * @param text - The final text
 * @param markers - Markers (any overlap structure; `enabled === false` ignored)
 * @returns Non-overlapping segments with half-open ranges (end exclusive)
 */
export function computeHeatSegments(
  text: string,
  markers: Marker[]
): HeatSegment[];

/**
 * Merge markers born in the SAME revision that overlap or sit within
 * `joinGap` characters of each other. Markers from different revisions are
 * never merged — cross-revision stacking is the depth signal. Returns a new
 * array sorted by (start, revision); the input is not mutated.
 *
 * @param markers - Markers to normalize
 * @param options - `{ joinGap }` (default 0: merge overlapping/adjacent)
 * @returns New array of merged markers
 */
export function normalizeMarkers(
  markers: Marker[],
  options?: NormalizeOptions
): Marker[];

/**
 * Convenience function: compute deep diff and render as HTML.
 *
 * @param revisions - Array of text versions, oldest first
 * @param options - Combined compute and render options
 * @returns HTML string with nested marker tags
 */
export function deepDiffHtml(
  revisions: string[],
  options?: DeepDiffHtmlOptions
): string;

/**
 * Get CSS for styling nested markers with increasing intensity, plus the
 * `.deep-diff-ghost` deletion style. Accepts either the legacy maxDepth
 * number or a StyleOptions object.
 *
 * @param optionsOrMaxDepth - Maximum nesting depth (default: 5), or options
 * @returns CSS string
 */
export function getDefaultStyles(
  optionsOrMaxDepth?: number | StyleOptions
): string;

declare const _default: {
  computeDeepDiff: typeof computeDeepDiff;
  renderWithMarkers: typeof renderWithMarkers;
  deepDiffHtml: typeof deepDiffHtml;
  getDefaultStyles: typeof getDefaultStyles;
  computeHeatSegments: typeof computeHeatSegments;
  normalizeMarkers: typeof normalizeMarkers;
};

export default _default;

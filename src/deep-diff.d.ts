/**
 * A marker representing a changed region across revisions.
 */
export interface Marker {
  /** Start position (inclusive) */
  start: number;
  /** End position (inclusive) */
  end: number;
  /** Whether the marker is still active */
  enabled: boolean;
  /** Length of the marked region */
  readonly length: number;
}

/**
 * Result of computing deep diff across revisions.
 */
export interface DeepDiffResult {
  /** The final revision text */
  text: string;
  /** Array of active markers */
  markers: Marker[];
}

/**
 * Options for computing deep diff.
 */
export interface ComputeOptions {
  /** Skip empty revisions (default: true) */
  skipEmpty?: boolean;
  /** Diff computation timeout in seconds (default: 1) */
  timeout?: number;
}

/**
 * Options for rendering markers as HTML.
 */
export interface RenderOptions {
  /** HTML tag to use for markers (default: 'ins') */
  tagName?: string;
  /** CSS class for marker tags (default: 'deep-diff') */
  className?: string;
}

/**
 * Combined options for deepDiffHtml.
 */
export type DeepDiffHtmlOptions = ComputeOptions & RenderOptions;

/**
 * Compute cumulative diff markers across a sequence of text revisions.
 *
 * @param revisions - Array of text versions, oldest first
 * @param options - Configuration options
 * @returns Object containing final text and markers
 */
export function computeDeepDiff(
  revisions: string[],
  options?: ComputeOptions
): DeepDiffResult;

/**
 * Render text with markers as HTML with nested tags.
 *
 * @param text - The final text
 * @param markers - Array of markers to render
 * @param options - Rendering options
 * @returns HTML string with nested marker tags
 */
export function renderWithMarkers(
  text: string,
  markers: Marker[],
  options?: RenderOptions
): string;

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
 * Get CSS for styling nested markers with increasing intensity.
 *
 * @param maxDepth - Maximum nesting depth to generate styles for (default: 5)
 * @returns CSS string
 */
export function getDefaultStyles(maxDepth?: number): string;

declare const _default: {
  computeDeepDiff: typeof computeDeepDiff;
  renderWithMarkers: typeof renderWithMarkers;
  deepDiffHtml: typeof deepDiffHtml;
  getDefaultStyles: typeof getDefaultStyles;
};

export default _default;

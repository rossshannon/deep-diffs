# Core library changes

Summary of the core-library deepening pass (`src/deep-diff.js`, `src/deep-diff.d.ts`, `test/deep-diff.test.js`). The existing public API is 100% backward compatible: default output of every function is byte-identical to before, and all 57 pre-existing tests pass unmodified. The core suite now has 138 tests.

## 1. Deletion tombstones — `trackDeletions`

```js
const { text, markers, deletions } = computeDeepDiff(revisions, { trackDeletions: true });
// deletions: [{ index, text, revision }, ...]  — sorted by (index, revision)
```

Every deletion becomes a zero-width **tombstone** `{ index, text, revision }` in final-text coordinates (`index` is a point between characters; `text.length` means "at the very end"; `revision` is the 1-based revision in which the deletion happened). The `deletions` key only appears when the option is on, so the default result shape is unchanged.

Tombstone positions are transformed through every subsequent revision's diff, like zero-width markers:

- **Insert strictly before** the tombstone → shift right.
- **Insert at exactly the tombstone's position** → tombstone stays put, so the ghost renders *before* text later inserted at the same point. This makes replacements read chronologically: `the <del>cat</del><ins>dog</ins> sat`.
- **Delete entirely before** → shift left.
- **Delete whose range straddles the tombstone** → collapse to the deletion point.
- Tombstones are never merged. Several may share an index ("stacking", e.g. after a collapse); they render in ascending revision order — oldest deleted text first.

Rendering:

```js
renderWithMarkers(text, markers, { renderDeletions: deletions });
// ... hello<del class="deep-diff-ghost"> world</del> ...
```

`renderWithMarkers`' `renderDeletions` option takes the tombstone array and interleaves `<del class="deep-diff-ghost">…</del>` (HTML-escaped) at each position. At a marker boundary, ghosts render after closing tags and before opening tags. Out-of-range indices are clamped to the text bounds. Convenience: `deepDiffHtml(revisions, { renderDeletions: true })` auto-enables `trackDeletions` (unless explicitly set to `false`) and pipes the tombstones through.

## 2. Data attributes — `dataAttributes`

```js
renderWithMarkers(text, markers, { dataAttributes: true });
// <ins class="deep-diff" data-revision="1" data-last-touched="3" data-depth="1">...
```

Default `false`; default output is byte-identical to previous releases. When on, each marker tag carries `data-revision` (birth revision), `data-last-touched`, and `data-depth` (nesting depth at that open tag). Missing metadata defaults to `0`. Ghosts get `data-revision` too.

This mode uses a stack-based renderer that tracks marker *identity*: when a partially-overlapping marker ends, inner tags are closed and reopened so every character is attributed to the correct marker. (The fast default renderer is depth-correct but identity-agnostic, which is fine when tags are anonymous.) Consequence: a marker split by a partial overlap may emit more than one tag, possibly at different depths.

## 3. `computeHeatSegments(text, markers)`

```js
computeHeatSegments('abcdefghij', markers);
// [{ start: 0, end: 3, depth: 1, revision: 1, lastTouched: 1 }, ...]
```

Flattens any overlap structure into non-overlapping segments covering the whole text — the canonical input for canvas minimaps/heat strips. Semantics:

- **`end` is EXCLUSIVE** (half-open ranges), unlike markers whose `end` is inclusive.
- Segments tile the text exactly: first starts at 0, contiguous, last ends at `text.length`. Empty text → `[]`.
- `depth` = number of covering markers (0 for unmarked stretches, which get `revision: 0, lastTouched: 0`); `revision`/`lastTouched` = max among covering markers.
- Adjacent segments with identical `(depth, revision, lastTouched)` are merged.
- Markers with `enabled === false` are ignored; markers *missing* the flag count as active.

## 4. `normalizeMarkers(markers, { joinGap = 0 })` and `normalize` option

```js
normalizeMarkers(markers, { joinGap: 1 });
computeDeepDiff(revisions, { normalize: true });          // joinGap 0
computeDeepDiff(revisions, { normalize: { joinGap: 2 } });
```

Diff cleanup can fragment one conceptual edit into several small markers within a single revision. `normalizeMarkers` merges markers **born in the same revision** that overlap or sit within `joinGap` unmarked characters of each other (adjacent markers have gap 0 and merge by default). Markers from different revisions are *never* merged — cross-revision stacking is the depth signal. Merged markers span `min(start)..max(end)` and take the max `lastTouched`; disabled markers are dropped. Returns a new array sorted by `(start, revision)`; the input is not mutated. `computeDeepDiff`'s `normalize` option applies this once, after all revisions are processed (in final-text coordinates).

## 5. Word-boundary snapping — `boundary: 'word'`

```js
renderWithMarkers('hello world', [{ start: 7, end: 8, enabled: true }], { boundary: 'word' });
// hello <ins class="deep-diff">world</ins>
```

Render-level only (default `'char'` is unchanged). Marker edges are snapped *outward* to word boundaries so highlights read as whole words. An edge only moves when it falls strictly inside a word (word characters — Unicode letters, digits, underscore — on both sides); edges resting on whitespace/punctuation stay put, so punctuation is never swallowed. Snapping operates on copies — the markers array is never mutated — and tags stay balanced even when snapping makes markers coincide. Composes with `dataAttributes`.

## 6. `getDefaultStyles` overhaul

Legacy `getDefaultStyles(maxDepth)` still works and equals `getDefaultStyles({ maxDepth })`. New options-object form:

```js
getDefaultStyles({ maxDepth: 6, palette: 'heat', mode: 'depth', darkMode: true });
```

- **Palettes**: `'green'` (default), `'amber'`, `'ocean'`, `'heat'` — hand-tuned rgba ramps (6 stops; deeper depths clamp to the last stop) instead of naive opacity stacking. Depths 5+ (4+ for `heat` and dark ramps) also set an explicit text `color` so text stays readable on intense backgrounds. Unknown palette/mode throws `RangeError` (`mode` accepts only `'depth'` for now; reserved for future age-based ramps).
- **`darkMode: true`** additionally emits a `@media (prefers-color-scheme: dark)` block *plus* `[data-theme="dark"]` overrides, using separate ramps designed for dark backgrounds (dim tints at low depth rising to bright fills with dark text at high depth).
- **`.deep-diff-ghost`** is now styled in every output: muted red, subtle strikethrough, faint background; a matching dark variant is included with `darkMode`.

## 7. `transformMarkers` correctness audit

Hand-worked the coordinate bookkeeping (the per-marker index advances on INSERT/EQUAL and holds on DELETE, i.e. new-text coordinates; markers are shifted in lockstep, so comparisons stay in a consistent frame) against replacements, multi-op diffs, and every exact-boundary case. **Verdict: no transform bugs found.** The boundary semantics are now locked in by regression tests with hand-computed positions:

- Insert at exactly `marker.start` → shift (a pure shift does not update `lastTouched`); the inserted text gets its own marker, adjacent rather than nested.
- Insert at exactly `marker.end + 1` → no change.
- Delete ending at exactly `marker.start - 1` → shift left by full length.
- Delete starting at exactly `marker.end` → contract by one.
- Delete starting at exactly `marker.end + 1` → no change.
- Replacement (`DELETE` + `INSERT`) strictly inside a marker → contract then expand; net size preserved and the replacement nests (depth signal kept).
- Replacement at a marker's start → the delete consumes the marked prefix, then the insert-at-start shifts the remainder; the replacement text becomes an adjacent rev-N marker, *not* nested. Documented semantic consequence of the insert-at-start-shifts rule, not a bug.

### Bug found and fixed

- **`computeDeepDiff` early return omitted `revisionCount`** (and `deletions`): with fewer than two revisions after filtering, the result was `{ text, markers }` only, unlike the documented `{ text, markers, revisionCount }` shape of the main path. Fixed: `revisionCount` (0 or 1) is always present, and `deletions: []` is included when `trackDeletions` is on.

## 8. Types

`src/deep-diff.d.ts` fully updated with doc comments: `Marker` gains `revision`/`lastTouched`, new `Tombstone`, `HeatSegment`, `NormalizeOptions`, `StyleOptions` interfaces, `DeepDiffResult` gains `revisionCount`/`deletions?`, `ComputeOptions`/`RenderOptions`/`DeepDiffHtmlOptions` extended, new function declarations for `computeHeatSegments` and `normalizeMarkers` (both also added to the default export), and `getDefaultStyles` accepts `number | StyleOptions`.

## Verification

- `npm test` — passes (core suite grew from 57 to 138 tests).
- `npm run typecheck` — passes.
- `npm run build` — rollup builds `dist/deep-diff.js` + `dist/deep-diff.cjs` cleanly.

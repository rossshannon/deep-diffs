# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-07-10

A major revival release. New options and result fields are additive, but the
rendered-output guarantees and marker ordering have changed, so exact 1.0.0
output should not be relied upon byte-for-byte.

### Added

- Per-marker revision metadata: every marker now records `revision` (the revision that created it) and `lastTouched` (the revision that most recently modified it), and results include `revisionCount`.
- Deletion tombstones: `trackDeletions` records every deletion as a zero-width tombstone `{ index, text, revision }` in final-text coordinates, and `renderDeletions` interleaves them as `<del class="deep-diff-ghost">` ghosts.
- `computeHeatSegments(text, markers)` — flattens any overlap structure into non-overlapping segments that tile the whole text, the canonical input for minimaps and heat strips.
- `normalizeMarkers(markers, { joinGap })` and a matching `normalize` option on `computeDeepDiff` — merges fragmented same-revision markers without ever collapsing the cross-revision depth signal.
- `trackReplacements` option on `computeDeepDiff` — treats an adjacent delete+insert pair as a replacement, remapping overlapping markers proportionally onto the inserted text instead of killing or contracting them.
- `dataAttributes` render option — a stack-based renderer that emits `data-revision`, `data-last-touched` and `data-depth` on every tag.
- `boundary: 'word'` render option — snaps marker edges outward to word boundaries so highlights read as whole words (render-only; the markers array is never mutated).
- `getDefaultStyles` options form with `palette` (`'green'`, `'amber'`, `'ocean'`, `'heat'`) and `darkMode` colour ramps; the legacy `getDefaultStyles(maxDepth)` call still works.
- `deep-diffs-git` CLI — turns any file's git history into a self-contained deep-diff HTML churn report, with `--since`, `--max-revisions`, `--mode`, `--note` and `--open` options.
- Five interactive demos (Playground, Draft Archaeology, The Living Draft, Collaboration Lens, Git Report) plus a gallery at `demos/index.html`, each a self-contained single HTML file.
- Property-based fuzz suite (`test/property.test.js`) that verifies the marker transform against an independent character-identity reference model — 60,000+ randomised revision chains with zero invariant failures.
- Future Directions research essay (`docs/FUTURE-DIRECTIONS.md`) mapping where deep diffs go next: editor integrations, CRDT-native markers, and provenance lenses for AI co-writing.

### Changed

- Rendered HTML is now guaranteed well-formed around astral characters and degenerate markers; exact output may differ from 1.0.0 where those cases previously produced broken tags.
- `renderWithMarkers` now defensively snaps caller-supplied marker edges off surrogate halves and filters degenerate markers (it works on copies; the input array is never mutated).

### Fixed

The full ledger, with repros and diagnoses, lives in [docs/known-issues.md](docs/known-issues.md).

- Markers no longer split UTF-16 surrogate pairs: diff-match-patch's code-unit-level diffs could misalign tags mid-code-point (a tag between an emoji's high and low surrogate); marker edges are now snapped to code-point boundaries.
- Deletion tombstone points can no longer land between surrogate halves, so ghost tags never render mid-code-point.
- `revisionCount` is now present on the early-exit return shape (zero or one usable revisions), matching the documented result.
- Marker ordering is deterministic — results are sorted by `(start, end, revision)`, no longer dependent on no-op revisions or creation order.
- Degenerate markers (`end < start`) no longer emit unbalanced tags on `renderWithMarkers`' fast path.
- `deep-diffs-git`: non-ASCII file paths are no longer silently dropped before a rename (git's C-quoted `--name-only` output is now handled), and author names containing tabs no longer shift the parsed log fields (NUL separators).

## [1.0.0] - 2026

- Initial published release: `computeDeepDiff`, `renderWithMarkers`, `deepDiffHtml` and `getDefaultStyles`, modernising the original 2010 Deep Diffs algorithm (Shannon, Quigley & Nixon, AVI 2010).

[2.0.0]: https://github.com/rossshannon/deep-diffs/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/rossshannon/deep-diffs/releases/tag/v1.0.0

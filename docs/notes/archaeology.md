# Draft Archaeology (demos/draft-archaeology.html)

A cinematic replay of a document being written: two hand-authored revision histories ("His Hands", a 14-revision
personal essay; "The Hinge", an 8-revision speech opening) play back like film while deep-diff heat accumulates
wherever the writer kept circling. Fully self-contained (diff-match-patch and an adapted `src/deep-diff.js`
marker algorithm are inlined), works over `file://`.

Design decisions:
- Heat is rendered as flat constant-depth runs (per-char marker-overlap counts) instead of nested `<ins>` tags —
  visually identical, but makes span-level morphing between revisions tractable. One JS ramp (`heatColor`) feeds
  both the generated `.d1–.d8` CSS and the strata canvas, so text and minimap can never disagree.
- The ramp is deliberately steep: single-pass text is a near-invisible wash so the eye keys on the strata that
  matter — the specimen's contested sentence was authored so each rewrite lands *inside* the previous insertion,
  producing an honest depth-4 "appraising" hotspot by v13.
- Morphs diff the two rendered states: insertions flash bright then settle into their heat colour (implicit-final
  keyframe trick), deletions linger as struck-through ghosts before collapsing; reduced-motion disables both.
- Scrubber ticks glow in proportion to each revision's char-delta; the right-hand "core sample" canvas doubles as
  a click/drag minimap with a viewport band. Light/dark themes via tokens with `prefers-color-scheme` +
  `[data-theme]` overrides, canvas repainting on a `data-theme` MutationObserver.

Verified with Playwright (Chromium, 1440x900 @2x): zero console errors, full playback to the summary overlay,
keyboard/scrubber/strata/theme/specimen interactions, no overflow at 720px. Screenshots: `docs/screenshots/
archaeology.png`, `archaeology-dark.png`, plus bonus `archaeology-summary.png`.

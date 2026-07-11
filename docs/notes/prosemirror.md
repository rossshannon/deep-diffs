# ProseMirror integration

`integrations/prosemirror/deep-diffs-plugin.js` — the FUTURE-DIRECTIONS
"editor decorations" direction made concrete. The plugin keeps its own
marker list `{from, to, revision, lastTouched}` in plugin state and maps
positions through `tr.mapping` on every transaction — ProseMirror's step
maps natively perform the operational transform that `transformMarkers`
does in the library. Snapshots auto-commit after a configurable pause
(`snapshotMs`, default 2000ms) or via the exported `commitSnapshot`
command; new markers come from diffing snapshot plaintexts with
diff-match-patch and converting offsets to document positions.

Decorations are `Decoration.inline` ranges carrying `deep-diff` +
`dd-d{depth}` classes and `data-depth`/`data-revision`/`data-last-touched`
attributes, rebuilt from flattened heat segments. Heat modes: `depth`
(classic) and `recency` (Embers-style decay, `e^(−age/τ)`).
`getHeatSegments(state)` exposes segments for minimaps; `deepDiffsKey`
is the PluginKey.

`demos/prosemirror.html` is built by `integrations/prosemirror/build.mjs`
(rollup, prosemirror packages installed with `--no-save`), which inlines
the bundle into a single self-contained file. Verified: zero console
errors; nested inserts across snapshots stack to `data-depth="2"`+;
full-range delete-and-retype resets depth by design (the plugin maps
positions only — the library's `trackReplacements` semantics are a
natural v2).

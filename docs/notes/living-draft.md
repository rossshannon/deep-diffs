# The Living Draft — deep diffs as ambient feedback

`demos/living-draft.html` turns the deep-diff history viewer into a live writing surface: snapshots
auto-commit (2s pause after a change, or every 40 keystrokes) and the chained marker heat glows
beneath the text as you type. Fully self-contained — diff-match-patch and the marker algebra from
`src/deep-diff.js` are inlined; works from `file://` with zero network.

Two modes: **Watch a writer** (scripted session with human typing rhythm — a title renamed three
times, sentences repeatedly reworked) and **Write yourself** (transparent-textarea-over-highlight
overlay, with a sample baseline to rework). The novel bit is the **Embers** decay toggle: heat
× e^(−age/τ), τ ≈ 6 snapshots, so the map shows *current attention* rather than Geology's
accumulated strata — toggling animates between the two in place (per-character spans persist,
so CSS transitions carry the change).

One engine adaptation for keystroke granularity: a DELETE immediately followed by an INSERT is
treated as a *replacement* — overlapped markers remap onto the new text instead of being disabled.
Without this, "delete the phrase, retype it" (the dominant rework gesture) would reset heat to zero
on every rewrite. Also on-screen: canvas heat-strip minimap with viewport indicator, live stats
(snapshots, words, churn ratio, deepest edit, most-reworked phrase), provisional tint for
uncommitted typing, light/dark themes, speed control, pause/restart.

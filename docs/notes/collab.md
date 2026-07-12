# Collaboration Lens (demos/collab-lens.html)

Deep diffs × History Flow: one document, three lenses over the same nested markers.
Marker `.revision` maps to an author; `.lastTouched` gives the consensus hue.

- **Heat** — classic deep diffs: intensity = marker nesting depth, single hue.
- **Author** — hue = author of the marker that introduced the wording (History-Flow style).
- **Consensus** — hue = author of the last touch, intensity = depth: contested vs settled ground.

Two specimens built as base text + per-revision replace edits: a 14-revision startup
launch post (Priya/Marcus/Sofia ping-pong the headline down to "in a heartbeat or less",
depth 4) and an 8-revision wiki intro (the guidebook-attribution war, depth 4). Getting
depth > 2 requires *concentric* edits — each rewrite must land strictly inside the previous
insertion with surviving buffer text on both sides, or diff-match-patch deletes the whole
old marker and nesting resets. Author hues are CVD-validated per theme (worst adjacent
deutan ΔE ≥ 40); diff-match-patch is inlined, so the file runs offline from `file://`.
Playwright-verified: lenses (keys 1/2/3), chip-hover isolation, timeline scrubbing,
edit-war detector, theme toggle, 720 px layout — zero console errors.

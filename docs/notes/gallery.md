# demos/index.html — gallery landing page

An exhibition-catalogue front door for the demo suite: framing header with links to the AVI 2010 paper
(Shannon, Quigley & Nixon) and the GitHub repo, then five numbered cards (playground featured full-width,
the rest in a 2-up grid) — each with a hook, feature bullets drawn from `docs/notes/*.md`, an "Explores"
theme line, and its screenshot (light/dark `<img>` pair swapped by `prefers-color-scheme` with
`[data-theme]` overrides winning both directions; git-report is badged as a *generated artifact* of
`npx deep-diffs-git`). Footer links FUTURE-DIRECTIONS.md and known-issues.md. Zero network, works from
`file://`, responsive to 720 px. Playwright-verified: no console errors, all 10 images load, all 7 link
targets exist, theme toggle overrides OS scheme in both directions, no horizontal overflow at 1440/720.
Screenshots: `docs/screenshots/gallery.png`, `gallery-dark.png` (1440×900 @2x).

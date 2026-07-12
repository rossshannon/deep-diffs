# deep-diffs-git

`bin/deep-diffs-git.js` turns a file's git history into a self-contained deep-diff HTML report — the AVI 2010 technique applied to any prose file in a repo (READMEs, docs, ADRs, blog posts).

## Usage

```bash
deep-diffs-git README.md                          # writes README.md.deep-diff.html
deep-diffs-git docs/adr/001.md --out report.html --max-revisions 20
deep-diffs-git essay.md --since 2025-01-01 --mode age --open
```

## Design decisions

- Revisions are fetched with `git log --follow` (plus `--name-only` to resolve each commit's historical path), so renames are chained through; binary/missing/empty revisions are skipped with a warning while keeping `marker.revision` → commit mapping aligned (revision *i* = *i*-th sampled text, baseline 0).
- Histories longer than `--max-revisions` (default 30) are evenly sampled, always keeping the first and last commits; ledger churn dots then measure change vs the previous *shown* revision.
- The document is rendered as flat, well-formed spans with exact depth classes (computed from overlapping markers) rather than raw nested tags; the legend chips, though, are genuinely nested output from `renderWithMarkers`. Two heat modes: edit depth (default) and recency, toggleable in the report.
- Zero new dependencies: only `src/deep-diff.js`, `diff-match-patch` (already a dependency), and `git` via `child_process`.

## The example report

`demos/git-report.html` was generated from a demo repository (built by a script in the session scratchpad) in which a short essay, `why-we-rewrite.md`, is reworked over 15 commits by three authors, including a mid-history rename — the history is synthesised (and labelled as such in the report header) to show deep nesting: the opening paragraph and the "contested sentences" paragraph glow hottest because they were rewritten in four separate passes. Running the CLI on this repo's own `README.md` (8 real commits) also works and was used for verification. Screenshots: `docs/screenshots/git-report.png` (light) and `docs/screenshots/git-report-dark.png` (dark).

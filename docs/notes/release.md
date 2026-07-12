# Release checklist — 2.0.0

Short checklist for publishing the revival release.

## 1. Version bump (coordinator)

- **The coordinator should bump `version` in `package.json` to `2.0.0`** — this
  file is owned by another agent (its `bin` field is under concurrent edit), so
  the bump is deliberately not done here.
- Confirm `CHANGELOG.md`'s `[2.0.0]` heading date matches the publish date.

## 2. Pre-publish smoke test

Run the full local gate first:

```bash
npm ci
npm test          # includes the property suite (FUZZ_CHAINS=100 by default)
npm run typecheck
npm run build     # produces dist/ — required; package main/module/types point at dist/
```

Then smoke-test the three README examples against the **built** package
(`node -e "import('./dist/deep-diff.js').then(...)"` or a quick scratch file):

1. **Quick Start** — `deepDiffHtml(revisions)` on the contract-clause chain must
   produce the nested `<ins class="deep-diff">` output shown in the README, and
   `getDefaultStyles()` must return CSS.
2. **Raw data** — `computeDeepDiff(revisions)` must return
   `{ text, markers, revisionCount: 4 }` with `revision`/`lastTouched` on markers.
3. **Tombstones** — `deepDiffHtml(['the cat sat', 'the dog sat'], { renderDeletions: true })`
   must render the `<del class="deep-diff-ghost">cat</del><ins class="deep-diff">dog</ins>` ghost.

Also worth 30 seconds: `node bin/deep-diffs-git.js README.md` and open the
report; and open `demos/index.html` in a browser.

## 3. Publish

The package is scoped (`@rossshannon/deep-diffs`), so `--access public` is
required or npm will try (and fail) to publish it as private:

```bash
npm publish --access public --dry-run   # inspect the file list: dist/, README.md, LICENSE (+ bin if packaged)
npm publish --access public             # prepublishOnly runs the build automatically
```

Note: `files` in package.json currently lists `dist`, `README.md`, `LICENSE` —
verify the `bin/` scripts are included in the dry-run file list once the bin
field settles, and add `bin` to `files` if not.

## 4. Tag and release

```bash
git tag v2.0.0
git push origin main --tags
```

Then create a GitHub release from the tag, pasting the `[2.0.0]` section of
`CHANGELOG.md` as the notes.

## 5. CI

CI lives at `.github/workflows/ci.yml`: a `test` job (Node 18/20/22 matrix:
`npm ci`, `npm test`, `npm run typecheck`, `npm run build`) and a `fuzz` job
(Node 22, `FUZZ_CHAINS=500 npm test`) on every push and pull request. Make
sure both jobs are green on the release commit before tagging.

# Known issues

Found by the adversarial property-based suite in `test/property.test.js`,
which checks `computeDeepDiff` against an independent character-identity
reference model (`test/reference-impl.js`). Each issue is pinned by a test in
the `known issues` describe block; those tests auto-detect whether the issue
still reproduces (src is under concurrent development) and assert either the
current buggy behavior or, once fixed, the correct behavior.

Status as of 2026-07-10.

---

## 1. [FIXED] Markers can split UTF-16 surrogate pairs

**Repro (minimal):**

```js
computeDeepDiff(['hi 🙂 there', 'hi 🙁 there'])
```

**Expected:** one marker covering the whole replacement emoji `🙁`
(positions 3–4), and rendered HTML that never places a tag between a high and
low surrogate.

**Actual:** one marker `[4,4]` whose slice is the lone low surrogate
`"\ude41"`. Rendering produces

```
hi \ud83d<ins class="deep-diff">\ude41</ins> there
```

i.e. the high surrogate `\ud83d` sits outside the tag and the low surrogate
inside it — invalid text content in both segments (renders as replacement
characters, breaks downstream code-point processing).

**Diagnosis:** diff-match-patch diffs at the UTF-16 code-unit level. `🙂`
(`🙂`) and `🙁` (`🙁`) share the high surrogate, so
`diff_main` factors it into the common prefix and the DELETE/INSERT ops carry
lone low surrogates. The library faithfully turns those ops into marker
offsets, and neither `addInsertionMarkers` nor `renderWithMarkers`
(`src/deep-diff.js`) snaps boundaries back to code-point (or grapheme)
boundaries. The transform itself is not at fault — the fix belongs at marker
creation (widen `start`/`end` off surrogate halves) or at render time (move
tag boundaries off intra-pair positions).

The randomized unicode fuzz reproduces this in roughly 2–3% of emoji-bearing
chains (33 of ~1300 unicode chains at seed range 1–2000).

**Status:** fixed (2026-07-10). `computeDeepDiff` now widens final marker
edges off surrogate halves (`snapStartToCodePoint`/`snapEndToCodePoint`),
and `renderWithMarkers` applies the same snapping defensively to
caller-supplied markers (on copies). Regression tests live in
`test/deep-diff.test.js` ("never splits surrogate pairs…") and the
auto-detecting property test now asserts the fixed behavior. Note: deletion
tombstone *text* can still carry a lone surrogate half when a replacement
splits a pair (the removed low surrogate is what the diff deleted); ghosts
render it escaped, so output remains well-formed HTML.

---

## 2. [FIXED] `revisionCount` missing from the early-exit return shape

**Repro (against the original implementation):**

```js
computeDeepDiff(['only one'])   // was: { text: 'only one', markers: [] }
computeDeepDiff([])             // was: { text: '', markers: [] }
computeDeepDiff(['', '  '])     // skipEmpty filters both; same shape
```

**Expected:** the documented return shape `{ text, markers, revisionCount }`
(with `revisionCount` 1 / 0 / 0 respectively), as returned by the >= 2
revision path.

**Actual (original):** `revisionCount` was `undefined` — the
`if (texts.length < 2)` early exit returned only `{ text, markers }`.

**Status:** fixed during concurrent development of `src/deep-diff.js`
(2026-07-10); the early-exit path now reports the kept-revision count.
Pinned by the `FIXED REGRESSION #2` test in `test/property.test.js`.

---

## 3. [RESOLVED] (Quirk, not a bug) Returned marker order is unstable under no-op revisions

**Status:** resolved (2026-07-10). `computeDeepDiff` now sorts the returned
array by `(start, end, revision)` before returning, so marker order is
deterministic and independent of no-op revisions. The diagnosis below is
retained for history.

**Repro:**

```js
const revs = ['aaaa bbbb cccc', 'aaaa bbbb ccccXX', 'YYaaaa bbbb ccccXX'];
computeDeepDiff(revs).markers          // order: creation order
computeDeepDiff([...revs, revs[2]]).markers  // same SET, different order
```

**Expected vs actual:** appending a revision identical to the last one never
changes any marker's values (verified across all fuzz chains) — but it *does*
reorder the returned array, because `transformMarkers` sorts `markers` by
`start` in place on every revision, including no-op ones, while new markers
are appended afterward in creation order.

**Diagnosis:** the sort at the top of `transformMarkers` is not needed for
correctness (each marker is transformed independently) and leaks an
unspecified, unstable ordering into the public result. Callers must not rely
on marker order; the property suite compares marker sets, not arrays.

---

## Explicitly verified NOT to be bugs

The suspicion that the `transformMarkers` loop mixes coordinate spaces
(advancing `index` on INSERT while comparing DELETE ranges in the same pass)
was probed with hand-computed `[DELETE, INSERT]` replacement cases adjacent
to and overlapping markers, plus 60,000+ randomized chains checked against
the reference model. Every branch behaves as an exact operational transform:
`index` and the marker are always in the same intermediate coordinate space.
In particular: markers do **not** cover extra characters after contractions;
revision-0 text never acquires spurious markers (P2); and every inserted
character remains covered by its birth-revision marker until deleted (P1).
Note dmp's `diff_cleanupMerge` always emits DELETE before INSERT, so the
INSERT-then-DELETE ordering that *would* misalign coordinates cannot reach
`transformMarkers` (verified: 0 occurrences in 2000 random diffs).

# Replacement-aware transform — `trackReplacements`

```js
computeDeepDiff(revisions, { trackReplacements: true });
deepDiffHtml(revisions, { trackReplacements: true }); // passes straight through
```

Default `false`; default output is byte-identical to previous releases (the 169-test
baseline and the property suite pass unmodified).

## Motivation: the living-draft gesture

The option upstreams the engine adaptation discovered while building
`demos/living-draft.html` (see its `toOps` comment). diff-match-patch reports a
replacement as an adjacent `[DELETE old][INSERT new]` pair. The stock
`transformMarkers` treats the two independently: a marker fully covered by the
DELETE is killed, and the INSERT gets a fresh depth-1 marker. So "delete a
phrase and retype it" — the dominant rework gesture, and at keystroke/snapshot
granularity essentially the *only* rework gesture — RESETS heat instead of
deepening it:

```js
computeDeepDiff(['The quick brown fox', 'The quick red fox', 'The quick crimson fox'])
// default:            "crimson" is depth 1 — the rev-1 "red" marker was killed
// trackReplacements:  "crimson" is depth 2 — the "red" marker rode onto it,
//                     and the fresh rev-2 marker stacks on top
```

With the option on, a chain of N successive replacements of the same word
yields depth N over that word, monotonically (pinned by test: six replacements
give six stacked markers, one per birth revision, all `lastTouched` by the
final revision).

## Semantics

An adjacent DELETE+INSERT in the cleaned diff is treated as one *replacement*
of the deleted span by the inserted text. (dmp's `diff_cleanupMerge`, which
ends every cleanup pass, guarantees DELETE precedes INSERT when adjacent and
that no empty ops survive — so pairing on "DELETE immediately followed by
INSERT" catches every replacement, and `delLen >= 1`, `insLen >= 1` always.)

For each existing marker:

- **Replacement entirely before / after the marker** — net shift by
  `insLen - delLen` / no change. Identical to the default composition of the
  two ops.
- **Marker intersecting the deleted range** — the marker is REMAPPED onto the
  inserted text instead of killed/contracted:
  - The overlapped portion maps **proportionally**: the marker's relative
    coverage of the deleted span becomes the same relative span of the
    inserted text, **rounded outward** (start floors, end ceils). Outward
    rounding means the remapped span is never empty, and markers that tiled
    the deleted span tile the inserted one.
  - Any portion **outside** the replacement stays intact: a head before the
    deleted range keeps its position; a tail past it shifts by the net length
    delta. The marker stays one contiguous range (a marker is a single
    `[start, end]`), which is the simplest sound rule: intersecting the
    rework at all means the surviving marker covers the corresponding
    inserted span plus whatever it covered outside it.
  - **Identity is preserved**: `revision` stays the birth revision,
    `lastTouched` becomes the current revision, `enabled` stays true — a
    remap never kills a marker.
- **The fresh insertion marker is still added as usual** (unchanged
  `addInsertionMarkers`). Remapped old markers + the new marker stack — that
  stacking is what makes rework accumulate depth.

### Edge cases (each pinned by a hand-computed test)

| Case | Outcome |
|---|---|
| Pure delete, no adjacent insert | Default kill/contract semantics, unchanged. Same for a DELETE and INSERT separated by an EQUAL — unrelated edits, not a replacement. |
| Marker exactly equal to deleted range | Remaps to exactly the inserted range, whatever the length change (100% relative coverage). |
| Marker strictly inside deleted range | Proportional sub-span of the insert, at least one char thanks to outward rounding. |
| Marker straddling a replacement edge | Outside portion intact; inside portion remapped proportionally; one contiguous marker. |
| Multiple markers over one replacement | Each remaps independently (per-marker transform loop). Two markers tiling the delete tile the insert. |
| Insert shorter than delete | Several markers may remap onto overlapping spans and stack — the honest reading: all of them were rewritten into this text. |
| Insert longer than delete | Coverage stretches proportionally (a whole-span marker covers the whole longer insert). |
| Replacement strictly inside a marker | Identical result to the default contract-then-expand path (asserted by test). The modes only diverge when the delete reaches a marker edge. |
| Boundary `delete starts at marker.end` | Default contracts by one; with the option on the marker intersects the rework and remaps — touching the deleted range counts as being part of the rework. |
| Zero-length ops | Cannot occur after cleanupMerge; no division by zero. |
| Surrogate pairs | Remapped edges can land on a surrogate half; `computeDeepDiff`'s existing final snapping widens them off intra-pair positions, unchanged order of operations. |
| `normalize` | Runs after snapping and only merges same-revision markers; a remapped marker (old birth revision) never merges with the fresh insertion marker, so the depth stack survives normalization. |
| `trackDeletions` | Independent and composable: the replacement's deleted text still gets its tombstone. |

Implementation: `remapThroughReplacement` in `src/deep-diff.js`, invoked from
`transformMarkers` only when the option is on; the off path is the original
code, byte for byte in behavior.

## When to use it

- **On — fine-grained histories**: keystroke-level snapshots, autosave
  streams, editor session replays (the living-draft use case). At this
  granularity rewrites arrive as delete+retype and the default transform
  bleeds heat exactly where the editorial attention is; `trackReplacements`
  makes reworked phrases glow as deep as they were reworked.
- **Off (default) — coarse committed revisions**: wiki edits, git commits,
  document versions. Between coarse revisions, "this text was deleted and
  other text appeared next to it" is weaker evidence of identity — a
  replacement there may genuinely be new content, and the default
  kill-and-restart reading is the more conservative signal. The default also
  guarantees byte-identical output with prior releases.

## Prior art in the demo

`demos/living-draft.html` ships its own earlier replacement-aware
variant that remaps every intersecting marker onto the *whole* inserted
span rather than proportionally. Review confirmed this is a benign
simplification (no bounds or depth-loss defects), but markers that tiled
a deleted span collapse onto the same remapped range instead of
preserving the tiling — the library's proportional rule is strictly more
faithful, and the demo is a candidate to adopt it.

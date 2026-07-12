/**
 * Independent ground-truth reference model for the deep-diff marker algorithm,
 * based on character identity.
 *
 * The document is modelled as an array of char objects. For each revision we
 * compute the diff with diff-match-patch using EXACTLY the same pipeline as
 * src/deep-diff.js (trim each revision, optionally drop empties,
 * Diff_EditCost = 4, diff_cleanupSemantic then diff_cleanupEfficiency) and
 * apply it to the char array: DELETE ops remove chars, INSERT ops splice in
 * new chars tagged with the revision index that introduced them. Because
 * diff-match-patch is deterministic (as long as the timeout never fires), the
 * reference sees the *identical* edit script that computeDeepDiff transformed
 * its markers through, so any mismatch is a marker-transform bug and not a
 * diff-computation disagreement.
 *
 * ---------------------------------------------------------------------------
 * What the marker transform GUARANTEES vs what it approximates
 * ---------------------------------------------------------------------------
 * Reading transformMarkers() in src/deep-diff.js as an operational transform:
 * `index` tracks a position in the intermediate text (previous text with the
 * already-processed prefix of diff ops applied) and each marker is mutated
 * into that same coordinate space, op by op. Working through every branch:
 *
 *   INSERT at index i, length L:
 *     i <= start          -> shift(+L)   (insertion before/at start: exact)
 *     start < i <= end    -> expand(+L)  (marker absorbs chars inserted
 *                                         strictly inside it: by design)
 *     i > end             -> no-op       (exact)
 *   DELETE of [i, i+L-1]:
 *     entirely before     -> shift(-L)                       (exact)
 *     encompasses marker  -> disable                         (exact: every
 *                            covered char was deleted)
 *     overlaps start      -> shift(-(start-i)); contract(overlap)
 *                            => [i, end-L]: exactly the surviving chars
 *     overlaps end        -> contract(end-i+1) => [start, i-1]: exact
 *     strictly inside     -> contract(L) => [start, end-L]: front part stays,
 *                            back part slides left onto the closed gap: exact
 *
 * Every branch is an exact identity-preserving transform. Therefore a marker
 * born for an insertion in revision r covers, in the final text, exactly:
 *
 *     (a) the chars of that insertion which still survive, plus
 *     (b) any chars later inserted STRICTLY INSIDE the marker (which also
 *         carry their own younger markers).
 *
 * Consequences we may assert as hard ground truth (per identity model):
 *
 *   P1 (coverage): every final-text char introduced in revision r >= 1 is
 *      covered by at least one enabled marker — in fact by a marker with
 *      .revision === r (its birth marker). A marker is only disabled when
 *      ALL chars it covered are deleted.
 *
 *   P2 (no false positives): every final-text char with origin revision 0
 *      (never deleted-and-reinserted under the same diff script) has marker
 *      depth exactly 0. Markers never legitimately leak onto original text:
 *      contractions are exact, not approximate — the algorithm does NOT
 *      "cover a few extra chars after contractions". (We considered whether
 *      the contract-from-the-end implementation smears a marker onto
 *      following text when a deletion straddles the middle: it does not,
 *      because the trailing survivors slide left into the closed gap and the
 *      new [start, end-L] range lands exactly on them.)
 *
 *   P3 (exact coverage): stronger than P1+P2 — the set of final positions
 *      covered by markers of revision r equals precisely the set of
 *      surviving chars with origin r, UNION chars inserted strictly inside a
 *      revision-r marker in a later revision. P3 is awkward to state without
 *      re-simulating markers, so the suite asserts P1 + P2 plus a per-char
 *      depth lower bound (origin >= 1 => depth >= 1) which together pin the
 *      transform down tightly.
 *
 * Caveats that keep the model honest:
 *   - "origin revision" is defined by the DIFF SCRIPT, not by textual
 *     content. If dmp expresses "abc" -> "xbc" as [-1 "abc"][+1 "xbc"], then
 *     b and c acquire the new origin even though the letters match. Both the
 *     model and the markers follow the same script, so this is consistent.
 *   - Determinism requires the dmp deadline never to fire; pass timeout: 0
 *     (dmp treats <= 0 as "no deadline") to both sides for comparison tests.
 *   - Offsets are UTF-16 code units. dmp happily splits surrogate pairs, so
 *     a "char" object here may be a lone surrogate. The model tracks this
 *     faithfully; whether that is *desirable* is a separate (real) issue —
 *     see docs/known-issues.md.
 */

import DiffMatchPatch from 'diff-match-patch';

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

/**
 * Compute the same diff computeDeepDiff would compute between two texts.
 * @param {string} a
 * @param {string} b
 * @param {number} timeout - seconds; 0 disables the deadline (deterministic)
 * @returns {Array<[number, string]>}
 */
export function computeDiff(a, b, timeout = 0) {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = timeout;
  dmp.Diff_EditCost = 4;
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs);
  dmp.diff_cleanupEfficiency(diffs);
  return diffs;
}

/**
 * Apply the same revision filtering computeDeepDiff applies.
 * @param {string[]} revisions
 * @param {boolean} skipEmpty
 * @returns {string[]}
 */
export function filterRevisions(revisions, skipEmpty = true) {
  return revisions.map(r => r.trim()).filter(r => !skipEmpty || r.length > 0);
}

/**
 * Build the ground-truth char-identity model.
 *
 * @param {string[]} revisions - raw revisions, oldest first
 * @param {Object} [options]
 * @param {boolean} [options.skipEmpty=true]
 * @param {number} [options.timeout=0] - 0 = no dmp deadline (deterministic)
 * @returns {{
 *   text: string,
 *   chars: Array<{ch: string, origin: number}>,
 *   revisionCount: number
 * }}
 *   chars[i].origin is the (1-based) revision index whose diff INSERTED the
 *   char at final position i; origin 0 means the char has survived, under
 *   the diff scripts, since the first kept revision.
 */
export function buildReference(revisions, options = {}) {
  const { skipEmpty = true, timeout = 0 } = options;
  const texts = filterRevisions(revisions, skipEmpty);

  if (texts.length === 0) return { text: '', chars: [], revisionCount: 0 };

  let chars = Array.from(texts[0], () => null); // placeholder, filled below
  chars = texts[0].split('').map(ch => ({ ch, origin: 0 }));

  for (let i = 1; i < texts.length; i++) {
    const diffs = computeDiff(texts[i - 1], texts[i], timeout);
    chars = applyDiffToChars(chars, diffs, i, texts[i - 1], texts[i]);
  }

  return {
    text: chars.map(c => c.ch).join(''),
    chars,
    revisionCount: texts.length
  };
}

/**
 * Apply one diff script to the char array. Sanity-checks that the EQUAL and
 * DELETE ops line up with the current model text, so a drifting model fails
 * loudly instead of producing bogus ground truth.
 */
function applyDiffToChars(chars, diffs, revision, oldText, newText) {
  const out = [];
  let pos = 0; // position in old char array

  for (const [op, text] of diffs) {
    const len = text.length;
    if (op === DIFF_EQUAL) {
      const slice = chars.slice(pos, pos + len);
      assertSame(slice.map(c => c.ch).join(''), text, 'EQUAL', oldText, newText);
      out.push(...slice);
      pos += len;
    } else if (op === DIFF_DELETE) {
      const slice = chars.slice(pos, pos + len);
      assertSame(slice.map(c => c.ch).join(''), text, 'DELETE', oldText, newText);
      pos += len; // dropped
    } else if (op === DIFF_INSERT) {
      for (const ch of text.split('')) out.push({ ch, origin: revision });
    }
  }
  if (pos !== chars.length) {
    throw new Error(
      `reference model drift: consumed ${pos} of ${chars.length} old chars ` +
      `(old=${JSON.stringify(oldText)} new=${JSON.stringify(newText)})`
    );
  }
  return out;
}

function assertSame(got, want, opName, oldText, newText) {
  if (got !== want) {
    throw new Error(
      `reference model drift on ${opName}: got ${JSON.stringify(got)} want ` +
      `${JSON.stringify(want)} (old=${JSON.stringify(oldText)} new=${JSON.stringify(newText)})`
    );
  }
}

/**
 * Per-position marker depth for a text: depths[i] = number of enabled
 * markers covering final position i.
 * @param {string} text
 * @param {Array<{start:number,end:number,enabled:boolean}>} markers
 * @returns {number[]}
 */
export function markerDepths(text, markers) {
  const depths = new Array(text.length).fill(0);
  for (const m of markers) {
    if (!m.enabled) continue;
    for (let i = m.start; i <= m.end && i < depths.length; i++) {
      if (i >= 0) depths[i]++;
    }
  }
  return depths;
}

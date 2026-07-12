# Fuzzing notes

`test/property.test.js` property-tests the marker transform against an
independent character-identity reference model (`test/reference-impl.js`)
that replays the identical diff-match-patch edit scripts over an array of
revision-tagged char objects. Coverage: marker bounds/enabled invariants;
ground-truth coverage (every char inserted in revision >= 1 is covered by a
marker of its birth revision; untouched revision-0 chars have depth exactly 0);
render well-formedness (balanced/nested tags, strip == escaped text, escaping);
idempotence; no-op-revision stability (as a set); unicode/astral chains;
pathological chains (same-spot edit storms, insert/delete oscillation,
whole-text replacement, prefix/suffix chains); and hand-computed targeted
cases for [DELETE, INSERT] replacements at exact marker boundaries.
Seeded mulberry32 PRNG; every failure message embeds the seed. Default 100
chains per generator (CI-fast, <0.5s); verified locally at FUZZ_CHAINS=20000
(60,000+ chains) with zero invariant failures.

Verdict: the marker transform is an exact operational transform — robust; the
only real defects are peripheral (surrogate-pair splitting, a missing
`revisionCount` on early exit, unstable marker order — see docs/known-issues.md).

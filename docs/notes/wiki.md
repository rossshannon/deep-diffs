# deep-diffs-wiki

`bin/deep-diffs-wiki.js` turns a live Wikipedia article's revision history into a self-contained deep-diff HTML report — the AVI 2010 paper's original motivating corpus, 16 years later. Revisions come from the MediaWiki Action API (sequential requests, `maxlag=5`, descriptive User-Agent, backoff on 429), redirects are followed, and suppressed/deleted/non-wikitext revisions are skipped with a warning.

## Usage

```bash
deep-diffs-wiki "Ship of Theseus"                                  # writes Ship_of_Theseus.deep-diff.html
deep-diffs-wiki "Trolley problem" --max-revisions 20 --mode authors --out report.html
deep-diffs-wiki Kaffee --lang de --no-strip-markup
deep-diffs-wiki "Ship of Theseus" --keep-reverts                   # disable revert collapsing (see below)
```

Histories are evenly sampled down to `--max-revisions` (default 30), always keeping the first and latest revisions. `--strip-markup` (default on) applies a light, avowedly approximate wikitext cleanup — templates, refs, tables, file links and category/interwiki links are dropped; running prose survives. Three toggleable heat lenses: edit depth, **recency**, and authors (each highlight tinted by who introduced its wording — top 8 contributors get Okabe–Ito hues, the rest bucket as "others").

## Revert collapsing

Wikipedia histories are dense with vandalism → revert cycles. Before sampling, the full revision-metadata timeline (fetched with `sha1` and `tags` riding the same paginated request — no extra API calls) is collapsed exactly as History Flow does, in `collapseReverts()`:

1. **sha1-cycle collapse.** Walking oldest → newest, whenever a revision's `sha1` exactly matches an earlier surviving revision's, every revision in between (the vandalism, any partial reverts, and the revert itself) is dropped — the article was in that earlier state throughout, so the transient span never happened. Repeated and nested cycles collapse correctly because scanning continues from whatever state survives after each collapse. A revision with no `sha1` (rare; some suppressed revisions omit it) can never falsely match and always survives this rule.
2. **`mw-reverted` tag drop**, independent of the sha1 rule. Modern rollback/undo tools tag the reverted edit even when the revert doesn't reproduce the exact prior bytes (a partial revert, or a revert bundled with other changes) — the sha1 rule alone misses these.

The first and last revisions in the timeline are never dropped by either rule, matching `sampleEvenly`'s "always keep first + latest" guarantee. Disable both with `--keep-reverts` (e.g. to compare before/after, or if you specifically want vandalism visible in the report). Counts are surfaced both on stderr while fetching and in the report's header note.

Without this pass, sampling regularly lands on — or straddles — a vandalized state, and a revert re-inserting a huge swath of reverted-away text makes it look freshly edited, drowning the real editorial signal. This was most visible in the Recency lens: on Ship of Theseus, 559 of 2,150 revisions (26%) were sha1-cycle vandalism/revert noise, plus 3 more dropped by the `mw-reverted` tag — 562 revisions total, leaving 1,588 genuine ones to sample from.

## Recency lens: fixed calendar buckets

The Recency lens buckets each highlighted region by the real calendar date of the revision that last touched it (`ageBucket()`), not by that revision's rank among the sampled revisions. Six fixed buckets, measured back from the report's generation time: **10+ yr, 5–10 yr, 2–5 yr, 1–2 yr, 3–12 mo, < 3 mo**. An unparseable timestamp falls back to the oldest/coolest bucket.

Fixed calendar buckets were chosen over normalising hue across the sampled span's date range: normalising stretches whatever the *last few sampled revisions* did across the full hue range regardless of how long the article has actually existed, so a 23-year-old article's last month of edits would still paint "newest" — indistinguishable from an article that is itself only a month old. Fixed buckets read consistently regardless of article age or how a run happens to sample it: a 5-year-old edit is always "cool," full stop. The legend now shows the six real date-range labels rather than a bare "older … newer" gradient.

Revert collapsing and date-based bucketing fix different halves of the same symptom: collapsing keeps sampling from landing on vandalized states (a byte-identical revert no longer looks like a fresh edit); fixed buckets stop stale sampling-index math from smearing "newest" hue across whatever a run happened to sample last. Even with both fixes, a long, actively-maintained article sampled at only a handful of revisions will still show its most recently-reworked passages (typically the lede) running hot — that's real signal, not a bug: measured on Ship of Theseus at 25 samples the single hottest bucket still covered essentially the whole article (~98%), because the last of only 25 samples happened to fall right at the end of an 18-month gap of ordinary, non-vandalism copyediting, and diff-match-patch's word-level diff of that gap touched wording scattered across most of the lede in one step. Sampling more finely shrinks each individual diff step and spreads "last touched" dates out realistically; at 100 samples the hottest bucket drops to under half (measured 45.6%) with a believable mix across all six buckets.

## The example report

`demos/wiki-report.html` was generated live from the API on 12 Jul 2026: `deep-diffs-wiki "Ship of Theseus" --max-revisions 100 --mode authors --out demos/wiki-report.html` (2,150 revisions, 2003–2026, 1,268 contributors, 562 reverted/vandalised revisions collapsed before sampling — see above). `--max-revisions` was raised from the original 25 to 100 specifically for the Recency lens: at 25 samples the tail-end gap between samples was wide enough that a single ordinary (non-vandalism) copyediting stretch painted nearly the whole article "newest"; 100 samples breaks that gap up enough to show a believable spread (measured hottest bucket 45.6% of highlighted text, vs. 98% at 25). The heat still makes the article live its own paradox in the Edit depth and Authors lenses: much of the earliest sampled text no longer survives (the ledger says so per row), while the lede and the Hobbes/second-ship passage glow hottest, reworked in multiple separate passes. Screenshots (Recency lens, since that's what the fix targeted): `docs/screenshots/wiki-report.png` and `wiki-report-dark.png`.

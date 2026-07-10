# deep-diffs-wiki

`bin/deep-diffs-wiki.js` turns a live Wikipedia article's revision history into a self-contained deep-diff HTML report — the AVI 2010 paper's original motivating corpus, 16 years later. Revisions come from the MediaWiki Action API (sequential requests, `maxlag=5`, descriptive User-Agent, backoff on 429), redirects are followed, and suppressed/deleted/non-wikitext revisions are skipped with a warning.

## Usage

```bash
deep-diffs-wiki "Ship of Theseus"                                  # writes Ship_of_Theseus.deep-diff.html
deep-diffs-wiki "Trolley problem" --max-revisions 20 --mode authors --out report.html
deep-diffs-wiki Kaffee --lang de --no-strip-markup
```

Histories are evenly sampled down to `--max-revisions` (default 30), always keeping the first and latest revisions. `--strip-markup` (default on) applies a light, avowedly approximate wikitext cleanup — templates, refs, tables, file links and category/interwiki links are dropped; running prose survives. Three toggleable heat lenses: edit depth, recency, and **authors** (each highlight tinted by who introduced its wording — top 8 contributors get Okabe–Ito hues, the rest bucket as "others").

## The example report

`demos/wiki-report.html` was generated live from the API on 10 Jul 2026: `deep-diffs-wiki "Ship of Theseus" --max-revisions 25 --mode authors` (2,150 revisions, 2003–2026, 1,268 contributors; "Trolley problem" and "Sourdough" were tried too — Ship of Theseus had the smoothest depth spread and the best story). The heat makes the article live its own paradox: every plank has been replaced — nothing from the first fourteen sampled revisions (2003 to early 2018) survives in the current text (the ledger says so per row), while the lede and the Hobbes/second-ship passage glow hottest, reworked in four to six separate passes. Screenshots: `docs/screenshots/wiki-report.png` and `wiki-report-dark.png`.

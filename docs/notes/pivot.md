# Polish vs Pivot

`demos/polish-vs-pivot.html` — first prototype of the FUTURE-DIRECTIONS
"semantic deep diffs" idea: churn says a passage was reworked; meaning
drift says whether the author was refining wording (polish) or changing
their mind (pivot). Sentences are split and threaded across revisions by
greedy alignment on lexical cosine similarity with a positional prior;
each changed step is scored by content-word cosine blended with character
trigram cosine (an honest lexical proxy for semantic similarity — the
footnote says so and points to embeddings as the production path).

Classification per sentence thread: Settled / Polished / Pivoted /
Contested (high churn AND high drift). Two visual channels in the
document: warmth = churn, hue = amber (polish) vs violet (pivot), chosen
to survive deuteranopia and both themes. Hovering a sentence opens its
"thread card" — the sentence's biography across revisions with per-step
POLISH/PIVOT badges and similarity percentages. A canvas scatter ("map
of the draft's soul", x = churn, y = drift) plots one dot per sentence;
summary chips filter by class. Includes a revision scrubber and a second
specimen.

Verified via Playwright: zero console errors; the specimen classifies as
designed (settled/polished/pivoted/contested all present); thread card
opens on hover; scatter renders. Screenshots: docs/screenshots/pivot.png
(light, thread card open) and pivot-dark.png.

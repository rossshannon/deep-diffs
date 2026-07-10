# Deep Diffs in 2026: Future Directions

*A research-and-product roadmap for the `deep-diffs` library. Written July 2026.*

In 2010 we published a four-page note at AVI — [Deep Diffs: Visually Exploring the History of a Document](https://rossshannon.com/publications/softcopies/Shannon2010DeepDiffs.pdf) ([ACM DL](https://dl.acm.org/doi/10.1145/1842993.1843063)) — arguing that a document's history shouldn't live in a separate mode you visit, but in the text itself: chain the diffs across every revision, let changed regions accrete translucent highlights, and the page becomes a heatmap of editorial attention. Passages that survived many rounds of review fade to calm; passages still being fought over glow. Then the PhD ended, the prototype gathered dust, and the idea slept for fifteen years.

It woke up into a much better world for it. This memo is an honest accounting of where the technique stands now that the library exists, which of the 2010 assumptions died, and where the interesting work is — engineering, product, and research. The short version: the core insight (cumulative, in-situ, character-resolution history) aged well; almost everything about *where revisions come from* and *who makes edits* did not, and that's exactly what makes the next two years interesting.

---

## 1. The idea, restated for 2026

The 2010 note made a bet: that as documents became more collaborative, the scarce resource would be *knowing where to look*. A diff between two versions answers "what changed?"; a deep diff answers "where has the effort been going?" — which passages are new and unpolished, which have been finessed repeatedly, which have quietly stabilised. We framed this around three editorial tasks: **assess** (is this text mature?), **monitor** (what happened since I last looked?), and **quantify change** (how much do I need to re-review?).

Every trend since has raised the stakes on that bet.

**Collaboration is now the default, not the exception.** In 2010 we treated Wikipedia and academic paper-writing as the motivating edge cases; the ordinary document was a file on one person's machine. In 2026 the ordinary document is a Google Doc, a Notion page, a Figma file, a shared repo — multiplayer from birth, with every keystroke retained. [Google Docs records every change continuously](https://support.google.com/docs/answer/190843) and Notion keeps per-edit page history. Yet the *presentation* of that history has barely moved since 2010: it still lives in a sidebar you open deliberately, showing one version-pair at a time, colour-coded by author. The assess/monitor/quantify tasks are still essentially unsupported in mainstream tools. Fifteen years of infrastructure progress, near-zero interface progress. That gap is the product opportunity.

**AI co-writing changed the meaning of "edit."** This is the development we did not see coming, and it's the one that transforms deep diffs from a nice-to-have visualisation into something closer to an epistemic necessity. When a language model can flood a document with fluent prose in seconds, the surface of the text stops telling you anything about the effort behind it. Uniform polish is now the *cheapest* signal to produce. What can't be faked cheaply is *history*: which sentences a human wrote, rewrote, and rewrote again; which AI paragraphs were accepted verbatim and never touched. A deep diff is precisely a record of accumulated human attention — and human attention is the thing readers, reviewers, editors, and teachers now most want to verify. Tools like [Grammarly Authorship](https://www.grammarly.com/authorship) (launched 2024: tracks typed vs. pasted vs. AI-generated text) and CHI 2024's [HaLLMark](https://dl.acm.org/doi/10.1145/3613904.3641895) (interactive provenance visualisation for LLM-assisted writing) show the demand; both stop at categorical labels or summary charts. Neither renders the *texture* of revision — the edits-within-edits — in the text itself. That's our lane.

The intellectual lineage still holds: Hill et al.'s [Edit Wear and Read Wear](https://dl.acm.org/doi/10.1145/142750.142751) (CHI 1992) — interaction history as physical wear on the artifact — remains the founding metaphor, and Viégas et al.'s [History Flow](http://hint.fm/projects/historyflow/) the sibling that chose authorship over intensity. Deep diffs is edit wear at character resolution, rendered in the reading surface rather than the scrollbar.

### What didn't survive from 2010

Honesty section. Re-reading the note, several assumptions are dead:

- **"Revisions" as sparse, committed checkpoints.** The 2010 design assumed a wiki or Subversion: a handful of deliberate saves. Modern editors emit revision streams at keystroke granularity via CRDTs. This is a gift (see §2.2) but it breaks the naive model — chaining diff-match-patch across 40,000 micro-revisions is both wasteful and semantically wrong. The unit of "a revision" now has to be *constructed* (session-, pause-, or intent-based chunking), not assumed.
- **"Non-adversarial editors with good intentions."** We explicitly scoped to cooperative editing and treated vandalism as noise to pre-filter. In 2026 the adversary isn't a Wikipedia vandal; it's an author (or a tool) with an incentive to *simulate* human editing history. Any provenance claim we make must state its threat model plainly: deep diffs describe the record; they do not authenticate it (§3).
- **The Wikipedia sociology.** We leaned on the 2005-era finding that anonymous drive-by editors add content and a core cadre polishes it. Wikipedia's editing economy has changed, and more importantly the paradigm document moved from the public wiki to the private collaborative doc — where the "drive-by contributor adding big chunks" is now, frequently, a model.
- **"Colour is unavailable for authorship because overlays would clash."** Partially dead. Modern rendering (blend modes, hue-for-author × alpha-for-depth, hover lenses, dark mode tokens) gives us more channels than 2010 CSS did. Authorship and intensity can coexist if one is on-demand (§4, collaboration lens).
- **Client-side JavaScript as a novelty.** In 2010, "runs in the browser" was a contribution. Now it's table stakes — and the actual deployment question is *editor integration*, not page decoration.

What survived: the marker-transform algorithm (a simplified [operational transformation](https://en.wikipedia.org/wiki/Operational_transformation), which is what the library ships today in `src/deep-diff.js`), character-level resolution as the right grain for editorial work, and nesting depth as the encoding of revision intensity. The 2010 note's known weakness also survived, verbatim: moved text is seen as unconnected delete + insert. Fixing that is now tractable (§2.3).

---

## 2. Nearest-term engineering directions

### 2.1 Editor plugins: ProseMirror and CodeMirror decorations

The library currently renders static HTML with nested `<ins>` tags. That's fine for reports; it's the wrong shape for the place deep diffs most wants to live — *inside the editor while you write*. The good news is that both major editor toolkits have decoration systems that map almost one-to-one onto our `Marker` model.

**ProseMirror** (and therefore [TipTap](https://tiptap.dev/docs/editor/core-concepts/prosemirror), which wraps it): a plugin holds a `DecorationSet` of inline decorations; on each transaction, `decorationSet.map(tr.mapping, tr.doc)` shifts positions through the edit — which is *exactly* our marker transform, implemented natively by the editor. The sketch:

```js
// prosemirror-deep-diff plugin state
{
  decorations: DecorationSet,     // one inline decoration per marker
  depthAt(pos): number            // derived: overlap count → CSS class
}
// on transaction: decorations = decorations.map(tr.mapping, tr.doc)
// on new insertion: add Decoration.inline(from, to, { class: `dd-depth-${d}` })
```

Two subtleties: (a) depth must be *recomputed from overlaps* rather than baked into a class at creation time, since markers merge and split as they map; (b) ProseMirror positions are token positions in a node tree, not character offsets, so `computeDeepDiff`'s output needs a position-translation layer when hydrating history that arrived as plain text. TipTap [has no first-class decoration API](https://github.com/ueberdosis/tiptap/discussions/5434), so we ship a raw ProseMirror plugin that TipTap users mount via `addProseMirrorPlugins` — one plugin, both ecosystems.

**CodeMirror 6** is even cleaner: a `StateField<DecorationSet>` whose update method calls [`decorations.map(tr.changes)`](https://codemirror.net/examples/decoration/), with `RangeSet` doing efficient position mapping for us. This is the code-review use case from the README (which blocks got tweaked repeatedly this sprint), and it composes naturally with gutter markers for a scrollbar-level overview — closing the loop back to Hill et al.'s attribute-mapped scrollbars.

The strategic point: in both systems, *the editor already implements our transform*. The library's job shrinks to (1) seeding markers from history and (2) the depth→style policy. That's a small, well-shaped plugin, and it should be the first thing we ship after core stabilises.

### 2.2 CRDT-native deep diffs: markers without diffing

This is the deepest engineering idea on the list. Today we *reconstruct* edits by diffing adjacent snapshots with [diff-match-patch](https://github.com/google/diff-match-patch). Diffing is inference, and inference is sometimes wrong: a rewrite can be misread as unrelated delete+insert; two edits in the same region can be merged or misordered; `diff_cleanupSemantic` makes judgment calls. But in a CRDT-backed editor, *the edits themselves are the stored representation*. [Yjs encodes every change as an update](https://docs.yjs.dev/api/document-updates) with a unique (clientID, clock) ID per inserted item; [Automerge keeps a full change log](https://automerge.org/) — hash-linked change objects with actor IDs and timestamps, "git commits for text." Deleted items are tombstoned, not erased. In other words: a CRDT document already contains a perfect, unambiguous deep-diff substrate. No diff step, no ambiguity, exact provenance — including *who* and *when* per character, for free.

Sketch of the adapter:

```js
// yjs adapter (no text diffing anywhere)
import { computeMarkersFromUpdates } from '@rossshannon/deep-diffs/yjs';

const markers = computeMarkersFromUpdates(ydoc, {
  chunkBy: 'pause',        // group ops into "revisions": pause | session | snapshot
  pauseMs: 90_000,
  attribution: true,       // carry clientID → author metadata onto markers
});
// markers: { start, end, depth, revision, author, timestamp }[]
// positions resolved via Y.RelativePosition → absolute at render time
```

The design questions are real but tractable. First, **chunking**: keystroke-level ops must be grouped into revisions or every document is depth-50 everywhere; pause-based sessionisation (a pause of *n* seconds ends a revision) is the obvious default, with named snapshots ([y-prosemirror's versions demo](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror) shows the pattern) as the deliberate alternative. Second, **positions**: markers should be stored as `Y.RelativePosition`s, which survive concurrent edits by construction — the marker-transform code becomes unnecessary in this mode, because CRDT identity *is* the transform. Third, **retention**: Yjs histories require keeping updates (or snapshots + `gc: false`); Automerge keeps everything by default at some cost. We should document the storage contract explicitly per backend.

One caveat worth stating: the diff-based path stays first-class forever. Most of the world's document history is still snapshots (git, wikis, DOCX exports, CMS revisions), and "works on any two or more versions of an unadorned text document" was the 2010 note's superpower. CRDT-native is the high-fidelity tier, not a replacement.

### 2.3 Structural tracking: surviving moves and paragraph surgery

The README is honest about the library's two limitations: character-indexed markers lose context under large structural refactors, and there is **no move detection** — cut-and-paste reads as delete + insert, so a paragraph's accumulated heat is destroyed by the act of moving it. This was flagged as future work in the 2010 paper ("no conception of the semantics involved") and it's still the most common way real documents embarrass the technique, because *reorganisation is what late-stage editing is*.

The fix is a two-level model: track **block identity** above **character markers**.

```js
// level 1: block identity across revisions
blocks: [{ id, revisionSpans: [{ revision, start, end }] }]
// level 2: markers indexed relative to their block, not the document
marker: { blockId, start, end, depth, ... }
```

Per revision-pair: split both texts into blocks (paragraphs, list items, code blocks); match blocks across the pair by similarity — exact hash first, then a shingle/MinHash pass for edited-and-moved blocks, with a similarity floor below which a block is "new." A matched-but-relocated block carries its markers with it (offset-adjusted); the *move itself* can optionally register as a light touch (a move is an editorial decision, but not a rewrite — this should be a policy knob, not hard-coded). Unmatched old blocks die with their markers, as today. This is the same problem shape WikiWho solved for Wikipedia token provenance ([Flöck & Acosta, WWW 2014](https://dl.acm.org/doi/10.1145/2566486.2568026) — token-level authorship at 95%+ accuracy, [running today as a Wikimedia API](https://www.mediawiki.org/wiki/WikiWho)); their key insight, that provenance should be computed against a *graph* of content survival rather than a chain of linear diffs, is exactly the upgrade our marker model needs. In CRDT mode (§2.2) moves are still delete+insert at the type level, so block matching earns its keep there too.

### 2.4 Streaming and incremental recomputation

`computeDeepDiff` is batch: hand it N revisions, get markers. Every live use case — editor plugins, live dashboards, watching a colleague's doc — wants the incremental form:

```js
const session = createDeepDiffSession(initialText, options);
session.applyRevision(nextText);      // one diff + one transform pass
session.markers();                    // current state, cheap
session.window(k);                    // only markers from last k revisions
```

The algorithm is already fold-shaped — each revision only transforms existing markers and appends new ones — so this is mostly API surface plus two real pieces of engineering: (a) an interval tree or sorted structure for markers so transform passes stop being O(markers × diff-ops) with a full re-sort per revision, and (b) *windowing with decay semantics*, since the 2010 design brief ("highlighting gradually fades as text survives") implies markers age out of view without being forgotten — which requires retaining `lastTouched` (already in the code) and evaluating depth against a sliding window rather than all history. Windowing is also what keeps 500-revision documents legible: unbounded accretion turns any old document uniformly hot, which is the failure mode where the visualisation stops being information.

---

## 3. The AI-drafting frontier

This is the big one, and it deserves to be stated as a thesis: **in AI-assisted writing, revision history is the most trustworthy signal of human authorship we have, and deep diffs is the right lens for reading it.**

**Provenance: what did the human actually touch?** Run the deep diff over a co-written document's history and partition by edit source (human keystrokes vs. model insertions — data that CRDT attribution (§2.2), editor telemetry, or Grammarly-Authorship-style tracking already captures). The rendering answers questions no AI-detector can: *which AI-drafted sentences were accepted verbatim and never revisited?* (zero heat over machine text — the document's least-examined regions), *which did the human finesse?* (human heat layered over machine base — arguably the most collaboratively robust text in the document), *what remained purely human?* This reframing matters. The discourse treats "AI-written?" as a binary classification problem, and classifiers are unreliable and adversarial. Deep diffs sidesteps detection entirely: it renders the *process record*. HaLLMark's CHI 2024 study found that provenance visualisation increased writers' sense of control and ownership; Grammarly's replay feature shows the market pull (and [its critics](https://www.plagiarismtoday.com/2025/11/06/how-grammarly-launders-ai-generated-content/) show how contested this space is). We must be equally clear about the threat model: a process record demonstrates attention only if the record is trusted; against deliberate history-laundering it needs signed edit logs, which is an infrastructure problem (CRDT change logs, being hash-linked and actor-attributed, are a surprisingly good start) — not a rendering problem. Deep diffs shows; it does not certify.

**Heat as review prioritization.** Invert the lens for the reader. An editor reviewing an AI-assisted draft should spend attention where the *author didn't*: cold machine-generated spans are precisely the unverified regions. "Sort review order by inverse heat" is a one-line policy over our marker model and plausibly the highest-value feature in the whole roadmap — it converts a visualisation into a workflow. The same applies to code review of AI-generated pull requests: heat from the human's post-generation edits marks what was actually reasoned about; pristine generated blocks deserve the skeptical read. This is assess/monitor/quantify from 2010, transplanted into the human-AI loop, where the asymmetry of effort is far more extreme than anything Wikipedia produced.

**Churn as a feedback signal to the assistant.** Deep-diff heat over a writing session is a per-span measure of *author dissatisfaction*: a sentence rewritten five times is a sentence whose current form the author doesn't yet believe. Feed that to the writing assistant. Concretely: spans above a churn threshold become context for the model ("the author has rewritten this sentence four times; offer three alternatives in genuinely different registers, or ask what constraint keeps failing"), and — more interesting — *machine text the human keeps re-editing is evidence about the model's failure modes for this author*, a fine-grained RLHF-ish signal that no thumbs-up button will ever capture. The inverse policy also holds: high-heat human text is text the author has invested in; an assistant should treat it as load-bearing and stop offering to rewrite it.

**Deep diffs of prompt/response iterations.** The iteration loop *around* the document is itself a revision history. When a user regenerates a response five times, or steers a draft through successive prompts in a canvas-style interface, each attempt is a revision; deep-diffing them shows what the model kept changing (unstable, low-confidence regions) versus what stayed fixed across regenerations (the model's attractor states). That's a prompt-debugging instrument for AI engineers and a self-awareness instrument for writers — "notice that you've regenerated this paragraph six times; the model isn't going to say the thing you want; write it." The library needs nothing new for this: attempts-as-revisions is just an input framing, and it might be the cheapest compelling demo we can build.

---

## 4. New interaction concepts

Several concepts are being prototyped in this repo's `demos/` directory as this roadmap is written — the git-report demo (`demos/git-report.html`) has already landed, and the first four below correspond to those prototypes; the rest are proposed.

**Recency embers.** The 2010 note promised that highlights "gradually fade away" as text survives edits, but the original prototype only had depth, not age. The embers rendering treats each marker's `lastTouched` as a temperature: fresh edits burn bright, untouched regions cool through amber toward nothing, and depth sets how much total energy a region has to lose — a much-edited passage cools slowly. This gives one rendering that answers both "what's active *right now*?" and "what's been worked hardest *overall*?" without a mode switch. The craft challenge is the colour ramp: heat-map clichés (red/green) collide with insert/delete conventions and accessibility; a single-hue ramp with alpha-for-age and depth-for-saturation, tested in both light and dark themes, is the standard to hit.

**Collaboration lens.** The 2010 paper conceded that colour was spent on intensity and couldn't also encode authorship. The lens resolves this with *modality* instead of simultaneity: the base view stays intensity-only, and a held modifier key (or hovering a collaborator's avatar) re-colours the heat by author — your finessing in one hue, your co-author's in another, the model's in a third. Released, it snaps back to calm. Author identity is a question you *ask*, not a property that shouts permanently. In CRDT mode the attribution is exact per character; in diff mode it's per revision, which is usually enough.

**Draft archaeology.** A replay scrubber over the marker timeline: drag from revision 1 to now and watch the document assemble itself, heat blooming where work concentrated and fading as passages settle. This is the 2010 "slider" (Figure 4 of the paper) grown into a narrative instrument — the writing-process equivalent of a git blame you can *feel*. The design detail that makes it archaeology rather than a movie: deleted text should ghost briefly before vanishing, because the paper's own choice to hide deletions ("we purposefully don't expose recently-deleted passages") is wrong in replay mode — the abandoned attempt *is* the story. Teachers reviewing student process, writers reviewing their own habits, and anyone demonstrating "a human wrote this" are the audiences.

**Git reports** (now a working prototype in `demos/git-report.html`). Batch-mode deep diffs over commit history: point the tool at a file's last N commits and get a standalone HTML report — the file's hot spots, per-function churn, effectively "GitLens-style heat, but cumulative-change-count rather than age." The immediate consumers are code reviewers ("this function has been touched in 9 of the last 12 commits — that's either a design smell or the heart of the system") and maintainers triaging unfamiliar codebases.

Beyond the in-flight prototypes, three proposals:

**Semantic deep diffs.** Character-level markers can't see the difference between fixing a typo and reversing a claim; both are small diffs. Embed each sentence per revision, chain nearest-neighbour matches across revisions (which also gives move-detection for free, at the sentence level), and mark *semantic displacement* — cumulative embedding drift — instead of, or alongside, surface change. Now the heatmap distinguishes polish (high character churn, near-zero drift: wording being finessed around a stable meaning) from pivot (modest character churn, large drift: the author changed their mind). The overlay of the two is the genuinely new instrument: "high polish, low pivot" is a finished thought; "high pivot, still churning" is the document's open question. Local embedding models are now fast and cheap enough for this to run client-side on realistic documents; the research question is whether sentence-level drift metrics match writers' own judgments of where meaning moved.

**Heat-guided summarization: "what's still unsettled?"** Combine markers with an LLM to produce the meta-document readers of long-running collaborative docs actually need. Feed the model the text *with heat annotations inline* and ask for a settlement report: "§2 has been stable for six revisions. The pricing paragraph has been rewritten by three people in the last two days and its numbers changed twice — unresolved. The FAQ is machine-drafted and unreviewed." That's the standup update for a document. It inverts the usual summarization framing — instead of summarizing content, it summarizes *state of agreement*, which is what a returning collaborator needs first. The marker model already carries everything required (depth, recency, authorship); this is prompt engineering plus a rendering, and it's the feature most likely to make non-visualisation-people care.

**Deep diffs across forks.** Documents branch now: suggestion mode, PR-style doc proposals, "duplicate page" divergence in Notion, and AI tools generating N candidate variants of the same draft. History is a DAG, not a chain, and the marker model assumes a chain. The fork-aware extension deep-diffs each branch against the common ancestor and renders them in juxtaposition: heat both branches share (everyone agrees this part needed work) versus heat unique to a branch (this fork's specific concerns). For AI-generated variants, this shows where candidates *disagree* — variance across model attempts as a direct visual, the document-level cousin of the regeneration-diffing idea in §3. The merge story writes itself: when branches reunite, their marker sets merge too — CRDT backends (Automerge especially, whose [history model](https://automerge.org/) is natively branchy) make this concrete rather than speculative.

---

## 5. Research questions and evaluation

It must be said plainly: the 2010 note shipped **zero empirical evaluation**. Its abstract claims the technique "heightens participants' understanding" — no study backed that sentence. Fifteen years later, every one of those claims is still open, which is embarrassing and also an opportunity: the technique now has a production implementation, and the claims are testable.

The 2010 claims, restated as hypotheses:

- **H1 (assess):** readers shown deep-diff views judge document maturity/stability more accurately and faster than readers with version-history sidebars. Testable with a controlled study: participants rank passages by "how settled is this text?", ground truth from actual revision data; compare deep-diff vs. Google-Docs-style history vs. plain text. The interesting measure is *calibration* — does heat correlate with where subsequent edits actually landed?
- **H2 (monitor / reviewer efficiency):** reviewers of collaborative or AI-assisted documents find more substantive issues per minute when review is heat-prioritised (§3's inverse-heat ordering). This is the highest-value study because it evaluates a *workflow*, not a picture, and has an obvious field-deployment version (code review with churn reports; time-to-review and defect-catch rates).
- **H3 (writer self-awareness):** writers with ambient deep-diff feedback change revision behaviour — revisit cold accepted-AI text more, report higher ownership (HaLLMark found ownership effects for prompt-level provenance; character-level is untested). Diary study plus telemetry over weeks of real writing, not a lab hour.
- **H4 (the wear hypothesis, inherited from Hill et al.):** editing intensity actually *predicts* something — residual error rates, reader difficulty, future churn. If heat predicts where bugs/disputes/edits happen next, deep diffs graduates from visualisation to instrument. Wikipedia + WikiWho data makes this a purely computational study; git corpora give the code version.

New questions raised by the 2026 directions: What is the right revision-chunking granularity for CRDT streams — do pause-based sessions match writers' own sense of "a revision"? (A study in its own right, and every CRDT-history tool needs the answer.) Does semantic drift (§4) correspond to author-perceived meaning change? At what document age does unbounded heat accretion destroy legibility, and what decay half-life restores it? And the field-scale question: in AI-assisted classrooms and newsrooms, does process-visibility change *writing behaviour itself* — do people finesse more when the finessing shows? That last one is a CHI paper with legs, and it's the true successor to the 2010 note's closing thought that streams of editing operations "allow us to explore the thought process of the author."

---

## 6. A pragmatic 90-day plan

Sequenced for a solo designer-engineer with occasional collaborators; each month ends with something shippable.

**Days 1–30: harden the core, ship the instrument.**
Land the incremental session API (§2.4) with marker windowing/decay — it unblocks everything interactive. Add `author`/`source` metadata passthrough on markers (trivial in the data model, prerequisite for every §3 idea). Finish and polish the four `demos/` prototypes into a single gallery page; the demos *are* the marketing. Publish the git-report CLI (`npx deep-diffs report src/foo.js --last 30`) — it's the lowest-friction way for strangers to feel the technique on their own data.

**Days 31–60: go where the editors are.**
Ship `@rossshannon/deep-diffs-prosemirror` (raw PM plugin + TipTap mounting recipe) and `-codemirror` (StateField + gutter overview). Build the Yjs adapter behind the same marker interface, with pause-based chunking and relative positions (§2.2) — validate it on the y-prosemirror versions demo document. Write the honest docs page on retention/threat-model ("what deep diffs can and cannot prove").

**Days 61–90: the AI story, and one study.**
Build the flagship demo: a co-writing pad (TipTap + any LLM) where model insertions and human edits are tracked live, with the collaboration lens separating them and inverse-heat review ordering — this is the artifact that makes §3 legible to everyone else, and it's the one to write up publicly. Prototype heat-guided settlement summaries on top of it (§4). In parallel, run the cheap version of H1 as a pilot (20 participants, Wikipedia histories, maturity-ranking task) — enough signal to decide whether a full CHI submission for the 2027 cycle is warranted. Fifteen years late is a fine time for the first real evaluation.

The through-line for all of it: the 2010 idea was that a document should wear its history the way a well-used tool wears its handling. In 2026, when most new text is machine-smooth on arrival, the wear is the proof of the hand. Build the lens that shows it.

---

*References woven inline. Primary sources: [Shannon, Quigley & Nixon, AVI 2010](https://dl.acm.org/doi/10.1145/1842993.1843063) · [Hill et al., CHI 1992](https://dl.acm.org/doi/10.1145/142750.142751) · [Viégas et al., History Flow, CHI 2004](http://hint.fm/projects/historyflow/) · [Flöck & Acosta, WikiWho, WWW 2014](https://dl.acm.org/doi/10.1145/2566486.2568026) · [Hoque et al., HaLLMark, CHI 2024](https://dl.acm.org/doi/10.1145/3613904.3641895) · [Grammarly Authorship](https://www.grammarly.com/authorship) · [Yjs document updates](https://docs.yjs.dev/api/document-updates) · [Automerge](https://automerge.org/) · [CodeMirror decorations](https://codemirror.net/examples/decoration/) · [ProseMirror/TipTap](https://tiptap.dev/docs/editor/core-concepts/prosemirror).*

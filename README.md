# deep-diff-text

Visualise cumulative changes across multiple text revisions. Regions that have been edited multiple times are highlighted with increasing intensity.

![Deep diff example](https://rossshannon.com/projects/deepdiffs/example.png)

Unlike standard diff tools that compare two versions, `deep-diff-text` tracks how text regions shift, expand, and contract through an entire revision history — giving you a "heatmap" of editorial activity.

## Use Cases

- **Legal document review** — see which clauses have been contentious across redlining rounds
- **Collaborative writing** — identify paragraphs that keep getting tweaked
- **Wikipedia-style editing** — spot edit-war hotspots
- **Code review** — find functions that have been patched repeatedly (code smell indicator)
- **AI-assisted writing** — visualise which parts the human kept adjusting vs. accepted first-pass

## Installation

```bash
npm install deep-diff-text
```

## Quick Start

```javascript
import { deepDiffHtml, getDefaultStyles } from 'deep-diff-text';

const revisions = [
  'The cat sat on the mat.',
  'The cat sat on the comfortable mat.',
  'The black cat sat on the comfortable mat.',
  'The black cat slept on the comfortable mat.',
];

// Get HTML with nested <ins> tags
const html = deepDiffHtml(revisions);

// Get CSS for intensity styling
const css = getDefaultStyles();
```

Output:
```html
The <ins class="deep-diff">black </ins>cat <ins class="deep-diff">slept</ins>
on the <ins class="deep-diff">comfortable </ins>mat.
```

Regions changed multiple times will have nested `<ins>` tags, which the default CSS styles with increasing background intensity.

## API

### `computeDeepDiff(revisions, options?)`

Computes diff markers without rendering.

```javascript
import { computeDeepDiff } from 'deep-diff-text';

const { text, markers } = computeDeepDiff(revisions);

// text: the final revision text
// markers: array of { start, end, enabled } marker objects
```

**Options:**
- `skipEmpty` (boolean, default `true`) — skip empty revisions (useful for filtering vandalism)
- `timeout` (number, default `1`) — diff computation timeout in seconds

### `renderWithMarkers(text, markers, options?)`

Renders text with markers as HTML.

```javascript
import { computeDeepDiff, renderWithMarkers } from 'deep-diff-text';

const { text, markers } = computeDeepDiff(revisions);
const html = renderWithMarkers(text, markers, {
  tagName: 'mark',
  className: 'changed'
});
```

**Options:**
- `tagName` (string, default `'ins'`) — HTML tag for markers
- `className` (string, default `'deep-diff'`) — CSS class for tags

### `deepDiffHtml(revisions, options?)`

Convenience function combining `computeDeepDiff` and `renderWithMarkers`.

```javascript
import { deepDiffHtml } from 'deep-diff-text';

const html = deepDiffHtml(revisions, { skipEmpty: true });
```

### `getDefaultStyles(maxDepth?)`

Generates CSS for nested marker intensity.

```javascript
import { getDefaultStyles } from 'deep-diff-text';

const css = getDefaultStyles(5);
// Returns CSS with increasingly intense backgrounds for nested .deep-diff elements
```

## How It Works

1. **Chain diffs** — compute diffs between each consecutive revision pair
2. **Track markers** — maintain a list of changed regions with `[start, end]` positions
3. **Transform markers** — as new edits occur, existing markers shift, expand, or contract:
   - Insert before marker → shift right
   - Insert within marker → expand
   - Delete before marker → shift left
   - Delete within marker → contract (disable if fully subsumed)
4. **Accumulate** — new insertions add new markers; nesting depth = change frequency
5. **Render** — interleave tags at marker boundaries

This is essentially a simplified form of [operational transformation](https://en.wikipedia.org/wiki/Operational_transformation) — the same conceptual framework that powers real-time collaboration in Google Docs.

## Browser Usage

```html
<script type="module">
  import { deepDiffHtml, getDefaultStyles } from 'https://unpkg.com/deep-diff-text';
  
  const style = document.createElement('style');
  style.textContent = getDefaultStyles();
  document.head.appendChild(style);
  
  document.getElementById('output').innerHTML = deepDiffHtml(myRevisions);
</script>
```

## Limitations

- **Character-indexed markers** — large structural refactors (e.g., swapping paragraphs) may produce overlapping chaos. Works best for prose with localised edits.
- **No move detection** — if text is cut and pasted elsewhere, it's treated as delete + insert, not a move.
- **Partial overlap edge cases** — markers at deletion boundaries may behave unexpectedly in some cases.

## Prior Art & Inspiration

- [IBM History Flow](http://hint.fm/projects/historyflow/) — Wikipedia revision visualisation (author-coloured, not intensity-based)
- [diff-match-patch](https://github.com/google/diff-match-patch) — the underlying diff engine (Google)
- [GitLens heatmaps](https://gitlens.amod.io/) — file-level age visualisation (not cumulative change count)

## History

Original algorithm by [Ross Shannon](https://rossshannon.com) (c. 2014). Modernised and published 2026.

## License

MIT

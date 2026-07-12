/**
 * deep-diffs × ProseMirror — live editorial-heat decorations
 *
 * This is docs/FUTURE-DIRECTIONS.md §2.1 ("Editor plugins") made concrete:
 * the deep-diff marker model living *inside* the editor while you write,
 * rather than rendered after the fact from a list of revisions.
 *
 * ── How this replaces the library's transformMarkers ─────────────────────
 * The core library (src/deep-diff.js) reconstructs edits by diffing adjacent
 * snapshots with diff-match-patch, then pushes every existing marker through
 * the diff with transformMarkers() — a hand-rolled operational transform
 * (insert-before shifts, insert-within expands, delete contracts/kills).
 *
 * Inside ProseMirror none of that inference is needed: every transaction
 * carries its edits as explicit steps, and `tr.mapping` (a pipeline of
 * StepMaps) IS the operational transform. Mapping a position through
 * `tr.mapping` is exactly what transformMarkers does to a marker endpoint —
 * except it is exact provenance, not diff inference (the same argument
 * FUTURE-DIRECTIONS makes for CRDT-native markers: the edits themselves are
 * the stored representation, so there is nothing to guess). This also means
 * there is no plaintext-offset → ProseMirror-position translation layer and
 * no diff ambiguity around repeated substrings.
 *
 * ── Why we keep our own marker list instead of DecorationSet.map() ──────
 * `DecorationSet.map(tr.mapping, tr.doc)` would move the highlight ranges
 * for free, but a decoration doesn't know its neighbours: nesting depth must
 * be recomputed from marker overlaps after every edit, and `lastTouched`
 * must be bumped when an edit lands *inside* an existing region. So plugin
 * state holds a plain marker list `{ from, to, revision, lastTouched }`
 * (PM positions, `to` exclusive — Decoration.inline coordinates), maps it
 * through `tr.mapping` on every transaction — the same StepMaps
 * DecorationSet.map would use — and rebuilds the DecorationSet from it.
 *
 * A rendering note: prosemirror-view FLATTENS overlapping inline
 * decorations — a text run covered by several of them gets one <span> with
 * merged, deduplicated classes, not nested spans — so the library's
 * `.deep-diff .deep-diff` descendant-selector trick cannot express depth
 * here. Instead the marker list (which preserves the full overlap
 * structure) is flattened into non-overlapping segments at render time,
 * and every segment carries its stacking depth explicitly: class
 * `dd-d{depth}` plus `data-depth` (with data-revision / data-last-touched
 * as the maxima over the markers stacked on that segment) — the same
 * nesting-depth semantics as the library's renderNested, precomputed
 * because the DOM can't be asked to count ancestors.
 *
 * ── Snapshot model ───────────────────────────────────────────────────────
 * A "revision" commits when the doc has changed and the user pauses for
 * `snapshotMs` (or on the explicit `commitSnapshot` command). Between
 * commits we accumulate the inserted ranges from each transaction's step
 * maps (mapped forward through the remaining steps and all later
 * transactions); at commit those ranges — merged when within `joinGap` —
 * become new markers stamped with the new revision number. This is the
 * step-range approach rather than the diff-the-plaintext approach: it costs
 * nothing (the ranges are already in the transaction), it is exact, and it
 * works for non-text content. The one behaviour it inherits from the core
 * library: text deleted in one transaction and retyped in later ones reads
 * as marker-death + fresh marker (single-transaction replacements —
 * select-and-paste-over — are detected and carry their heat across).
 *
 * @license MIT
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** PluginKey — use `deepDiffsKey.getState(state)` to reach plugin state. */
export const deepDiffsKey = new PluginKey('deepDiffs');

const DEFAULTS = {
  /** Pause (ms) after a doc change before a snapshot auto-commits. */
  snapshotMs: 2000,
  /** 'depth' (geology: heat never fades) or 'recency' (embers: heat decays). */
  heatMode: 'depth',
  /** Embers decay constant τ, in snapshots: heat = e^(−age/τ). */
  decayTau: 6,
  /** Deepest nesting level styled / reported in data-depth. */
  maxDepth: 6,
  /** Inserted ranges from the same snapshot merge when ≤ this many positions apart. */
  joinGap: 2,
  /** Base CSS class on every decoration. */
  className: 'deep-diff'
};

/* ────────────────────────────────────────────────────────────────────────
 * Marker transform: tr.mapping instead of transformMarkers()
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Push markers and pending insert-ranges through one transaction.
 * Pure: returns fresh arrays/objects (plugin state is treated immutably).
 *
 * Endpoint association mirrors the library's boundary semantics:
 *  - `from` maps with assoc +1 → an insert at exactly `from` shifts the
 *    marker right (adjacent text, not "within"; a fresh marker covers it).
 *  - `to` maps with assoc −1 → an insert at exactly `to` leaves it alone.
 *  - a marker whose mapped length collapses to ≤ 0 has been subsumed by a
 *    deletion and dies (library: `enabled = false`).
 */
function mapThroughTransaction(markers, pending, tr) {
  const mapping = tr.mapping;
  let sawDelete = false;

  // Collect this transaction's inserted ranges, expressed in final-doc
  // coordinates (each step's new range mapped through the remaining steps).
  const inserted = [];
  mapping.maps.forEach((stepMap, i) => {
    const rest = mapping.slice(i + 1);
    stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (oldEnd > oldStart) sawDelete = true;
      if (newEnd > newStart) {
        const from = rest.map(newStart, 1);
        const to = rest.map(newEnd, -1);
        if (to > from) inserted.push({ from, to });
      }
    });
  });

  const nextMarkers = [];
  for (const m of markers) {
    let from = m.from;
    let to = m.to;
    let touched = m.touched;
    let dead = false;

    for (const stepMap of mapping.maps) {
      // Replacement heuristic: a single step that deletes a range fully
      // containing the marker AND inserts new content in its place is a
      // paste-over / programmatic replacement — remap the marker onto the
      // replacement so its accumulated heat survives (cf. the living-draft
      // demo's replacement remap; the dominant rework gesture).
      let remapped = false;
      stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
        if (!remapped && oldEnd > oldStart && newEnd > newStart &&
            from >= oldStart && to <= oldEnd) {
          from = newStart;
          to = newEnd;
          touched = true;
          remapped = true;
        }
      });
      if (remapped) continue;

      // Touched? (before mapping, in this step's old coordinates)
      // - insert strictly inside the marker  → expands it   → touched
      // - delete overlapping the marker      → contracts it → touched
      stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
        if (oldEnd > oldStart) {
          if (oldStart < to && oldEnd > from) touched = true;
        } else if (newEnd > newStart) {
          if (from < oldStart && oldStart < to) touched = true;
        }
      });

      from = stepMap.map(from, 1);
      to = stepMap.map(to, -1);
      if (to <= from) { dead = true; break; }
    }

    if (!dead) {
      nextMarkers.push({
        from, to, touched,
        revision: m.revision,
        lastTouched: m.lastTouched
      });
    }
  }

  // Pending ranges ride the same mapping; collapsed ones die.
  const nextPending = [];
  for (const r of pending) {
    const from = mapping.map(r.from, 1);
    const to = mapping.map(r.to, -1);
    if (to > from) nextPending.push({ from, to });
  }
  nextPending.push(...inserted);

  return { markers: nextMarkers, pending: nextPending, sawDelete };
}

/** Merge sorted-or-not ranges that overlap or sit within `joinGap`. */
function mergeRanges(ranges, joinGap) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1];
    if (sorted[i].from - cur.to <= joinGap) {
      cur.to = Math.max(cur.to, sorted[i].to);
    } else {
      out.push({ ...sorted[i] });
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * Decorations
 * ──────────────────────────────────────────────────────────────────────── */

/** Embers temperature for a marker: e^(−age/τ), age in snapshots. */
function emberHeat(marker, revision, decayTau) {
  const age = Math.max(0, revision - marker.lastTouched);
  return Math.exp(-age / decayTau);
}

/**
 * Flatten the overlapping marker list into non-overlapping segments (the PM
 * cousin of the library's computeHeatSegments; half-open [from, to) ranges).
 * `depth` is the number of markers stacked on the segment; revision and
 * lastTouched are the maxima among them; `ember` is the composited embers
 * opacity — each covering marker contributes a translucent wash of
 * temperature e^(−age/τ), composited like the stacked layers it replaces
 * (prosemirror-view flattens overlapping inline decorations, so the
 * compounding nested spans would have provided is computed here instead).
 *
 * Segments with depth 0 are omitted (nothing to decorate).
 */
function flattenMarkers(markers, size, { revision, decayTau }) {
  const cuts = new Set();
  for (const m of markers) {
    cuts.add(Math.max(0, Math.min(m.from, size)));
    cuts.add(Math.max(0, Math.min(m.to, size)));
  }
  const points = [...cuts].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    let depth = 0;
    let rev = 0;
    let last = 0;
    let clear = 1; // Π(1 − wash_i): what shows through the stacked washes
    for (const m of markers) {
      if (m.from <= from && m.to >= to && m.to > m.from) {
        depth++;
        rev = Math.max(rev, m.revision);
        last = Math.max(last, m.lastTouched);
        clear *= 1 - 0.38 * emberHeat(m, revision, decayTau);
      }
    }
    if (depth > 0) {
      segments.push({
        from, to, depth,
        revision: rev,
        lastTouched: last,
        ember: Math.min(1 - clear, 0.8) // cap so text stays readable
      });
    }
  }
  return segments;
}

function buildDecorations(doc, s) {
  const { markers, pending, revision, heatMode } = s;
  const { className, maxDepth, decayTau } = s.options;
  const modeClass = heatMode === 'recency' ? 'dd-recency' : 'dd-depth';
  const size = doc.content.size;
  const decos = [];

  for (const seg of flattenMarkers(markers, size, { revision, decayTau })) {
    const depth = Math.min(seg.depth, maxDepth);
    const attrs = {
      class: `${className} ${modeClass} dd-d${depth}`,
      'data-revision': String(seg.revision),
      'data-last-touched': String(seg.lastTouched),
      'data-depth': String(seg.depth)
    };
    if (heatMode === 'recency') {
      attrs.style = `--dd-heat:${seg.ember.toFixed(3)}`;
    }
    decos.push(Decoration.inline(seg.from, seg.to, attrs));
  }

  // Uncommitted typing shows as a whisper-light provisional tint until the
  // pause commits it into a real marker. Rendered as a background-image so
  // it layers over (rather than fights) a committed segment's
  // background-color when prosemirror-view merges the two decorations'
  // classes onto one span.
  for (const r of pending) {
    if (r.to > r.from) {
      decos.push(Decoration.inline(r.from, r.to, { class: `${className} dd-pending` }));
    }
  }

  return DecorationSet.create(doc, decos);
}

/* ────────────────────────────────────────────────────────────────────────
 * Plugin
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Create the deep-diffs ProseMirror plugin.
 *
 * @param {Object} [options]
 * @param {number}  [options.snapshotMs=2000] - Pause before auto-commit.
 * @param {'depth'|'recency'} [options.heatMode='depth'] - Initial heat mode.
 * @param {number}  [options.decayTau=6] - Embers decay τ, in snapshots.
 * @param {number}  [options.maxDepth=6] - Depth cap for styling/data-depth.
 * @param {number}  [options.joinGap=2] - Merge gap for same-snapshot inserts.
 * @param {string}  [options.className='deep-diff'] - Base decoration class.
 * @returns {Plugin}
 */
export function deepDiffsPlugin(options = {}) {
  const opts = { ...DEFAULTS, ...options };

  return new Plugin({
    key: deepDiffsKey,

    state: {
      init() {
        return {
          options: opts,
          markers: [],      // committed heat regions {from,to,revision,lastTouched,touched}
          pending: [],      // inserted ranges awaiting the next snapshot {from,to}
          hasDeletes: false, // deletions since last snapshot (commit-worthy on their own)
          revision: 0,      // committed snapshot count; the seeded doc is revision 0
          heatMode: opts.heatMode,
          decorations: DecorationSet.empty
        };
      },

      apply(tr, prev, _oldState, newState) {
        let { markers, pending, hasDeletes, revision, heatMode } = prev;
        let changed = false;

        if (tr.docChanged) {
          // THE operational-transform step: tr.mapping plays the role of the
          // library's transformMarkers, with exact step provenance.
          const res = mapThroughTransaction(markers, pending, tr);
          markers = res.markers;
          pending = res.pending;
          hasDeletes = hasDeletes || res.sawDelete;
          changed = true;
        }

        const meta = tr.getMeta(deepDiffsKey);
        if (meta && meta.type === 'commit' &&
            (pending.length > 0 || hasDeletes || markers.some(m => m.touched))) {
          revision += 1;
          markers = markers.map(m => m.touched
            ? { ...m, touched: false, lastTouched: revision }
            : m);
          for (const r of mergeRanges(pending, prev.options.joinGap)) {
            markers.push({
              from: r.from, to: r.to,
              revision, lastTouched: revision, touched: false
            });
          }
          markers.sort((a, b) => a.from - b.from || b.to - a.to || a.revision - b.revision);
          pending = [];
          hasDeletes = false;
          changed = true;
        }
        if (meta && meta.type === 'setHeatMode' && meta.mode !== heatMode) {
          heatMode = meta.mode;
          changed = true;
        }

        if (!changed) return prev;

        const next = {
          options: prev.options,
          markers, pending, hasDeletes, revision, heatMode,
          decorations: DecorationSet.empty
        };
        next.decorations = buildDecorations(newState.doc, next);
        return next;
      }
    },

    props: {
      decorations(state) {
        return this.getState(state).decorations;
      }
    },

    // Auto-commit timer: any doc change (re)arms it; firing dispatches a
    // commit meta transaction. Lives in the view part so it can dispatch.
    view() {
      let timer = null;
      return {
        update(view, prevState) {
          if (!view.state.doc.eq(prevState.doc)) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              timer = null;
              commitSnapshot(view.state, view.dispatch);
            }, opts.snapshotMs);
          }
        },
        destroy() {
          if (timer) clearTimeout(timer);
        }
      };
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Commands & accessors
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Command: commit a snapshot now. Returns false when there is nothing to
 * commit (no inserts, deletes, or touched markers since the last one).
 * Usable as `commitSnapshot(view.state, view.dispatch)` or in a keymap.
 */
export function commitSnapshot(state, dispatch) {
  const s = deepDiffsKey.getState(state);
  if (!s) return false;
  if (!(s.pending.length > 0 || s.hasDeletes || s.markers.some(m => m.touched))) {
    return false;
  }
  if (dispatch) {
    dispatch(state.tr
      .setMeta(deepDiffsKey, { type: 'commit' })
      .setMeta('addToHistory', false));
  }
  return true;
}

/**
 * Command factory: switch heat mode ('depth' | 'recency').
 */
export function setHeatMode(mode) {
  return (state, dispatch) => {
    const s = deepDiffsKey.getState(state);
    if (!s || (mode !== 'depth' && mode !== 'recency')) return false;
    if (s.heatMode === mode) return false;
    if (dispatch) {
      dispatch(state.tr
        .setMeta(deepDiffsKey, { type: 'setHeatMode', mode })
        .setMeta('addToHistory', false));
    }
    return true;
  };
}

/**
 * Flatten the current markers into non-overlapping heat segments tiling the
 * whole document — the canonical input for minimaps and heat strips (the PM
 * cousin of the library's computeHeatSegments; half-open [from, to) ranges
 * in ProseMirror positions).
 *
 * Each segment: { from, to, depth, revision, lastTouched, heat } where
 * `heat` ∈ [0,1] is precomputed for the plugin's current heat mode.
 *
 * @param {EditorState} state
 * @returns {Array<{from:number,to:number,depth:number,revision:number,lastTouched:number,heat:number}>}
 */
export function getHeatSegments(state) {
  const s = deepDiffsKey.getState(state);
  if (!s) return [];
  const size = state.doc.content.size;
  if (size === 0) return [];
  const { markers, revision, heatMode } = s;
  const { maxDepth, decayTau } = s.options;

  // Presentation policy: depth mode ramps linearly to maxDepth; embers use
  // the composited wash opacity (rescaled to fill 0..1 at its cap).
  const heatOf = (seg) => heatMode === 'recency'
    ? Math.min(1, seg.ember / 0.8)
    : Math.min(seg.depth, maxDepth) / maxDepth;

  const heated = flattenMarkers(markers, size, { revision, decayTau });

  // Tile the whole doc: fill the gaps with depth-0 segments so the result
  // covers [0, doc.content.size) exactly, like the library's version.
  const segments = [];
  let pos = 0;
  const pushGap = (to) => {
    if (to > pos) {
      segments.push({ from: pos, to, depth: 0, revision: 0, lastTouched: 0, heat: 0 });
    }
  };
  for (const seg of heated) {
    pushGap(seg.from);
    segments.push({
      from: seg.from, to: seg.to, depth: seg.depth,
      revision: seg.revision, lastTouched: seg.lastTouched,
      heat: heatOf(seg)
    });
    pos = seg.to;
  }
  pushGap(size);
  return segments;
}

/* ────────────────────────────────────────────────────────────────────────
 * CSS generator
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Generate CSS for the plugin's decorations. A small generator rather than a
 * re-export of the library's getDefaultStyles for two structural reasons:
 * getDefaultStyles' `.deep-diff .deep-diff` descendant ramp assumes nested
 * tags, which prosemirror-view's flattened decoration spans never produce
 * (depth arrives as a `dd-d{n}` class instead), and bundling src/deep-diff.js
 * would drag diff-match-patch along for CSS the plugin never diffs with.
 * The idea is the same ramp, made theme-aware: intensities are mixes of a
 * single hot hue in `--dd-hot` (embers: `--dd-ember`), so host pages retheme
 * it — light and dark — by setting two custom properties.
 *
 * @param {Object} [options]
 * @param {number} [options.maxDepth=6] - Deepest stacking level to style.
 * @param {string} [options.className='deep-diff'] - Base decoration class.
 * @returns {string} CSS
 */
export function deepDiffsStyles({ maxDepth = 6, className = 'deep-diff' } = {}) {
  const base = `.${className}`;
  let css = '';
  css += `${base} { border-radius: 2px; transition: background-color 0.45s ease; }\n`;

  // Geology ramp: depth-d segments mix more of the hot hue in.
  const stops = [13, 24, 36, 48, 60, 72];
  for (let d = 1; d <= maxDepth; d++) {
    const pct = stops[Math.min(d, stops.length) - 1];
    css += `.dd-depth.dd-d${d} { background-color: color-mix(in srgb, var(--dd-hot, #2f9e44) ${pct}%, transparent); }\n`;
  }

  // Embers: composited wash opacity in --dd-heat (0..1), computed by the
  // plugin from every marker stacked on the segment.
  css += `.dd-recency { background-color: color-mix(in srgb, var(--dd-ember, var(--dd-hot, #e8590c)) calc(var(--dd-heat, 0) * 100%), transparent); }\n`;

  // Provisional tint for uncommitted typing. background-image, not -color:
  // it must layer over a committed segment's colour when prosemirror-view
  // merges both decorations' classes onto one span.
  css += `.dd-pending { background-image: linear-gradient(color-mix(in srgb, var(--dd-hot, #2f9e44) 9%, transparent), color-mix(in srgb, var(--dd-hot, #2f9e44) 9%, transparent)); }\n`;

  return css;
}

/**
 * Demo entry for demos/prosemirror.html — a real ProseMirror rich-text
 * editor (schema-basic + history + bold/italic keymap) with the deep-diffs
 * plugin decorating live editorial heat beneath the text.
 *
 * Bundled by integrations/prosemirror/build.mjs and inlined into the demo
 * HTML so the page stays self-contained (works from file://, no network).
 */

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { schema } from 'prosemirror-schema-basic';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import { baseKeymap, toggleMark } from 'prosemirror-commands';

import {
  deepDiffsPlugin,
  deepDiffsKey,
  commitSnapshot,
  setHeatMode,
  getHeatSegments,
  deepDiffsStyles
} from '../deep-diffs-plugin.js';

/* ---------- plugin CSS (generated, injected once) ---------- */

const styleEl = document.createElement('style');
styleEl.textContent = deepDiffsStyles({ maxDepth: 6 });
document.head.appendChild(styleEl);

/* ---------- editor ---------- */

const SNAPSHOT_MS = 2000;

const doc = PMDOMParser.fromSchema(schema)
  .parse(document.getElementById('seed'));

const state = EditorState.create({
  doc,
  plugins: [
    history(),
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Shift-Mod-z': redo,
      'Mod-b': toggleMark(schema.marks.strong),
      'Mod-i': toggleMark(schema.marks.em)
    }),
    keymap(baseKeymap),
    deepDiffsPlugin({ snapshotMs: SNAPSHOT_MS, heatMode: 'depth', decayTau: 6, maxDepth: 6 })
  ]
});

const view = new EditorView(document.getElementById('editor'), {
  state,
  dispatchTransaction(tr) {
    view.updateState(view.state.apply(tr));
    refreshUI();
  }
});

/* ---------- snapshot chip ---------- */

const snapChip = document.getElementById('snapChip');
const snapChipText = document.getElementById('snapChipText');
const statusNote = document.getElementById('statusNote');
let lastRevision = 0;

function refreshChip(s) {
  if (s.revision !== lastRevision) {
    lastRevision = s.revision;
    snapChip.classList.remove('pulse');
    void snapChip.offsetWidth; // restart the pulse animation
    snapChip.classList.add('pulse');
  }
  snapChipText.textContent = s.revision === 1 ? '1 snapshot' : `${s.revision} snapshots`;
  const uncommitted = s.pending.length > 0 || s.hasDeletes || s.markers.some(m => m.touched);
  statusNote.textContent = uncommitted
    ? `Editing… snapshot commits after a ${SNAPSHOT_MS / 1000}s pause`
    : s.revision === 0
      ? 'Type into the draft — pause, and your edit becomes a snapshot.'
      : `${s.markers.length} heat region${s.markers.length === 1 ? '' : 's'} · deepest ${Math.max(0, ...s.markers.map(m => depthOf(s, m)))}`;
}

function depthOf(s, m) {
  let d = 0;
  for (const o of s.markers) if (o.from <= m.from && o.to >= m.to) d++;
  return d;
}

/* ---------- heat strip (minimap via getHeatSegments) ---------- */

const strip = document.getElementById('strip');
const stripCtx = strip.getContext('2d');

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawStrip() {
  const dpr = window.devicePixelRatio || 1;
  const w = strip.clientWidth || strip.parentElement.clientWidth;
  const h = strip.clientHeight || strip.parentElement.clientHeight;
  if (strip.width !== w * dpr || strip.height !== h * dpr) {
    strip.width = w * dpr;
    strip.height = h * dpr;
  }
  stripCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  stripCtx.clearRect(0, 0, w, h);

  const size = view.state.doc.content.size;
  if (!size) return;
  const s = deepDiffsKey.getState(view.state);
  const hot = cssVar(s.heatMode === 'recency' ? '--dd-ember' : '--dd-hot') || '#e8590c';

  for (const seg of getHeatSegments(view.state)) {
    if (seg.heat <= 0) continue;
    const x = (seg.from / size) * w;
    const sw = Math.max(1, ((seg.to - seg.from) / size) * w);
    stripCtx.globalAlpha = 0.15 + 0.85 * seg.heat;
    stripCtx.fillStyle = hot;
    stripCtx.fillRect(x, 0, sw, h);
  }
  stripCtx.globalAlpha = 1;
}

/* ---------- toolbar ---------- */

const modeSeg = document.getElementById('modeSeg');
modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-value]');
  if (!btn) return;
  const mode = btn.dataset.value === 'embers' ? 'recency' : 'depth';
  setHeatMode(mode)(view.state, view.dispatch);
  syncModeSeg();
});

function syncModeSeg() {
  const mode = deepDiffsKey.getState(view.state).heatMode;
  for (const b of modeSeg.querySelectorAll('button')) {
    const checked = (b.dataset.value === 'embers') === (mode === 'recency');
    b.setAttribute('aria-checked', String(checked));
    b.tabIndex = checked ? 0 : -1;
  }
}

document.getElementById('commitBtn').addEventListener('click', () => {
  if (!commitSnapshot(view.state, view.dispatch)) {
    statusNote.textContent = 'Nothing new to commit — make an edit first.';
  }
  view.focus();
});

document.getElementById('boldBtn').addEventListener('click', () => {
  toggleMark(schema.marks.strong)(view.state, view.dispatch);
  view.focus();
});
document.getElementById('italicBtn').addEventListener('click', () => {
  toggleMark(schema.marks.em)(view.state, view.dispatch);
  view.focus();
});

/* ---------- theme ---------- */

const themeToggle = document.getElementById('themeToggle');
function currentTheme() {
  return document.documentElement.dataset.theme ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function updateThemeGlyph() {
  // toggleAttribute, not .hidden — SVG elements lack the hidden IDL property
  const dark = currentTheme() === 'dark';
  document.getElementById('glyphMoon').toggleAttribute('hidden', dark);
  document.getElementById('glyphSun').toggleAttribute('hidden', !dark);
}
themeToggle.addEventListener('click', () => {
  document.documentElement.dataset.theme = currentTheme() === 'dark' ? 'light' : 'dark';
  updateThemeGlyph();
  paintLegend();
  drawStrip();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) {
    updateThemeGlyph();
    paintLegend();
    drawStrip();
  }
});

function paintLegend() {
  const hot = cssVar('--dd-hot') || '#e8590c';
  const stops = [];
  for (let i = 0; i <= 6; i++) {
    const pct = Math.round((i / 6) * 72);
    stops.push(`color-mix(in srgb, ${hot} ${pct}%, transparent) ${Math.round((i / 6) * 100)}%`);
  }
  document.getElementById('legendBar').style.background =
    `linear-gradient(90deg, ${stops.join(', ')})`;
}

/* ---------- refresh loop ---------- */

function refreshUI() {
  const s = deepDiffsKey.getState(view.state);
  refreshChip(s);
  drawStrip();
  syncModeSeg();
}

window.addEventListener('resize', drawStrip);

/* ---------- boot ---------- */

updateThemeGlyph();
paintLegend();
refreshUI();
view.focus();

/* test hook (harmless in normal use) */
window.__deepDiffsDemo = {
  view,
  key: deepDiffsKey,
  commitSnapshot: () => commitSnapshot(view.state, view.dispatch),
  segments: () => getHeatSegments(view.state),
  get state() { return deepDiffsKey.getState(view.state); }
};

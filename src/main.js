/**
 * main.js -- integration. Wires the four parts together and owns nothing else.
 *
 *   parser  -> typed arrays          (src/parser)
 *   viewer  -> draws and picks them  (src/render)
 *   ui      -> chrome and controls   (src/ui)
 *   client  -> server and Claude     (src/bridge)
 *
 * All application state lives in `state` below. Every part is told what to do
 * from here; no part reaches into another.
 */

import { createUI } from './ui/layout.js';
import { createViewer } from './render/viewer.js';
import { legendFor, VIEW_MODES, FEATURE_NAMES, CLAUDE_COLORS } from './render/colors.js';
import { formatDuration, flowRate, segLength, KIND } from './parser/parse.js';
import { buildSelection, describeSelection } from './selection.js';
import * as api from './bridge/client.js';
import { rankBases } from './compare.js';
import { alignFor, shiftParse } from './align.js';
import { checkPrint, checkScrewSeats } from './printcheck.js';

const state = {
  jobs: [],
  path: null,      // current file path, server-relative
  parsed: null,    // current parse result
  selection: null, // current selection object (see docs/CONTEXT-bridge.md)
  selectionIndices: null, // the move indices behind it, for edits that need live values
  selectionShot: null,    // PNG data URL of the view when the selection was made
  picked: null,           // move index last clicked (not hovered)
  visibleFeatures: null,  // Set of feature ids shown in the rail, null = all
  areaOptions: { match: 'inside', includeAux: false },
  compare: null,          // {base, mode, stats} while a diff is shown
  ownWriteUntil: 0,       // ignore disk events for our own writes until then
  editing: false,  // an edit preview/apply is in flight
  viewMode: 'feature',
  layerRange: [0, 0],
};

const ui = createUI(document.getElementById('app') || document.body);

/**
 * A viewer that does nothing, so a renderer failure degrades instead of
 * exploding. If createViewer throws at module scope the whole import rejects
 * and index.html falls back to the mock harness -- which looks like a working
 * app full of fake data and wastes everybody's time. The file list, inspector,
 * layer bar and Claude are all still useful without 3D.
 */
function nullViewer(reason) {
  const noop = () => {};
  return {
    setData: noop, setViewMode: noop, setLayerRange: noop, setVisibleFeatures: noop,
    setShowTravel: noop, setShowRetractions: noop, setSelection: noop, clearSelection: noop,
    setCompareLook: noop, getCompareLook: () => null,
    onPick: noop, onHover: noop, onBoxSelect: noop, setBoxSelectMode: noop,
    onAreaSelect: noop, setAreaSelectMode: noop, setAreaOptions: noop,
    setCompare: noop, setCompareMode: noop, setPointers: noop, framePointers: noop, getLastRect: () => null, captureView: () => null,
    frameAll: noop, frameSelection: noop, setTopView: noop, setBottomView: noop, setFrontView: noop, setIsoView: noop,
    renderThumbnail: () => null, dispose: noop,
    getValueRange: () => ({ min: 0, max: 1 }),
    getStats: () => ({ unavailable: reason }),
  };
}

let viewer;
try {
  viewer = createViewer(ui.getCanvas(), {});
} catch (err) {
  console.error('[gcode-studio] renderer failed to start', err);
  viewer = nullViewer(err.message);
  ui.toast('3D view unavailable: ' + err.message, 'error');
  ui.setStatus({ connected: false, message: '3D unavailable - ' + err.message });
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

let worker = null;
let jobId = 0;

function parseInWorker(text) {
  if (!worker) {
    worker = new Worker(new URL('./parser/gcode-worker.js', import.meta.url), { type: 'module' });
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') {
        ui.setBusy(true, 'Parsing ' + Math.round(m.frac * 100) + '%');
      } else if (m.type === 'done') {
        worker.removeEventListener('message', onMessage);
        resolve(m.result);
      } else if (m.type === 'error') {
        worker.removeEventListener('message', onMessage);
        reject(new Error(m.message));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, text });
  });
}

// ---------------------------------------------------------------------------
// loading a file
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 * @param {{diff?: boolean|string}} [opts]  diff: true = against the version it
 *        came from, a path = against that file
 */
async function openFile(path, opts = {}) {
  ui.setBusy(true, 'Loading');
  try {
    const text = await api.readFile(path);
    const parsed = await parseInWorker(text);

    state.path = path;
    state.parsed = parsed;
    // remembered so a reload (F5) comes back to the same file
    try { localStorage.setItem('gcs.lastFile', path); } catch { /* private mode */ }
    // Line numbers only mean something inside one version of one file, so a
    // selection can never survive a file change.
    state.selection = null;
    state.selectionIndices = null;
    state.selectionShot = null;
    state.picked = null;
    ui.showSelection(null);
    viewer.clearSelection();
    // setData drops the compare layer: its classes belong to the old file
    state.compare = null;
    ui.showCompare(null);
    ui.showPointers(null);
    ui.setDraft(/_v\d+-draft\.gcode$/i.test(path));

    viewer.setData(parsed);
    viewer.setViewMode(state.viewMode);

    const top = Math.max(0, parsed.layers.length - 1);
    state.layerRange = [0, top];
    viewer.setLayerRange(0, top);
    ui.setLayerRange(0, top);

    ui.setFile({
      name: path.split(/[\\/]/).pop(),
      path,
      meta: parsed.meta,
      layers: parsed.layers,
      warnings: parsed.warnings,
      parseMs: parsed.parseMs,
      count: parsed.count,
      // Lets the UI disable the Lane A controls outright on an absolute-E file
      // rather than only warning about it (safety rule 5).
      relativeE: parsed.relativeE,
    });
    // Without this the rail lists all 17 feature types whether or not the file
    // contains them.
    state.featureCounts = featureCounts(parsed);
    ui.setFeatureCounts(state.featureCounts);
    refreshLegend();
    viewer.frameAll();

    if (parsed.warnings.length) {
      ui.toast(parsed.warnings[0], 'warn');
    }
    if (!parsed.relativeE) {
      ui.toast('This file does not use relative extrusion (M83) - editing is disabled.', 'error');
    }
  } catch (err) {
    ui.toast('Could not open ' + path + ': ' + err.message, 'error');
    console.error(err);
    return;
  } finally {
    ui.setBusy(false);
  }
  if (opts.diff) await startDiff(opts.diff === true ? null : opts.diff);
}

/** How many extruding moves of each feature type this file actually contains. */
function featureCounts(parsed) {
  const counts = Object.create(null);
  const { feature, kind } = parsed.segments;
  for (let i = 0; i < parsed.count; i++) {
    if (kind[i] !== KIND.EXTRUDE) continue;
    const name = FEATURE_NAMES[feature[i]];
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function refreshLegend() {
  const mode = state.viewMode;
  const spec = VIEW_MODES.find((m) => m.id === mode);
  if (mode === 'feature') {
    ui.setLegend(legendFor('feature', state.featureCounts));
  } else {
    ui.setLegend(legendFor(mode, viewer.getValueRange(mode), spec ? spec.unit : ''));
  }
}

// ---------------------------------------------------------------------------
// inspector: one picked move
// ---------------------------------------------------------------------------

function describeMove(i) {
  const p = state.parsed;
  if (!p || i == null || i < 0) return null;
  const s = p.segments;
  const kindName = ['Extrude', 'Travel', 'Retract', 'Prime'][s.kind[i]];
  const out = {
    'Move kind': kindName,
    Layer: String(s.layer[i]),
    Z: s.z1[i].toFixed(3) + ' mm',
    Speed: s.speed[i].toFixed(1) + ' mm/s',
    Fan: (s.fan[i] * 100).toFixed(0) + ' %',
    'Nozzle temp': s.temp[i].toFixed(0) + ' °C',
    Acceleration: s.accel[i].toFixed(0) + ' mm/s²',
    Length: segLength(s, i).toFixed(3) + ' mm',
    'E delta': s.e[i].toFixed(5) + ' mm',
    Time: (s.time[i] * 1000).toFixed(1) + ' ms',
    'Source line': String(s.line[i] + 1),
  };
  if (s.kind[i] === KIND.EXTRUDE) {
    out.Feature = FEATURE_NAMES[s.feature[i]];
    out['Line width'] = s.width[i].toFixed(3) + ' mm';
    out['Layer height'] = s.height[i].toFixed(3) + ' mm';
    out.Flow = flowRate(s, i, p.meta.filamentDiameter).toFixed(2) + ' mm³/s';
  }
  return out;
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

/**
 * @param {Uint32Array} indices
 * @param {{mode?: 'box'|'area', rect?: object, bounds?: object, partial?: Uint32Array, clip?: object}} [how]
 *   `partial` / `clip` (area only): crossing moves, drawn highlighted inside the
 *   rectangle only. They are NOT part of the selection sent to edits or Claude.
 */
async function setSelection(indices, how = {}) {
  if (!state.parsed || !indices || !indices.length) {
    state.selection = null;
    state.selectionIndices = null;
    state.selectionShot = null;
    ui.showSelection(null);
    viewer.clearSelection();
    if (how.mode === 'area') ui.toast('Nothing in that area - check the layer range, feature filters and "Counts if" in the Select panel.', 'warn');
    return;
  }
  const sel = buildSelection(indices, state.parsed, state.path);
  sel.mode = how.mode || 'box';
  if (how.rect || how.bounds) {
    sel.area = { rect: how.rect || null, bounds: how.bounds || null };
    if (how.partial) sel.area.crossingNotSelected = how.partial.length;
  }
  state.selection = sel;
  state.selectionIndices = indices;
  viewer.setSelection(indices, { partial: how.partial, clip: how.clip });
  // Grab the view now, while the rectangle still matches the camera. It is
  // only uploaded if the selection is attached.
  try {
    state.selectionShot = viewer.captureView({
      rect: how.rect || null,
      label: ({ area: 'area · ', layers: 'layers · ' }[sel.mode] || 'selection · ') + describeSelection(sel),
    });
  } catch (err) {
    state.selectionShot = null;
    console.warn('[gcode-studio] view capture failed', err);
  }
  // Pass the whole selection, not just the summary: its id is the one that goes
  // to bridge/selection.json and into attachments.
  ui.showSelection(sel);

  try {
    await api.putSelection(sel);
  } catch (err) {
    // The selection still works locally; it just is not visible to Claude.
    ui.toast('Selection not shared with Claude: ' + err.message, 'warn');
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

viewer.onPick((i) => { state.picked = i == null || i < 0 ? null : i; ui.showPickedSegment(describeMove(i)); });
// Hovering only previews: leaving the model shows the clicked move again, so
// "attach move" always attaches what was clicked, not what the mouse crossed.
viewer.onHover((i) => ui.showPickedSegment(describeMove(i != null && i >= 0 ? i : state.picked)));
viewer.onBoxSelect((indices) => setSelection(indices, { mode: 'box', rect: viewer.getLastRect() }));
viewer.onAreaSelect(({ indices, rect, bounds, partial, clip }) =>
  setSelection(indices, { mode: 'area', rect, bounds, partial, clip }));

ui.onViewModeChange((mode) => {
  state.viewMode = mode;
  viewer.setViewMode(mode);
  refreshLegend();
});

ui.onLayerRangeChange((lo, hi) => {
  state.layerRange = [lo, hi];
  viewer.setLayerRange(lo, hi);
});

ui.onFeatureToggle((visible) => {
  state.visibleFeatures = visible ? new Set(visible) : null;
  viewer.setVisibleFeatures(visible);
});
ui.onTravelToggle((on) => viewer.setShowTravel(on));
ui.onRetractToggle((on) => viewer.setShowRetractions(on));

ui.onCameraPreset((which) => {
  ({
    iso: () => viewer.setIsoView(),
    top: () => viewer.setTopView(),
    bottom: () => viewer.setBottomView(),
    front: () => viewer.setFrontView(),
    fit: () => viewer.frameAll(),
  }[which] || (() => {}))();
});

ui.onSelectModeChange((mode) => {
  // off first, so switching straight from one mode to the other is clean
  if (mode !== 'box') viewer.setBoxSelectMode(false);
  if (mode !== 'area') viewer.setAreaSelectMode(false);
  if (mode === 'box') viewer.setBoxSelectMode(true);
  if (mode === 'area') viewer.setAreaSelectMode(true);
  // 'layers' needs no drawing, so both stay off and the mouse orbits as usual
});

/**
 * Skirt, brim and the purge line ("Custom"/"Unknown") cross every rectangle on
 * the part and are almost never what "here" means, so they are left out
 * unless the select panel says otherwise.
 */
const AUX_FEATURES = ['Skirt', 'Brim', 'Custom', 'Unknown'].map((n) => FEATURE_NAMES.indexOf(n)).filter((i) => i >= 0);

function applyAreaOptions(o) {
  state.areaOptions = { match: o.match || 'inside', includeAux: !!o.includeAux };
  viewer.setAreaOptions({
    match: state.areaOptions.match,
    exclude: state.areaOptions.includeAux ? null : AUX_FEATURES,
  });
}
applyAreaOptions(ui.getAreaOptions());
ui.onAreaOptions(applyAreaOptions);

/** "Select these layers": every extrusion in lo..hi, same filters as area select. */
ui.onSelectLayers((lo, hi) => {
  const p = state.parsed;
  if (!p) return;
  const s = p.segments;
  const skip = new Set(state.areaOptions.includeAux ? [] : AUX_FEATURES);
  const out = [];
  for (let i = 0; i < p.count; i++) {
    if (s.kind[i] !== KIND.EXTRUDE) continue;
    const L = s.layer[i];
    if (L < lo || L > hi) continue;
    const f = s.feature[i];
    if (skip.has(f)) continue;
    if (state.visibleFeatures && !state.visibleFeatures.has(f)) continue;
    out.push(i);
  }
  if (!out.length) { ui.toast('No moves in layers ' + lo + '–' + hi + ' with the current filters.', 'warn'); return; }
  setSelection(Uint32Array.from(out), { mode: 'layers' });
});
ui.onFileOpen((path) => openFile(path));

ui.onSendToClaude((note) => attachSelection(note));
ui.onAttachMove(() => attachMove());

// ---------------------------------------------------------------------------
// live updates from the server
// ---------------------------------------------------------------------------

api.watch(({ type, data }) => {
  if (type === 'connected') {
    ui.setStatus({ connected: true, message: 'connected' });
  } else if (type === 'disconnected') {
    ui.setStatus({ connected: false, message: 'server not reachable' });
  } else if (type === 'open' && data && data.path) {
    ui.toast('Claude opened ' + data.path.split('/').pop() + (data.diff ? ' with the diff' : ''), 'info');
    seenNew.add(data.path);
    openFile(data.path, { diff: data.diff || false });
  } else if (type === 'reload') {
    location.reload();
  } else if (type === 'highlight' && data) {
    showClaudeAreas(data);
  } else if (type === 'file') {
    onFileEvent(data);
  }
});

let jobsRefreshTimer = 0;

/**
 * A G-code changed on disk -- usually Claude writing a new version from the
 * terminal, or our own edit landing. Writing a version moves the current file
 * into old\, which arrives here as "current file removed"; that is not a
 * reason to reload, the new version is opened by whoever wrote it.
 */
function onFileEvent(data) {
  clearTimeout(jobsRefreshTimer);
  jobsRefreshTimer = setTimeout(refreshJobs, 250);
  if (!data || state.editing || Date.now() < state.ownWriteUntil) return;

  if (data.path !== state.path) {
    // A new current file somewhere (Claude's slice or edit): offer it, with the diff.
    // "new" = not in the file list we had (the watcher often reports a fresh file as a change)
    const known = state.jobs.some((j) => [...(j.gcode || []), ...(j.old || [])].some((f) => f.path === data.path));
    const isNew = data.exists && !data.archived && !known && !/\/old\//.test(data.path);
    if (isNew && !seenNew.has(data.path)) {
      seenNew.add(data.path);
      ui.toast('New file: ' + data.name, 'info', {
        ttl: 20000,
        action: { label: 'Open + diff', onClick: () => openFile(data.path, { diff: true }) },
      });
    }
    return;
  }
  if (data.exists === false) {
    ui.toast('This file was moved or archived on disk.', 'warn');
    return;
  }
  ui.toast('This file changed on disk - reloading', 'info');
  openFile(state.path, { diff: state.compare ? state.compare.base : false });
}
const seenNew = new Set();

// ---------------------------------------------------------------------------
// lane A: region edits
// ---------------------------------------------------------------------------

/**
 * Turn the inspector's slider changes into server edit ops targeted at the
 * selection's source lines.
 */
function buildOps(changes) {
  const sel = state.selection;
  const ranges = sel.lineRanges;
  const s = state.parsed.segments;
  const idx = state.selectionIndices;
  const ops = [];
  const tags = [];

  for (const c of changes) {
    const d = Number(c.delta);
    if (!d) continue;
    if (c.key === 'speed') {
      ops.push({ op: 'scaleSpeed', factor: 1 + d / 100, lineRanges: ranges });
      tags.push('speed' + signed(d));
    } else if (c.key === 'flow') {
      ops.push({ op: 'scaleFlow', factor: 1 + d / 100, lineRanges: ranges });
      tags.push('flow' + signed(d));
    } else if (c.key === 'fan') {
      // Percentage points on top of what the region runs at now.
      const now = sel.summary.fan.avg * 100;
      const percent = Math.round(Math.max(0, Math.min(100, now + d)));
      ops.push({ op: 'setFan', percent, lineRanges: ranges });
      tags.push('fan' + percent);
    } else if (c.key === 'temp') {
      const now = idx && idx.length ? s.temp[idx[0]] : 0;
      if (!now) throw new Error('cannot tell the current nozzle temperature for this region');
      const celsius = Math.round(now + d);
      ops.push({ op: 'setTemp', celsius, lineRanges: ranges });
      tags.push('temp' + celsius);
    }
  }

  const [lo, hi] = sel.summary.layers;
  const where = lo === hi ? 'l' + lo : 'l' + lo + '-' + hi;
  return { ops, note: tags.join('-') + '-' + where };
}

function signed(n) { return (n > 0 ? 'plus' : 'minus') + Math.abs(n); }

/** Map the server's diff entries onto what the confirm modal renders. */
function diffForModal(diff) {
  if (!diff || !Array.isArray(diff.entries)) return [];
  return diff.entries.map((e) => ({
    line: e.line + 1,
    before: e.before,
    after: e.after,
  }));
}

function editTitle(changes, preview) {
  const what = changes.map((c) => c.text).join(', ');
  let t = what + ' — ' + describeSelection(state.selection);
  if (preview && preview.before && preview.after) {
    const a = preview.before.timeSec, b = preview.after.timeSec;
    if (a && b) t += ` — time ${formatDuration(a)} → ~${formatDuration(b)} (predicted)`;
  }
  return t;
}

async function runLaneA(req) {
  if (state.editing) return;
  if (!state.parsed || !state.selection) {
    ui.toast('Select a region in the 3D view first.', 'warn');
    return;
  }
  if (!state.parsed.relativeE) {
    ui.toast('This file uses absolute extrusion - editing is disabled.', 'error');
    return;
  }

  let plan;
  try {
    plan = buildOps(req.changes || []);
  } catch (err) {
    ui.toast(err.message, 'error');
    return;
  }
  if (!plan.ops.length) return;

  const path = state.path;
  state.editing = true;
  ui.setBusy(true, 'Checking the edit');
  try {
    const preview = await api.previewEdit(path, plan.ops, plan.note);
    ui.setBusy(false);

    if (preview.planError) {
      ui.toast('Cannot version this file: ' + preview.planError, 'error');
      return;
    }

    const counts = preview.diff || {};
    const ok = await ui.confirmEdit({
      title: editTitle(req.changes, preview.preview) +
        ` — ${counts.changedLines || 0} changed, ${counts.insertedLines || 0} inserted, ` +
        `${counts.deletedLines || 0} removed` +
        (preview.outPath ? ` — writes ${preview.outPath.split('/').pop()}` : ''),
      diff: diffForModal(preview.diff),
      validation: preview.validation,
    });
    if (!ok) {
      ui.toast('Edit cancelled - nothing was written.', 'info');
      return;
    }

    ui.setBusy(true, 'Writing new version');
    const result = await api.applyEdit(path, plan.ops, plan.note);
    ui.setBusy(false);
    if (!result.ok || !result.written) {
      const why = (result.validation && result.validation.errors || []).map((e) => e.message).join('; ');
      ui.toast('Not written: ' + (why || 'validation failed'), 'error');
      return;
    }

    ui.toast(result.commit && result.commit.draft
      ? 'Saved to ' + result.outPath.split('/').pop() + ' (the step before is in old\\)'
      : 'Saved ' + result.outPath.split('/').pop(), 'success');
    await refreshJobs();
    state.ownWriteUntil = Date.now() + 2500;
    seenNew.add(result.outPath);
    await openFile(result.outPath, { diff: true });
  } catch (err) {
    ui.toast('Edit failed: ' + err.message, 'error');
  } finally {
    ui.setBusy(false);
    state.editing = false;
  }
}

/**
 * Lane B requests (anything geometric) cannot be applied to G-code. They are
 * typed into Claude's prompt with the selection described, and Claude
 * re-slices. The user can add to the line before pressing Enter.
 */
function runLaneB(req) {
  const where = state.selection ? ' for ' + describeSelection(state.selection) : '';
  const ok = ui.typeToClaude(
    `[G-code Studio · re-slice request · ${req.label}${where} · ${state.path || req.file || '?'} · geometric, needs the slicer] `,
  );
  if (!ok) ui.toast('Claude is not running - start it in the Claude panel.', 'warn');
}

// ---------------------------------------------------------------------------
// diff: what changed against the version this file came from
// ---------------------------------------------------------------------------

let cmpWorker = null;
let cmpJob = 0;

function compareInWorker(cur, old) {
  if (!cmpWorker) cmpWorker = new Worker(new URL('./compare-worker.js', import.meta.url), { type: 'module' });
  const id = ++cmpJob;
  const pick = (p) => ({
    count: p.count,
    segments: { x0: p.segments.x0, y0: p.segments.y0, z1: p.segments.z1, x1: p.segments.x1, y1: p.segments.y1, kind: p.segments.kind, feature: p.segments.feature, width: p.segments.width },
  });
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      if (ev.data.id !== id) return;
      cmpWorker.removeEventListener('message', onMessage);
      if (ev.data.type === 'done') resolve(ev.data.result); else reject(new Error(ev.data.message));
    };
    cmpWorker.addEventListener('message', onMessage);
    cmpWorker.postMessage({ id, cur: pick(cur), old: pick(old) });
  });
}

/** Files to offer as a base, best match first. */
function baseCandidates() {
  const all = [];
  for (const job of state.jobs) for (const f of [...(job.gcode || []), ...(job.old || [])]) all.push(f.path);
  return rankBases(state.path, all);
}

async function pickBase() {
  if (!state.path) return null;
  const ranked = baseCandidates();
  return ui.pickFile({
    title: 'Diff against which file?',
    items: ranked.map((r, i) => ({ path: r.path, note: i === 0 && r.score > 0 ? 'best match' : '' })),
  });
}

/** @param {string|null} base  null = the version this file came from, else ask */
async function startDiff(base) {
  const cur = state.parsed, curPath = state.path;
  if (!cur) return;
  if (!base) {
    try { base = await api.getBase(curPath); } catch { base = null; }
    if (!base) {
      const best = baseCandidates()[0];
      base = best && best.score >= 4 ? best.path : await pickBase();
    }
  }
  if (!base) return;

  const mode = (state.compare && state.compare.mode) || 'changes';
  const name = base.split('/').pop();
  state.compare = { base, mode, stats: null };
  ui.showCompare({ name, path: base, mode });
  ui.setCompareBusy('comparing…');
  try {
    let old = await parseInWorker(await api.readFile(base));
    // Finalize centres parts; the align notes say how to line the base up again.
    const align = await findAlign(curPath, base);
    state.compare.align = align ? { ...align, on: !state.alignOff } : null;
    if (align && !state.alignOff && (align.dx || align.dy)) old = shiftParse(old, align.dx, align.dy);
    const result = await compareInWorker(cur, old);
    if (state.path !== curPath || !state.compare || state.compare.base !== base) return; // moved on
    viewer.setCompare({ parse: old, curClass: result.curClass, oldClass: result.oldClass });
    for (const m of ['changes', 'both']) { const l = loadLook(m); if (l) viewer.setCompareLook(m, l); }
    viewer.setCompareMode(mode);
    ui.setCompareLook(viewer.getCompareLook(mode));
    state.compare.stats = result.stats;
    ui.showCompare({ name, path: base, mode, stats: result.stats, align: state.compare.align });
  } catch (err) {
    ui.toast('Diff failed: ' + err.message, 'error');
    stopDiff();
  } finally {
    ui.setCompareBusy('');
    ui.setBusy(false);
  }
}

/** How far to move `base` so it lines up with `cur` (from the align notes), or null. */
async function findAlign(cur, base) {
  const readNote = (p) => api.readFile(p).then((t) => JSON.parse(t)).catch(() => null);
  const baseOfDraft = (p) => api.getBase(p).catch(() => null);
  try { return await alignFor(cur, base, readNote, baseOfDraft); } catch { return null; }
}

function stopDiff() {
  state.compare = null;
  viewer.setCompare(null);
  ui.showCompare(null);
}

ui.onDiff(() => (state.compare ? stopDiff() : startDiff(null)));
ui.onDiffPick(async () => { const b = await pickBase(); if (b) startDiff(b); });
ui.onCompareAlign(() => {
  state.alignOff = !state.alignOff;
  if (state.compare) startDiff(state.compare.base);
});
ui.onCompareMode((m) => {
  if (!state.compare) return;
  state.compare.mode = m;
  viewer.setCompareMode(m);
  ui.setCompareLook(viewer.getCompareLook(m));
});

// The diff card's look (opacity old / new, hide same), remembered per mode in this browser.
const LOOK_KEY = (m) => 'gcs.diffLook.' + m;
function loadLook(m) {
  try { const v = JSON.parse(localStorage.getItem(LOOK_KEY(m)) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
ui.onCompareLook((look) => {
  if (!state.compare) return;
  const m = state.compare.mode;
  viewer.setCompareLook(m, look);
  try { localStorage.setItem(LOOK_KEY(m), JSON.stringify(viewer.getCompareLook(m))); } catch { /* private mode */ }
});

ui.onFinalize(async () => {
  const path = state.path;
  if (!path || !/_v\d+-draft\.gcode$/i.test(path)) return;
  const note = window.prompt('What changed in this version? It becomes part of the file name, e.g. "slow-top-layers".');
  if (!note || !note.trim()) return;
  try {
    state.ownWriteUntil = Date.now() + 2500;
    const r = await api.finalize(path, note.trim());
    seenNew.add(r.path);
    ui.toast('Final: ' + r.name + (r.moved.length ? ' - the previous final moved to old\\' : ''), 'success');
    await refreshJobs();
    await openFile(r.path, { diff: true });
  } catch (err) {
    ui.toast('Finalize failed: ' + err.message, 'error');
  }
});

// ---------------------------------------------------------------------------
// Claude pointing at areas: app-cli.js show -> /api/app/highlight -> here
// ---------------------------------------------------------------------------

/**
 * Draw Claude's boxes and paint the moves inside each in the box's colour.
 * Regions are in bed (G-code) mm; a missing y / z means the whole part.
 */
// Only walls are painted inside a box: floor and infill lines run across
// every box and turn the picture into stripes. The box itself shows the area.
const WALLS = new Set(['Inner wall', 'Outer wall', 'Overhang wall', 'Gap infill'].map((n) => FEATURE_NAMES.indexOf(n)));

async function showClaudeAreas({ path, regions }) {
  if (path && path !== state.path) await openFile(path);
  const p = state.parsed;
  if (!p) return;
  if (!regions || !regions.length) { clearClaudeAreas(); return; }
  // the diff would paint over the boxes; Diff turns it back on
  if (state.compare) stopDiff();

  const s = p.segments;
  // the part's extent, without the purge line
  const aux = new Set(['Custom', 'Unknown'].map((n) => FEATURE_NAMES.indexOf(n)));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = 0;
  for (let i = 0; i < p.count; i++) {
    if (s.kind[i] !== KIND.EXTRUDE || aux.has(s.feature[i])) continue;
    x0 = Math.min(x0, s.x1[i]); x1 = Math.max(x1, s.x1[i]);
    y0 = Math.min(y0, s.y1[i]); y1 = Math.max(y1, s.y1[i]);
    z1 = Math.max(z1, s.z1[i]);
  }
  const zOfLayer = (n) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.count; i++) {
      if (s.layer[i] !== n || s.kind[i] !== KIND.EXTRUDE) continue;
      lo = Math.min(lo, s.z1[i]); hi = Math.max(hi, s.z1[i]);
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  };

  const boxes = regions.map((r, k) => {
    const xr = r.x || [x0 - 1, x1 + 1];
    const yr = r.y || [y0 - 1, y1 + 1];
    let zr = r.z || [0, z1];
    if (r.layers) {
      const a = zOfLayer(r.layers[0]), b = zOfLayer(r.layers[1]);
      if (a && b) zr = [a[0] - 0.2, b[1]];
    }
    const idx = [];
    for (let i = 0; i < p.count; i++) {
      if (s.kind[i] !== KIND.EXTRUDE || !WALLS.has(s.feature[i])) continue;
      if (r.layers && (s.layer[i] < r.layers[0] || s.layer[i] > r.layers[1])) continue;
      // both ends inside: a long top-surface line that merely crosses a narrow
      // box must not be painted along its whole length
      const z = s.z1[i];
      if (z < zr[0] - 1e-3 || z > zr[1] + 1e-3) continue;
      const inX = (x) => x >= xr[0] - 0.05 && x <= xr[1] + 0.05;
      const inY = (y) => y >= yr[0] - 0.05 && y <= yr[1] + 0.05;
      if (inX(s.x0[i]) && inX(s.x1[i]) && inY(s.y0[i]) && inY(s.y1[i])) idx.push(i);
    }
    const min = [xr[0], yr[0], Math.max(0, zr[0])];
    const max = [xr[1], yr[1], zr[1]];
    let after = null;
    if (r.move || r.toX || r.toY) {
      const [dx, dy] = r.move || [0, 0];
      const ax = r.toX || [min[0] + dx, max[0] + dx];
      const ay = r.toY || [min[1] + dy, max[1] + dy];
      after = { min: [ax[0], ay[0], min[2]], max: [ax[1], ay[1], max[2]] };
    }
    return {
      min, max, after,
      color: CLAUDE_COLORS[k % CLAUDE_COLORS.length],
      label: r.label,
      indices: Uint32Array.from(idx),
    };
  });

  viewer.setPointers(boxes);
  ui.showPointers(boxes.map((b) => ({
    label: b.label + (b.after ? '  →' : ''),
    color: b.color,
  })));
  state.pointerView = viewFor(boxes, z1);
  viewer.framePointers(false, state.pointerView);
}

/**
 * Top-down unless the boxes mark openings in a wall: all thin in one
 * direction and at least one limited in height. Then look at the wall's face
 * from above the walls in front of it.
 */
function viewFor(boxes, partTop) {
  const lowered = boxes.some((b) => b.max[2] - b.min[2] < partTop * 0.9);
  if (!lowered) return 'top';
  if (boxes.every((b) => b.max[0] - b.min[0] <= 3)) return 'hi-right';
  if (boxes.every((b) => b.max[1] - b.min[1] <= 3)) return 'hi-front';
  return 'top';
}

function clearClaudeAreas() {
  viewer.setPointers([]);
  ui.showPointers(null);
  checking = false;
  ui.setChecking(false);
}

// ---------------------------------------------------------------------------
// Check before printing (title bar Check / K) -- the same findings and boxes as
// `node server/print-check-cli.js <file> --show`, run here on the open file.
// ---------------------------------------------------------------------------
let checking = false;

/** findings -> boxes: merge nearby ones of the same kind, HIGH first, at most 12 */
function checkBoxes(findings) {
  const boxes = [];
  for (const f of findings) {
    const b0 = { x0: f.x - 2.5, x1: f.x + 2.5, y0: f.y - 2.5, y1: f.y + 2.5, z0: f.zFrom ?? 0, z1: f.zTo ?? 0 };
    const near = boxes.find((b) => b.kind === f.kind && b.level === f.level
      && b0.x0 < b.x1 + 6 && b0.x1 > b.x0 - 6 && b0.y0 < b.y1 + 6 && b0.y1 > b.y0 - 6);
    if (near) {
      near.x0 = Math.min(near.x0, b0.x0); near.x1 = Math.max(near.x1, b0.x1);
      near.y0 = Math.min(near.y0, b0.y0); near.y1 = Math.max(near.y1, b0.y1);
      near.z0 = Math.min(near.z0, b0.z0); near.z1 = Math.max(near.z1, b0.z1);
      near.n++;
    } else boxes.push({ ...b0, kind: f.kind, level: f.level, n: 1 });
  }
  return boxes.slice(0, 12).map((b) => ({
    x: [+b.x0.toFixed(1), +b.x1.toFixed(1)],
    y: [+b.y0.toFixed(1), +b.y1.toFixed(1)],
    ...(b.z1 > 0 ? { z: [+Math.max(0, b.z0 - 0.3).toFixed(1), +(b.z1 + 0.3).toFixed(1)] } : {}),
    label: `${b.level}: ${b.kind}${b.n > 1 ? ` (${b.n} spots)` : ''}`,
  }));
}

async function runCheck() {
  if (checking) { clearClaudeAreas(); return; }
  const p = state.parsed;
  if (!p) { ui.toast('Open a file first', 'info'); return; }
  let findings, seats;
  try {
    const r = checkPrint(p);
    seats = checkScrewSeats(p);
    findings = [...seats.findings, ...r.findings]      // thin screw seats first, as the CLI does
      .sort((a, b) => ({ HIGH: 0, MEDIUM: 1 })[a.level] - ({ HIGH: 0, MEDIUM: 1 })[b.level]);
  } catch (err) {
    ui.toast('Check failed: ' + err.message, 'error');
    return;
  }
  const high = findings.filter((f) => f.level === 'HIGH').length;
  const thin = seats.findings.filter((f) => f.kind === 'thin screw seat');
  const boxes = checkBoxes(findings);
  if (!boxes.length) {
    ui.toast('Check: nothing found' + (thin.length ? ` -- but ${thin.length} thin screw seat(s)` : ''), 'info');
    return;
  }
  await showClaudeAreas({ regions: boxes });
  checking = true;
  ui.setChecking(true);
  ui.toast(`Check: ${high} HIGH, ${findings.length - high} MEDIUM`
    + (thin.length ? `, ${thin.length} thin screw seat(s)` : '') + ` -- ${boxes.length} box(es)`, high ? 'error' : 'info');
}

ui.onCheck(runCheck);

ui.onPointersClear(clearClaudeAreas);
ui.onPointersFrame(() => viewer.framePointers(false, state.pointerView || 'top'));

// ---------------------------------------------------------------------------
// attaching to the live Claude
// ---------------------------------------------------------------------------
// Nothing is sent. The data (and a picture of the view) is saved under
// bridge/attached/, and a one-line reference is typed into the prompt. The
// user writes the actual message after it and presses Enter.

const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const r2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const span = (a, fmt) => (a && a.length === 2
  ? (fmt(a[0]) === fmt(a[1]) ? fmt(a[0]) : fmt(a[0]) + '–' + fmt(a[1]))
  : null);

async function saveAttachment(payload) {
  try {
    return await api.attach(payload);
  } catch (err) {
    ui.toast('Could not save the attachment: ' + err.message, 'error');
    return null;
  }
}

async function attachSelection(note) {
  const sel = state.selection;
  if (!sel) {
    ui.toast('Select something in the 3D view first (B or G, then drag).', 'warn');
    return;
  }
  const kind = sel.mode === 'area' ? 'area' : sel.mode === 'layers' ? 'layers' : 'selection';
  const saved = await saveAttachment({
    kind: kind === 'layers' ? 'selection' : kind, id: sel.id, file: sel.file, data: sel,
    png: state.selectionShot || undefined,
  });
  if (!saved) return;

  const s = sel.summary;
  const b = sel.area && sel.area.bounds;
  const xs = b ? [b.min[0], b.max[0]] : s.xRange;
  const ys = b ? [b.min[1], b.max[1]] : s.yRange;
  const where = [
    xs && 'X ' + span(xs, r1), ys && 'Y ' + span(ys, r1), 'Z ' + span(s.zRange, r2) + ' mm',
  ].filter(Boolean).join(' ');
  const parts = [
    'G-code Studio',
    kind + ' ' + sel.id,
    sel.file,
    describeSelection(sel),
    where,
    {
      area: 'everything inside the area, hidden moves included (' + state.areaOptions.match + ')',
      layers: 'whole layers',
      selection: 'visible moves only',
    }[kind],
    kind !== 'selection' && !state.areaOptions.includeAux ? 'skirt/brim/purge left out' : null,
    sel.area && sel.area.crossingNotSelected
      ? sel.area.crossingNotSelected + ' moves cross the edge: shown cut to the area, not in the selection' : null,
    note || null,
    'data ' + saved.json,
    saved.png ? 'view ' + saved.png : null,
  ].filter(Boolean);
  if (!ui.typeToClaude('[' + parts.join(' · ') + '] ')) ui.toast('The Claude terminal is not running.', 'warn');
}

async function attachMove() {
  const i = state.picked;
  const p = state.parsed;
  if (i == null || !p) {
    ui.toast('Click a move in the 3D view first.', 'warn');
    return;
  }
  const s = p.segments;
  const id = 'move-' + Date.now();
  const info = describeMove(i);
  const data = {
    id, file: state.path, index: i, line: s.line[i],
    from: [s.x0[i], s.y0[i], s.z0[i]], to: [s.x1[i], s.y1[i], s.z1[i]],
    fields: info,
  };
  let png;
  try { png = viewer.captureView({ label: 'move #' + i + ' · line ' + (s.line[i] + 1) }) || undefined; } catch { png = undefined; }
  const saved = await saveAttachment({ kind: 'move', id, file: state.path, data, png });
  if (!saved) return;
  const parts = [
    'G-code Studio',
    'move #' + i,
    state.path,
    'line ' + (s.line[i] + 1),
    'layer ' + s.layer[i],
    info.Feature || info['Move kind'],
    `X ${r1(s.x0[i])}→${r1(s.x1[i])} Y ${r1(s.y0[i])}→${r1(s.y1[i])} Z ${r2(s.z1[i])}`,
    info.Speed,
    'data ' + saved.json,
    saved.png ? 'view ' + saved.png : null,
  ].filter(Boolean);
  if (!ui.typeToClaude('[' + parts.join(' · ') + '] ')) ui.toast('The Claude terminal is not running.', 'warn');
}

// ---------------------------------------------------------------------------
// printer-screen preview
// ---------------------------------------------------------------------------

/**
 * Embed a printer-screen preview. The server renders it in ElegooSlicer's own
 * style (single blue model), which reads better on the printer than a capture
 * of the multi-coloured feature view. Dry run first, confirm, then write.
 */
async function addThumbnail() {
  if (!state.path || state.editing) return;
  const path = state.path;
  state.editing = true;
  try {
    ui.setBusy(true, 'Rendering preview');
    const plan = await api.addThumbnail(path, { dryRun: true });
    ui.setBusy(false);

    const ok = await ui.confirmEdit({
      title: 'Add printer-screen preview — writes ' + plan.outPath.split('/').pop() +
        ` (+${(plan.bytesAdded / 1024).toFixed(1)} KB). The toolpath is unchanged; the current file moves to old\\.`,
      diff: [
        { line: 1, before: null, after: ';gimage:<320x320 COLPIC preview>' },
        { line: 2, before: null, after: ';simage:<160x160 COLPIC preview>' },
        { line: 3, before: null, after: '; thumbnail begin 160x160 <PNG>' },
      ],
      validation: true,
    });
    if (!ok) {
      ui.toast('Cancelled - nothing was written.', 'info');
      return;
    }

    ui.setBusy(true, 'Writing new version');
    const res = await api.addThumbnail(path, { dryRun: false });
    ui.setBusy(false);
    ui.toast('Saved ' + res.outPath.split('/').pop() + ' - it will show a preview on the printer', 'success');
    await refreshJobs();
    state.ownWriteUntil = Date.now() + 2500;
    seenNew.add(res.outPath);
    await openFile(res.outPath, { diff: true });
  } catch (err) {
    ui.toast('Preview failed: ' + err.message, 'error');
  } finally {
    ui.setBusy(false);
    state.editing = false;
  }
}

ui.onAddThumbnail(addThumbnail);

ui.onEditRequest((req) => (req && req.lane === 'B' ? runLaneB(req) : runLaneA(req || {})));
ui.onClearSelection(() => {
  state.selection = null;
  state.selectionIndices = null;
  state.selectionShot = null;
  viewer.clearSelection();
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function refreshJobs() {
  try {
    // /api/jobs answers { archiveRoot, jobs: [...] }, not a bare array.
    const res = await api.listJobs();
    const jobs = Array.isArray(res) ? res : (res && res.jobs) || [];
    state.jobs = jobs;
    // The menu lists files, not folders: flatten each job into its current
    // G-code plus its archived versions, grouped by folder via the path.
    const files = [];
    for (const job of jobs) {
      for (const f of [...(job.gcode || []), ...(job.old || [])]) {
        files.push({
          path: f.path,
          name: f.name, // archived files already group under ".../old"
          time: f.time || '',
          archived: !!f.archived,
          mtime: f.mtime || 0,
        });
      }
    }
    ui.setJobs(files, state.path);
    return jobs;
  } catch (err) {
    ui.setStatus({ connected: false, message: 'API server not reachable' });
    return null;
  }
}

async function boot() {
  ui.startTerminal({ url: api.terminalUrl });
  const jobs = await refreshJobs();

  // Open the most recently modified current G-code so the app is useful the
  // instant it launches, rather than showing an empty bed.
  const candidates = [];
  for (const job of jobs || []) {
    for (const f of job.gcode || []) {
      if (!f.archived) candidates.push(f);
    }
  }
  candidates.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  // Reopen the file that was open before the reload, if it still exists
  // (old\ versions count too); otherwise the newest current file.
  let last = null;
  try { last = localStorage.getItem('gcs.lastFile'); } catch { /* private mode */ }
  const known = (jobs || []).some((j) => [...(j.gcode || []), ...(j.old || [])].some((f) => f.path === last));
  if (last && known) {
    await openFile(last);
  } else if (candidates.length) {
    await openFile(candidates[0].path);
  } else {
    ui.setStatus({ connected: true, message: 'no G-code files found in the Archive folder' });
  }
}

boot();

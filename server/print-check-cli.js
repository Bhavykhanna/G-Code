#!/usr/bin/env node
/**
 * print-check-cli.js -- before printing a file, list the places where the
 * nozzle is likely to touch / overheat the part, and screw holes with too
 * little plastic under the head (src/printcheck.js). Works without the app
 * server; --show needs it.
 *
 *   node gcode-studio/server/print-check-cli.js <file> [--vs <other file>] [--show] [--all] [--json]
 *
 *   <file>        G-code, Archive-relative or absolute
 *   --vs F        run the same check on F (e.g. the version before) and show both
 *   --show        draw the findings as boxes on the model in G-code Studio (HIGH first)
 *   --all         also list every group (tiny islands, low travels, spans, holes), not just findings
 *   --json        machine-readable output
 *
 * What it looks for:
 *   tiny islands            < 2 mm pieces printed between a push-out and a pull-back (heat, blobs)
 *   skimming travels        travels at layer height over plastic of the same layer
 *   spans over air          overhang / bridge runs: speed, and a fan that only bursts while spanning
 *   nozzle inside the part  any move below plastic printed on earlier layers
 *   long unlifted travel    >= 3 mm over fresh outer wall / top surface without a lift
 *   printed twice           lines laid on a line of the same layer (ironing excluded)
 *   thin screw seat         < 1.5 mm between a screw-head pocket and the top of the shaft hole
 *
 * Run it on every new or changed print file before calling it done, and
 * with --show when it finds something (..\context\preferences.md). It
 * never changes a file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGcode } from '../src/parser/parse.js';
import { checkPrint, checkScrewSeats } from '../src/printcheck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const main = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--vs');
const files = [main, opt('--vs')].filter(Boolean);
if (!main) {
  console.log('usage: node gcode-studio/server/print-check-cli.js <file> [--vs <other file>] [--show] [--all] [--json]');
  process.exit(1);
}
const resolve = (f) => {
  for (const p of [f, path.join(ARCHIVE, f)]) if (existsSync(p)) return p;
  console.error('not found: ' + f);
  process.exit(1);
};

const out = [];
for (const f of files) {
  const abs = resolve(f);
  const parse = parseGcode(readFileSync(abs, 'utf8'));
  const r = checkPrint(parse);
  const seats = checkScrewSeats(parse);
  const findings = [...seats.findings, ...r.findings];
  const rank = { HIGH: 0, MEDIUM: 1 };
  findings.sort((a, b) => rank[a.level] - rank[b.level]);
  r.summary.high += seats.findings.length;
  out.push({ file: path.relative(ARCHIVE, abs).replace(/\\/g, '/'), ...r, holes: seats.holes, findings });
}
if (flag('--json')) {
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

for (const r of out) {
  const sm = r.summary;
  console.log(`\n== ${r.file}`);
  console.log(`   ${sm.high} HIGH, ${sm.medium} MEDIUM | tiny islands ${sm.islands} | skimming travels ${sm.lowTravelMoves} | ` +
    `long unlifted ${sm.longSkims} | nozzle inside part ${sm.collisions} | printed twice ${sm.doubled} | span runs ${sm.spanRuns}`);
  const seats = r.holes.filter((h) => h.pocket);
  if (seats.length) console.log(`   screw seats: ${seats.map((h) => `${h.seat} mm at X ${h.x} Y ${h.y}`).join(', ')}`);
  if (!r.findings.length) console.log('   no findings');
  for (const f of r.findings) console.log(`   ${f.level.padEnd(6)} ${f.kind.padEnd(22)} X ${f.x} Y ${f.y}: ${f.text}`);
  if (flag('--all')) {
    const list = (title, arr, fmt) => { console.log(`   -- ${title}`); for (const g of arr) console.log('      ' + fmt(g)); };
    list('tiny islands', r.islands, (g) => `X ${g.x} Y ${g.y}: ${g.count} on layers ${g.layerFrom}-${g.layerTo} (${g.layers}), ${g.sizes.slice(0, 3).join(' ')}, fan ${g.fans.join('/')} %`);
    list('travels at layer height over fresh plastic (top 25)', r.lowTravel.slice(0, 25), (g) => `X ${g.x} Y ${g.y}: ${g.count} moves, ${g.mm} mm, layers ${g.layerFrom}-${g.layerTo} (${g.layers}), ${g.speeds.join('/')} mm/s`);
    list('spans over air', r.spans, (g) => `X ${g.x} Y ${g.y}: ${g.count} runs, ${g.mm} mm, layers ${g.layerFrom}-${g.layerTo}, ${g.speeds.join('/')} mm/s, fan ${g.fans.join('/')} % (layer ${g.layerFans.join('/')} %)`);
    list('round holes', r.holes, (h) => JSON.stringify(h));
  }
}
if (out.length === 2) {
  const [a, b] = out.map((r) => r.summary);
  console.log(`\n   ${out[0].file.split('/').pop()} vs ${out[1].file.split('/').pop()}: HIGH ${a.high} / ${b.high}, MEDIUM ${a.medium} / ${b.medium}, ` +
    `tiny islands ${a.islands} / ${b.islands}, long unlifted ${a.longSkims} / ${b.longSkims}, nozzle inside ${a.collisions} / ${b.collisions}`);
}

if (flag('--show')) {
  // merge nearby findings of the same kind into one box, HIGH first, at most 12 boxes
  const boxes = [];
  for (const f of out[0].findings) {
    const b0 = { x0: f.x - 2.5, x1: f.x + 2.5, y0: f.y - 2.5, y1: f.y + 2.5, z0: f.zFrom ?? 0, z1: f.zTo ?? 0 };
    const near = boxes.find((b) => b.kind === f.kind && b.level === f.level &&
      b0.x0 < b.x1 + 6 && b0.x1 > b.x0 - 6 && b0.y0 < b.y1 + 6 && b0.y1 > b.y0 - 6);
    if (near) {
      near.x0 = Math.min(near.x0, b0.x0); near.x1 = Math.max(near.x1, b0.x1);
      near.y0 = Math.min(near.y0, b0.y0); near.y1 = Math.max(near.y1, b0.y1);
      near.z0 = Math.min(near.z0, b0.z0); near.z1 = Math.max(near.z1, b0.z1);
      near.n++;
    } else boxes.push({ ...b0, kind: f.kind, level: f.level, n: 1 });
  }
  const show = boxes.slice(0, 12);
  const cli = path.join(here, 'app-cli.js');
  const a = ['show', out[0].file];
  const r2 = (v) => v.toFixed(1);
  for (const b of show) {
    a.push('--x', `${r2(b.x0)}:${r2(b.x1)}`, '--y', `${r2(b.y0)}:${r2(b.y1)}`);
    if (b.z1 > 0) a.push('--z', `${r2(Math.max(0, b.z0 - 0.3))}:${r2(b.z1 + 0.3)}`);
    a.push('--label', `${b.level}: ${b.kind}${b.n > 1 ? ` (${b.n} spots)` : ''}`);
  }
  if (!show.length) { console.log('\n   nothing to show'); process.exit(0); }
  const res = spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8' });
  console.log('\n   ' + (res.stdout || res.stderr).trim() + (boxes.length > show.length ? ` (first ${show.length} of ${boxes.length} boxes)` : ''));
}

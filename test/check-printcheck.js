/**
 * printcheck.js -- places where the nozzle can touch / overheat the part, and thin screw seats.
 *   node test/check-printcheck.js
 *
 * Synthetic cases:
 *   - a tiny island with its own pull-back / push-out, crossed at layer height -> HIGH
 *   - the same file with lifted travels -> less skimming
 *   - a 5 mm loop is not a tiny island
 *   - an overhang run at 100 mm/s with a fan burst over a 15 % layer -> HIGH span; a slow one at the layer fan -> nothing
 *   - a layer printed below the one before -> "nozzle inside the part"
 *   - the same line printed twice on one layer -> "printed twice"
 * Real files (only when test/fixtures.local.js points at them): screw seats of a base (2.0 mm ok,
 * 1.0 mm flagged), a lid (no pockets), and a printed part whose bars and opening tops are found.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseGcode } from '../src/parser/parse.js';
import { checkPrint, checkScrewSeats } from '../src/printcheck.js';
import { fx, arc } from './fixtures.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(62) + detail);
};
const NL = String.fromCharCode(10);

/** a 20 mm square wall per layer, then a 0.6 mm island, then a travel back across the square, then a 0.5 mm dot */
function file({ lift, islandSize = 0.6 }) {
  const L = ['M83', 'M106 S38', ';LAYER:1', ';Z:0.2', ';TYPE:Outer wall', ';WIDTH:0.45', ';HEIGHT:0.2',
    'G1 X0 Y0 Z0.2 F6000', 'G1 E0.5 F3600',
    'G1 X20 Y0 E1 F3000', 'G1 X20 Y20 E1', 'G1 X0 Y20 E1', 'G1 X0 Y0 E1',
    'G1 E-0.6 F3600'];
  for (const layer of [2, 3, 4]) {
    const z = (0.2 * layer).toFixed(2);
    L.push(`;LAYER:${layer}`, `;Z:${z}`, ';TYPE:Outer wall', ';WIDTH:0.45', ';HEIGHT:0.2',
      `G1 X0 Y0 Z${z} F6000`, 'G1 E0.6 F3600',
      'G1 X20 Y0 E1 F3000', 'G1 X20 Y20 E1', 'G1 X0 Y20 E1', 'G1 X0 Y0 E1',
      'G1 E-0.6 F3600',
      'G1 X30 Y10 F18000', 'G1 E0.6 F3600',
      `G1 X${30 + islandSize} Y10 E0.05 F3000`, `G1 X${30 + islandSize} Y${10 + islandSize} E0.05`, `G1 X30 Y${10 + islandSize} E0.05`,
      'G1 E-0.6 F3600');
    if (lift) L.push(`G1 Z${(0.2 * layer + 0.4).toFixed(2)}`, 'G1 X10 Y10 F18000', `G1 Z${z}`);
    else L.push('G1 X10 Y10 F18000');
    L.push('G1 E0.6 F3600', 'G1 X10.5 Y10 E0.02 F3000', 'G1 E-0.6 F3600');
  }
  return parseGcode(L.join(NL));
}

console.log('\n=== printcheck: synthetic ===');
{
  const r = checkPrint(file({ lift: false }));
  ok('tiny island found on 3 layers', r.islands.length >= 1 && r.islands.some((g) => g.layers === 3), JSON.stringify(r.summary));
  ok('travel across the fresh square found', r.lowTravel.length >= 1 && r.summary.lowTravelMm > 5);
  const hi = r.findings.filter((f) => f.level === 'HIGH' && f.kind === 'tiny islands');
  ok('island + skimming travel in one cell -> HIGH', hi.length >= 1, hi.map((f) => f.text).join(' | '));
  ok('no collisions in a normal file', r.summary.collisions === 0);

  const r2 = checkPrint(file({ lift: true }));
  ok('lifted travels (3 of them) no longer skim', r2.summary.lowTravelMm <= r.summary.lowTravelMm - 2.5,
    `${r2.summary.lowTravelMm} vs ${r.summary.lowTravelMm}`);

  const r3 = checkPrint(file({ lift: false, islandSize: 5 }));
  ok('a 5 mm loop is not a tiny island (only the 0.5 mm dot is)',
    r3.islands.every((g) => g.sizes.every((z) => !z.startsWith('5.0'))), JSON.stringify(r3.islands.map((g) => g.sizes)));
}
{
  const span = (fanOn, speed) => parseGcode(['M83', 'M106 S38', ';LAYER:1', ';Z:0.2',
    ';TYPE:Outer wall', ';WIDTH:0.45', ';HEIGHT:0.2', 'G1 X0 Y0 Z0.2 F6000', 'G1 X30 Y0 E1.5 F3000',
    ';TYPE:Overhang wall', `M106 S${fanOn}`, `G1 X36 Y0 E0.3 F${speed * 60}`, 'M106 S38',
    ';TYPE:Outer wall', 'G1 X60 Y0 E1.2 F3000'].join(NL));
  const a = checkPrint(span(178, 100));
  const f = a.findings.find((x) => x.kind === 'spans over air');
  ok('fast span with a short fan burst -> HIGH', f && f.level === 'HIGH', f && f.text);
  const b = checkPrint(span(38, 20));
  ok('slow span at the layer fan -> no finding', !b.findings.some((x) => x.kind === 'spans over air'));
}
{
  // a layer printed LOWER than the one before it: the nozzle goes through the part
  const f = parseGcode(['M83', ';LAYER:1', ';Z:0.4', ';TYPE:Outer wall', ';WIDTH:0.45', ';HEIGHT:0.2',
    'G1 X0 Y0 Z0.4 F6000', 'G1 X10 Y0 E0.5 F3000', ';LAYER:2', ';Z:0.2', 'G1 X0 Y0 Z0.2 F6000', 'G1 X10 Y0 E0.5 F3000'].join(NL));
  const r = checkPrint(f);
  ok('nozzle below earlier plastic -> HIGH', r.findings.some((x) => x.kind === 'nozzle inside the part' && x.level === 'HIGH'),
    JSON.stringify(r.summary));
  // the same line printed twice, 6 times on one layer
  const lines = ['M83', ';LAYER:1', ';Z:0.2', ';TYPE:Outer wall', ';WIDTH:0.45', ';HEIGHT:0.2', 'G1 X0 Y0 Z0.2 F6000'];
  for (let k = 0; k < 6; k++) {
    const y = k * 3;
    lines.push(`G1 X0 Y${y} F6000`, `G1 X10 Y${y} E0.5 F3000`, `G1 X0 Y${y} F6000`, `G1 X10 Y${y} E0.5 F3000`);
  }
  const rd = checkPrint(parseGcode(lines.join(NL)));
  ok('a line printed twice is found', rd.summary.doubled >= 5, JSON.stringify(rd.summary));
}

console.log('\n=== screw seats ===');
{
  const base = fx ? arc(fx.jobRel) : null;
  const cases = fx ? fx.screwSeats.map(([f, want, name]) => [base + f, want, name]) : [];
  if (!cases.length) console.log('  skip  no test/fixtures.local.js');
  for (const [f, want, name] of cases) {
    if (!existsSync(f)) { console.log('  skip  ' + f); continue; }
    const r = checkScrewSeats(parseGcode(readFileSync(f, 'utf8')));
    ok(name, r.findings.length === want && r.holes.length === 4, JSON.stringify(r.holes.map((h) => h.seat ?? '-')));
  }
}

console.log('\n=== printcheck: a printed part with known findings ===');
{
  const f = fx ? arc(fx.jobRel + fx.printed) : null;
  if (!f || !existsSync(f)) console.log('  skip  no test/fixtures.local.js');
  else {
    const t0 = Date.now();
    const r = checkPrint(parseGcode(readFileSync(f, 'utf8')));
    const ms = Date.now() - t0;
    const bars = r.findings.filter((x) => x.kind === 'tiny islands' && x.x > 189.9 && x.x < 191.1 && x.y > 196 && x.y < 230);
    const tops = r.findings.filter((x) => x.kind === 'spans over air' && x.x > 189.9 && x.x < 191.1 && x.level === 'HIGH');
    ok('divider bars flagged (tiny islands, HIGH)', bars.length >= 5 && bars.every((x) => x.level === 'HIGH'), `${bars.length}`);
    ok('opening tops flagged (fast span, fan burst)', tops.length >= 5, `${tops.length}`);
    ok('no collisions, runs in reasonable time', r.summary.collisions === 0 && ms < 20000, `${ms} ms`);
  }
}

console.log(fails ? `\n  ${fails} CHECK(S) FAILED\n` : '\n  all checks passed\n');
process.exit(fails ? 1 : 0);

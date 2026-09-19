/**
 * compare.js -- what changed between two toolpaths, as plastic per layer.
 *   node test/check-compare.js
 *
 * What it proves (docs/CONTEXT-compare.md has the rules):
 *   - identical files: nothing added or removed
 *   - a moved wall: added in the new file, removed in the old one
 *   - a 0.05 mm shift (slicer rounding) is not a change
 *   - a wall standing where the old file only had floor is a change
 *   - a moved ring crossing the old ring is a change along its whole length
 *     (direction is what separates them) -- the screw-hole case
 *   - a floor re-laid at another angle is NOT a change
 *   - sparse infill is neutral
 *   - the same XY on another layer is a change
 *   - a real pair: the moved screw holes are added, the untouched
 *     right half is unchanged, and it runs fast enough
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { parseGcode, KIND } from '../src/parser/parse.js';
import { compareToolpaths, rankBases, CLASS } from '../src/compare.js';
import { fx, arc } from './fixtures.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name.padEnd(62) + detail);
};
const NL = String.fromCharCode(10);

/** A one-layer file: blocks of [feature, moves...]. */
function file(z, ...blocks) {
  const lines = ['M83', ';LAYER:1', ';Z:' + z];
  for (const [feature, ...moves] of blocks) {
    lines.push(';TYPE:' + feature, ';WIDTH:0.45', ';HEIGHT:0.2', ...moves);
  }
  return parseGcode(lines.join(NL));
}
const classesOf = (p, cls) => {
  const out = [];
  for (let i = 0; i < p.count; i++) if (p.segments.kind[i] === KIND.EXTRUDE) out.push(cls[i]);
  return out;
};
/** A polygon approximating a circle, as extruding G1 moves. */
function ring(cx, cy, r, n = 36) {
  const m = [`G1 X${(cx + r).toFixed(3)} Y${cy.toFixed(3)} Z0.2 F3000`];
  for (let k = 1; k <= n; k++) {
    const a = (k / n) * 2 * Math.PI;
    m.push(`G1 X${(cx + r * Math.cos(a)).toFixed(3)} Y${(cy + r * Math.sin(a)).toFixed(3)} E0.1`);
  }
  return m;
}

console.log('\n=== synthetic ===');
{
  const wallA = file(0.2, ['Outer wall', 'G1 X10 Y10 Z0.2 F3000', 'G1 X50 Y10 E1', 'G1 X50 Y50 E1']);
  const same = compareToolpaths(wallA, wallA);
  ok('a file against itself: nothing added or removed',
    same.stats.addedMoves === 0 && same.stats.removedMoves === 0, JSON.stringify(same.stats));

  const moved = file(0.2, ['Outer wall', 'G1 X10 Y10 Z0.2 F3000', 'G1 X50 Y10 E1', 'G1 X60 Y10', 'G1 X60 Y50 E1']);
  const r = compareToolpaths(moved, wallA);
  ok('a wall moved 10 mm: added in the new file', classesOf(moved, r.curClass).join() === '0,1', classesOf(moved, r.curClass).join());
  ok('... and removed in the old one', classesOf(wallA, r.oldClass).join() === '0,2', classesOf(wallA, r.oldClass).join());
  ok('travels are not classified', r.curClass[0] === CLASS.NEUTRAL);

  const nudged = file(0.2, ['Outer wall', 'G1 X10.05 Y10.05 Z0.2 F3000', 'G1 X50.05 Y10.05 E1', 'G1 X50.05 Y50.05 E1']);
  ok('a 0.05 mm shift is not a change', compareToolpaths(nudged, wallA).stats.addedMoves === 0);

  const floor = file(0.2, ['Bottom surface', 'G1 X10 Y10 Z0.2 F3000', 'G1 X50 Y10 E1']);
  const wallOnFloor = file(0.2, ['Outer wall', 'G1 X10 Y10 Z0.2 F3000', 'G1 X50 Y10 E1']);
  ok('a wall where the old file had only floor is a change',
    classesOf(wallOnFloor, compareToolpaths(wallOnFloor, floor).curClass).join() === '1');

  // the screw-hole case: the ring moves 4.2 mm and crosses the old ring
  const oldHole = file(0.2, ['Inner wall', ...ring(100, 100, 3)]);
  const newHole = file(0.2, ['Inner wall', ...ring(95.8, 100, 3)]);
  const h = compareToolpaths(newHole, oldHole);
  const hc = classesOf(newHole, h.curClass);
  ok('a ring moved 4.2 mm (crossing the old one): every chord added',
    hc.every((c) => c === CLASS.ADDED), `${hc.filter((c) => c === CLASS.ADDED).length} of ${hc.length}`);
  const sameHole = compareToolpaths(oldHole, oldHole);
  ok('... while the unmoved ring is unchanged', sameHole.stats.addedMoves === 0);

  // a floor re-laid at another angle over the same area
  const lines = (dirX) => {
    const m = ['G1 X10 Y10 Z0.2 F3000'];
    for (let k = 0; k <= 40; k++) {
      const v = 10 + k * 0.45;
      m.push(dirX ? `G1 X10 Y${v.toFixed(2)}` : `G1 X${v.toFixed(2)} Y10`);
      m.push(dirX ? `G1 X28 Y${v.toFixed(2)} E0.5` : `G1 X${v.toFixed(2)} Y28 E0.5`);
    }
    return m;
  };
  const floorX = file(0.2, ['Bottom surface', ...lines(true)]);
  const floorY = file(0.2, ['Bottom surface', ...lines(false)]);
  const fl = compareToolpaths(floorY, floorX);
  ok('a floor re-laid at 90 deg over the same area is not a change', fl.stats.addedMoves === 0, JSON.stringify(fl.stats.addedMoves));

  const sparse = file(0.2, ['Sparse infill', 'G1 X10 Y10 Z0.2 F3000', 'G1 X50 Y30 E1']);
  ok('sparse infill is neutral', classesOf(sparse, compareToolpaths(sparse, wallA).curClass).join() === '255');

  const higher = file(0.4, ['Outer wall', 'G1 X10 Y10 Z0.4 F3000', 'G1 X50 Y10 E1', 'G1 X50 Y50 E1']);
  ok('the same XY on another layer is a change', compareToolpaths(higher, wallA).stats.addedMoves === 2);
}

console.log('\n=== rankBases ===');
{
  const r = rankBases('job/v2/EN4Max_0.4_WidgetBase_HSPLA+_0.20_v2-draft.gcode', [
    'job/v2/EN4Max_0.4_WidgetLid_HSPLA+_0.20_v2-draft.gcode',
    'job/v1/widget-lid-mesh-fast.gcode',
    'job/v1/widget-base-mesh-fast.gcode',
    'other-job/EN4Max_0.4_OtherModel_HSPLA+_0.20_v2-thumbnail_49m.gcode',
  ]);
  ok('base v1 ranks first', r[0].path.endsWith('widget-base-mesh-fast.gcode'), r.map((x) => x.score + ' ' + x.path.split('/').pop()).join(' | '));
  const v = rankBases('j/EN4Max_0.4_WidgetBase_HSPLA+_0.20_v3-brim_45m.gcode', [
    'j/old/EN4Max_0.4_WidgetBase_HSPLA+_0.20_v2-wire-gap_44m.gcode',
    'j/EN4Max_0.4_WidgetLid_HSPLA+_0.20_v3-brim_32m.gcode',
    'x/widget-base-mesh-fast.gcode']);
  ok('the previous version of the same model ranks first', v[0].path.includes('v2-wire-gap'), v.map((x) => x.score).join(','));
}

console.log('\n=== real pair: a draft vs the version before it ===');
{
  // the draft before the second change: only one side moved, so the other half is untouched
  // (the final has the later change and is centred -- BUGS B12)
  const dir = fx ? arc(fx.jobRel) : null;
  const pick = dir && existsSync(dir + fx.beforeChange) ? fx.beforeChange : null;
  const B = fx ? arc(fx.v1BaseRel) : null;
  if (!pick || !existsSync(B)) console.log('  skip  no test/fixtures.local.js');
  else {
    const cur = parseGcode(readFileSync(dir + pick, 'utf8'));
    const old = parseGcode(readFileSync(B, 'utf8'));
    const r = compareToolpaths(cur, old);
    console.log('  ' + JSON.stringify(r.stats));
    ok('runs in under 3 s', r.stats.ms < 3000, r.stats.ms + ' ms');

    // Walls by region. The draft moved everything left of X 193 by 4.2 mm.
    const s = cur.segments;
    const tally = (pred) => {
      let added = 0, same = 0;
      for (let i = 0; i < cur.count; i++) {
        if (s.kind[i] !== KIND.EXTRUDE || s.feature[i] < 1 || s.feature[i] > 3 || !pred(i)) continue;
        if (r.curClass[i] === CLASS.ADDED) added++; else if (r.curClass[i] === CLASS.SAME) same++;
      }
      return { added, same, share: added / Math.max(1, added + same) };
    };
    const mid = (i) => [(s.x0[i] + s.x1[i]) / 2, (s.y0[i] + s.y1[i]) / 2];
    // the screw-hole rings: short wall chords inside the left end, below layer 22
    const holes = tally((i) => { const [x, y] = mid(i); return x > 152 && x < 165 && y > 188 && y < 238 && s.layer[i] < 22 && Math.hypot(s.x1[i] - s.x0[i], s.y1[i] - s.y0[i]) < 1.5; });
    ok('moved screw-hole rings are added (>= 90 %)', holes.share >= 0.9, JSON.stringify(holes));
    const right = tally((i) => mid(i)[0] > 200);
    ok('walls of the untouched right half are unchanged (>= 95 %)', right.share <= 0.05, JSON.stringify(right));
  }
}

console.log(fails ? `\n  ${fails} CHECK(S) FAILED` : '\n  all checks passed');
process.exit(fails ? 1 : 0);

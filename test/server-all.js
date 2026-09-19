/**
 * server-all.js -- run every server-* test in turn.
 *
 *   node test/server-all.js
 *
 * Sequentially, not in parallel: each one binds the same test port and
 * server-slice.js launches the real slicer.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS = ['server-smoke.js', 'server-edit.js', 'server-diff.js', 'server-chat.js', 'server-terminal.js', 'server-slice.js'];

let failed = 0;
for (const t of TESTS) {
  console.log('\n' + '#'.repeat(70));
  console.log('# ' + t);
  console.log('#'.repeat(70));
  const code = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, t)], { stdio: 'inherit' });
    c.on('close', resolve);
  });
  if (code !== 0) { failed++; console.log(`\n!! ${t} exited ${code}`); }
}

console.log('\n' + '='.repeat(70));
console.log(failed ? `${failed} of ${TESTS.length} test files FAILED` : `all ${TESTS.length} test files passed`);
process.exit(failed ? 1 : 0);

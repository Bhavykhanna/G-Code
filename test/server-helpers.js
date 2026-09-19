/**
 * server-helpers.js -- shared assertions and HTTP helpers for the server-* tests.
 * Deliberately tiny: no framework, exit code 1 on the first failure summary.
 *
 * Every /api call needs the server's token (BUGS B9); the helpers send it.
 * GCS_TOKEN_FILE is pointed at the temp dir so a test run never overwrites
 * the live app's gcode-studio\.gcs-token. start() reads it lazily, after
 * every import has run, so setting it here is early enough.
 */
import os from 'node:os';
import path from 'node:path';
import { getToken } from '../server/index.js';

export const PORT = Number(process.env.GCS_TEST_PORT || 5199);
export const BASE = `http://127.0.0.1:${PORT}`;

if (!process.env.GCS_TOKEN_FILE) {
  process.env.GCS_TOKEN_FILE = path.join(os.tmpdir(), `gcs-test-token-${process.pid}`);
}

/** Headers carrying the token, merged over `extra`. */
export function auth(extra = {}) {
  return { ...extra, 'X-GCS-Token': getToken() };
}

let passed = 0;
const failures = [];

export function ok(cond, what) {
  if (cond) { passed++; console.log('  PASS  ' + what); }
  else { failures.push(what); console.log('  FAIL  ' + what); }
}

export function eq(actual, expected, what) {
  ok(Object.is(actual, expected), `${what}: ${JSON.stringify(actual)}` + (Object.is(actual, expected) ? '' : ` (expected ${JSON.stringify(expected)})`));
}

export function section(title) {
  console.log('\n--- ' + title + ' ' + '-'.repeat(Math.max(0, 62 - title.length)));
}

export function row(k, v) {
  console.log('        ' + String(k).padEnd(22) + v);
}

export async function run(fn) {
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    failures.push('threw: ' + e.message);
    console.error('\nUNCAUGHT: ' + (e.stack || e.message));
  }
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${passed} passed, ${failures.length} failed, ${Date.now() - t0} ms`);
  if (failures.length) {
    for (const f of failures) console.log('  FAILED: ' + f);
    process.exitCode = 1;
  }
  try { (await import('node:fs')).rmSync(process.env.GCS_TOKEN_FILE, { force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}

export async function get(path) {
  const r = await fetch(BASE + path, { headers: auth() });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`GET ${path} -> ${r.status}: ${t.slice(0, 300)}`); }
}

export async function getText(path) {
  const r = await fetch(BASE + path, { headers: auth() });
  return r.text();
}

export async function code(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: auth(init.headers) });
  return r.status;
}

export async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let json;
  try { json = JSON.parse(t); } catch { throw new Error(`POST ${path} -> ${r.status}: ${t.slice(0, 300)}`); }
  json.__status = r.status;
  return json;
}

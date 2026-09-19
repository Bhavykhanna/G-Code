/**
 * _isolate.js -- imported FIRST by every server-* test.
 *
 * The server modules read their bridge folder when they are imported, so this
 * has to run before them. Without it the tests append to the live app's
 * bridge\chat.jsonl and selection.json, and the running app reacts to every
 * one of those writes (toasts, reloads) -- which looked like the app hanging.
 */
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

if (!process.env.GCS_BRIDGE_DIR) {
  const dir = path.join(os.tmpdir(), `gcs-test-bridge-${process.pid}`);
  process.env.GCS_BRIDGE_DIR = dir;
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
}
if (!process.env.GCS_TOKEN_FILE) {
  process.env.GCS_TOKEN_FILE = path.join(os.tmpdir(), `gcs-test-token-${process.pid}`);
}

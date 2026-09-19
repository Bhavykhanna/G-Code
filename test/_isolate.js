/**
 * _isolate.js -- imported FIRST by every server-* test.
 *
 * The server modules read their bridge folder when they are imported, so this
 * has to run before them. Without it the tests append to the live app's
 * bridge\chat.jsonl and selection.json, and the running app reacts to every
 * one of those writes (toasts, reloads) -- which looked like the app hanging.
 */
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Next to the app, not in the OS temp folder. `/api/bridge/attach` answers with
// Archive-RELATIVE paths, and there is no relative path from D:\ to C:\ -- with
// the scratch in TEMP those answers came back absolute and three attach checks
// failed for a reason that had nothing to do with the code. Same drive, always.
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

if (!process.env.GCS_BRIDGE_DIR) {
  const dir = path.join(PROJECT_ROOT, `.test-bridge-${process.pid}`);
  process.env.GCS_BRIDGE_DIR = dir;
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
}
if (!process.env.GCS_TOKEN_FILE) {
  const tok = path.join(PROJECT_ROOT, `.test-token-${process.pid}`);
  process.env.GCS_TOKEN_FILE = tok;
  process.on('exit', () => { try { rmSync(tok, { force: true }); } catch { /* ignore */ } });
}

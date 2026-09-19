// Real 3D screenshots of the running app (headless Edge + SwiftShader WebGL, via CDP).
//   node scripts/screenshot.mjs "v,z"     keys to press, one screenshot after each
//   node scripts/screenshot.mjs '["click:.legend__toggle", "js:document.title", "key:v"]'
//     steps: key:<k> | click:<css> | js:<expression> | size:<w>x<h> | drag<dy> ; a bare word is a key
// PNGs land in scripts/shots/. The Claude terminal socket is blocked so this copy
// never resizes the user's terminal. Needs the app server on 5174.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
mkdirSync(OUT, { recursive: true });
const arg = process.argv[2] || 'v';
const steps = arg.startsWith('[') ? JSON.parse(arg) : arg.split(',');
const prof = mkdtempSync(path.join(os.tmpdir(), 'gcs-shot-'));
const port = 9333;
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0; const pend = new Map();
ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled') console.log('console:', d.params.args.map((a) => a.value ?? a.description).join(' ')); else if (d.method === 'Runtime.exceptionThrown') console.log('EXC:', d.params.exceptionDetails.exception?.description); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  const W = window.WebSocket;
  window.WebSocket = function (u, p) { if (String(u).includes('term')) throw new Error('blocked for screenshot'); return new W(u, p); };
  window.WebSocket.prototype = W.prototype;
` });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5174/' });
await sleep(9000);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  console.log('saved', name);
};
await shot('0-start');
// click the viewport centre-ish so keys go to the page, not a text field
let n = 0;
for (const s of steps) {
  if (s.startsWith('drag')) {
    const dy = Number(s.slice(4));
    const x = 800, y = 450;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 20; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y + dy * k / 20, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y + dy, button: 'left', buttons: 0, clickCount: 1 });
  } else if (s.startsWith('click:')) {
    const r = await send('Runtime.evaluate', { expression: `(() => { const e = document.querySelector(${JSON.stringify(s.slice(6))}); if (!e) return 'not found'; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`, returnByValue: true });
    const v = r.result.result.value;
    if (!Array.isArray(v)) console.log(s, '->', v);
    else {
      const [x, y] = v;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    }
  } else if (s.startsWith('size:')) {
    const [w, hh] = s.slice(5).split('x').map(Number);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: 1, mobile: false });
  } else if (s.startsWith('js:')) {
    const r = await send('Runtime.evaluate', { expression: s.slice(3), returnByValue: true, awaitPromise: true });
    console.log('js ->', JSON.stringify(r.result.result.value ?? r.result.exceptionDetails?.exception?.description));
  } else {
    const k = s.startsWith('key:') ? s.slice(4) : s;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
  }
  await sleep(s.startsWith('js:') ? 300 : 1500);
  n++;
  await shot(`step-${String(n).padStart(2, '0')}`);
}
ws.close();
edge.kill();
process.exit(0);

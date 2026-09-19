/**
 * server-chat.js -- the file-backed chat mailbox.
 *
 *   node test/server-chat.js
 *
 * The hard part of this transport is not the HTTP; it is that Claude appends to
 * bridge\chat.jsonl from a terminal while the server appends to the same file.
 * So this test:
 *   - hammers the file from 6 separate OS processes AND the server at once and
 *     checks that not one line is lost or interleaved
 *   - appends a reply externally (via server/chat-cli.js, server not involved)
 *     and checks it arrives on the /api/watch SSE stream
 *   - checks the CLI works with the server down
 *   - checks a truncated / malformed line does not break any endpoint
 *
 * The real bridge\chat.jsonl is moved aside for the run and restored after.
 */
import './_isolate.js'; // must be first: keeps the tests out of the live bridge\ folder
import { readFile, writeFile, rename, rm, access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { start, stop } from '../server/index.js';
import { CHAT_FILE, BRIDGE_DIR } from '../server/api/bridge.js';
import { PROJECT_ROOT } from '../server/api/files.js';
import { ok, eq, section, row, run, get, post, PORT, auth } from './server-helpers.js';

const run_ = promisify(execFile);
const CLI = path.join(PROJECT_ROOT, 'server', 'chat-cli.js');
const BACKUP = CHAT_FILE + '.testbackup';
const cli = (...args) => run_(process.execPath, [CLI, ...args], { cwd: PROJECT_ROOT });

await run(async () => {
  await mkdir(BRIDGE_DIR, { recursive: true });
  const hadFile = await access(CHAT_FILE).then(() => true, () => false);
  if (hadFile) await rename(CHAT_FILE, BACKUP);

  try {
    section('CLI with the server down');
    let out = await cli('pending');
    ok(/no pending messages/.test(out.stdout), 'pending on an empty transcript');
    out = await cli('reply', 'hello from the terminal');
    ok(/^appended msg-/.test(out.stdout), 'reply appends: ' + out.stdout.trim());
    out = await cli('log', '5');
    ok(/CLAUDE/.test(out.stdout), 'log shows the message');
    out = await cli('stats');
    eq(JSON.parse(out.stdout).messages, 1, 'stats counts one message');

    section('server up');
    await start(PORT, '127.0.0.1');
    const chat0 = await get('/api/bridge/chat');
    eq(chat0.total, 1, 'the server sees the CLI-written message');

    section('concurrent appends: 6 CLI processes x 10 + 30 from the server');
    const t0 = Date.now();
    const procs = [];
    for (let w = 0; w < 6; w++) {
      procs.push((async () => {
        for (let i = 0; i < 10; i++) await cli('reply', `worker ${w} message ${i}`);
      })());
    }
    const server = (async () => {
      for (let i = 0; i < 30; i++) await post('/api/bridge/chat', { text: `server message ${i}` });
    })();
    await Promise.all([...procs, server]);
    row('elapsed', (Date.now() - t0) + ' ms');

    const raw = await readFile(CHAT_FILE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    let parsed = 0, broken = 0;
    const ids = new Set();
    for (const l of lines) {
      try { const o = JSON.parse(l); parsed++; ids.add(o.id); } catch { broken++; }
    }
    row('lines on disk', lines.length);
    row('parsed / broken', `${parsed} / ${broken}`);
    row('distinct ids', ids.size);
    eq(lines.length, 91, '1 + 60 + 30 lines, nothing lost');
    eq(broken, 0, 'no line was torn by a concurrent writer');
    eq(ids.size, 91, 'every message got a distinct id');
    eq((await get('/api/bridge/chat?limit=1000')).total, 91, 'the API agrees');

    section('pending / answered derivation');
    const u = await post('/api/bridge/chat', { text: 'please slow layer 20' });
    let pend = await get('/api/bridge/chat/pending');
    ok(pend.pending.some((m) => m.id === u.message.id), 'the new user message is pending');
      // The 60 CLI replies had no --to, so each attached itself to whatever user
    // message was newest-pending at the time. That is the documented default,
    // and it means the 30 server messages are already answered by now.
    eq(pend.count, 1, 'only the brand new message is still pending');
    await cli('reply', 'on it', '--to', u.message.id);
    pend = await get('/api/bridge/chat/pending');
    ok(!pend.pending.some((m) => m.id === u.message.id), 'a CLI reply marks it answered, with no rewrite of the file');
    const rawAfter = await readFile(CHAT_FILE, 'utf8');
    ok(rawAfter.startsWith(raw.slice(0, 200)), 'the file was only appended to, never rewritten');

    section('an EXTERNAL append reaches the SSE stream');
    const events = await collectSse(3000, async () => {
      await cli('reply', 'external reply written straight to the jsonl');
    });
    const chatEvents = events.filter((e) => e.event === 'chat');
    row('events seen', events.map((e) => e.event).join(', '));
    ok(chatEvents.length > 0, 'fs.watch picked up the external append and pushed event: chat');
    ok(chatEvents.some((e) => /external reply written/.test(e.data)), 'and the payload carries the message');

    section('malformed input');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(CHAT_FILE, '{"id":"torn","role":"user","text":"half a lin', 'utf8');
    const afterTear = await get('/api/bridge/chat?limit=1000');
    ok(afterTear.skipped >= 1, `${afterTear.skipped} unparseable line(s) skipped, endpoint still answers`);
    ok((await get('/api/bridge/chat/pending')).count >= 0, '/pending still answers');
    ok((await cli('stats')).stdout.length > 0, 'the CLI still answers');
    await appendFile(CHAT_FILE, 'e"}\n', 'utf8'); // complete the torn line
    ok((await get('/api/bridge/chat?limit=1000')).skipped === 0, 'once the writer finishes the line, it parses');

    section('input validation');
    eq((await post('/api/bridge/chat', { text: '' })).__status, 400, 'empty text -> 400');
    eq((await post('/api/bridge/chat', { text: '   ' })).__status, 400, 'whitespace text -> 400');
    eq((await post('/api/bridge/chat', { text: 'x'.repeat(40000) })).__status, 413, '40 KB text -> 413');
    ok((await post('/api/bridge/chat', { text: 'x'.repeat(30000) })).ok, '30 KB text is accepted');

    await stop();
  } finally {
    await rm(CHAT_FILE, { force: true });
    if (hadFile) await rename(BACKUP, CHAT_FILE);
  }
});

async function collectSse(ms, trigger) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/watch`, { signal: ctrl.signal, headers: auth() });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (.+)/.exec(block);
          const da = /data: (.*)/.exec(block);
          if (ev) events.push({ event: ev[1].trim(), data: da ? da[1] : null });
        }
      }
    } catch { /* aborted */ }
  })();
  await new Promise((r) => setTimeout(r, 250));
  await trigger();
  await new Promise((r) => setTimeout(r, ms));
  ctrl.abort();
  await pump;
  return events;
}

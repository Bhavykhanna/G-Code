#!/usr/bin/env node
/**
 * chat-cli.js -- the terminal end of the in-app chat.
 *
 * The UI appends user messages to bridge\chat.jsonl. This reads them and
 * appends replies, using the SAME append discipline as the server (bridge.js),
 * so it works whether or not the HTTP server is running -- and works correctly
 * if it is running and appending at the same time.
 *
 *   node server/chat-cli.js pending            unanswered user messages
 *   node server/chat-cli.js pending --json     the same, as JSON
 *   node server/chat-cli.js reply "text"       append a Claude reply
 *   node server/chat-cli.js reply "text" --to msg-...   reply to a specific message
 *   node server/chat-cli.js log [n]            the last n messages (default 20)
 *   node server/chat-cli.js watch              print new messages as they arrive
 */
import { readChat, postChatReply, getChatPending, chatStats, CHAT_FILE, bridgeEvents, startBridgeWatch } from './api/bridge.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : null;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));

const WRAP = 96;

function wrap(text, indent = '    ') {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.length) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line.length + word.length + 1 > WRAP) { out.push(indent + line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    if (line) out.push(indent + line);
  }
  return out.join('\n');
}

function printMessage(m) {
  const who = m.role === 'user' ? 'USER  ' : 'CLAUDE';
  const mark = m.role === 'user' ? (m.status === 'answered' ? ' [answered]' : ' [PENDING]') : (m.replyTo ? ` [-> ${m.replyTo}]` : '');
  console.log(`\n${who}  ${m.ts}  ${m.id}${mark}`);
  if (m.selectionId) console.log(`    selection: ${m.selectionId}`);
  console.log(wrap(m.text));
  if (Array.isArray(m.actions) && m.actions.length) {
    console.log('    actions:');
    for (const a of m.actions) console.log(`      - [${a.kind}] ${a.label}${a.detail ? ' -- ' + a.detail : ''}`);
  }
}

function printSelection(sel) {
  if (!sel) return;
  const s = sel.summary || {};
  console.log(`    -- selection ${sel.id} --`);
  if (sel.file) console.log(`       file       ${sel.file}`);
  if (s.count != null) console.log(`       moves      ${s.count}`);
  if (s.layers) console.log(`       layers     ${s.layers[0]}-${s.layers[1]}`);
  if (s.zRange) console.log(`       z          ${s.zRange[0]} - ${s.zRange[1]} mm`);
  if (s.features) console.log(`       features   ${Object.entries(s.features).map(([k, v]) => `${k} x${typeof v === 'number' ? v : v.count}`).join(', ')}`);
  if (s.lengthMm != null) console.log(`       length     ${s.lengthMm} mm`);
  if (s.timeSec != null) console.log(`       time       ${s.timeSec} s`);
  if (s.speed) console.log(`       speed      ${s.speed.min}-${s.speed.max} (avg ${s.speed.avg}) mm/s`);
  if (Array.isArray(sel.lineRanges)) {
    const shown = sel.lineRanges.slice(0, 6).map((r) => r.join('-')).join(', ');
    console.log(`       lineRanges ${shown}${sel.lineRanges.length > 6 ? ` ... (${sel.lineRanges.length} ranges)` : ''}`);
  }
}

async function main() {
  switch (cmd) {
    case 'pending': {
      const r = await getChatPending();
      if (flag('json')) { console.log(JSON.stringify(r, null, 2)); return; }
      if (!r.count) {
        console.log(`no pending messages  (${CHAT_FILE})`);
        if (r.currentSelection) { console.log('current selection:'); printSelection(r.currentSelection); }
        return;
      }
      console.log(`${r.count} pending message(s)  --  ${CHAT_FILE}`);
      for (const m of r.pending) {
        printMessage(m);
        printSelection(m.selection);
      }
      console.log(`\nreply with:  node server/chat-cli.js reply "..." --to ${r.pending[r.pending.length - 1].id}\n`);
      return;
    }

    case 'reply': {
      const text = positional[0];
      if (!text) {
        console.error('usage: node server/chat-cli.js reply "<text>" [--to msg-id]');
        process.exitCode = 1;
        return;
      }
      const to = typeof flag('to') === 'string' ? flag('to') : undefined;
      const msg = await postChatReply({ text, replyTo: to });
      console.log(`appended ${msg.id}${msg.replyTo ? ' in reply to ' + msg.replyTo : ' (no pending message to attach to)'}`);
      return;
    }

    case 'log': {
      const n = Number(positional[0]) || 20;
      const { messages, skipped } = await readChat();
      for (const m of messages.slice(-n)) printMessage(m);
      console.log(`\n${messages.length} message(s) total${skipped ? `, ${skipped} unparseable line(s) skipped` : ''}`);
      return;
    }

    case 'watch': {
      await startBridgeWatch();
      const stats = await chatStats();
      console.log(`watching ${CHAT_FILE} (${stats.messages} message(s), ${stats.pending} pending). Ctrl-C to stop.`);
      bridgeEvents.on('chat', (messages) => { for (const m of messages) printMessage(m); });
      setInterval(() => {}, 1 << 30); // keep the process alive
      return;
    }

    case 'stats': {
      console.log(JSON.stringify(await chatStats(), null, 2));
      return;
    }

    default:
      console.log(`G-code Studio chat CLI -- operates directly on ${CHAT_FILE}

  node server/chat-cli.js pending [--json]
  node server/chat-cli.js reply "<text>" [--to <msg-id>]
  node server/chat-cli.js log [n]
  node server/chat-cli.js watch
  node server/chat-cli.js stats

The server does not need to be running: every command appends to, or reads
from, bridge/chat.jsonl directly, with the same append-only discipline.`);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exitCode = 1;
});

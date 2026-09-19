/**
 * gcode-worker.js -- runs the parser off the main thread.
 *
 * A 3MB file takes ~120ms to parse and a 7.7MB one proportionally longer. That
 * is enough to drop frames and freeze the UI mid-interaction, so parsing always
 * happens here and the result is transferred (not copied) back.
 *
 * Protocol
 *   in : { id, text }
 *   out: { id, type:'progress', frac }
 *        { id, type:'done', result }   -- typed arrays transferred
 *        { id, type:'error', message, stack }
 */

import { parseGcode } from './parse.js';

self.onmessage = (ev) => {
  const { id, text } = ev.data;
  try {
    let lastPost = 0;
    const result = parseGcode(text, {
      onProgress: (frac) => {
        // Throttle: posting every chunk costs more than the parse itself.
        const now = Date.now();
        if (now - lastPost > 80) {
          lastPost = now;
          self.postMessage({ id, type: 'progress', frac });
        }
      },
    });

    // Transfer the typed arrays rather than structured-cloning them.
    const transfer = Object.values(result.segments).map((a) => a.buffer);
    self.postMessage({ id, type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message, stack: err.stack });
  }
};

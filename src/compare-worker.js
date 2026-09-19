/**
 * compare-worker.js -- runs compareToolpaths off the main thread.
 * In:  {id, cur:{segments,count}, old:{segments,count}}
 * Out: {id, type:'done', result} | {id, type:'error', message}
 */
import { compareToolpaths } from './compare.js';

self.onmessage = (ev) => {
  const { id, cur, old } = ev.data;
  try {
    const result = compareToolpaths(cur, old);
    self.postMessage({ id, type: 'done', result }, [result.curClass.buffer, result.oldClass.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message });
  }
};

import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOKEN_FILE = fileURLToPath(new URL('./.gcs-token', import.meta.url));

/**
 * The API server makes a new token every start (BUGS B9) and writes it to
 * .gcs-token. In built mode it injects it into index.html itself; in dev the
 * page comes from Vite, so Vite does the same. Read on every page load, so
 * restarting only the API server just needs a window reload.
 */
function gcsToken() {
  return {
    name: 'gcs-token',
    apply: 'serve',
    transformIndexHtml(html) {
      let token = '';
      try { token = readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { /* API not started yet */ }
      return html.replace('<head>', `<head>\n<meta name="gcs-token" content="${token}" />`);
    },
  };
}

// The API server runs separately (scripts/dev.js starts both). Vite proxies
// /api to it so the frontend only ever talks to its own origin -- no CORS, and
// the same relative URLs work in a built bundle.
export default defineConfig({
  root: '.',
  plugins: [gcsToken()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: false,
        // /api/term is a WebSocket (the live Claude terminal)
        ws: true,
        // Server-Sent Events must not be buffered or the live file/chat updates
        // arrive in a lump when the stream closes instead of as they happen.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});

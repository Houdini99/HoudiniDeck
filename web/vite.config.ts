import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// In dev, Vite serves the UI on :5173 and forwards API/WebSocket traffic to the Node server.
// (Not read from PORT: tools that launch the dev server often set PORT to Vite's own port.)
const backend = `http://127.0.0.1:${process.env.STREAMDECK_BACKEND_PORT ?? 3325}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte()],
  resolve: {
    alias: { $shared: fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    // Keep the browser's Host header (changeOrigin: false): the server compares it with Origin.
    proxy: {
      '/ws': { target: backend, changeOrigin: false, ws: true },
      '/api': { target: backend, changeOrigin: false },
      '/icons': { target: backend, changeOrigin: false },
      '/uploads': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});

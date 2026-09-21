import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server port is pinned to 5173 because that is the server's `WEB_ORIGIN`
 * default. `strictPort` matters: without it Vite silently moves to 5174 when
 * 5173 is taken, and then every credentialed request is cross-origin against a
 * CORS allowlist that names 5173 — the app loads and every call fails.
 *
 * `/api` is proxied rather than called cross-origin so that the session cookie is
 * first-party in development, which is the same shape as production behind one
 * origin. SSE passes through the proxy unharmed as long as nothing buffers it.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /**
         * Everything from `node_modules` in one chunk, so a change to application code does
         * not invalidate the ~140 kB of React underneath it. One bucket rather than one per
         * package: `react`, `react-dom`, `react-router` and `@tanstack/react-query` are all
         * needed by the shell itself, so a finer split would only add requests.
         *
         * The *pages* are not split here — `App.tsx`'s `lazy` imports do that, because which
         * pages a session needs is something only the route table knows.
         */
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
});

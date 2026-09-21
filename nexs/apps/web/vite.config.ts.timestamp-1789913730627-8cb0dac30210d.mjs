// vite.config.ts
import { defineConfig } from "file:///C:/Users/bharg/OneDrive/Desktop/agents/nexs/node_modules/.pnpm/vite@5.4.21_@types+node@22.20.3/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/bharg/OneDrive/Desktop/agents/nexs/node_modules/.pnpm/@vitejs+plugin-react@4.7.0_vite@5.4.21_@types+node@22.20.3_/node_modules/@vitejs/plugin-react/dist/index.js";
var vite_config_default = defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: false
      }
    }
  },
  preview: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
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
        manualChunks: (id) => id.includes("node_modules") ? "vendor" : void 0
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxiaGFyZ1xcXFxPbmVEcml2ZVxcXFxEZXNrdG9wXFxcXGFnZW50c1xcXFxuZXhzXFxcXGFwcHNcXFxcd2ViXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxiaGFyZ1xcXFxPbmVEcml2ZVxcXFxEZXNrdG9wXFxcXGFnZW50c1xcXFxuZXhzXFxcXGFwcHNcXFxcd2ViXFxcXHZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9DOi9Vc2Vycy9iaGFyZy9PbmVEcml2ZS9EZXNrdG9wL2FnZW50cy9uZXhzL2FwcHMvd2ViL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnO1xuXG4vKipcbiAqIERldiBzZXJ2ZXIgcG9ydCBpcyBwaW5uZWQgdG8gNTE3MyBiZWNhdXNlIHRoYXQgaXMgdGhlIHNlcnZlcidzIGBXRUJfT1JJR0lOYFxuICogZGVmYXVsdC4gYHN0cmljdFBvcnRgIG1hdHRlcnM6IHdpdGhvdXQgaXQgVml0ZSBzaWxlbnRseSBtb3ZlcyB0byA1MTc0IHdoZW5cbiAqIDUxNzMgaXMgdGFrZW4sIGFuZCB0aGVuIGV2ZXJ5IGNyZWRlbnRpYWxlZCByZXF1ZXN0IGlzIGNyb3NzLW9yaWdpbiBhZ2FpbnN0IGFcbiAqIENPUlMgYWxsb3dsaXN0IHRoYXQgbmFtZXMgNTE3MyBcdTIwMTQgdGhlIGFwcCBsb2FkcyBhbmQgZXZlcnkgY2FsbCBmYWlscy5cbiAqXG4gKiBgL2FwaWAgaXMgcHJveGllZCByYXRoZXIgdGhhbiBjYWxsZWQgY3Jvc3Mtb3JpZ2luIHNvIHRoYXQgdGhlIHNlc3Npb24gY29va2llIGlzXG4gKiBmaXJzdC1wYXJ0eSBpbiBkZXZlbG9wbWVudCwgd2hpY2ggaXMgdGhlIHNhbWUgc2hhcGUgYXMgcHJvZHVjdGlvbiBiZWhpbmQgb25lXG4gKiBvcmlnaW4uIFNTRSBwYXNzZXMgdGhyb3VnaCB0aGUgcHJveHkgdW5oYXJtZWQgYXMgbG9uZyBhcyBub3RoaW5nIGJ1ZmZlcnMgaXQuXG4gKi9cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtyZWFjdCgpXSxcbiAgc2VydmVyOiB7XG4gICAgcG9ydDogNTE3MyxcbiAgICBzdHJpY3RQb3J0OiB0cnVlLFxuICAgIHByb3h5OiB7XG4gICAgICAnL2FwaSc6IHtcbiAgICAgICAgdGFyZ2V0OiAnaHR0cDovL2xvY2FsaG9zdDo0MDAwJyxcbiAgICAgICAgY2hhbmdlT3JpZ2luOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbiAgcHJldmlldzoge1xuICAgIHBvcnQ6IDUxNzMsXG4gICAgc3RyaWN0UG9ydDogdHJ1ZSxcbiAgfSxcbiAgYnVpbGQ6IHtcbiAgICBvdXREaXI6ICdkaXN0JyxcbiAgICBzb3VyY2VtYXA6IHRydWUsXG4gICAgZW1wdHlPdXREaXI6IHRydWUsXG4gICAgcm9sbHVwT3B0aW9uczoge1xuICAgICAgb3V0cHV0OiB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBFdmVyeXRoaW5nIGZyb20gYG5vZGVfbW9kdWxlc2AgaW4gb25lIGNodW5rLCBzbyBhIGNoYW5nZSB0byBhcHBsaWNhdGlvbiBjb2RlIGRvZXNcbiAgICAgICAgICogbm90IGludmFsaWRhdGUgdGhlIH4xNDAga0Igb2YgUmVhY3QgdW5kZXJuZWF0aCBpdC4gT25lIGJ1Y2tldCByYXRoZXIgdGhhbiBvbmUgcGVyXG4gICAgICAgICAqIHBhY2thZ2U6IGByZWFjdGAsIGByZWFjdC1kb21gLCBgcmVhY3Qtcm91dGVyYCBhbmQgYEB0YW5zdGFjay9yZWFjdC1xdWVyeWAgYXJlIGFsbFxuICAgICAgICAgKiBuZWVkZWQgYnkgdGhlIHNoZWxsIGl0c2VsZiwgc28gYSBmaW5lciBzcGxpdCB3b3VsZCBvbmx5IGFkZCByZXF1ZXN0cy5cbiAgICAgICAgICpcbiAgICAgICAgICogVGhlICpwYWdlcyogYXJlIG5vdCBzcGxpdCBoZXJlIFx1MjAxNCBgQXBwLnRzeGAncyBgbGF6eWAgaW1wb3J0cyBkbyB0aGF0LCBiZWNhdXNlIHdoaWNoXG4gICAgICAgICAqIHBhZ2VzIGEgc2Vzc2lvbiBuZWVkcyBpcyBzb21ldGhpbmcgb25seSB0aGUgcm91dGUgdGFibGUga25vd3MuXG4gICAgICAgICAqL1xuICAgICAgICBtYW51YWxDaHVua3M6IChpZCkgPT4gKGlkLmluY2x1ZGVzKCdub2RlX21vZHVsZXMnKSA/ICd2ZW5kb3InIDogdW5kZWZpbmVkKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFnVyxTQUFTLG9CQUFvQjtBQUM3WCxPQUFPLFdBQVc7QUFZbEIsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsU0FBUyxDQUFDLE1BQU0sQ0FBQztBQUFBLEVBQ2pCLFFBQVE7QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxNQUNMLFFBQVE7QUFBQSxRQUNOLFFBQVE7QUFBQSxRQUNSLGNBQWM7QUFBQSxNQUNoQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsRUFDZDtBQUFBLEVBQ0EsT0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsV0FBVztBQUFBLElBQ1gsYUFBYTtBQUFBLElBQ2IsZUFBZTtBQUFBLE1BQ2IsUUFBUTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFFBVU4sY0FBYyxDQUFDLE9BQVEsR0FBRyxTQUFTLGNBQWMsSUFBSSxXQUFXO0FBQUEsTUFDbEU7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==

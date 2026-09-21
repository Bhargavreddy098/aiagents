import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Component tests need a DOM; the pure parsers do not, but one environment keeps
 * the config honest rather than having two runners.
 *
 * `globals: false` on purpose — every test imports `describe`/`it`/`expect` from
 * `vitest` explicitly, so there is no ambient global to typo and no `types` entry
 * needed in tsconfig.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});

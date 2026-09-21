import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmount everything between tests.
 *
 * Testing Library registers this itself — but only when it finds a **global** `afterEach`,
 * and `vitest.config.ts` sets `globals: false` on purpose. Without this the first component
 * test to render would leave its DOM in place, and the next test's `getByRole` would find two
 * dialogs and fail for a reason that has nothing to do with the code under test.
 */
afterEach(() => {
  cleanup();
});

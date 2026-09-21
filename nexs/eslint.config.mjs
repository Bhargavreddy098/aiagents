import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // underscore-prefixed args are intentionally unused (e.g. express `_next`)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // the whole architecture depends on no implicit any crossing a boundary
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['error'] }],
      'prefer-const': 'error',
    },
  },

  // The browser app.
  //
  // Two problems this block fixes, both of which made `apps/web` unlintable:
  //
  //  - `apps/web` matched the `**/*.ts` block above, which declares **Node** globals. Every
  //    `document`, `window`, `navigator` and `EventSource` in the web app was therefore a
  //    `no-undef` error, and the web app is not Node — it is a Vite/React package.
  //  - `.tsx` matched **no** block at all. `tseslint.configs.recommended` applies to every file
  //    and brings `no-undef` with it, so every JSX file failed on its first browser global.
  //
  // Declared for both extensions rather than `.tsx` alone, because `apps/web/src/lib` and
  // `apps/web/src/hooks` are `.ts` and just as browser-bound as the components beside them.
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  // tests may be looser
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', '**/test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

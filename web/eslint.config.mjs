import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// Incremental adoption: rules we've cleaned are `error` (CI blocks regressions);
// the rest sit at `warn` and get promoted one category at a time. CI fails on
// errors only, so warnings don't block while we ratchet.
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    rules: {
      // ✅ Cleaned — keep blocking.
      'react-hooks/rules-of-hooks': 'error',

      // ⏳ Ratchet queue (real signal; promote to error as each is cleaned).
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',

      // DX/HMR nicety only — not worth churning 138 existing files. Disabled.
      'react-refresh/only-export-components': 'off',
    },
  },
)

import tseslint from 'typescript-eslint'
import next from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'

// Flat config (ESLint 9). Self-contained: import the plugins directly so pnpm resolves them
// as root deps (FlatCompat + eslint-config-next's transitive plugins don't resolve under
// pnpm's strict layout). tsc (`pnpm typecheck`) owns TYPE correctness; ESLint adds the rules
// tsc can't — unused vars, React hooks correctness, Next-specific mistakes.
//
// The plugins' shipped config objects still use the legacy array-style `plugins`, so we
// register the plugins ourselves and pull in only their RULES.
export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'db/migrations/**', 'coverage/**', 'next-env.d.ts', '*.config.*', '.claude/**'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': next, 'react-hooks': reactHooks },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
      ...reactHooks.configs['recommended-latest'].rules,
    },
  },
  {
    rules: {
      // The codebase uses `as`/`any` deliberately at typed seams (DB rows, Inngest step
      // boundaries, untrusted payloads) where tsc already guards the shape. Not a bug source.
      '@typescript-eslint/no-explicit-any': 'off',
      // Real value: catch genuinely-unused code, but allow intentional _-prefixed throwaways
      // and don't flag unused catch bindings (we often `catch (err)` for a comment/log).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Tests + scripts: looser — they legitimately use empty mocks and non-null assertions.
    files: ['**/*.test.ts', '**/__tests__/**', 'scripts/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
)

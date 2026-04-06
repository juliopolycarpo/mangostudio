import eslint from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/node_modules/**',
      'apps/*/dist/**',
      'apps/*/coverage/**',
      '.mango/out/**',
      'apps/frontend/src/routeTree.gen.ts',
    ],
  },
  // Base JavaScript recommendations
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // TypeScript for all .ts/.tsx
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // Relax type-aware rules in test files — Bun test types are incomplete
  // (e.g. expect().rejects is not typed as Thenable)
  {
    files: ['**/tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  // React rules — frontend only
  {
    files: ['apps/frontend/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'off',
      // React Compiler rules from react-hooks v7 — disable until codebase is compiler-ready
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/incompatible-library': 'off',
    },
  },
  {
    files: ['apps/frontend/src/routes/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/only-throw-error': 'off',
    },
  },
  {
    files: [
      'apps/frontend/src/components/MarkdownContent.tsx',
      'apps/frontend/src/components/settings/ConnectorsSettings.tsx',
      'apps/frontend/src/hooks/use-chats-query.ts',
      'apps/frontend/src/hooks/use-global-settings.ts',
      'apps/frontend/src/hooks/use-messages-query.ts',
      'apps/frontend/src/hooks/use-optimistic-messages.ts',
      'apps/frontend/src/services/gallery-service.ts',
      'apps/frontend/src/services/generation-service.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // SDK adapter boundaries: current provider/client typings still leak `any`
  // into parsing code. Keep typed lint for the repo, but relax unsafe rules
  // in the narrow files that sit directly on third-party response shapes.
  {
    files: [
      'apps/api/src/services/providers/anthropic-provider.ts',
      'apps/api/src/services/providers/gemini-provider.ts',
      'apps/api/src/services/providers/openai-compatible-provider.ts',
      'apps/api/src/services/providers/openai-provider.ts',
      'apps/api/src/services/providers/replay-builder.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  // Prettier last (disables conflicting stylistic rules; formatting is handled by Prettier itself)
  prettierConfig,
);

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
  // Base JavaScript recommendations (applied to all files, no type-checking)
  eslint.configs.recommended,
  // TypeScript with type-checked rules — scoped to .ts/.tsx only so that plain
  // .js tooling files (e.g. eslint.config.js) are not subjected to typed parsing.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
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
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  // Require explicit return types in API services, utilities, and shared code.
  // Elysia route/plugin files are excluded — their return types must be inferred
  // for Eden Treaty type propagation. Frontend is excluded — React component and
  // hook return types are either trivially JSX.Element or complex TanStack Query
  // generics that add noise without safety.
  {
    files: [
      'apps/api/src/services/**/*.ts',
      'apps/api/src/utils/**/*.ts',
      'apps/api/src/lib/**/*.ts',
      'apps/api/src/db/**/*.ts',
      'apps/shared/src/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
          allowIIFEs: true,
        },
      ],
    },
  },
  // Build scripts — console is the intended output mechanism
  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
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
      'react-hooks/exhaustive-deps': 'error',
      // React Compiler rules from react-hooks v7 — disable until codebase is compiler-ready
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/incompatible-library': 'off',
    },
  },
  // Prettier last (disables conflicting stylistic rules; formatting is handled by Prettier itself)
  prettierConfig
);

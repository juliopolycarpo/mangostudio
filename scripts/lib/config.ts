import { join } from 'path';

export const ROOT_DIR = join(import.meta.dir, '..', '..');

export type WorkspaceName = 'frontend' | 'api' | 'shared';

export interface WorkspaceConfig {
  name: WorkspaceName;
  packageName: string;
  path: string;
  maxWarnings: number;
  hasIntegrationTests: boolean;
  hasCoverage: boolean;
}

export const WORKSPACES: Record<WorkspaceName, WorkspaceConfig> = {
  frontend: {
    name: 'frontend',
    packageName: '@mangostudio/frontend',
    path: join(ROOT_DIR, 'apps/frontend'),
    maxWarnings: 2,
    hasIntegrationTests: true,
    hasCoverage: true,
  },
  api: {
    name: 'api',
    packageName: '@mangostudio/api',
    path: join(ROOT_DIR, 'apps/api'),
    maxWarnings: 23,
    hasIntegrationTests: true,
    hasCoverage: true,
  },
  shared: {
    name: 'shared',
    packageName: '@mangostudio/shared',
    path: join(ROOT_DIR, 'apps/shared'),
    maxWarnings: 0,
    hasIntegrationTests: false,
    hasCoverage: false,
  },
};

export const ALL_WORKSPACE_NAMES: WorkspaceName[] = ['frontend', 'api', 'shared'];

// Files ESLint processes at root level (outside workspace src/)
export const ROOT_LINT_FILES: string[] = [
  'eslint.config.js',
  'playwright.config.ts',
  'scripts/**/*.ts',
  'tests/browser-smoke/auth-flow.spec.ts',
  'apps/frontend/vite.config.ts',
  'apps/frontend/vitest.config.ts',
  'apps/shared/vitest.config.ts',
];

// Files Prettier processes at root level (superset of lint files + docs + test globs)
export const ROOT_FORMAT_FILES: string[] = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'CONTRIBUTING.md',
  'docs/**/*.md',
  'eslint.config.js',
  'playwright.config.ts',
  'scripts/**/*.ts',
  'tests/browser-smoke/auth-flow.spec.ts',
  'apps/frontend/vite.config.ts',
  'apps/frontend/vitest.config.ts',
  'apps/shared/vitest.config.ts',
  'apps/api/tests/**/*.ts',
  'apps/frontend/tests/**/*.{ts,tsx}',
  'apps/shared/tests/**/*.ts',
];

import { join } from 'node:path';

export const ROOT_DIR = join(import.meta.dir, '..', '..');

export type WorkspaceName = 'frontend' | 'api' | 'shared';

export interface WorkspaceConfig {
  name: WorkspaceName;
  packageName: string;
  path: string;
  hasIntegrationTests: boolean;
  hasCoverage: boolean;
}

export const WORKSPACES: Record<WorkspaceName, WorkspaceConfig> = {
  frontend: {
    name: 'frontend',
    packageName: '@mangostudio/frontend',
    path: join(ROOT_DIR, 'apps/frontend'),
    hasIntegrationTests: true,
    hasCoverage: true,
  },
  api: {
    name: 'api',
    packageName: '@mangostudio/api',
    path: join(ROOT_DIR, 'apps/api'),
    hasIntegrationTests: true,
    hasCoverage: true,
  },
  shared: {
    name: 'shared',
    packageName: '@mangostudio/shared',
    path: join(ROOT_DIR, 'apps/shared'),
    hasIntegrationTests: false,
    hasCoverage: true,
  },
};

export const ALL_WORKSPACE_NAMES: WorkspaceName[] = ['frontend', 'api', 'shared'];

// End of config

// Paths Biome checks at root level. Biome receives directories instead of
// shell-only globs so the runner can spawn it without shell expansion.
export const ROOT_BIOME_PATHS: string[] = [
  'package.json',
  'biome.json',
  '.zed',
  '.vscode',
  '.claude/settings.json',
  '.claude/hooks',
  '.codex/hooks',
  'lefthook.yml',
  'playwright.config.ts',
  'scripts',
  'packages',
  'apps/api/package.json',
  'apps/frontend/package.json',
  'apps/shared/package.json',
  'tests/browser-smoke/auth-flow.spec.ts',
  'apps/frontend/vite.config.ts',
  'apps/frontend/vitest.config.ts',
  'apps/api/tests',
  'apps/frontend/tests',
  'apps/shared/tests',
];

export const ROOT_DPRINT_PATHS: string[] = [
  'AGENTS.md',
  'README.md',
  'docs',
  '.github',
  '.mango',
  '.codex/config.toml',
  'packages',
  'lefthook.yml',
  'dprint.json',
];

export const WORKSPACE_DPRINT_PATHS: Record<WorkspaceName, string[]> = {
  frontend: ['apps/frontend/AGENTS.md', 'apps/frontend/bunfig.toml'],
  api: ['apps/api/AGENTS.md', 'apps/api/bunfig.toml'],
  shared: ['apps/shared/AGENTS.md', 'apps/shared/bunfig.toml'],
};

export const WORKSPACE_MADGE_PATHS: Record<WorkspaceName, string> = {
  frontend: 'apps/frontend',
  api: 'apps/api',
  shared: 'apps/shared',
};

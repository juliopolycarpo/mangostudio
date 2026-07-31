import { join } from 'node:path';

export const ROOT_DIR = join(import.meta.dir, '..', '..');

export type WorkspaceName = 'frontend' | 'api' | 'shared' | 'runtime';

export interface WorkspaceConfig {
  name: WorkspaceName;
  packageName: string;
  path: string;
}

export const WORKSPACES: Record<WorkspaceName, WorkspaceConfig> = {
  frontend: {
    name: 'frontend',
    packageName: '@mangostudio/frontend',
    path: join(ROOT_DIR, 'apps/frontend'),
  },
  api: {
    name: 'api',
    packageName: '@mangostudio/api',
    path: join(ROOT_DIR, 'apps/api'),
  },
  shared: {
    name: 'shared',
    packageName: '@mangostudio/shared',
    path: join(ROOT_DIR, 'apps/shared'),
  },
  runtime: {
    name: 'runtime',
    packageName: '@mangostudio/runtime',
    path: join(ROOT_DIR, 'apps/runtime'),
  },
};

export const ALL_WORKSPACE_NAMES: WorkspaceName[] = ['frontend', 'api', 'shared', 'runtime'];

// End of config

// Paths Biome checks at root level. Biome receives directories instead of
// shell-only globs so the runner can spawn it without shell expansion.
export const ROOT_BIOME_PATHS: string[] = [
  'package.json',
  'biome.json',
  'turbo.jsonc',
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
  'apps/api/turbo.json',
  'apps/frontend/package.json',
  'apps/frontend/turbo.json',
  'apps/shared/package.json',
  'apps/runtime/package.json',
  'apps/runtime/turbo.json',
  'tests/browser-smoke',
  'apps/frontend/vite.config.ts',
  'apps/frontend/vitest.config.ts',
  'apps/api/tests',
  'apps/frontend/tests',
  'apps/shared/tests',
  'apps/runtime/tests',
];

export const ROOT_DPRINT_PATHS: string[] = [
  'AGENTS.md',
  'README.md',
  'Dockerfile',
  'Dockerfile.alpine',
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
  runtime: ['apps/runtime/AGENTS.md'],
};

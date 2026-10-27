import { join } from 'node:path';

export const ROOT_DIR = join(import.meta.dir, '..', '..');

export type WorkspaceName = 'frontend' | 'api' | 'shared';

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
};

export const ALL_WORKSPACE_NAMES: WorkspaceName[] = ['frontend', 'api', 'shared'];

// Root-owned paths shared by Bun lint and fmt. Workspaces run the same tools
// from this root so nested test-only bunfig.toml files cannot hide lint policy.
export const ROOT_TOOLING_PATHS: string[] = [
  'package.json',
  'bunfig.toml',
  'turbo.jsonc',
  '.zed',
  '.vscode',
  '.claude',
  '.codex',
  '.cursor/rules',
  '.github',
  '.mango',
  'AGENTS.md',
  'README.md',
  'docs',
  'lefthook.yml',
  'opencode.json',
  'knip.json',
  'playwright.config.ts',
  'scripts',
  'packages',
  'apps/api/package.json',
  'apps/api/turbo.json',
  'apps/frontend/package.json',
  'apps/frontend/turbo.json',
  'apps/shared/package.json',
  'tests/browser-smoke',
  'apps/frontend/build.ts',
  'spec',
  'crates',
  'Cargo.toml',
  'deny.toml',
  'rustfmt.toml',
  'rust-toolchain.toml',
];

// Lint accepts only source directories; JSON-only directories are errors.
export const ROOT_LINT_PATHS: string[] = [
  '.claude/hooks',
  '.codex/hooks',
  'scripts',
  'packages',
  'tests/browser-smoke',
  'playwright.config.ts',
  'apps/frontend/build.ts',
];

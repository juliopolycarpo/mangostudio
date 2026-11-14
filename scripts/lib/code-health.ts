// Change-scoping rules for the repository-wide Knip code-health gate, and the
// commands `bun run check` runs it with.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_CONFIG_FILES = new Set([
  '.gitignore',
  'bunfig.toml',
  'bun.lock',
  'lefthook.yml',
  'package.json',
  'playwright.config.ts',
  'tsconfig.json',
  'turbo.jsonc',
]);

const SCRIPT_FILE_PATTERN = /^(?:\.claude\/hooks|scripts)\/.*\.(?:[cm]?[jt]sx?|sh)$/;
const WORKSPACE_SOURCE_PATTERN = /^(?:apps|packages)\/[^/]+\/(?:bin|scripts|src|tests)\//;
const WORKSPACE_CONFIG_PATTERN =
  /^(?:apps|packages)\/[^/]+\/(?:build\.ts|bunfig\.toml|package\.json|tsconfig(?:\.[^/]+)?\.json|tsr\.config\.json|turbo\.json|v(?:ite|itest)\.config\.[cm]?[jt]s)$/;

/** True when scoped changes can affect Knip's entry graph or dependency report. */
export function touchesCodeHealthSurface(files: string[]): boolean {
  return files.some((file) => {
    const path = file.replaceAll('\\', '/');
    return (
      ROOT_CONFIG_FILES.has(path) ||
      /^knip\.(?:jsonc?|[cm]?[jt]s)$/.test(path) ||
      path.startsWith('.github/actions/') ||
      path.startsWith('.github/workflows/') ||
      path.startsWith('tests/') ||
      SCRIPT_FILE_PATTERN.test(path) ||
      WORKSPACE_SOURCE_PATTERN.test(path) ||
      WORKSPACE_CONFIG_PATTERN.test(path)
    );
  });
}

/** Where local `bun run check` keeps Knip's cache, relative to the repository root. */
export const CODE_HEALTH_CACHE_DIR = '.mango/knip-cache';

export type CodeHealthMode = 'default' | 'production';

const CODE_HEALTH_SCRIPTS: Readonly<Record<CodeHealthMode, string>> = {
  default: 'code-health',
  production: 'code-health:production',
};

/**
 * Names one generation of Knip's cache: the Knip version and the bytes of its
 * configuration. Knip caches what it parsed per file, keyed by that file's own
 * metadata, so an edit to a source file is seen; a new Knip or a new
 * configuration gets a fresh directory instead of trusting that.
 *
 * @example
 * codeHealthCacheGeneration('6.44.2', '{"workspaces":{}}'); // '3f9a1c0b7d2e'
 */
export function codeHealthCacheGeneration(knipVersion: string, knipConfig: string): string {
  return new Bun.CryptoHasher('sha256')
    .update(`${knipVersion}\0${knipConfig}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * The command for one code-health scan.
 *
 * A local run adds Knip's own cache (5.3 s to 1.8 s on an unchanged tree, with
 * the same report). The two modes get separate directories because they run at
 * the same time. `generation` is null when `CI` is set or the caller could not
 * name one: that run is uncached, which is the package script as written.
 *
 * @example
 * createCodeHealthCommand('default', null); // ['bun', 'run', 'code-health']
 * createCodeHealthCommand('production', '3f9a1c0b7d2e');
 * // ['bun', 'run', 'code-health:production', '--cache', '--cache-location',
 * //  '.mango/knip-cache/3f9a1c0b7d2e/production']
 */
export function createCodeHealthCommand(mode: CodeHealthMode, generation: string | null): string[] {
  const command = ['bun', 'run', CODE_HEALTH_SCRIPTS[mode]];
  if (generation === null) return command;
  return [
    ...command,
    '--cache',
    '--cache-location',
    `${CODE_HEALTH_CACHE_DIR}/${generation}/${mode}`,
  ];
}

/**
 * Cache directories of earlier generations, as paths relative to the
 * repository root. Each generation is tens of megabytes, so `check` removes the
 * ones it no longer reads.
 *
 * @example
 * staleCodeHealthCaches(['3f9a1c0b7d2e', 'aaaaaaaaaaaa'], '3f9a1c0b7d2e');
 * // ['.mango/knip-cache/aaaaaaaaaaaa']
 */
export function staleCodeHealthCaches(
  existing: readonly string[],
  generation: string | null
): string[] {
  return existing
    .filter((name) => name !== generation)
    .map((name) => `${CODE_HEALTH_CACHE_DIR}/${name}`);
}

/**
 * The cache generation a `check` run should use, and the earlier ones it can
 * remove. No generation when `CI` is set (CI starts cold, and an uncached scan
 * there is the reference) or when Knip or its configuration cannot be read.
 *
 * @example
 * planCodeHealthCache('/repo', {}); // { generation: '3f9a1c0b7d2e', stale: [] }
 * planCodeHealthCache('/repo', { CI: 'true' }); // { generation: null, stale: [] }
 */
export function planCodeHealthCache(
  rootDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): { generation: string | null; stale: string[] } {
  if (env.CI?.trim()) return { generation: null, stale: [] };
  let generation: string;
  try {
    const knip = JSON.parse(
      readFileSync(join(rootDir, 'node_modules/knip/package.json'), 'utf8')
    ) as { version?: unknown };
    if (typeof knip.version !== 'string') return { generation: null, stale: [] };
    generation = codeHealthCacheGeneration(
      knip.version,
      readFileSync(join(rootDir, 'knip.json'), 'utf8')
    );
  } catch {
    return { generation: null, stale: [] };
  }
  let existing: string[] = [];
  try {
    existing = readdirSync(join(rootDir, CODE_HEALTH_CACHE_DIR));
  } catch {
    // No cache directory yet: nothing to remove.
  }
  return { generation, stale: staleCodeHealthCaches(existing, generation) };
}

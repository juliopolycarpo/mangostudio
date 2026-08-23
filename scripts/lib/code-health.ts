// Change-scoping rules for the repository-wide Knip code-health gate.

const ROOT_CONFIG_FILES = new Set([
  '.gitignore',
  'biome.json',
  'bun.lock',
  'dprint.json',
  'lefthook.yml',
  'package.json',
  'playwright.config.ts',
  'tsconfig.json',
  'turbo.jsonc',
]);

const SCRIPT_FILE_PATTERN = /^(?:\.claude\/hooks|\.codex\/hooks|scripts)\/.*\.(?:[cm]?[jt]sx?|sh)$/;
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

/**
 * Build a cycle-only Biome command for TS/TSX roots, independent of formatting
 * and VCS exclusions. Run it from the repository root so the shared config is
 * resolved there. Both required workspace checks and QA use this command.
 * // Usage: createImportCycleCommand(['apps/api'], 'json')
 */
export function createImportCycleCommand(
  roots: readonly string[],
  reporter: 'default' | 'json' = 'default'
): string[] {
  return [
    'bunx',
    'biome',
    'lint',
    '--config-path=biome.cycles.json',
    '--only=suspicious/noImportCycles',
    '--only=nursery/noSelfImport',
    '--max-diagnostics=none',
    '--diagnostic-level=error',
    '--error-on-warnings',
    '--colors=off',
    `--reporter=${reporter}`,
    ...roots,
  ];
}

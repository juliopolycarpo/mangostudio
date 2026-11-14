/**
 * The argv of the cycle scanner, kept apart from `import-cycles.ts` so a caller
 * that only builds a command does not load the TypeScript compiler (about 250 ms).
 */

/** The command used by the workspace check and QA collector.
 * @example createImportCycleCommand(['apps/api'], 'json');
 */
export function createImportCycleCommand(
  roots: readonly string[],
  reporter: 'default' | 'json' = 'default'
): string[] {
  return [
    'bun',
    'scripts/check-import-cycles.ts',
    ...(reporter === 'json' ? ['--json'] : []),
    ...roots,
  ];
}

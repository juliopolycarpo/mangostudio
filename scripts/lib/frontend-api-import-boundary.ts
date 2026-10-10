import { readFileSync } from 'node:fs';

import { ROOT_DIR } from './config';
import { collectModuleSpecifiers } from './import-specifiers';

const PARITY_TEST =
  'apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts';
const API_INTERNAL_PREFIX = '@mangostudio/api/internal/';
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.mango']);

/**
 * Keep frontend runtime imports out of hub internals, except the test comparing
 * the live reducer with the real hub transcript. Covers deferred imports that
 * Biome's import rule does not recognize and ignores erased type-only imports.
 * Transparent expression wrappers preserve the same literal dependency edge;
 * generated directories are excluded only at the frontend workspace root.
 *
 * @example
 * assertFrontendApiImportBoundary(); // Checks the repository's frontend files.
 */
export function assertFrontendApiImportBoundary(rootDir: string = ROOT_DIR): void {
  const glob = new Bun.Glob('apps/frontend/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');
  const paths = [...glob.scanSync({ cwd: rootDir, onlyFiles: true, dot: true })]
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !IGNORED_DIRECTORIES.has(path.split('/')[2] ?? ''));
  if (paths.length === 0) {
    throw new Error(
      `Expected frontend JavaScript or TypeScript source files in ${rootDir}/apps/frontend.`
    );
  }
  const violations = paths
    .filter((path) => path !== PARITY_TEST)
    .flatMap((path) =>
      collectModuleSpecifiers(readFileSync(`${rootDir}/${path}`, 'utf8'), path)
        .filter(({ text, typeOnly }) => !typeOnly && text.startsWith(API_INTERNAL_PREFIX))
        .map(({ text, line, column }) => `  - ${path}:${line}:${column} (${text})`)
    );
  if (violations.length === 0) return;

  throw new Error(
    `Frontend value imports of ${API_INTERNAL_PREFIX}* are allowed only in ${PARITY_TEST} ` +
      'to compare the live reducer with the real hub transcript. Use shared contracts or Eden root API types elsewhere.\n' +
      violations.join('\n')
  );
}

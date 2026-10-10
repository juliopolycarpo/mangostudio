import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from './config';
import { listCheckoutFiles } from './git';
import { collectModuleSpecifiers } from './import-specifiers';

const SHARED_ROOT = '@mangostudio/shared';
const BOUNDARY_MESSAGE =
  'Use a bounded-context entrypoint such as @mangostudio/shared/agents. The private shared root export was removed; type-only imports must also use a subpath.';
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function sourcePaths(rootDir: string): string[] {
  let files: string[];
  try {
    files = listCheckoutFiles(rootDir);
  } catch (error) {
    throw new Error(
      `Cannot inventory shared imports in ${JSON.stringify(rootDir)}; expected a Git checkout. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const paths = files
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => SOURCE_EXTENSION.test(path) && existsSync(join(rootDir, path)));
  if (paths.length === 0) {
    throw new Error(
      `Empty source inventory in ${JSON.stringify(rootDir)}; expected tracked or unignored JavaScript/TypeScript files.`
    );
  }
  return paths;
}

/**
 * Reject private shared root imports throughout the checkout, including erased
 * types and root tooling. Git includes tracked files and unignored new files.
 * Transparent expression wrappers retain the same literal module dependency.
 *
 * @example
 * assertNoSharedRootImports(); // Run before workspace checks.
 */
export function assertNoSharedRootImports(rootDir: string = ROOT_DIR): void {
  const failures = sourcePaths(rootDir).flatMap((path) =>
    collectModuleSpecifiers(readFileSync(join(rootDir, path), 'utf8'), path)
      .filter(({ text }) => text === SHARED_ROOT)
      .map(({ line, column }) => `${path}:${line}:${column}: ${JSON.stringify(SHARED_ROOT)}`)
  );
  if (failures.length === 0) return;
  throw new Error(
    `Unexpected shared root importer(s):\n${failures.join('\n')}\n${BOUNDARY_MESSAGE}`
  );
}

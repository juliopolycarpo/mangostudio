import { sep } from 'node:path';

/**
 * A scanned path with `/` separators, the spelling a source scan compares against and
 * prints. `Bun.Glob` and `readdirSync` answer with the host separator, so on Windows
 * `lib/hub-connection-limits.ts` arrives as `lib\hub-connection-limits.ts`.
 *
 * @example
 * toPosixSourcePath('lib\\hub-connection-limits.ts', '\\'); // 'lib/hub-connection-limits.ts'
 * toPosixSourcePath('lib/hub-connection-limits.ts', '/'); // unchanged
 */
export function toPosixSourcePath(path: string, separator: string = sep): string {
  return separator === '\\' ? path.replaceAll('\\', '/') : path;
}

/**
 * The files under `root` that match `pattern`, as `/`-separated paths relative to `root`.
 *
 * @example
 * const sources = await scanSourcePaths(SRC_ROOT, '**\/*.ts');
 */
export async function scanSourcePaths(root: string, pattern: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    paths.push(toPosixSourcePath(path));
  }
  return paths;
}

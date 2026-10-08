/**
 * A stand-in for `tsc --noEmit` in the throwaway workspaces of
 * `typecheck-fixture.ts`. Like `tsc`, it reads the workspace's own sources and
 * the sources of the workspaces it imports, so an error in a dependency fails
 * the dependent too. A file containing the error marker is the "type error";
 * one containing the slow marker makes the check take `SLOW_CHECK_MS` first,
 * the way a large workspace outlasts a small one.
 *
 * @example
 * bun fake-typecheck.ts src private ../shared/src   // exits 1 if any tree has the marker
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TYPE_ERROR_MARKER = '@fake-type-error';
export const SLOW_MARKER = '@fake-slow';
const SLOW_CHECK_MS = 1500;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else yield path;
  }
}

if (import.meta.main) {
  const files = process.argv.slice(2).flatMap((directory) => [...sourceFiles(directory)]);
  const texts = files.map((file) => [file, readFileSync(file, 'utf8')] as const);
  if (texts.some(([, text]) => text.includes(SLOW_MARKER))) await Bun.sleep(SLOW_CHECK_MS);
  const broken = texts.filter(([, text]) => text.includes(TYPE_ERROR_MARKER));
  for (const [file] of broken) {
    console.error(`${file}(1,1): error TS2322: Type 'string' is not assignable to type 'number'.`);
  }
  process.exit(broken.length > 0 ? 1 : 0);
}

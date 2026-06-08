import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';

/** Read a repo-relative file as UTF-8 text. // Usage: readText('scripts/test.ts'); */
export function readText(relativePath: string): string {
  return readFileSync(join(ROOT_DIR, relativePath), 'utf8');
}

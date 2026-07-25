import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';

/** Repo-relative paths of every workflow under `.github/workflows/`. */
export function workflowFiles(): string[] {
  return readdirSync(join(ROOT_DIR, '.github', 'workflows'))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => `.github/workflows/${file}`);
}

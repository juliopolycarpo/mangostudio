import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';

/** Repo-relative paths of every workflow under `.github/workflows/`. */
export function workflowFiles(): string[] {
  return readdirSync(join(ROOT_DIR, '.github', 'workflows'))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => `.github/workflows/${file}`);
}

/**
 * Return each `actions/upload-artifact` step's trailing block (sibling keys
 * such as `with:` plus their nested values), so callers can assert on path
 * and compression settings without depending on step names.
 */
export function uploadArtifactSteps(text: string): string[] {
  const lines = text.split('\n');
  const steps: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*(?:-\s+)?uses:\s*actions\/upload-artifact@/.test(line)) continue;

    const indent = line.search(/\S/);
    const block: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next];
      if (nextLine.trim() === '') {
        block.push(nextLine);
        continue;
      }
      const nextIndent = nextLine.search(/\S/);
      if (nextIndent < indent) break;
      // Same-indent sibling keys (e.g. `with:`) stay in the step; a new
      // list item at this indent starts the next step.
      if (nextIndent === indent && /^\s*-\s/.test(nextLine)) break;
      block.push(nextLine);
    }
    steps.push(block.join('\n'));
  }

  return steps;
}

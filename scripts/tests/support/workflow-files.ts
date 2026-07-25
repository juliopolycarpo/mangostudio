import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { extractJobBlocks, extractStepBlocks } from './workflow-blocks';

/** Repo-relative paths of every workflow under `.github/workflows/`. */
export function workflowFiles(): string[] {
  return readdirSync(join(ROOT_DIR, '.github', 'workflows'))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => `.github/workflows/${file}`);
}

/**
 * Repo-relative path of one composite action's manifest. GitHub accepts either
 * spelling, so probe `action.yaml` before falling back to `action.yml` — naming
 * only the latter turns a legitimately named action into a missing-file crash.
 */
function actionManifest(actionName: string): string {
  const yaml = `.github/actions/${actionName}/action.yaml`;
  return existsSync(join(ROOT_DIR, yaml)) ? yaml : `.github/actions/${actionName}/action.yml`;
}

/** Repo-relative manifest paths of every composite action under `.github/actions/`. */
export function compositeActionFiles(): string[] {
  return readdirSync(join(ROOT_DIR, '.github', 'actions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => actionManifest(entry.name));
}

/**
 * Every `actions/upload-artifact` step block in a workflow. Blocks are anchored
 * at the step's list item rather than its `uses:` line, so a `with:` mapping
 * written above `uses:` is still part of the step callers assert on.
 */
export function uploadArtifactSteps(text: string): string[] {
  return extractJobBlocks(text)
    .flatMap(({ block }) => extractStepBlocks(block))
    .filter((step) => /^\s*(?:-\s+)?uses:\s*actions\/upload-artifact@/m.test(step));
}

/**
 * The artifact payload paths a step declares, covering both `path: value` and
 * the block-scalar (`path: |`) form. Reading the paths rather than the whole
 * step keeps step names and YAML comments from being mistaken for a payload.
 */
export function uploadPaths(step: string): string[] {
  const lines = step.split('\n');
  const paths: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)path:[ \t]*(.*)$/.exec(lines[index]);
    if (!match) continue;

    const [, indent, inline] = match;
    if (inline !== '' && !inline.startsWith('|') && !inline.startsWith('>')) {
      paths.push(inline.trim());
      continue;
    }

    for (let next = index + 1; next < lines.length; next += 1) {
      const entry = lines[next].trim();
      if (entry === '' || entry.startsWith('#')) continue;
      if (lines[next].search(/\S/) <= indent.length) break;
      paths.push(entry);
    }
  }

  return paths;
}

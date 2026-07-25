import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { extractJobBlocks, extractStepBlocks, extractStepBlocksAtIndent } from './workflow-blocks';

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

const CACHE_SCOPED_USES = /(?:^|\n)\s*(?:-\s+)?uses:\s*\.\/\.github\/actions\/cache-scoped\s*$/m;

export interface CacheScopedCallSite {
  readonly file: string;
  /** Step `id:` when present, otherwise null. */
  readonly id: string | null;
  readonly inputs: Readonly<Record<string, string>>;
  readonly block: string;
}

/** Parse a step's `with:` mapping into a flat string record. */
function parseWithInputs(step: string): Record<string, string> {
  const withMatch = /\n(\s*)with:\n([\s\S]*?)(?=\n\1\S|$)/.exec(`\n${step}`);
  if (!withMatch) return {};

  const body = withMatch[2];
  const inputs: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (raw === '' || raw.startsWith('|') || raw.startsWith('>')) continue;
    inputs[key] = raw.trim().replace(/^['"]|['"]$/g, '');
  }
  return inputs;
}

function callSitesFromSteps(file: string, steps: string[]): CacheScopedCallSite[] {
  return steps
    .filter((step) => CACHE_SCOPED_USES.test(step))
    .map((block) => ({
      file,
      id: /^\s*(?:-\s+)?id:\s*(\S+)/m.exec(block)?.[1] ?? null,
      inputs: parseWithInputs(block),
      block,
    }));
}

/**
 * Every `cache-scoped` call site across workflows and composite manifests.
 * Workflow job steps sit at indent 6; composite-action steps sit at indent 4.
 */
export function cacheScopedCallSites(): CacheScopedCallSite[] {
  const sites: CacheScopedCallSite[] = [];

  for (const file of workflowFiles()) {
    const text = readFileSync(join(ROOT_DIR, file), 'utf8');
    const steps = extractJobBlocks(text).flatMap(({ block }) => extractStepBlocks(block));
    sites.push(...callSitesFromSteps(file, steps));
  }

  for (const file of compositeActionFiles()) {
    if (file.includes('/cache-scoped/')) continue;
    const text = readFileSync(join(ROOT_DIR, file), 'utf8');
    sites.push(...callSitesFromSteps(file, extractStepBlocksAtIndent(text, 4)));
  }

  return sites;
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

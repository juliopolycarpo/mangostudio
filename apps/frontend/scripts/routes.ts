#!/usr/bin/env bun
import { readdirSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Generate routes with the same pinned implementation used by the former CLI.
 * Resolve config and temporary files from the frontend root, independently of cwd.
 *
 * @example
 * await generateRouteTree();
 */
export async function generateRouteTree(root: string = FRONTEND_ROOT): Promise<void> {
  // A fresh dev build skips generation without loading the generator's dependency graph.
  const { configSchema, Generator, getConfig } = await import('@tanstack/router-generator');
  const frontendRoot = resolve(root);
  const configFile = Bun.file(join(frontendRoot, 'tsr.config.json'));
  const configured = configSchema.parse((await configFile.exists()) ? await configFile.json() : {});
  const config = getConfig(
    {
      tmpDir: resolve(
        frontendRoot,
        configured.tmpDir || process.env.TSR_TMP_DIR || '.tanstack/tmp'
      ),
    },
    frontendRoot
  );
  await new Generator({ config, root: frontendRoot }).run();
}

/**
 * Check route inputs and directory mtimes so edits, renames and deletions invalidate the tree.
 * Missing or mid-removal entries are stale and must be settled by the generator.
 *
 * @example
 * if (!routeTreeIsCurrent()) await generateRouteTree();
 */
export function routeTreeIsCurrent(root: string = FRONTEND_ROOT): boolean {
  const routesDir = join(root, 'src', 'routes');
  try {
    const generated = statSync(join(root, 'src', 'routeTree.gen.ts')).mtimeMs;
    const inputs = readdirSync(routesDir, { recursive: true, encoding: 'utf8' }).reduce(
      (newest, entry) => Math.max(newest, statSync(join(routesDir, entry)).mtimeMs),
      Math.max(statSync(routesDir).mtimeMs, statSync(join(root, 'tsr.config.json')).mtimeMs)
    );
    return generated >= inputs;
  } catch {
    return false;
  }
}

interface UpdateRouteTreeOptions {
  /** Production builds always generate, independently of input mtimes. */
  readonly force?: boolean;
  readonly root?: string;
}

/**
 * Generate a stale dev tree or force a production tree. Return whether generation ran.
 * Restamp unchanged dev output so the next build can skip it after a route-only edit.
 *
 * @example
 * await updateRouteTree({ force: !dev });
 */
export async function updateRouteTree(
  { force = false, root = FRONTEND_ROOT }: UpdateRouteTreeOptions = {},
  generate: (root: string) => Promise<void> = generateRouteTree
): Promise<boolean> {
  if (!force && routeTreeIsCurrent(root)) return false;
  await generate(root);
  if (!force) {
    const now = new Date();
    utimesSync(join(root, 'src', 'routeTree.gen.ts'), now, now);
  }
  return true;
}

if (import.meta.main) await generateRouteTree();

/**
 * Dev-only frontend build + watch, imported solely by `../dev.ts`. Never reached
 * by `bun build --compile`: `index.ts` (the binary entry) does not import this
 * file, directly or transitively.
 *
 * There is no dev-specific *serving* code. `getDefaultFrontendDir()` already
 * resolves `apps/frontend/dist` in a source checkout, so once this module has
 * produced that directory the normal `registerFrontend()` path serves it —
 * the same code the shipped binary's filesystem branch uses.
 *
 * The build runs as a subprocess rather than an import so `apps/frontend/src`
 * never enters this process's `bun --watch` reload graph, and so dev runs
 * literally the production build command.
 */

import { readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { HIDDEN_WINDOW } from '@mangostudio/runtime';
import { setDevFrontendDir } from './dev-frontend-dir';

// Resolved from this file rather than from `process.cwd()`: Turbo runs the API's
// dev task with the cwd set to `apps/api`, not the repo root.
const FRONTEND_DIR = join(import.meta.dir, '..', '..', '..', 'frontend');
const WATCH_DIR = join(FRONTEND_DIR, 'src');
const DIST_DIR = join(FRONTEND_DIR, 'dist');
/** Coalesce the burst of events an editor save produces into one rebuild. */
const REBUILD_DEBOUNCE_MS = 120;
/**
 * The build regenerates this file, and it lives inside the watched directory.
 * Rebuilding on it would make the watcher feed itself.
 */
const GENERATED_FILE = 'routeTree.gen.ts';

async function runBuild(): Promise<boolean> {
  const proc = Bun.spawn(['bun', './build.ts', '--dev'], {
    cwd: FRONTEND_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    ...HIDDEN_WINDOW,
  });
  return (await proc.exited) === 0;
}

/** Newest mtime under a directory, or 0 when it does not exist. */
function newestMtime(directory: string): number {
  try {
    return readdirSync(directory, { recursive: true, encoding: 'utf8' }).reduce((newest, entry) => {
      const stats = statSync(join(directory, entry));
      return stats.isFile() ? Math.max(newest, stats.mtimeMs) : newest;
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * True when `dist/` is already newer than every frontend source file.
 *
 * The API's dev script runs under `bun --watch`, so editing any `apps/api/src`
 * file restarts this process and calls back into here. Without this check every
 * API hot reload would tear down `dist/` and rebuild it from scratch.
 */
function distIsCurrent(): boolean {
  const built = newestMtime(DIST_DIR);
  return built > 0 && built >= newestMtime(WATCH_DIR);
}

/**
 * Build the frontend, then rebuild it whenever `apps/frontend/src` changes.
 *
 * Awaited before the server starts because `registerFrontend()` inspects the
 * directory once at boot: with no `dist/` present it registers the API-only
 * branch and no later build would be picked up.
 *
 * Rebuilds replace `dist/` in place. There is no HMR — Bun's HTML-bundle dev
 * server is unusable for this app's dependency graph (it drops a transitive
 * import) — so a browser refresh is needed to see an edit.
 */
export async function registerDevFrontend(): Promise<void> {
  if (distIsCurrent()) {
    console.warn('[frontend] Bundle is up to date.');
  } else {
    console.warn('[frontend] Building...');
    if (!(await runBuild())) {
      console.error('[frontend] Initial build failed; the server will serve API routes only.');
      return;
    }
  }
  setDevFrontendDir(DIST_DIR);

  let pending: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  const watcher = watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
    // The build writes routeTree.gen.ts back into the watched tree; reacting to
    // it would make each rebuild schedule the next one.
    if (filename?.endsWith(GENERATED_FILE)) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      // A save during a rebuild is dropped rather than queued: the next save
      // rebuilds from the same source tree anyway.
      if (building) return;
      building = true;
      void runBuild()
        .then((ok) => {
          if (ok) console.warn('[frontend] Rebuilt. Refresh the browser to see the change.');
        })
        .finally(() => {
          building = false;
        });
    }, REBUILD_DEBOUNCE_MS);
  });

  process.on('exit', () => watcher.close());
}

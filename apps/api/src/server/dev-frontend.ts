/**
 * Dev-only frontend build, imported solely by `../dev.ts`. Never reached by
 * `bun build --compile`: `index.ts` (the binary entry) does not import this
 * file, directly or transitively.
 *
 * There is no dev-specific *serving* code. `getSourceFrontendDir()` already
 * resolves `apps/frontend/dist` in a source checkout, so once this module has
 * produced that directory the normal `registerFrontend()` path serves it — the
 * same code that serves a dev rebuild started from any other terminal.
 *
 * This used to watch the frontend workspace and rebuild on every save. It was
 * never hot reload — there is no HMR here, so a browser refresh was needed
 * either way — and what it actually bought was saving one command per edit, at
 * the price of a directory allowlist that had to be corrected three times, a
 * debounce-and-coalesce state machine, and a rebuild that removes `dist/` out
 * from under a running server. An explicit `bun run --filter
 * @mangostudio/frontend build` costs the same 1.5s and cannot fire on a turbo
 * log.
 *
 * The build runs as a subprocess rather than an import so `apps/frontend/src`
 * never enters this process's `bun --watch` reload graph, and so dev runs
 * literally the production build command.
 */

import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HIDDEN_WINDOW } from '@mangostudio/runtime';
import { setDevFrontendDir } from './dev-frontend-dir';

// Resolved from this file rather than from `process.cwd()`: Turbo runs the API's
// dev task with the cwd set to `apps/api`, not the repo root.
const FRONTEND_DIR = join(import.meta.dir, '..', '..', '..', 'frontend');
const DIST_DIR = join(FRONTEND_DIR, 'dist');
/**
 * The build regenerates this under `src/`, so it is inside the input tree and
 * has to be skipped by name: counting its mtime makes the tree permanently
 * newer than `dist/`, so `distIsCurrent()` could never be true again and every
 * API hot reload would rebuild the frontend from scratch.
 */
const GENERATED_FILE = 'routeTree.gen.ts';

/**
 * Frontend workspace entries that are genuine inputs to `build.ts`.
 *
 * An allowlist, not a denylist. Scanning only `src/` was too narrow — a change
 * to `index.html`, to `public/`, or to `build.ts` left a stale bundle reading
 * as current — but the correction, the whole workspace minus `dist/` and
 * `node_modules`, was too wide in a way that kept losing ground: the tree also
 * accumulates `tests/`, `.turbo/`, `.tanstack/` and `dist-metafile.json`, none
 * of which the bundler reads. Each left `distIsCurrent()` false, so the next
 * API hot reload rebuilt from scratch; `bun run check` writing a turbo log was
 * enough to trigger it.
 *
 * A denylist has to be extended for every artifact anyone adds to the
 * workspace, and the symptom of missing one is a slow dev loop that never looks
 * like a bug. The set of real inputs is small, known, and changes rarely, so it
 * is the side worth enumerating: `tsconfig.json` is here because `Bun.build()`
 * honours its `paths`, and `tsr.config.json` because route generation reads it.
 */
const BUILD_INPUTS = new Set([
  'src',
  'public',
  'index.html',
  'build.ts',
  'package.json',
  'tsconfig.json',
  'tsr.config.json',
]);

/**
 * Whether a directory entry counts as a build input, given its depth below the
 * frontend root. The allowlist applies at the root only; below it, everything
 * is an input except the file the build itself generates.
 */
function isBuildInput(name: string, depth: number): boolean {
  return depth === 0 ? BUILD_INPUTS.has(name) : name !== GENERATED_FILE;
}

async function runBuild(): Promise<boolean> {
  const proc = Bun.spawn(['bun', './build.ts', '--dev'], {
    cwd: FRONTEND_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    ...HIDDEN_WINDOW,
  });
  return (await proc.exited) === 0;
}

/**
 * Newest mtime under a directory, or 0 when it does not exist.
 *
 * `keep` decides which entries are descended into and counted, which is what
 * lets one walker answer for both sides of `distIsCurrent()` — the output tree
 * whole, and the input tree filtered. Two walkers is how `GENERATED_FILE` came
 * to be honoured by one of them and not the other.
 *
 * `countDirectories` adds each kept subdirectory's own mtime to the maximum.
 * That is the only way to see a *removal*: deleting a file advances its parent
 * directory's mtime and touches no file, so a file-only scan still reports the
 * newest surviving file and misses the change entirely. It is set for the input
 * side alone — raising `built` is the direction that serves a stale bundle
 * while claiming it is current.
 *
 * Hand-rolled rather than `readdirSync({ recursive: true })` because that has
 * no way to prune a subtree: it would descend all of `node_modules` — tens of
 * thousands of stats on every dev boot — before anything could filter the
 * result. Pruning at the directory level is the whole point.
 */
function newestMtime(
  directory: string,
  keep: (name: string, depth: number) => boolean,
  countDirectories: boolean,
  depth = 0
): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!keep(entry.name, depth)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path, keep, countDirectories, depth + 1));
      if (countDirectories) {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
          // Same reasoning as the file case below: skipping can only make the
          // result older, which fails toward a rebuild.
        }
      }
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      // Removed between the readdir and the stat. Skipping it can only make the
      // result older, which fails toward a rebuild — the safe direction.
    }
  }
  return newest;
}

/**
 * Newest mtime of the frontend's build *inputs*, including the mtimes of the
 * allowlisted subdirectories themselves so that deleting or renaming an input
 * registers as a change.
 *
 * `directory`'s own mtime is deliberately not counted. It advances whenever any
 * entry appears or disappears at the frontend root, which a build does on every
 * run (`dist/` is removed and recreated) and `bun run check` does the first time
 * it writes `.turbo/` — churn that has nothing to do with the bundle's inputs.
 * The accepted gap is that deleting a root-level input (`build.ts`,
 * `index.html`, the configs) is still invisible to this scan; each of those
 * breaks the build loudly the moment it does run, unlike a quietly dropped
 * route.
 */
export function newestSourceMtime(directory: string): number {
  return newestMtime(directory, isBuildInput, true);
}

/**
 * True when `dist/` is already newer than every frontend build input.
 *
 * The API's dev script runs under `bun --watch`, so editing any `apps/api/src`
 * file restarts this process and calls back into here. Without this check every
 * API hot reload would tear down `dist/` and rebuild it from scratch.
 */
function distIsCurrent(): boolean {
  // No `dist/` settles the question on its own, so the input scan — the more
  // expensive of the two — is not run at all in the case that needs a full
  // build anyway.
  const built = newestMtime(DIST_DIR, () => true, false);
  if (built === 0) return false;
  // A failed source scan (the walker's catch returns 0, e.g. a file deleted
  // mid-scan) must read as "stale", not as "0 is older than anything built":
  // failing toward a rebuild costs seconds, the other direction serves an old
  // bundle while claiming it is up to date.
  const source = newestSourceMtime(FRONTEND_DIR);
  return source > 0 && built >= source;
}

/** What to run after editing a frontend file, printed wherever that is the next step. */
const REBUILD_HINT = 'bun run --filter @mangostudio/frontend build';

/**
 * Build the frontend once, if `dist/` is not already current.
 *
 * Awaited before the server starts because `registerFrontend()` inspects the
 * directory once at boot: with no `dist/` present it registers the API-only
 * branch and no later build would be picked up.
 *
 * Nothing watches for changes afterwards. There is no HMR either way — Bun's
 * HTML-bundle dev server is unusable for this app's dependency graph, it drops
 * a transitive import — so an edit always cost a browser refresh, and rebuilding
 * on save only ever saved the command itself.
 */
export async function registerDevFrontend(): Promise<void> {
  if (distIsCurrent()) {
    console.warn('[frontend] Bundle is up to date.');
  } else {
    console.warn('[frontend] Building...');
    if (!(await runBuild())) {
      // Not a `return`: a previous bundle on disk keeps being served, and the
      // registration below is what hands the server a directory at all.
      // `registerFrontend()` inspects it once at boot, so a failed *first* build
      // leaves nothing to register and the process has to be restarted once the
      // build goes green.
      console.error(
        existsSync(join(DIST_DIR, 'index.html'))
          ? `[frontend] Build failed; serving the previous bundle. Fix the error, then run \`${REBUILD_HINT}\`.`
          : '[frontend] Build failed and no previous bundle exists; serving API routes only. Fix the error, then restart `bun run dev`.'
      );
    }
  }
  setDevFrontendDir(DIST_DIR);
  console.warn(`[frontend] After a frontend edit: \`${REBUILD_HINT}\`, then refresh.`);
}

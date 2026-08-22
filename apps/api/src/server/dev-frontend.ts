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

import { type Dirent, existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { HIDDEN_WINDOW } from '@mangostudio/runtime';
import { setDevFrontendDir } from './dev-frontend-dir';

// Resolved from this file rather than from `process.cwd()`: Turbo runs the API's
// dev task with the cwd set to `apps/api`, not the repo root.
const FRONTEND_DIR = join(import.meta.dir, '..', '..', '..', 'frontend');
const DIST_DIR = join(FRONTEND_DIR, 'dist');
/** Coalesce the burst of events an editor save produces into one rebuild. */
const REBUILD_DEBOUNCE_MS = 120;
/**
 * Files the build writes back into the watched tree. Both prune mechanisms
 * below have to skip them: the watcher, or every rebuild schedules the next one
 * forever, and `newestSourceMtime`, or the tree is always newer than `dist/`
 * and `distIsCurrent()` can never be true again.
 *
 * `routeTree.gen.ts` is regenerated under `src/`. `dist-metafile.json` is
 * written to the frontend *root* — beside `dist/`, deliberately outside it so
 * the binary does not embed it — which puts it outside `UNWATCHED_DIRS`' reach
 * and makes it the last write of every build.
 */
const GENERATED_FILE = 'routeTree.gen.ts';
const BUILD_OUTPUT_FILES = new Set([GENERATED_FILE, 'dist-metafile.json']);

/** True when a watched path's last segment names a file the build itself writes. */
function isBuildOutputFile(path: string): boolean {
  return BUILD_OUTPUT_FILES.has(path.split(/[\\/]/).pop() ?? '');
}
/**
 * Watching only `src/` meant an edit to `index.html`, to anything under
 * `public/`, or to `build.ts`/the Tailwind config fired no rebuild at all —
 * and `distIsCurrent()`, comparing against the same narrow tree, then reported
 * the stale bundle as current across every API restart. The whole frontend
 * workspace is the real input to the build, so that is what gets watched.
 *
 * Two subtrees have to stay out. `dist/` is the build's own output: watching it
 * makes each rebuild trigger the next one forever. `node_modules` is inert
 * between installs and walking it dominates the scan.
 */
const UNWATCHED_DIRS = new Set(['dist', 'node_modules']);

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
 * Newest mtime of the frontend's build *inputs*.
 *
 * Hand-rolled rather than `readdirSync({ recursive: true })` because that has
 * no way to prune a subtree: it would descend all of `node_modules` — tens of
 * thousands of stats on every dev boot — before anything could filter the
 * result. Pruning at the directory level is the whole point.
 */
export function newestSourceMtime(directory: string): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (UNWATCHED_DIRS.has(entry.name)) continue;
      newest = Math.max(newest, newestSourceMtime(join(directory, entry.name)));
      continue;
    }
    if (!entry.isFile() || BUILD_OUTPUT_FILES.has(entry.name)) continue;
    try {
      newest = Math.max(newest, statSync(join(directory, entry.name)).mtimeMs);
    } catch {
      // Removed between the readdir and the stat. Skipping it can only make the
      // result older, which fails toward a rebuild — the safe direction.
    }
  }
  return newest;
}

/**
 * True when `dist/` is already newer than every frontend build input.
 *
 * The API's dev script runs under `bun --watch`, so editing any `apps/api/src`
 * file restarts this process and calls back into here. Without this check every
 * API hot reload would tear down `dist/` and rebuild it from scratch.
 */
function distIsCurrent(): boolean {
  const built = newestMtime(DIST_DIR);
  const source = newestSourceMtime(FRONTEND_DIR);
  // A failed source scan (newestMtime's catch returns 0, e.g. a file deleted
  // mid-scan) must read as "stale", not as "0 is older than anything built":
  // failing toward a rebuild costs seconds, the other direction serves an old
  // bundle while claiming it is up to date.
  return built > 0 && source > 0 && built >= source;
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
      // Not a `return`. The watcher below still goes up, so fixing the source
      // rebuilds without a manual step — and if a previous bundle is on disk it
      // keeps being served meanwhile. What a failed *initial* build cannot do is
      // hand the server a directory to register: `registerFrontend()` inspects
      // it once at boot, so with nothing there the process has to be restarted
      // after the build goes green. Returning here also skipped the watcher,
      // which made that restart the only way out of a typo.
      console.error(
        existsSync(join(DIST_DIR, 'index.html'))
          ? '[frontend] Initial build failed; serving the previous bundle until the next rebuild.'
          : '[frontend] Initial build failed and no previous bundle exists; serving API routes only. Fix the error, then restart `bun run dev`.'
      );
    }
  }
  setDevFrontendDir(DIST_DIR);

  let pending: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  let dirty = false;

  // A save landing while a rebuild is in flight cannot be dropped: the running
  // build already read that file's pre-save content, so "the next save
  // rebuilds anyway" leaves dist/ stale right after "Rebuilt." prints. Mark
  // the tree dirty and run one more build when the in-flight one completes.
  const rebuild = (): void => {
    building = true;
    void runBuild()
      .then((ok) => {
        if (ok) console.warn('[frontend] Rebuilt. Refresh the browser to see the change.');
      })
      // `runBuild` rejects when the *spawn* fails rather than the build — `bun`
      // off PATH, or EAGAIN under the fd pressure oven-sh/bun#37968 still
      // produces. Without a handler the rejection escapes the `void` as an
      // unhandled rejection, which takes the dev server down and says nothing
      // about the frontend.
      .catch((error: unknown) => {
        console.error('[frontend] Rebuild could not start:', error);
      })
      .finally(() => {
        building = false;
        if (dirty) {
          dirty = false;
          rebuild();
        }
      });
  };

  const watcher = watch(FRONTEND_DIR, { recursive: true }, (_event, filename) => {
    // The build writes routeTree.gen.ts and dist-metafile.json back into the
    // watched tree; reacting to either would make each rebuild schedule the
    // next one. The metafile is the build's *last* write, so nothing about the
    // debounce or the in-flight guard can absorb it.
    if (filename && isBuildOutputFile(filename)) return;
    // Same self-feeding problem, one level up: now that the whole workspace is
    // watched, `dist/` — which every rebuild rewrites — is inside it. Prune the
    // build's own output and `node_modules` before anything is scheduled.
    // Split on either separator rather than `path.sep`: the value here comes
    // from the OS watch API, not from `path.join`, so it is not guaranteed to
    // use the platform's canonical form.
    if (filename && UNWATCHED_DIRS.has(filename.split(/[\\/]/)[0] ?? '')) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (building) {
        dirty = true;
        return;
      }
      rebuild();
    }, REBUILD_DEBOUNCE_MS);
  });

  process.on('exit', () => watcher.close());
}

/**
 * Dev-only frontend build + watch, imported solely by `../dev.ts`. Never reached
 * by `bun build --compile`: `index.ts` (the binary entry) does not import this
 * file, directly or transitively.
 *
 * There is no dev-specific *serving* code. `getSourceFrontendDir()` already
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
 * The build regenerates this under `src/`, so it is inside the input tree and
 * has to be skipped by name: reacting to it makes every rebuild schedule the
 * next one forever, and counting its mtime makes the tree permanently newer
 * than `dist/` so `distIsCurrent()` can never be true again.
 */
const GENERATED_FILE = 'routeTree.gen.ts';

/**
 * Frontend workspace entries that are genuine inputs to `build.ts`.
 *
 * An allowlist, not a denylist. Watching only `src/` was too narrow — an edit
 * to `index.html`, to `public/`, or to `build.ts` fired no rebuild at all — but
 * the correction, watching the whole workspace minus `dist/` and
 * `node_modules`, was too wide in a way that kept losing ground: the tree also
 * accumulates `tests/`, `.turbo/`, `.tanstack/` and `dist-metafile.json`, none
 * of which the bundler reads. Each cost a full rebuild — which starts by
 * removing `dist/`, so the running dev app 404s until it finishes — and each
 * also left `distIsCurrent()` false, so the next API hot reload rebuilt from
 * scratch. `bun run check` writing a turbo log was enough to trigger both.
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

/**
 * Whether a path the watcher reported should schedule a rebuild, given
 * relative to the frontend root.
 *
 * Split on either separator rather than `path.sep`: the value comes from the
 * OS watch API, not from `path.join`, so it is not guaranteed to use the
 * platform's canonical form.
 *
 * Note the direction this fails in. An allowlist skips unless every segment
 * passes, so a path shaped differently than expected — a leading separator
 * makes the first segment empty — is a rebuild that does *not* happen, and a
 * missed rebuild is silent where a spurious one is merely slow. That is the
 * opposite of `distIsCurrent()`'s bias, and it is why this is exported and
 * pinned rather than left inline: nothing else in the suite, and nothing in
 * `test-build.ts`, ever executes this module.
 */
export function isWatchedInput(filename: string): boolean {
  // A leading separator would otherwise make the first segment empty, which no
  // allowlist entry matches — so the one plausible shape variation would turn
  // every event into a skipped rebuild rather than a spurious one.
  return filename
    .replace(/^[\\/]+/, '')
    .split(/[\\/]/)
    .every((segment, depth) => isBuildInput(segment, depth));
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
    // Filtered through the same allowlist the staleness scan uses, so the two
    // cannot disagree about what an input is. Without it a rebuild's own writes
    // (`dist/`, `dist-metafile.json`, the regenerated route tree) schedule the
    // next rebuild forever, and unrelated workspace traffic — a saved test, a
    // turbo log — costs a full rebuild that tears `dist/` down first.
    if (filename && !isWatchedInput(filename)) return;
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

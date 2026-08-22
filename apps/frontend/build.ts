#!/usr/bin/env bun
/**
 * Builds `apps/frontend` into `dist/` with Bun's bundler. Replaces `vite build`,
 * and is also what the API dev server runs — dev and production go through this
 * one script so they cannot drift.
 *
 * `bun build` the CLI has no plugin flag, and Tailwind v4 needs one, so the
 * build has to be a `Bun.build()` call in a script rather than a package.json
 * one-liner.
 *
 * Usage: bun ./build.ts [--dev]
 */

import { existsSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_STATE_FILE, listDistFiles } from '@mangostudio/shared/utils/dist-files';
import tailwind from 'bun-plugin-tailwind';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const PUBLIC_DIR = join(ROOT, 'public');
const HTML_TEMPLATE = join(ROOT, 'index.html');

/** The `<script>` tag `index.html` carries in source, replaced by the built one. */
const SOURCE_SCRIPT_TAG = '<script type="module" src="./src/main.tsx"></script>';

interface BuildFrontendOptions {
  /** Skip minify and the React Compiler pass. Halves build time for the dev loop. */
  readonly dev?: boolean;
}

/**
 * What `BUILD_STATE_FILE` records about the bundle sitting in `dist/`.
 *
 * Written by every build, dev and production alike. Writing it only in dev
 * meant a production build left none, and the reader could not tell "built with
 * a different API URL" from "built by the other mode" — it answered stale to
 * both, so an unrelated API save rebuilt in dev mode straight over a production
 * bundle. Both fields are here for the same reason: they are the two inputs
 * that change what is in `dist/` without changing any source file's mtime.
 */
export interface BuildState {
  /** The `MANGO_API_URL` compiled into the bundle, empty when unset. */
  readonly apiUrl: string;
  readonly mode: 'dev' | 'production';
}

/**
 * Staging and backup paths this process created and has not yet cleaned up.
 *
 * `publishDist` moves the live bundle aside before renaming the staged one into
 * place, and Ctrl-C is the ordinary way to stop the dev server that spawns a
 * build on every boot. Killed in that window, the process left `dist/` absent
 * and a full bundle copy stranded under `.dist-backup-<uuid>`, which nothing
 * ever reaped — one multi-MB directory per interrupt.
 *
 * Cleanup is driven by this set rather than by a glob sweep of the workspace on
 * startup: the documented two-terminal workflow makes a concurrent build real
 * (a `bun run dev` boot spawns one while a manual build is running), and a
 * sweep cannot tell another run's live staging directory from an orphan.
 */
interface TempPathOptions {
  /** Restore this path here if cleanup finds the destination absent. */
  readonly restoreTo?: string;
}

const tempPaths = new Map<string, TempPathOptions>();

export function trackTempPath(path: string, options: TempPathOptions = {}): string {
  tempPaths.set(path, options);
  return path;
}

async function untrackTempPath(path: string, options: { recursive?: boolean } = {}): Promise<void> {
  tempPaths.delete(path);
  await rm(path, { force: true, ...options });
}

/**
 * Put a tracked backup back where it came from, if its destination is free.
 *
 * Only ever a restore, never a removal. Called on paths where the destination
 * may hold a *failed* bundle — `publishDist`'s rollback reaches here after its
 * own `rmSync` threw — and deleting the backup in that state would destroy the
 * only good copy. `existsSync(restoreTo)` therefore means "leave it alone",
 * not "the backup is redundant".
 */
function restoreTempPath(path: string): void {
  const restoreTo = tempPaths.get(path)?.restoreTo;
  if (!restoreTo) return;
  try {
    if (existsSync(path) && !existsSync(restoreTo)) {
      renameSync(path, restoreTo);
      tempPaths.delete(path);
    }
  } catch {
    // Already unwinding. The backup stays tracked and on disk, which is the
    // outcome that keeps the previous bundle recoverable by hand.
  }
}

/**
 * Remove every path this process is still tracking. Synchronous because it runs
 * from a signal handler, where the process is about to exit and a pending
 * promise would never settle.
 */
export function removeTempPaths(): void {
  for (const [path, { restoreTo }] of tempPaths) {
    // Forget first so a path whose name is reused later in this process is not
    // mistaken for this build's temporary output. If restoration fails, the
    // backup itself remains on disk rather than being deleted below.
    tempPaths.delete(path);
    try {
      if (restoreTo && existsSync(path) && !existsSync(restoreTo)) {
        renameSync(path, restoreTo);
      } else {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Nothing useful to do while unwinding, and a failed cleanup must not
      // replace the interrupt's exit code with a crash.
    }
  }
}

/**
 * Clean up when the build is interrupted.
 *
 * Installed from the CLI entrypoint only, so importing this module for a test
 * does not take over the test runner's signal handling. `once`, and the exit
 * code is the conventional 128 + signal so a shell still sees an interrupt.
 */
function removeTempPathsOnSignal(): void {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.once(signal, () => {
      removeTempPaths();
      process.exit(code);
    });
  }
}

/**
 * Regenerate `src/routeTree.gen.ts` from `src/routes/`. Was the Vite plugin's
 * job; `@tanstack/router-cli` produces a byte-identical file. Routed through the
 * `routes` package script rather than invoked directly so the dependency stays
 * visible to knip.
 */
async function generateRouteTree(): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', 'routes'], {
    cwd: ROOT,
    // `ignore`, not `pipe`: nothing reads stdout, and an undrained pipe leaks a
    // descriptor per run — the dev loop calls this on every rebuild.
    stdout: 'ignore',
    stderr: 'pipe',
  });
  // Drained unconditionally, for the same reason: reading it only on failure
  // leaks the descriptor on every successful build.
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`tsr generate failed:\n${stderr}`);
  }
}

/**
 * True when `src/routeTree.gen.ts` is newer than everything that feeds it, so
 * a dev rebuild can skip the `tsr generate` spawn — measured at ~1.1s of a ~3s
 * dev rebuild, paid on every rebuild that touches anything under `src/`.
 *
 * Directory mtimes are compared on purpose: deleting or renaming a route file
 * bumps no surviving file's mtime, only its parent directory's, so a file-only
 * scan would keep serving the deleted route.
 */
function routeTreeIsCurrent(): boolean {
  const routesDir = join(ROOT, 'src', 'routes');
  try {
    const generated = statSync(join(ROOT, 'src', 'routeTree.gen.ts')).mtimeMs;
    const inputs = readdirSync(routesDir, { recursive: true, encoding: 'utf8' }).reduce(
      (newest, entry) => Math.max(newest, statSync(join(routesDir, entry)).mtimeMs),
      Math.max(statSync(routesDir).mtimeMs, statSync(join(ROOT, 'tsr.config.json')).mtimeMs)
    );
    return generated >= inputs;
  } catch {
    // A missing or mid-removal entry means the answer is unknowable — say
    // stale and let the generator settle it.
    return false;
  }
}

/**
 * The split-deployment API base URL, from `MANGO_API_URL` or the deprecated
 * `VITE_API_URL` alias.
 *
 * The old name outlived the bundler it was named after — nothing in this repo
 * has used Vite since the migration, and a `VITE_` prefix sends the next reader
 * looking for a `vite.config.ts` that does not exist. The alias stays for one
 * release so an existing build script keeps working, and says so out loud when
 * it is the one that supplied the value.
 *
 * The value is baked into the bundle, so it has to be in the `build` task's
 * Turbo cache key or a run with a changed one restores a `dist/` pointing at
 * the previous API. `VITE_API_URL` was covered incidentally by the root
 * `turbo.jsonc` task's `VITE_*` glob; the rename moved the primary name out of
 * it, so `apps/frontend/turbo.json` names `MANGO_API_URL` explicitly and
 * restates `VITE_*` — a package task's `env` *replaces* the root's for that
 * task rather than adding to it (verified with
 * `turbo run build --dry=json --filter=@mangostudio/frontend`).
 */
interface BuildEnvironment {
  readonly MANGO_API_URL?: string;
  readonly VITE_API_URL?: string;
}

export function resolveApiUrlOverride(
  environment: BuildEnvironment = process.env as BuildEnvironment,
  warn: (message: string) => void = console.warn
): string {
  const current = environment.MANGO_API_URL;
  if (current) return current;

  const deprecated = environment.VITE_API_URL;
  if (deprecated) {
    warn(
      '[build] VITE_API_URL is deprecated and will be removed in a future release; rename it to MANGO_API_URL.'
    );
    return deprecated;
  }
  // Always a string: an unset variable would otherwise survive the define as a
  // bare `process` reference and throw a ReferenceError in the browser.
  return '';
}

/**
 * Build the app and write `dist/`.
 *
 * Three things here are load-bearing and look optional:
 *
 * - **The entrypoint is `src/main.tsx`, never `index.html`.** Bun's HTML loader
 *   silently drops a nested transitive import from this app's graph (measured:
 *   better-auth's `nanostores`, surfacing as `ReferenceError: atom is not
 *   defined` and a blank page). The TS entrypoint is unaffected, so the HTML is
 *   stitched by hand below instead of being handed to the bundler.
 * - **`publicPath: '/'`.** Without it Bun rewrites the HTML to relative asset
 *   URLs, and the SPA shell served at `/settings/agents` then resolves
 *   `./assets/x.js` to `/settings/assets/x.js` — a 404, a blank page, and no
 *   server-side error. The assertion at the end of this file is the guard.
 * - **The `NODE_ENV` define.** Nothing in this repo sets `NODE_ENV`, and
 *   `Bun.build()` then resolves `process.env.NODE_ENV` to `'development'` —
 *   which is how React, its scheduler, and every dev-gated dependency picked
 *   their *development* builds in a minified production bundle (measured:
 *   +78 kB gzip on the eager payload, plus React's dev-mode runtime checks).
 *   Vite inlined `'production'`; this define restores that.
 */
async function buildFrontend(options: BuildFrontendOptions = {}): Promise<void> {
  const production = !options.dev;
  const apiUrlOverride = resolveApiUrlOverride();
  // Only the dev loop skips: a production build must be byte-identical to one
  // from a clean checkout, whatever the mtimes say.
  if (production || !routeTreeIsCurrent()) {
    await generateRouteTree();
    if (!production) {
      // `tsr generate` leaves the file untouched when the tree is unchanged,
      // which would otherwise disarm the mtime comparison for good after any
      // edit under `src/routes` — restamp so the next rebuild measures
      // against this run. Content is untouched; only the timestamp moves.
      const now = new Date();
      utimesSync(join(ROOT, 'src', 'routeTree.gen.ts'), now, now);
    }
  }
  // Build beside dist/, then publish only after every output and post-build
  // assertion succeeds. A failed dev rebuild therefore leaves the bundle the
  // API is already serving intact.
  const stagedDist = trackTempPath(await mkdtemp(join(ROOT, '.dist-staging-')));
  const metafilePath = join(ROOT, 'dist-metafile.json');
  const stagedMetafilePath = production
    ? trackTempPath(join(ROOT, `.dist-metafile-staging-${Bun.randomUUIDv7()}`))
    : null;
  try {
    // `mkdtemp` creates mode 0700. dist/ is packaged and may be served by a
    // different user, so preserve the ordinary directory mode from the old
    // remove-and-recreate build.
    await chmod(stagedDist, 0o755);
    const result = await Bun.build({
      entrypoints: [join(ROOT, 'src/main.tsx')],
      outdir: stagedDist,
      target: 'browser',
      splitting: true,
      minify: production,
      sourcemap: 'none',
      publicPath: '/',
      define: {
        'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
        // The split-deployment override read by src/lib/api-base-url.ts, always
        // defined (empty string when unset) so the bundle never contains a bare
        // `process` reference. A define, not `env: 'MANGO_*'`: the env option
        // rewrites the member read but leaves any surrounding
        // `typeof process` guard to evaluate false in a browser and discard the
        // inlined value, and an unset variable survives verbatim — both
        // measured on 1.4.0.
        'process.env.MANGO_API_URL': JSON.stringify(apiUrlOverride),
      },
      metafile: true,
      // Auto-memoization. `@vitejs/plugin-react` did not run it, so this is a
      // behavior change rather than parity, and nothing in the test suite covers
      // the transform. Off in dev so the loop stays fast.
      reactCompiler: production,
      plugins: [tailwind],
      naming: {
        // `entry` and `chunk` must not share a pattern. Bun names a dynamic-import
        // chunk after the entry that reaches it, so one pattern for both yields
        // eighteen files called `assets/main-<hash>.js` and any glob that looks for
        // the entry finds a chunk instead — which renders a blank page with no
        // console error at all.
        entry: 'assets/[name]-[hash].[ext]',
        chunk: 'assets/chunk-[name]-[hash].[ext]',
        asset: 'assets/[name]-[hash].[ext]',
      },
    });

    if (!result.success) {
      for (const log of result.logs) console.error(String(log));
      throw new Error('Frontend build failed');
    }

    await cp(PUBLIC_DIR, stagedDist, { recursive: true });
    await writeHtml(result, stagedDist);
    await writeRuntimeConfig(stagedDist);
    await writeBuildState(stagedDist, {
      apiUrl: apiUrlOverride,
      mode: production ? 'production' : 'dev',
    });

    // Next to dist/, not inside it: the binary build embeds every file dist/
    // contains, and the metafile is a build diagnostic (the bundle report's
    // duplicate-module check reads it), not shipped payload. Sitting outside
    // dist/ also puts it outside the `dist/**` glob, so it is declared as a
    // second `build` output in turbo.json — otherwise a cache hit restores dist/
    // and leaves whatever metafile happens to be on disk describing it.
    //
    // Production only. It is ~1.5 MB of JSON and its sole consumer is the bundle
    // report, which the parity gate runs against a production build; writing it
    // on every dev save spent the stringify of that whole object graph on
    // something nothing in the dev loop reads. The report already handles its
    // absence — it prints that the duplicate-module check was skipped.
    //
    // A dev build *removes* it rather than leaving the last production one
    // behind. The invariant worth keeping is that the metafile on disk describes
    // the bundle in dist/; a stale one silently describes a different build, and
    // the report has no way to tell. Absent is a state it reports honestly.
    if (stagedMetafilePath) {
      await writeFile(stagedMetafilePath, JSON.stringify(result.metafile));
    }
    await publishDist(stagedDist, DIST, async () => {
      if (stagedMetafilePath) {
        await publishMetafile(stagedMetafilePath, metafilePath);
      } else {
        await rm(metafilePath, { force: true });
      }
    });
  } finally {
    // No-op after publish because rename moved this path to dist/. On failure,
    // remove the partial outputs without touching the previous bundle.
    await untrackTempPath(stagedDist, { recursive: true });
    if (stagedMetafilePath) await untrackTempPath(stagedMetafilePath);
  }
}

/** Record what this build compiled into `dist/`, for the dev server's freshness check. */
export async function writeBuildState(outputDir: string, state: BuildState): Promise<void> {
  await writeFile(join(outputDir, BUILD_STATE_FILE), `${JSON.stringify(state)}\n`);
}

/**
 * Replace a published directory with a fully prepared staging directory.
 *
 * POSIX cannot rename a directory over another non-empty directory. Move the
 * old one aside first, but restore it if publishing the staged tree or its
 * final sidecar operation fails.
 */
export async function publishDist(
  stagedDist: string,
  dist: string,
  finalize?: () => Promise<void>
): Promise<void> {
  const backupDist = trackTempPath(join(dirname(dist), `.dist-backup-${Bun.randomUUIDv7()}`), {
    restoreTo: dist,
  });
  // Keep the state-changing filesystem operations synchronous. A signal
  // handler cannot interleave with a sync syscall, so cleanup always observes
  // either the state before a rename/removal or the state after it. With async
  // calls, an in-flight rename could finish after cleanup inspected the paths
  // and recreate the exact missing-dist failure this transaction prevents.
  let hasBackup = false;
  try {
    renameSync(dist, backupDist);
    hasBackup = true;
  } catch (error) {
    tempPaths.delete(backupDist);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let published = false;
  try {
    renameSync(stagedDist, dist);
    published = true;
    if (finalize) await finalize();
  } catch (publishError) {
    const rollbackErrors: unknown[] = [];
    if (published) {
      try {
        rmSync(dist, { recursive: true, force: true });
      } catch (removeError) {
        rollbackErrors.push(removeError);
      }
    }
    if (hasBackup && rollbackErrors.length === 0) {
      try {
        renameSync(backupDist, dist);
        tempPaths.delete(backupDist);
      } catch (restoreError) {
        // Still tracked as a rollback backup. A later signal cleanup retries the
        // restore instead of deleting what may be the only valid bundle.
        rollbackErrors.push(restoreError);
      }
    }
    if (rollbackErrors.length > 0) {
      // One last attempt before unwinding, for the branch where the inline
      // restore above is what threw: `dist` is absent and this backup holds the
      // only copy of the previous bundle. A no-op when the failure was the
      // `rmSync` instead, because then `dist` still exists.
      restoreTempPath(backupDist);
      throw new AggregateError(
        [publishError, ...rollbackErrors],
        `Failed to publish ${dist} and restore its previous contents`
      );
    }
    throw publishError;
  }

  if (hasBackup) {
    try {
      await untrackTempPath(backupDist, { recursive: true });
    } catch (error) {
      // The new dist is already live. Do not report the build as failed and
      // make the dev server claim it fell back to the previous bundle.
      console.warn(
        `[frontend] Could not remove previous bundle at ${backupDist}: ${String(error)}`
      );
    }
  }
}

/** Publish the production metafile without losing its previous valid version on failure. */
async function publishMetafile(stagedMetafile: string, metafile: string): Promise<void> {
  const backupMetafile = trackTempPath(
    join(dirname(metafile), `.dist-metafile-backup-${Bun.randomUUIDv7()}`),
    { restoreTo: metafile }
  );
  let hasBackup = false;
  try {
    renameSync(metafile, backupMetafile);
    hasBackup = true;
  } catch (error) {
    tempPaths.delete(backupMetafile);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    renameSync(stagedMetafile, metafile);
  } catch (publishError) {
    if (hasBackup) {
      try {
        renameSync(backupMetafile, metafile);
        tempPaths.delete(backupMetafile);
      } catch (restoreError) {
        restoreTempPath(backupMetafile);
        throw new AggregateError(
          [publishError, restoreError],
          `Failed to publish ${metafile} and restore its previous contents`
        );
      }
    }
    throw publishError;
  }

  if (hasBackup) {
    try {
      await untrackTempPath(backupMetafile);
    } catch (error) {
      console.warn(
        `[frontend] Could not remove previous metafile at ${backupMetafile}: ${String(error)}`
      );
    }
  }
}

async function writeHtml(
  result: Awaited<ReturnType<typeof Bun.build>>,
  outputDir: string
): Promise<void> {
  // Resolved by `kind`, not by filename — see the `naming` comment above.
  const entry = result.outputs.find((output) => output.kind === 'entry-point');
  if (!entry) throw new Error('Frontend build produced no entry-point output');
  // The shell links one stylesheet, which holds while `src/main.tsx` carries the
  // only CSS import in the graph. The first component that imports its own
  // `.css` would emit a second output, and picking the first of two here would
  // silently drop a stylesheet from every page — no build error, no console
  // error, just unstyled UI. Fail instead, so the choice is made deliberately.
  const stylesheets = result.outputs.filter((output) => output.path.endsWith('.css'));
  if (stylesheets.length > 1) {
    throw new Error(
      `Frontend build emitted ${stylesheets.length} stylesheets; index.html links one. ` +
        `Decide which are eager before shipping: ${stylesheets
          .map((stylesheet) => distUrl(stylesheet.path, outputDir))
          .join(', ')}`
    );
  }
  const css = stylesheets[0];

  const template = await Bun.file(HTML_TEMPLATE).text();
  if (!template.includes(SOURCE_SCRIPT_TAG)) {
    throw new Error(`index.html no longer contains the expected script tag: ${SOURCE_SCRIPT_TAG}`);
  }

  const tags = [
    css ? `<link rel="stylesheet" crossorigin href="${distUrl(css.path, outputDir)}" />` : null,
    // A *classic* script, and it must stay classic: a classic script without
    // `defer`/`async` runs the moment the parser reaches it, while module
    // scripts are deferred by default. That ordering is the whole guarantee —
    // `window.__MANGO_CONFIG__` is populated before any bundle code evaluates.
    // Deliberately unhashed so a deployer can edit it in place.
    `<script src="${RUNTIME_CONFIG_URL}"></script>`,
    `<script type="module" crossorigin src="${distUrl(entry.path, outputDir)}"></script>`,
  ].filter((tag) => tag !== null);

  const html = template.replace(SOURCE_SCRIPT_TAG, tags.join('\n    '));
  assertAbsoluteAssetUrls(html);
  await writeFile(join(outputDir, 'index.html'), html);
}

/** URL of the deployer-editable runtime config, relative to `publicPath`. */
const RUNTIME_CONFIG_URL = '/config.js';

/**
 * Writes the runtime config the published `frontend-dist` tarball can be
 * repointed with, without a rebuild.
 *
 * `MANGO_API_URL` is a `define`, so it is fixed when the bundle is compiled —
 * which is fine for someone building their own, and useless for someone serving
 * the tarball we ship. That artifact is built with the variable unset, so its
 * only answer is `window.location.origin`: serve it from a CDN and every request
 * goes to the CDN instead of the API.
 *
 * Shipping an empty config gives that deployment a seam. It is written on every
 * build, including into the standalone binary, where it stays empty and the
 * same-origin path is exactly what it was before.
 */
async function writeRuntimeConfig(outputDir: string): Promise<void> {
  const contents = [
    '// Runtime configuration for a deployment that serves this bundle from a',
    '// different origin than the API. Edit apiUrl in place — no rebuild needed.',
    '// Leave it empty to use the origin this page was served from.',
    '//',
    '// Example: window.__MANGO_CONFIG__ = { apiUrl: "https://api.example.com" };',
    'window.__MANGO_CONFIG__ = { apiUrl: "" };',
    '',
  ].join('\n');
  await writeFile(join(outputDir, RUNTIME_CONFIG_URL.slice(1)), contents);
}

/** `/tmp/x/dist/assets/main-abc.js` -> `/assets/main-abc.js`, matching publicPath. */
function distUrl(absolutePath: string, outputDir: string): string {
  return `/${absolutePath.slice(outputDir.length + 1).replaceAll('\\', '/')}`;
}

/**
 * Fail the build if any emitted asset reference is relative. A relative URL only
 * breaks on deep links, so it survives every smoke test that loads `/` and then
 * blanks the page in production.
 */
function assertAbsoluteAssetUrls(html: string): void {
  // Anything that is not root-relative, scheme-qualified, protocol-relative or a
  // fragment. Matching only a `./` prefix would miss the bare form
  // (`assets/x.js`), which resolves against the deep link exactly the same way.
  //
  // Both quote styles, and the attribute has to start at a whitespace boundary:
  // an unanchored `src="` also matches `data-src="`, while a single-quoted
  // `src='./assets/x.js'` slipped through entirely — a hole in the one guard
  // that stands between a relative URL and a blank page on every deep link.
  const relative = [...html.matchAll(/\s(?:src|href)=(?:"([^"]*)"|'([^']*)')/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((url) => url !== '' && !/^(?:\/|#|[a-z][a-z0-9+.-]*:)/i.test(url));
  if (relative.length > 0) {
    throw new Error(`Built index.html has relative asset URLs: ${relative.join(', ')}`);
  }
}

if (import.meta.main) {
  removeTempPathsOnSignal();
  const started = performance.now();
  try {
    await buildFrontend({ dev: process.argv.includes('--dev') });
  } catch (error) {
    // Not decoration. A failed publish can leave a tracked backup holding the
    // only copy of the previous bundle while `dist/` is absent, and unwinding
    // through an unhandled rejection would kill the process without ever
    // running `removeTempPaths` — the exact stranded-backup failure the
    // transaction exists to prevent. `removeTempPathsOnSignal` does not cover
    // this: no signal is delivered on a plain throw.
    removeTempPaths();
    console.error(error);
    process.exit(1);
  }
  const count = listDistFiles(DIST).length;
  console.warn(`[frontend] built ${count} files in ${Math.round(performance.now() - started)}ms`);
}

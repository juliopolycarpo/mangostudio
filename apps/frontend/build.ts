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

import { readdirSync, statSync, utimesSync } from 'node:fs';
import { cp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * Regenerate `src/routeTree.gen.ts` from `src/routes/`. Was the Vite plugin's
 * job; `@tanstack/router-cli` produces a byte-identical file. Routed through the
 * `routes` package script rather than invoked directly so the dependency stays
 * visible to knip.
 */
async function generateRouteTree(): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', 'routes'], {
    cwd: ROOT,
    // `ignore`, not `pipe`: nothing reads stdout, and an undrained pipe leaks a
    // descriptor per run — the dev watcher calls this on every save.
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
 * the dev rebuild loop can skip the `tsr generate` spawn — measured at ~1.1s
 * of a ~3s dev rebuild, paid on every save anywhere under `src/`.
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
function resolveApiUrlOverride(): string {
  const current = process.env.MANGO_API_URL;
  if (current) return current;

  const deprecated = process.env.VITE_API_URL;
  if (deprecated) {
    console.warn(
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
  await rm(DIST, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.tsx')],
    outdir: DIST,
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
      'process.env.MANGO_API_URL': JSON.stringify(resolveApiUrlOverride()),
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

  await cp(PUBLIC_DIR, DIST, { recursive: true });
  await writeHtml(result);
  // Next to dist/, not inside it: the binary build embeds every file dist/
  // contains, and the metafile is a build diagnostic (the bundle report's
  // duplicate-module check reads it), not shipped payload. Sitting outside
  // dist/ also puts it outside the `dist/**` glob, so it is declared as a
  // second `build` output in turbo.json — otherwise a cache hit restores dist/
  // and leaves whatever metafile happens to be on disk describing it.
  await writeFile(join(ROOT, 'dist-metafile.json'), JSON.stringify(result.metafile));
}

async function writeHtml(result: Awaited<ReturnType<typeof Bun.build>>): Promise<void> {
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
        `Decide which are eager before shipping: ${stylesheets.map((s) => distUrl(s.path)).join(', ')}`
    );
  }
  const css = stylesheets[0];

  const template = await Bun.file(HTML_TEMPLATE).text();
  if (!template.includes(SOURCE_SCRIPT_TAG)) {
    throw new Error(`index.html no longer contains the expected script tag: ${SOURCE_SCRIPT_TAG}`);
  }

  const tags = [
    css ? `<link rel="stylesheet" crossorigin href="${distUrl(css.path)}" />` : null,
    // A *classic* script, and it must stay classic: a classic script without
    // `defer`/`async` runs the moment the parser reaches it, while module
    // scripts are deferred by default. That ordering is the whole guarantee —
    // `window.__MANGO_CONFIG__` is populated before any bundle code evaluates.
    // Deliberately unhashed so a deployer can edit it in place.
    `<script src="${RUNTIME_CONFIG_URL}"></script>`,
    `<script type="module" crossorigin src="${distUrl(entry.path)}"></script>`,
  ].filter((tag) => tag !== null);

  const html = template.replace(SOURCE_SCRIPT_TAG, tags.join('\n    '));
  assertAbsoluteAssetUrls(html);
  await writeFile(join(DIST, 'index.html'), html);
  await writeRuntimeConfig();
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
async function writeRuntimeConfig(): Promise<void> {
  const contents = [
    '// Runtime configuration for a deployment that serves this bundle from a',
    '// different origin than the API. Edit apiUrl in place — no rebuild needed.',
    '// Leave it empty to use the origin this page was served from.',
    '//',
    '// Example: window.__MANGO_CONFIG__ = { apiUrl: "https://api.example.com" };',
    'window.__MANGO_CONFIG__ = { apiUrl: "" };',
    '',
  ].join('\n');
  await writeFile(join(DIST, RUNTIME_CONFIG_URL.slice(1)), contents);
}

/** `/tmp/x/dist/assets/main-abc.js` -> `/assets/main-abc.js`, matching publicPath. */
function distUrl(absolutePath: string): string {
  return `/${absolutePath.slice(DIST.length + 1).replaceAll('\\', '/')}`;
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

/** Files in `dist/`, relative and '/'-separated. */
async function listDist(): Promise<string[]> {
  const entries = await readdir(DIST, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(DIST.length + 1)
        .replaceAll('\\', '/')
    )
    .sort();
}

if (import.meta.main) {
  const started = performance.now();
  await buildFrontend({ dev: process.argv.includes('--dev') });
  const files = await listDist();
  console.warn(
    `[frontend] built ${files.length} files in ${Math.round(performance.now() - started)}ms`
  );
}

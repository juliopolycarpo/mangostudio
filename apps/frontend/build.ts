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

export interface BuildFrontendOptions {
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
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`tsr generate failed:\n${await new Response(proc.stderr).text()}`);
  }
}

/**
 * Build the app and write `dist/`.
 *
 * Two things here are load-bearing and look optional:
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
export async function buildFrontend(options: BuildFrontendOptions = {}): Promise<void> {
  const production = !options.dev;
  await generateRouteTree();
  await rm(DIST, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.tsx')],
    outdir: DIST,
    target: 'browser',
    splitting: true,
    minify: production,
    sourcemap: 'none',
    publicPath: '/',
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
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
  // duplicate-module check reads it), not shipped payload.
  await writeFile(join(ROOT, 'dist-metafile.json'), JSON.stringify(result.metafile));
}

async function writeHtml(result: Awaited<ReturnType<typeof Bun.build>>): Promise<void> {
  // Resolved by `kind`, not by filename — see the `naming` comment above.
  const entry = result.outputs.find((output) => output.kind === 'entry-point');
  if (!entry) throw new Error('Frontend build produced no entry-point output');
  const css = result.outputs.find((output) => output.path.endsWith('.css'));

  const template = await Bun.file(HTML_TEMPLATE).text();
  if (!template.includes(SOURCE_SCRIPT_TAG)) {
    throw new Error(`index.html no longer contains the expected script tag: ${SOURCE_SCRIPT_TAG}`);
  }

  const tags = [
    css ? `<link rel="stylesheet" crossorigin href="${distUrl(css.path)}" />` : null,
    `<script type="module" crossorigin src="${distUrl(entry.path)}"></script>`,
  ].filter((tag) => tag !== null);

  const html = template.replace(SOURCE_SCRIPT_TAG, tags.join('\n    '));
  assertAbsoluteAssetUrls(html);
  await writeFile(join(DIST, 'index.html'), html);
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
  const relative = [...html.matchAll(/(?:src|href)="(\.\/[^"]*)"/g)].map((match) => match[1]);
  if (relative.length > 0) {
    throw new Error(`Built index.html has relative asset URLs: ${relative.join(', ')}`);
  }
}

/** Files in `dist/`, relative and '/'-separated. // Usage: await listDist() */
export async function listDist(): Promise<string[]> {
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

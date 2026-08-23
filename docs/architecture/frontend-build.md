# Frontend Build and Serving

One bundler, one dev server, one topology. `apps/frontend` is built by `Bun.build()` and
served by Elysia — in development, from `dist/` in a normal install, and from bytes embedded
in the standalone binary. There is no second HTTP server and no proxy.

## Why one server

Vite's dev server ran on `:5173` and proxied four path prefixes (`/api/ws`, `/api`,
`/uploads`, `/images`) to Elysia on `:3001`. That made the shape a developer tested different
from the shape the binary ships: proxy timeouts, WebSocket upgrade handling, and same-origin
behaviour all existed only in dev. Serving the bundle from Elysia collapses the two into one
topology, so a deep link, a WebSocket, and a `/uploads/*` fetch behave the same everywhere.

Consequence: the frontend is same-origin with the API. The CORS origin list defaults to the
server's own origin — `http://localhost:<port>`, `http://127.0.0.1:<port>`, and
`http://<server.host>:<port>` when the bind host is neither of those. `FRONTEND_PORT` and
`frontend.port` are deprecated: both still parse, so an existing `~/.mango/config.toml` or
`.env` keeps booting, but they drive nothing and setting either logs one warning at startup.

## Serving the bundle from another origin

A split deployment — the bundle on a CDN or a separate web server, this API somewhere else —
is still supported, and it is what the `MANGO_API_URL` build-time override exists for. Nothing
can derive that origin, so it is named explicitly:

There are two layers, and the runtime one wins:

| Layer                                            | Where                                          | Who it is for                                         |
| ------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------- |
| `window.__MANGO_CONFIG__.apiUrl` in `/config.js` | emitted unhashed into `dist/`, edited in place | anyone deploying the prebuilt `frontend-dist` tarball |
| `MANGO_API_URL`                                  | `Bun.build()` `define`, baked in               | anyone building the bundle themselves                 |

`/config.js` exists because the build-time variable cannot help the artifact we actually
publish. `mangostudio-<version>-frontend-dist.tar.gz` is built with `MANGO_API_URL` unset, so
the branch reading it is dead-code-eliminated and the bundle's only answer is
`window.location.origin` — serve it from a CDN and every request goes to the CDN instead of
the API. Editing `config.js` repoints it with no rebuild.

It ships with `apiUrl: ""`, which falls through to `window.location.origin`. That is what keeps
the standalone binary unchanged: it embeds the same empty file and stays same-origin, so the
one-binary deployment needs no configuration and no CORS entry.

`build.ts` stitches `/config.js` in as a **classic** script ahead of the module bundle. That
ordering is the guarantee that `window.__MANGO_CONFIG__` is populated before any bundle code
evaluates — a classic script without `defer`/`async` runs where the parser meets it, while
module scripts are deferred. Keep it classic. The API serves it `no-cache` rather than the
`max-age=86400` other unhashed files get, because it is the one file a deployer edits.

`VITE_API_URL` is accepted as a deprecated alias of `MANGO_API_URL` for one release and warns
at build time; it is named after a bundler this repo no longer uses.

```toml
[server]
allowedOrigins = ["https://studio.example.com"]
```

or `ALLOWED_ORIGINS=https://studio.example.com,https://staging.example.com` in the
environment (comma-separated; the env value replaces the TOML list). Each entry must be a
bare `scheme://host[:port]` origin: no path, no trailing slash, no explicit default port. All
three gates that guard a browser request — the CORS middleware in `apps/api/src/app.ts`,
Better Auth's `trustedOrigins`, and the realtime WebSocket handshake — compare the `Origin`
header by exact string, so an entry that is merely close would match nothing. Startup fails
with the canonical form rather than accepting one silently.

Configured origins are added to the server's own, never substituted for them, so a local
browser session keeps working alongside them.

## Development

`bun run dev` starts one process. Before it listens, `apps/api/src/server/dev-frontend.ts`
runs the production build script as a subprocess — but only when `dist/` is older than the
frontend or shared inputs, the root `package.json`, or `bun.lock`. The root dependency files
matter because a lockfile-only transitive update changes the bytes the bundler resolves without
touching frontend source. `bun --watch` restarts this process on every `apps/api/src` save, and
each restart would otherwise rebuild from scratch. Serving is the ordinary directory mode
below — dev and production share both the build and the route table, so there is no dev-only
serving path to drift.

Mtimes cannot see the one input that is not a file. Every build — dev and production alike —
stamps `dist/.build-state.json` with the `MANGO_API_URL` it compiled in and the mode it ran
in, and the freshness check rebuilds when that URL differs from the running server's, or when
the stamp is missing or unreadable. The mode is not part of the comparison: a production
bundle answers `bun run dev` perfectly well. It is only reported, because a dev rebuild
replaces a production bundle with an unminified one and that should not happen quietly.

The stamp lives inside `dist/` so the rename that publishes a build publishes it too, which
means the directory's wholesale consumers have to skip it: `listDistFiles` drops it (keeping it
out of the embedded manifest, where it would become a route the shipped binary answers, and
out of the bundle reports), `archive-assets.ts` excludes it from the `frontend-dist` tarball,
and `frontend-static.ts` refuses to serve its path from a live `dist/`.

That rename is a transaction: the live bundle moves aside to `.dist-backup-<uuid>` first, because
POSIX cannot rename a directory over a non-empty one. Both renames are synchronous, so a Ctrl-C
cannot land between them. A build that fails *after* the backup is taken unwinds through the CLI
entrypoint, which restores `dist/` rather than leaving the only copy of the previous bundle
stranded under a dotted name — the one exception being a rollback that could not remove the
failed bundle, where the backup is kept on disk instead of deleted.

**Nothing watches the frontend.** After editing a frontend file, run
`bun run --filter @mangostudio/frontend build` and refresh. A watcher used to do this on save;
it was never hot reload, so a refresh was needed either way, and what it bought — saving one
command — cost a hand-maintained input allowlist that mistook a turbo log for a source change,
a debounce-and-coalesce state machine, and a rebuild that removes `dist/` out from under the
running server.

**There is no HMR, and this is not a temporary omission.** Bun's HTML-bundle dev server
(`Bun.serve({ routes: { '/': htmlBundle } })`) silently drops a nested transitive import from
this app's dependency graph, which renders a blank page. So does `Bun.build()` when handed
`index.html` as the entrypoint. Only a **TS entrypoint** (`src/main.tsx`) bundles this app
correctly, and the HTML is stitched afterwards — see `apps/frontend/build.ts`. A rebuild takes
about 1.5s; the browser needs a manual refresh.

## Production build

`apps/frontend/build.ts`, run by `bun run --filter @mangostudio/frontend build`. `Bun.build()`
in a script, not the `bun build` CLI — the CLI has no plugin flag, and Tailwind v4 needs one.
The script builds and checks a staging directory first, then replaces `dist/`. A failed build
leaves the previous bundle available to the dev server. The build produces the layout the rest
of the repo already expects:

```text
apps/frontend/dist/
  index.html
  assets/<name>-<hash>.js
  assets/<name>-<hash>.css
  fonts/<family>-latin-wght.woff2
```

Six things in that build are load-bearing:

- **The entrypoint is `src/main.tsx`, never `index.html`.** Bun's HTML loader drops a nested
  transitive import from this graph. `build.ts` stitches the built `<script>`/`<link>` tags
  into `index.html` itself.
- **`naming`** reproduces the `index.html` + `assets/*-[hash].*` layout, and gives chunks a
  `chunk-` prefix so they cannot collide with the entry. Under `splitting: true` Bun names a
  dynamic-import chunk after the entry that reaches it, so a shared pattern yields eighteen
  files called `assets/main-<hash>.js`.
- **The stitched `<script>` is resolved by `kind === 'entry-point'`**, never by filename. Pick
  a chunk by mistake and the page renders blank with no console error at all.
- **`publicPath: '/'`** forces absolute asset URLs. Bun defaults to relative (`./assets/…`),
  which resolves correctly at `/` and 404s on every deep link — a blank page with no
  server-side error. `build.ts` asserts on this; nothing in CI catches it otherwise.
- **The `NODE_ENV` define.** Nothing in this repo sets `NODE_ENV`, and `Bun.build()` then
  resolves `process.env.NODE_ENV` to `'development'` — so React, its scheduler, and every
  dev-gated dependency selected their *development* builds in a minified production bundle
  (+78 kB gzip eager, plus React's dev-mode runtime checks). Vite inlined `'production'`;
  the explicit `define` in `build.ts` restores that.
- **`external: ['/fonts/*']`.** The self-hosted fonts are copied verbatim from `public/fonts/`
  into `dist/`, so the `@font-face` `url("/fonts/…")` in `src/index.css` and the
  `<link rel="preload">` tags in `index.html` name one stable, un-hashed path. Without the
  `external` entry the CSS bundler tries to resolve that absolute URL against the filesystem
  at build time and the build fails.

Chunking is Bun's automatic splitting; there is no `manualChunks` equivalent and none is
reintroduced. Bundle size is tracked instead of controlled:

```bash
bun ./scripts/ci/frontend-bundle-report.ts --baseline scripts/ci/frontend-bundle-baseline.json
```

The baseline is the pre-migration Vite output. Rows are keyed by hash-stripped chunk name, so
a rebuild is not reported as wholesale churn. The report splits the bundle into **eager**
(what a first paint downloads: `index.html`, its stylesheet and script tags, and the
static-import closure of those scripts) and **lazy**, because a totals-only diff cannot tell
"we shipped more code" apart from "lazy code went eager". The build also writes
`apps/frontend/dist-metafile.json` (gitignored), which the report reads to flag any module
bundled into more than one chunk.

## Serving a built frontend

`apps/api/src/server/frontend-static.ts` picks one of three modes at boot:

| Mode      | When                                       | Behaviour                                                                               |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Embedded  | the binary registered an embedded manifest | one explicit `GET` per embedded asset                                                   |
| Directory | `dist/index.html` exists on disk           | `@elysia/static` on `/assets`, everything else resolved per request in the SPA fallback |
| API-only  | neither                                    | a plain 404 for non-`/api` paths                                                        |

Two shapes there are deliberate and must survive any change:

- **No root wildcard.** A root `GET /*` shadows every `.all('/*')` route once `.listen()`
  promotes routes into Bun's native table — at the root, inside a `.group()` and inside a
  mounted prefixed instance alike. Literal routes and `.get('/*')` wildcards are unaffected,
  which is why `/images/*` and `/uploads/*` kept working and Better Auth (mounted as
  `.all('/*')` in `routes/auth.ts`) did not: sign-in, sign-up and get-session answered 404
  while `/api/auth/ok` worked. So the embedded mode registers assets one route at a time, and
  the directory mode scopes `@elysia/static` to `prefix: '/assets'` rather than `'/'` (the
  plugin mounts `${prefix}/*` unless `alwaysStatic` is on, and that keys off
  `NODE_ENV === 'production'`, which nothing here sets). `/assets` stays dynamic because a dev
  rebuild renames every bundle file.
- **The SPA fallback returns a `Response`**, built from `Bun.file(indexPath)`, never an
  imported `HTMLBundle`. An `HTMLBundle` returned from an error handler gets JSON-serialized.

The directory mode resolves unhashed files (favicon, icons, manifest, build-info) inside that
same fallback, per request. Enumerating them into routes at boot looked safe — the names are
fixed — but the *set* is not: a dev rebuild lands while the server runs, so a file added to
`public/` afterwards had no route, fell through to the fallback and came back as `index.html`
at 200 `text/html`. `isSpaRoute()` therefore stops claiming root-level paths that carry a file
extension, so a missing one is a 404 instead of an HTML document handed to an `<img>`. The
rule is anchored to a single segment: `/library/my-skill.md` is a real SPA deep link. Ownership
checks decode the pathname first, so encoded API roots and file extensions cannot fall through
to the shell; malformed escapes and decoded traversal forms also fail with a 404.

`app.handle()` resolves both correctly, so an in-process test cannot see either failure. The
`over a listening server` suite in `apps/api/tests/unit/server/frontend-static.test.ts` binds
a real port; extend it rather than adding another `handle()`-driven case.

`/assets/*` is immutable (`max-age=31536000`) in both modes because its filenames are
content-hashed; unhashed root files get `max-age=86400` with an ETag, matching what the static
plugin used to add for them. `index.html` is `no-cache` — it must revalidate so an upgraded
install stops serving a stale shell — and carries an ETag derived from its stat, without which
`no-cache` degenerates into re-sending the whole document on every navigation. Inside a
compiled binary there is no inode to stat, so the shell ships there without a validator; its
content cannot change within one binary anyway.

## The standalone binary

`scripts/lib/embed-frontend.ts` generates two throwaway modules under `.mango/out/embed/`
(gitignored): a manifest that imports every file in `dist/` with Bun's `type: 'file'` loader,
and an entry that registers the manifest before booting the real CLI. `bun build --compile`
embeds the bytes and rewrites each import to an embedded path that `Bun.file()` can serve.

This is why the dev-mode build sits behind a **module boundary**, not a runtime
`if`. `apps/api/src/dev.ts` is a separate entrypoint that `index.ts` — the binary entry —
never imports, so nothing in `dev-frontend.ts` reaches `bun build --compile`. A binary must
never shell out to a bundler; it already carries the built output. `dev-frontend-dir.ts` is
the seam that lets `start-server.ts` read the dev directory without depending on the dev
module, the same shape `frontend-fallback.ts` uses.

`bun scripts/test-build.ts` is the only gate that runs the compiled binary. `bun run check`,
`bun run test` and `bun run verify` are all blind to binary-only breakage.

## Testing

`bun test` with happy-dom, registered through `bunfig.toml`'s `[test] preload`. Registration
must happen in a preload file that does not import `@testing-library/react`: preloads run in
order, and a shared file evaluates `@testing-library/dom` before `document` exists, leaving
`screen` silently broken.

Module aliasing (`@/…`, `motion/react`) is resolver-level — `tsconfig.json` `paths` — not
`mock.module`. A module mock is not undone by `mock.restore()` and leaks across files in the
shared module graph.

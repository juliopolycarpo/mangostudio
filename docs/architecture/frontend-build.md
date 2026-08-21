# Frontend Build and Serving

One bundler, one dev server, one topology. `apps/frontend` is built by `Bun.build()` and
served by Elysia — in development, from `dist/` in a normal install, and from bytes embedded
in the standalone binary. There is no second HTTP server and no proxy.

> Status: the destination. `apps/api` already serves `dist/` and the embedded bundle exactly
> as described below; the bundler and the dev server are being migrated off Vite on
> `refactor/bun-frontend`. The migration's measured traps live in the `bun-frontend` skill —
> read it before changing anything on this page's path.

## Why one server

Vite's dev server ran on `:5173` and proxied four path prefixes (`/api/ws`, `/api`,
`/uploads`, `/images`) to Elysia on `:3001`. That made the shape a developer tested different
from the shape the binary ships: proxy timeouts, WebSocket upgrade handling, and same-origin
behaviour all existed only in dev. Serving the bundle from Elysia collapses the two into one
topology, so a deep link, a WebSocket, and a `/uploads/*` fetch behave the same everywhere.

Consequence: the frontend is same-origin with the API, so the CORS origin list and
`FRONTEND_PORT` / `frontend.port` stop carrying weight.

## Development

Elysia registers the app's `index.html` as a Bun `HTMLBundle` and serves it on the API port.
Bun's bundler handles the module graph in-process: React Fast Refresh for components, Tailwind
through `bun-plugin-tailwind` so CSS stays in the module graph rather than being generated
beside it. Browser console output is echoed into the terminal.

The route table is unchanged from production: explicit API routes and mounted plugins match
first, and only the paths nothing else claimed fall through to the SPA shell.

## Production build

`Bun.build()` in a script, not the `bun build` CLI — the CLI has no plugin flag, and Tailwind
is a plugin (T1 in the skill). The build produces the layout the rest of the repo already
expects:

```text
apps/frontend/dist/
  index.html
  assets/<name>-<hash>.js
  assets/<name>-<hash>.css
```

Two options in that build are load-bearing:

- **`naming`** reproduces the `index.html` + `assets/*-[hash].*` layout. Everything downstream
  enumerates `dist/` generically, so keeping the layout keeps the API side untouched.
- **`publicPath: '/'`** forces absolute asset URLs. Bun defaults to relative (`./assets/…`),
  which resolves correctly at `/` and 404s on every deep link — a blank page with no
  server-side error. Nothing in CI catches this.

Chunking is Bun's automatic splitting; there is no `manualChunks` equivalent and none is
reintroduced. Bundle size is tracked instead of controlled:

```bash
bun ./scripts/ci/frontend-bundle-report.ts --baseline scripts/ci/frontend-bundle-baseline.json
```

The baseline is the pre-migration Vite output. Rows are keyed by hash-stripped chunk name, so
a rebuild is not reported as wholesale churn.

## Serving a built frontend

`apps/api/src/server/frontend-static.ts` picks one of three modes at boot:

| Mode      | When                                       | Behaviour                             |
| --------- | ------------------------------------------ | ------------------------------------- |
| Embedded  | the binary registered an embedded manifest | one explicit `GET` per embedded asset |
| Directory | `dist/index.html` exists on disk           | `@elysia/static` over the directory   |
| API-only  | neither                                    | a plain 404 for non-`/api` paths      |

Two shapes there are deliberate and must survive any change:

- **No root wildcard.** A root `app.get('/*')` would shadow mounted handlers — Better Auth's
  `/api/auth/*` most visibly — so embedded assets are registered one route at a time.
- **The SPA fallback returns a `Response`**, built from `Bun.file(indexPath)`, never an
  imported `HTMLBundle`. An `HTMLBundle` returned from an error handler gets JSON-serialized.

`/assets/*` is immutable (`max-age=31536000`) because its filenames are content-hashed;
`index.html` must revalidate so an upgraded install stops serving a stale shell.

## The standalone binary

`scripts/lib/embed-frontend.ts` generates two throwaway modules under `.mango/out/embed/`
(gitignored): a manifest that imports every file in `dist/` with Bun's `type: 'file'` loader,
and an entry that registers the manifest before booting the real CLI. `bun build --compile`
embeds the bytes and rewrites each import to an embedded path that `Bun.file()` can serve.

This is why the dev server's HTML bundle must sit behind a **module boundary**, not a runtime
`if`: Bun's bundler statically analyzes `import` and `await import()` alike, so a top-level
`import index from './index.html'` in a server module would drag the whole frontend source
graph into a binary that already carries the built output. Only the generated entry populates
the registry — the same shape `embedded-frontend.ts` uses today.

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

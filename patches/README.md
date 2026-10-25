# Dependency patches

Patches applied by Bun at install time via `patchedDependencies` in the root
`package.json`. Each entry below records what it fixes and the condition for
deleting it, so a dependency bump can retire a patch instead of carrying it
forever.

To edit one: `bun patch <package>`, change the files under
`node_modules/<package>`, then `bun patch --commit node_modules/<package>`.

> Bun caches the patched extraction under
> `~/.bun/install/cache/<pkg>@<hash>_patch_hash=<hash>`. After changing a patch,
> a plain `bun install` can reuse the stale extraction and report `no changes`;
> remove that cache directory to force a re-apply. Verify the result by reading
> the file in `node_modules`, not by trusting the install output.

## `@elysia/openapi@2.0.0-beta.6`

One defect still present in beta.6, in `dist/` only — no source change is
possible from here. (Through `2.0.0-beta.1` this patch also rewrote leaked
`../node_modules/typebox/...` import paths in `dist/gen/*` and dropped the
barrel's eager `./gen` import; `2.0.0-beta.4` imports `typebox/type` and
declares `typebox` as a peer dependency, so that half was retired.)

### File schemas are published as internal markers (`dist/openapi.*`)

`t.File()` serializes to `{"~kind":"File","~elyTyp":10}` rather than to a
schema. `enumToOpenApi` passes unrecognized nodes through untouched, so those
markers land verbatim in the served document — no `format: 'binary'`, which is
what drives multipart handling in generated clients and the upload control in
Scalar.

The patch teaches `enumToOpenApi` two things:

- a `~kind: 'File'` node converts to `{ type: 'string', format: 'binary' }`
- the `~elyTyp` tag is dropped from `anyOf`/`oneOf`/`allOf` nodes; upstream
  already recurses into their branches, so composed file schemas
  (`t.Files()`) convert too

`mapJsonSchema` cannot do this from application code: it is consulted only for
schemas carrying a `~standard` vendor tag, which native TypeBox nodes do not
have. Nor can a route's `detail` — the generator assigns `requestBody` after
spreading `detail`, overwriting it. The node itself is frozen, so it cannot be
annotated at the declaration site either.

The declared `maxSize`/`type` constraints are **not** recoverable: they live in
non-enumerable closures on that frozen node. They are still enforced when a
request is validated; they can no longer be published.

**Drop when:** the plugin converts file schemas itself. The
`publishes no framework-internal schema markers` assertion in
`apps/api/tests/integration/routes/app-plugin-contract.integration.test.ts`
covers this and will keep passing once upstream does the conversion.

## `@xterm/addon-webgl@0.19.0`

A failing `WebglRenderer` constructor can leave canvases, observers, listeners
and cursor blink resources behind before `WebglAddon` receives the renderer.
Disposing the addon cannot release resources from partial construction.

The patch registers parent and child cleanup before construction can fail,
rejects null GL allocations, deletes temporary shaders and untransferred programs,
and releases owned programs, vertex arrays, buffers and textures. Capability
limits are committed together so a failed query cannot poison the next renderer.
Cleanup attempts preserve the exact original exception, including when secondary
cleanup or diagnostic reporting throws. The active renderer's atlas stays owned
when another renderer cannot acquire a context.

The patch maintains four TypeScript sources, ESM and CommonJS bundles, and both
source maps. The browser regressions exercise the published entries with real
WebGL2 calls and named allocation failures. Resource counters disable optional
context loss and count native deletion calls; they do not measure GPU memory
reclamation. Context-loss fallback remains optional, and transaction safety when
an old disposer throws during restoration is outside this constructor repair. See
[#1627](https://github.com/juliopolycarpo/mangostudio/issues/1627) and
[#1641](https://github.com/juliopolycarpo/mangostudio/pull/1641).

**Drop when:** a verified upstream addon release owns cleanup after partial
`WebglRenderer` construction and the existing
[constructor failure regressions](../tests/browser-smoke/webgl-constructor.spec.ts)
pass without this patch in both ESM and CommonJS bundles.

### Rebuild the WebGL patch

Use upstream xterm.js commit `f447274f430fd22513f6adbf9862d19524471c04`
(the `@xterm/addon-webgl` 0.19.0 release), TypeScript 5.5.3, webpack 5.94.0,
webpack-cli 4.10.0 and esbuild 0.25.2. Migrate its official `package-lock.json`
with `bun install --lockfile-only` in an isolated checkout and keep that lock
for `bun install --frozen-lockfile`. The addon build does not need the demo's
node-pty lifecycle: a build-only mirror may install with `--ignore-scripts`,
then explicitly run `bun node_modules/esbuild/install.js`. This does not qualify
the upstream demo or native development dependencies.

Apply the patch's four `src/` changes under upstream `addons/addon-webgl/src/`,
then run from the upstream root:

```sh
bun node_modules/typescript/bin/tsc -b addons/addon-webgl/src
(cd addons/addon-webgl && bun ../../node_modules/webpack-cli/bin/cli.js --config webpack.config.js)
bun bin/esbuild.mjs --prod --addon=webgl
```

Before editing the installed addon, run `bun patch @xterm/addon-webgl`. Copy the
four sources and four generated `lib/` bundle/map files into that prepared
package, then run `bun patch --commit <prepared-package-path>` using the exact
path printed by Bun (isolated installs place it below `node_modules/.bun/`). Verify
the frontend's installed package matches the generated files after installation,
and each map's `sourcesContent` matches the patched sources. The same pinned
recipe reproduces all four unpatched published assets byte for byte before
applying source changes. Run the constructor browser regressions for both
manifest entries and the normal terminal restoration regressions after rebuilding.

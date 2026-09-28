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

## `@elysia/openapi@2.0.0-beta.4`

One defect in the published beta, in `dist/` only — no source change is
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

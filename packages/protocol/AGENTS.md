# Mango Protocol — workspace guidelines

Deltas for the Mango Protocol only. The root `AGENTS.md` still applies.

Mango Protocol is one wire contract published three ways: the normative spec under `spec/`, the
TypeScript SDK `@mangostudio/protocol` here, and the Rust crate `mango-protocol` under
`crates/mango-protocol/`. They must never disagree; the lanes below are how the repository proves
it.

## Layout

| Path                                                                     | Owns                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `spec/mango-protocol-1.md`, `spec/transports/*.md`, `spec/versioning.md` | Normative text                                                                               |
| `spec/schema/1/*.json`                                                   | Normative JSON Schema 2020-12, one file per wire shape                                       |
| `spec/fixtures/1/`                                                       | Conformance corpus consumed by both SDKs                                                     |
| `packages/protocol/`                                                     | TypeScript SDK: types, codec, session, transports, contracts, testing kit                    |
| `crates/mango-protocol/`                                                 | Rust crate: types, codec, a tokio session, a contract builder, the transports, a testing kit |
| `crates/mango-protocol/fuzz/`                                            | cargo-fuzz targets; its own workspace, nightly only                                          |
| `docs/protocol/`                                                         | Guides: build a contract, adopt in TS or Rust, versioning, conformance, releasing            |
| `scripts/protocol/`                                                      | The protocol lanes: check, test, fix, release preparation, schema equality, fixtures         |

## Validation

`bun run check` and `bun run test` run the **TypeScript half only** (`--ts-only`). The Rust half —
Clippy over the feature powerset, `cargo doc`, the cross-language round trip — is a 25-minute cold
lane, so it lives in the path-filtered `.github/workflows/protocol-ci.yml` rather than in every
run of the repository gate.

For any change under the paths above, run the full gate before handoff:

```sh
bun run protocol:check     # adds rustfmt, Clippy, cargo doc, the feature powerset, the round trip
bun run protocol:test      # adds cargo test and the interop suites
```

Both degrade to the TypeScript half with a warning when `cargo` is not on PATH.

The Rust SDK is a member of the root Cargo workspace and uses the root `Cargo.lock`. The
`mangostudio` launcher shares that workspace but not the protocol version or MSRV. Keep protocol
path filters scoped to `crates/mango-protocol/**`; launcher-only changes must not enter the
protocol changelog or masquerade as wire-contract changes. The fuzz crate remains an excluded
nightly workspace with its own lockfile.

## Resolving from the workspace, publishing from a build

`exports` points at `src/`, like every other workspace here. Nothing in the Turbo graph builds
`dist/` before a typecheck or a test lane (`typecheck` is `dependsOn: ["^typecheck"]`, the
`test:*` lanes declare none), so a `dist`-pointing workspace link would be unresolvable on a clean
checkout.

The published map lives in `publishConfig.exports` and points at `dist/` — but **npm does not
apply it**. Measured on npm 11.19.0: `npm pack` copies `publishConfig` into the tarball verbatim
and leaves `exports` alone, so a tarball packed from this directory installs with an `exports` map
pointing at `src/`, which `files` does not ship, and every import fails with
`Cannot find module '@mangostudio/protocol'`.

So packing goes through a staging directory:

```sh
bun run protocol:pack             # build, stage into .mango/out/protocol, npm pack there
bun run protocol:verify-package   # …then install the tarball and import every subpath
```

`scripts/protocol/package-contents.ts` builds the staged manifest: `exports` replaced by the
published map, `publishConfig` stripped of its copy, and `scripts` dropped (they reference
`build.ts`, which the tarball does not ship). `protocol-release.yml` publishes from that staged
directory, never from here.

Two consequences:

- `./schema/*` is a **published-only** subpath. `build.ts` copies `spec/schema/1/` into
  `packages/protocol/schema/`, which is gitignored; in-repo readers take `spec/schema/1/` directly
  (see `scripts/runtime-contract/validate.ts`).
- The published `files`/`exports` are proved by the pack-and-consume lane in `protocol-ci.yml` and
  nowhere else. It is not optional.

## Contract-change procedure

A wire change lands as one task that touches every layer, in this order, and is reviewed as one:

1. **Spec first.** Edit `spec/mango-protocol-1.md` (or a transport spec). Say what changes, why,
   and whether it is additive. Non-additive changes bump the wire major and need a new
   `spec/schema/<major>/` directory.
2. **Schema.** Edit `spec/schema/<major>/*.json`. Tagged unions are `oneOf` with a `const` tag.
   Optional fields are absent, never `null`. Open records use `additionalProperties`. Never use
   `patternProperties` for records or OpenAPI `discriminator`.
3. **TypeScript.** Mirror the shape in `packages/protocol/src/schemas/*.ts` with TypeBox. Where
   TypeBox cannot express the spec (a `oneOf`), use `Type.Unsafe` with the exact JSON.
4. **Rust.** Mirror the shape in `crates/mango-protocol/src/` with serde, `#[serde(tag = "type")]`
   for frames, `skip_serializing_if = "Option::is_none"` on optionals, and the `schemars` derive
   behind the `schema` feature.
5. **Fixtures.** Add `y_`, `n_` or `i_` cases under `spec/fixtures/1/`. Both suites read them.
6. **Docs.** Update `docs/protocol/`. The changelog is generated — see below.

The schema-equality lane emits the TS and Rust schemas, applies the normaliser below, and
deep-compares them with the spec. A change that needs a new normaliser rule is a review flag, not
a quick fix.

Normaliser rules (`packages/protocol/src/testing/schema.ts`, re-exported from
`@mangostudio/protocol/testing` as `normalizeSchema` so a consumer applies the same ones):
`$ref` to `#/$defs/<name>` is inlined;
`$schema`, `$id`, `title`, `description`, `$comment`, `examples` and `format` are dropped where
they are keywords, never where they are a member's name (inside `properties`, `patternProperties`,
`dependentSchemas`, `$defs` or `definitions`);
`additionalProperties: true` is dropped; a TypeBox `anyOf` whose branches carry distinct `type`
consts becomes `oneOf`; the `null` alternative schemars adds to an `Option` member is stripped;
key order is ignored. Nothing else is tolerated.

## Wire rules

- Envelope keys without a prefix belong to the spec; `x-` is reserved for vendor extensions.
  Method names and event topics under `rpc.` are reserved for the spec.
- Decoders ignore unknown envelope keys. Every field added after wire 1.0 is optional.
- The TS core (`src/index.ts` and what it imports) must not import `node:` modules; only subpath
  entries (`stdio`, `ipc`, `spawn`) may.
- `cancel` is advisory: a handler's signal aborts, and the original response always follows.
- stdout is the protocol stream on stdio transports; diagnostics go to stderr.

## Release train

The protocol has its own version line and its own tag prefix, `protocol-v*` — the bare `v*` tags
belong to the application and fire `.github/workflows/release.yml`. Three manifests move together
and `bun run protocol:check` enforces it: `packages/protocol/package.json`, the root `Cargo.toml`
`[workspace.package]` version, and `Cargo.lock`. The root `package.json` version is the
application's and is deliberately **not** one of them.

```sh
bun run protocol:release:prepare 0.2.1   # rewrites the three, prepends the new CHANGELOG section
```

`packages/protocol/CHANGELOG.md` is generated by git-cliff from Conventional Commits
(`packages/protocol/cliff.toml`) and **prepended to, never regenerated** — its 0.1.0 and 0.2.0
sections were generated upstream, before the tree moved here, and cannot be reproduced from this
history (the note at the bottom of that file has the measurements). Never edit it by hand.

Commit scopes for this tree: `ts`, `rs`, `spec`, `schema`, `fixtures`, `protocol`.

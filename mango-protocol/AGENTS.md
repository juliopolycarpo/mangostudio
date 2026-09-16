# Repository Guidelines

`AGENTS.md` is the canonical root instruction file for this repository. Mango Protocol is one
wire contract published three ways: the normative spec under `spec/`, the TypeScript SDK
`@mangostudio/protocol` under `packages/protocol/`, and the Rust crate `mango-protocol` under
`crates/mango-protocol/`. They must never disagree; the tests below are how the repo proves it.

## Command Guidelines

1. **Always use** `bun` or `bunx` for the JavaScript half and `cargo` for the Rust half.
2. **Never use** `npm`, `npx`, `pnpm` or `yarn`. The one exception is the `npm publish` step
   inside the release workflow, which exists because npm trusted publishing needs the npm CLI.
3. Run root scripts from the repository root: `bun run check`, `bun run test`, `bun run fix`.
   Flags `--ts-only` and `--rs-only` narrow them. Read `package.json` before inventing a script.

## Working Loop

1. Read this file, then `spec/mango-protocol-1.md` if the change touches the wire.
2. Start from the closest entrypoint: a schema file, a codec, the session, a transport, a test.
3. Trace one layer outward at a time: spec → schema → TS → Rust → fixtures → docs.
4. Run the smallest relevant validation first (`bun run check --ts-only`, one `bun test` file,
   one `cargo test` filter), then the full `bun run check && bun run test` before handoff.

## Layout

| Path                                                                     | Owns                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `spec/mango-protocol-1.md`, `spec/transports/*.md`, `spec/versioning.md` | Normative text                                                                               |
| `spec/schema/1/*.json`                                                   | Normative JSON Schema 2020-12, one file per wire shape                                       |
| `spec/fixtures/1/`                                                       | Conformance corpus consumed by both SDKs                                                     |
| `packages/protocol/`                                                     | TypeScript SDK: types, codec, session, transports, contracts, testing kit                    |
| `crates/mango-protocol/`                                                 | Rust crate: types, codec, a tokio session, a contract builder, the transports, a testing kit |
| `docs/`                                                                  | Guides: build a contract, adopt in TS or Rust, versioning, conformance, releasing            |
| `scripts/`                                                               | Root Bun scripts: check, test, fix, release preparation, schema equality                     |

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
6. **Docs.** Update `docs/` and `CHANGELOG.md` through a Conventional Commit; never edit the
   changelog by hand.

The schema-equality test (`bun run check` runs it) emits the TS and Rust schemas, applies the
normaliser below, and deep-compares them with the spec. A change that needs a new normaliser
rule is a review flag, not a quick fix.

Normaliser rules (`packages/protocol/src/testing/schema.ts`, re-exported from
`@mangostudio/protocol/testing` as `normalizeSchema` so a consumer applies the same ones):
`$ref` to `#/$defs/<name>` is inlined;
`$schema`, `$id`, `title`, `description`, `$comment`, `examples` and `format` are dropped where
they are keywords, never where they are a member's name (inside `properties`, `patternProperties`,
`dependentSchemas`, `$defs` or `definitions`);
`additionalProperties: true` is dropped; a TypeBox `anyOf` whose branches carry distinct `type`
consts becomes `oneOf`; the `null` alternative schemars adds to an `Option` member is stripped;
key order is ignored. Nothing else is tolerated.

## Global Rules

- Envelope keys without a prefix belong to the spec; `x-` is reserved for vendor extensions.
  Method names and event topics under `rpc.` are reserved for the spec.
- Decoders ignore unknown envelope keys. Every field added after wire 1.0 is optional.
- The TS core (`packages/protocol/src/index.ts` and what it imports) must not import `node:`
  modules; only subpath entries (`stdio`, `ipc`, `spawn`) may.
- `cancel` is advisory: a handler's signal aborts, and the original response always follows.
- stdout is the protocol stream on stdio transports; diagnostics go to stderr.
- Every new function gets a test. A bug fix gets a regression test that fails first with the
  expected shape. Mock external I/O with named fake classes, not inline stubs.
- Exception and error messages include the received value and the expected shape.
- Keep changes scoped. Do not reformat unrelated files.

## Commits and pull requests

- Conventional Commits with a body: `type(scope): summary`. Scopes: `ts`, `rs`, `spec`,
  `schema`, `fixtures`, `docs`, `ci`, `build`, `deps`, `release`. One concern per commit.
- Signing and sign-off come from git config. Never write `Signed-off-by:` or `Co-authored-by:`
  trailers by hand.
- `CHANGELOG.md` is generated by git-cliff from commits (`bun run changelog`).
- PRs follow `.github/pull_request_template.md`.

## Validation

After every change run `bun run check`. If it fails, run `bun run fix` and check again.
Before final handoff run `bun run check && bun run test`.

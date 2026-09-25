# Runtime Contract: One Source, Two Languages

The hub/runtime contract — every method, event, capability, and error the two ends of
[hub-runtime.md](hub-runtime.md) exchange — has exactly one owner:
`apps/shared/src/runtime-contract/`. Its TypeBox schemas are the source of truth for the
TypeScript hub and for the Rust runtime (`crates/mangostudio-runtime`) alike.

## Who owns what

`apps/shared/src/runtime-contract/` defines the contract in TypeBox: every method's `params`
and `result`, every event topic's payload, the capability manifest, and the error vocabulary.
`scripts/runtime-contract/emit.ts` renders it into seven committed artifacts under
`apps/shared/src/runtime-contract/generated/`: six schema and string documents, plus the
behavioural conformance corpus covered in its own section below.

- `catalog.json` — every method and event, conforming to the Mango Protocol's own
  `catalog.json` schema (`crates/mango-protocol`'s `Catalog` type).
- `manifest.schema.json`, `health.schema.json`, `install-output.schema.json`,
  `runtime-home.schema.json` — standalone JSON Schema documents for shapes that are not on the
  method/event table (or, for `install-output.schema.json`, that also need to stand alone
  outside the event wire).
- `strings.json` — the contracts that are not schemas at all: error kinds, the update exit
  code, the pairing token prefix, runtime-home file names. Nothing here is derivable from a
  type; it is a fact one process must spell exactly the way another reads it.

`bun run contracts:check` (part of `bun run check`) fails the build the moment any of these
seven files drifts from what the TypeBox definitions would produce. That is what makes the
crate below safe to embed them.

`crates/mangostudio-runtime-contract` is the Rust half. It owns nothing about the contract's
*shape* — it embeds the seven artifacts above with `include_str!` and never copies their JSON
into `crates/`. What it does own: parsing `catalog.json` into `mango_protocol::Catalog`,
compiling a `jsonschema` validator for every method, event, and standalone document, and
giving the dispatcher in `crates/mangostudio-runtime` a typed, documented home for the
manifest and the error and runtime-home constants so it does not hand-type them from
`strings.json` itself. The crate is Tokio-free and carries no OS dependency: it is inventory
and validation, not a transport or a dispatcher. `crates/mangostudio-runtime` (a later crate)
serves the contract over a real session; this crate is what it is built on.

## Why there is no Rust code generation

The obvious alternative — generate Rust types from the TypeBox schemas with `typify` — was
tried and rejected. `typify-impl` 0.4.3 panics compiling this catalog
(`type_entry.rs:286: Failed to make unique variant names`), triggered by a `const`-string
union of line-ending literals already in the contract. Beyond that specific panic, `typify`
0.4 pins `schemars` 0.8 while this workspace is on `schemars` 1.2 — two majors of the same
crate in one dependency graph, which `deny.toml`'s `bans.multiple-versions = "deny"` refuses
outright. Both are measurements against this repository's actual catalog and lockfile, not a
general verdict on `typify`; if either fact changes upstream, revisit the decision, but do not
re-attempt code generation without addressing both.

Embedding the JSON and validating against it with `jsonschema` sidesteps the problem
entirely: there is one schema, read at runtime by a general-purpose validator, rather than a
second copy of the type system that a code generator must keep faithful to the first.

## The conformance corpus

Two sides reading the same `catalog.json` text proves the file is shared. It proves nothing
about whether TypeBox and `jsonschema` *agree on what the text means* — two JSON Schema
implementations can both be spec-compliant and still validate a real-world value differently,
particularly at the edges (recursive `$ref`, `format`, ambiguous `anyOf`). Textual equality is
the wrong gate for that question; a behavioural one is.

`scripts/runtime-contract/corpus.ts` builds `generated/conformance-corpus.json`, the seventh
artifact `contracts:emit`/`contracts:check` gates:

- One valid seed per method `params`, method `result`, and topic `payload`, from
  `Value.Create` on the TypeBox schema. A schema whose only way to satisfy a `pattern` or
  `uniqueItems` constraint needs a value TypeBox cannot invent gets a narrow, reviewed
  repair (`createSeed`/`manualCreate` in `corpus.ts`) rather than a hand-typed object — the
  repair only ever touches the one offending leaf.
- A bounded set of mechanical mutations per shape: drop each required key, replace each
  present property with a value of a different JSON type, add one unexpected property, push a
  bounded numeric property outside its range, and replace a `const`/literal-union property
  with a value outside its allowed set.
- Every fixture's `expect` is computed by running TypeBox's own `Value.Check` at emit time,
  never assumed. Most shapes in this contract are open objects (no
  `additionalProperties: false`), so an extra property is usually still valid, and dropping
  an optional key always is — the corpus only means something because its expectations come
  from the validator, not from an author's intuition about the shape.

`crates/mangostudio-runtime-contract/tests/conformance.rs` derives its inventory from the
parsed catalog (never a typed method or topic count) and asserts this crate's own
`jsonschema` validators reproduce every fixture's `expect`. It also fails outright if any
method or topic in the catalog has no valid seed at all, so a corpus generation bug cannot
silently drop a subject from the gate instead of failing it.

As of this writing every fixture agrees between the two validators. The one classic source of
TypeBox/JSON-Schema-2020-12 disagreement — `format` being annotation-only unless a validator
opts into assertion mode — does not currently arise here: this contract's schemas do not use
the `format` keyword anywhere (grep `generated/catalog.json` for `"format"` and every hit is a
property literally named `format`, an enum of string constants, not the JSON Schema keyword).
Should a future schema add one, `crates/mangostudio-runtime-contract/src/schemas.rs` compiles
with `should_validate_formats(true)` to match `mango-protocol`'s own dispatcher-side
validators — the same compile options a corpus fixture is checked against are the options the
real dispatcher runs with.

## CI

`.github/labeler.yml`'s `area: runtime` glob and `docs/reference/labels.md`'s summary of it
both cover `crates/mangostudio-runtime-contract/**` and `crates/mangostudio-runtime/**`
alongside the existing TypeScript and protocol paths. `.github/workflows/cargo-shim.yml`'s
change detector also treats `apps/shared/src/runtime-contract/**` as a Rust-relevant path — a
pull request that only edits the TypeScript contract is exactly where a conformance
regression would start, and the Rust lanes (including the corpus test above) must run for it.

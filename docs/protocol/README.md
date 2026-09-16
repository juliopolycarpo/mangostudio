# Mango Protocol

One JSON-Schema wire contract for MangoStudio hubs, runtimes and tools, inspired by JSON-RPC 2.0
and published as a TypeScript SDK (`@mangostudio/protocol`, npm) and a Rust crate
(`mango-protocol`, crates.io). A hub written in TypeScript and a runtime written in Rust speak the
same frames over stdio, local sockets, in-process ports or WebSocket without caring which language
sits on the other end.

MangoStudio's hub and runtime already speak a versioned frame protocol. Every new peer — a second
runtime, a language-server gateway, a CLI — would otherwise re-implement its framing, handshake,
request multiplexing, cancellation, streams, liveness and close semantics. This tree owns those
once. Applications keep their own method catalogs and their own policy: consent, audit,
authentication, reconnect rules.

## Where things live

| Path                          | What                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `spec/`                       | Normative spec, JSON Schema 2020-12 files, conformance fixture corpus        |
| `packages/protocol/`          | `@mangostudio/protocol`: types, codec, session, transports, contract helpers |
| `crates/mango-protocol/`      | `mango-protocol`: types, codec, a tokio session, a contract builder, testing |
| `crates/mango-protocol/fuzz/` | cargo-fuzz targets; its own workspace, nightly only                          |
| `scripts/protocol/`           | The lanes: check, test, fix, packing, release preparation                    |
| `docs/protocol/`              | These guides                                                                 |

`packages/protocol/AGENTS.md` is the contributor guide, including the contract-change procedure
every wire change follows.

## Develop

```sh
bun run protocol:check   # typecheck, spec, schema equality, fixtures, rustfmt, Clippy, round trip
bun run protocol:test    # the TypeScript suite, then cargo test and the interop suites
```

The repository gate (`bun run check` / `bun run test`) runs only the TypeScript half of these —
the Rust half is a 25-minute cold lane owned by the path-filtered
`.github/workflows/protocol-ci.yml`. Run the two commands above before handing off a protocol
change.

Both degrade to the TypeScript half with a warning when `cargo` is not on PATH.

## Read next

- [`spec/mango-protocol-1.md`](../../spec/mango-protocol-1.md), the wire, and
  [`spec/transports/`](../../spec/transports/) for stdio, local sockets, in-process, WebSocket and spawn
- [`build-a-contract.md`](./build-a-contract.md): describe methods and events once, get a typed
  client, validated handlers and a catalog
- [`adopt-typescript.md`](./adopt-typescript.md) and [`adopt-rust.md`](./adopt-rust.md): from
  install to a working peer
- [`conformance.md`](./conformance.md): the fixture corpus and the transport suite
- [`versioning.md`](./versioning.md) and [`releasing.md`](./releasing.md)

# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com), and this
project adheres to [Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-09-15

### 💥 Breaking Changes

- Bounded terminate(), limit panics, selected const fn removals, optional WebSocket accept.
- **(ts)** `SpawnedPeer` no longer declares `startError`. Code that reads a launch failure from a peer must type it as `LaunchedPeer`, which is what `spawnPort` has returned since this change.
- **(rs)** A serialized `Catalog` no longer carries optional members that are empty. Readers that indexed `events` or `capabilities` blindly must treat them as absent, which the schema has always allowed.

### 🚀 Features

- Wire minor 1.1 session limits, rpc.discover and the spec gaps behind them (#8)
- **(rs)** Every transport the TypeScript SDK offers, and an interop lane (#4)
- **(rs)** A tokio session and contract builder for mango-protocol (#2)
- **(rs)** Emit the catalog schema
- **(ts)** Carry the child's exit status on a refused spawn
- **(ts)** Give the connect functions a deadline

### 🐛 Bug Fixes

- **(build)** Carry breaking changes into the generated changelog (#20)
- **[breaking]** Bring seven cross-SDK behaviours back into step before 0.2.0 (#12)
- **[breaking]** **(rs)** Leave absent catalog members absent when serializing
- **(build)** Restore the not-in-the-spec guard for catalog $defs
- **(rs)** Name what the catalog emission found when the root is missing
- **(ts)** Unref the connect deadline timer
- **(ts)** Keep listening for errors on a socket the dial gave up on

### 🏗️ Build

- Retire the default normaliser rule

### ♻️ Refactor

- **[breaking]** **(ts)** Move startError onto a peer this launcher started
- **(ts)** Move lastNonEmptyLine out of the child-process module

### 🧪 Testing

- **(ts)** Replace the inline I/O stubs with named fakes
- **(rs)** Prove the catalog schema against the crate

### 👷 CI

- **(release)** Check crates.io before asking for a trusted-publishing token
## [0.1.0] - 2026-09-10

### 🚀 Features

- **(ts)** Add the ssh argv preset
- **(ts)** Add the spawn launcher
- **(ts)** Add the local socket transport
- **(ts)** Add the stdio transport
- **(ts)** Add the shared NDJSON port
- **(ts)** Add the WebSocket client and WHATWG adapter
- **(ts)** Add the WebSocket port
- **(rs)** Carry the spec's value constraints in the schema emission
- **(rs)** Emit JSON Schema behind the schema feature
- **(rs)** Add catalog document types
- **(rs)** Add the WebSocket chunk codec
- **(rs)** Add the NDJSON line codec
- **(rs)** Add wire frame types with validation
- **(ts)** Add the in-process transport
- **(ts)** Add the transport conformance suite
- **(ts)** Add the contract helper
- **(ts)** Add the session over any port
- **(ts)** Add the WebSocket chunk codec
- **(ts)** Add the NDJSON line codec
- **(ts)** Add wire frame schemas
- **(ts)** Add version negotiation and the close-code table
- **(ts)** Add the error vocabulary
- **(fixtures)** Add the conformance corpus with a reference verifier
- **(schema)** Add JSON Schema 2020-12 for wire 1 frames and the catalog document

### 🐛 Bug Fixes

- **(ts)** Terminate the child when the spawn port closes on its own
- **(ts)** Force RemoteCommand off in the ssh preset
- **(scripts)** Accept a release version the manifests already carry
- **(ts)** Expect PROTOCOL_MISMATCH from a refused hello in the conformance suite
- **(ts)** Reject ready with PROTOCOL_MISMATCH when the port refuses the hello
- Derive native paths from import.meta.url instead of URL pathnames
- **(scripts)** Spawn bun and bunx through the running binary
- **(fixtures)** Refuse the oversized chunk run before its last chunk

### 🏗️ Build

- **(ts)** Ship the licence in the npm package
- Prove the two SDKs read each other's bytes
- **(ts)** Fail the package build on a missing entry
- Prove catalog.json against the TypeScript catalog schemas
- Prove the spec, TypeScript and Rust schemas agree
- Add the release preparation script
- Keep the package versions in lockstep
- **(ts)** Bundle the package entries and ship the schema files

### 🧹 Miscellaneous

- Print only failures and the summary from lefthook
- Migrate the Biome config to 2.5.12
- **(build)** Scaffold Cargo workspace and pin the toolchain
- **(build)** Scaffold Bun workspace and toolchain

### ♻️ Refactor

- **(rs)** Drop the JsonSchema derive from Frame

### 📚 Documentation

- **(spec)** Stop promising a per-user ACL on the Windows pipe
- Describe what the byte transports guarantee and what they cannot
- Await listenIpc in the local socket example
- Describe both packages on their registry pages
- Add the adoption, contract, conformance, versioning and release guides
- **(spec)** Reconcile the early-request rule, the refused hello and the frame count
- **(spec)** Close with 4426 on a hello that fails the schema
- **(spec)** Specify the stdio, local socket, in-process, WebSocket and spawn transports
- **(spec)** Write the wire specification for protocol 1.0
- Add license, readme and contributor guides

### 🧪 Testing

- **(ts)** Settle rejections without Bun's rejects matcher
- **(ts)** Drive the stdio transport from a real child process
- **(ts)** Run the conformance suite over WebSocket
- **(rs)** Run the conformance corpus
- **(ts)** Scope the browser-safety guard to the barrel's import graph
- **(ts)** Share the refusal helper across the suites
- **(ts)** Run the conformance corpus

### 👷 CI

- Publish both packages from a signed tag
- Pin setup-bun and rust-cache to commit SHAs
- Add check and test workflows with issue and PR templates


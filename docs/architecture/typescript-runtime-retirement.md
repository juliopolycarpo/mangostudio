# TypeScript Runtime Retirement

The TypeScript runtime package (`apps/runtime`, `@mangostudio/runtime`) has been retired in favour
of the compiled Rust runtime (`crates/mangostudio-runtime`) and is deleted. This page records what
the hub's test suite used to prove *through* the TypeScript runtime, where each responsibility
lives now, the last result of the differential suites that compared the two runtimes before their
TypeScript halves were removed, and the fixtures that still stand for what the TypeScript runtime
wrote.

## The hub no longer imports or spawns the TypeScript runtime

The runtime package and the in-process seam that built a TypeScript host for Local
(`apps/api/src/services/runtime-client/connect-in-process-runtime.ts`) are deleted. Local spawns
the Rust binary. `tests/unit/services/runtime-client/runtime-module-allow-list.test.ts` asserts
that no file under `apps/api/src` or `apps/api/tests` imports either of them, and that no test
spawns the TypeScript runtime by a `runtime/src/` path literal. The three tests that used to spawn
it by its source path (`integration/services/spawn-runtime-child.integration.test.ts`,
`integration/services/connect-ssh-runtime.integration.test.ts` and
`unit/lib/runtime-paths.test.ts`) were migrated in the Local cut-over (#1161).

Tests replace the TypeScript host in one of two ways:

- **(a) Fake host.** Use this when a test only needs protocol behaviour or the hub's own
  behaviour. `tests/support/fake-runtime-host.ts` serves a test's handlers through
  `RUNTIME_CONTRACT.serve` over `@mangostudio/protocol/in-process`, with `validateFrames: true`.
  Every frame is re-encoded and schema-checked. Parameters and results are validated against the
  contract. The host applies a consent gate that returns the same `DENIED` details a real
  runtime sends, and a thrown `RuntimeServiceError` keeps its `kind` on the wire.
  `tests/unit/support/fake-runtime-host.test.ts` pins each of these properties.
  `connectTestRuntime` (`tests/support/runtime-fixture.ts`) is built on the fake host, and
  `FakeHostileRuntimePeer` is still the peer that puts malformed frames on the wire.
- **(b) Rust binary.** Use this when a test asserts real runtime behaviour. The test drives
  `target/debug/mangostudio-runtime` (or `MANGOSTUDIO_RUNTIME_BINARY`) over stdio or `serve`, and
  is guarded with `it.skipIf(skipWithoutRustBinary(binary, suite))`
  (`tests/support/rust-runtime-binary.ts`), which prints the skipped suite and how to build the
  binary when it is missing. The ordinary lane has no binary; `cargo-shim.yml`'s
  `real-binary-qualification` job runs these cases on Linux, macOS and Windows.

| File                                                                                                          | Strategy                                                                | Why                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `support/runtime-fixture.ts`, `support/mocks/fake-hostile-runtime-peer.ts`                                    | (a)                                                                     | Handler fakes; the hostile peer only drops its dependency on the runtime fixture's doc                        |
| `unit/services/runtime-client/hub-identity.test.ts`                                                           | (a)                                                                     | Only what the hub announced in its `hello` is asserted                                                        |
| `integration/routes/runtime-socket.integration.test.ts`                                                       | (a) over the WebSocket port                                             | Pairing and socket admission; `serveFakeRuntime` replaces `createRuntimeSession`                              |
| `integration/routes/environment-entities.integration.test.ts`                                                 | (a) routes, staging, locks, supervised restart; (b) `serve` live update | Rust cases: bytes published into the slot and the runtime's own digest refusal                                |
| `integration/routes/terminal-socket.integration.test.ts`                                                      | (b) stdio                                                               | Needs a real PTY and shell                                                                                    |
| `integration/modules/generation/capability-inspector.integration.test.ts`                                     | (a)                                                                     | Reads only `manifest.features`; no method is called                                                           |
| `integration/services/hub-isolation-claim.integration.test.ts`                                                | (b) `serve`, plus (a) twins for the hub-side withholding                | What a dialled runtime attests under the hub's claim                                                          |
| `integration/services/connect-http-runtime.integration.test.ts`                                               | (b) `serve`, plus (a) behind a loopback WebSocket                       | The fake covers the external-agent round-trip and the hub's pre-open refusal wording                          |
| `unit/modules/library/library-apply-transport.test.ts`                                                        | (a)                                                                     | The real-engine 404 case moved to `integration/modules/library/library-undo-missing-backup` (b)               |
| `unit/modules/environments/ssh-failure.test.ts`                                                               | none                                                                    | Builds the Rust setup-pending sentence from the shared signature                                              |
| `support/fixtures/mcp/turn-mcp-fixture.ts` (was `in-memory-mcp.ts`) and its MCP consumers                     | Production Local via a stdio relay                                      | The SDK servers stay in the test process and the runtime spawns `mcp-stdio-relay.ts`, so either runtime works |
| `integration/services/mcp/{http-transport,wrapper-contract}.integration.test.ts`                              | Production Local                                                        | SSE fallback and the wrapper contract are observed on the wire, not imported                                  |
| File-tool tests, `tool-registry-harness.ts`, file-checkpoint suites                                           | Production Local                                                        | `clearFileFreshness` is gone; each case's mkdtemp directory keeps freshness keys apart                        |
| `unit/services/runtime-client/unenforced-containment.test.ts`, `unit/services/tools/containment-wire.test.ts` | (a)                                                                     | The hub's reaction to a manifest and what it put on the wire                                                  |
| `unit/services/tools/support/target-home.ts` (the `~` cases)                                                  | (b) stdio with scratch `HOME`/`USERPROFILE`, plus (a) wire twins        | The file under the announced home is really read or written                                                   |
| `integration/services/rust-*-compat`, `rust-runtime-external-agents-qualification`                            | (b), Rust-only                                                          | See below                                                                                                     |

### Cases that run only against the binary

These run in `real-binary-qualification` and skip, loudly, everywhere else. Where the assertion
is the hub's own logic, a fake-host twin in the same file keeps the ordinary lane covering it.

| File                                                                          | Binary-only case                                                                                         | Fake-host twin in the ordinary lane                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `integration/routes/terminal-socket.integration.test.ts`                      | relays a real PTY through the terminal socket                                                            | none (runtime behaviour); the other terminal cases already use a fake                  |
| `integration/routes/environment-entities.integration.test.ts`                 | updates a connected runtime over its protocol connection; keeps the old binary when an update is refused | the mid-transfer update case pins the platform id the asset loader receives            |
| `integration/services/hub-isolation-claim.integration.test.ts`                | no claim, single-user claim, withdrawn claim (3)                                                         | the same three manifest outcomes, including withholding after `withdrawn`              |
| `integration/services/connect-http-runtime.integration.test.ts`               | round-trip, token rotation, 4401 refusal (3)                                                             | 4401 refusal after the upgrade; 401 refusal before it; external-agent round-trip       |
| `integration/services/environment-install-execution.integration.test.ts`      | streams a direct command over a fresh stdio connection, every line ahead of the answer                   | the same success case through the in-process Local runtime                             |
| `integration/modules/library/library-undo-missing-backup.integration.test.ts` | the runtime reports a missing backup set as a 404                                                        | `unit/modules/library/library-apply-transport.test.ts` keys the 404 on the wire `kind` |
| `unit/services/tools/{read-file,write-file,list-directory,glob}-tool.test.ts` | `~` reads, writes, lists or matches under the home the binary reports (4)                                | `~` expanded against the announced `homeDir`, asserted on the wire (4)                 |

## Differential suites

Before the TypeScript halves were removed, the full differential suite was run once on
`e1dc7f7316966f3a4a02962a05256cd9900fcff1` on 2026-09-25 (Linux x64, Bun 1.4.2, debug Rust
binary):

```
MANGOSTUDIO_RUNTIME_BINARY=target/debug/mangostudio-runtime bun test --timeout 30000 \
  tests/integration/services/{rust-command-compat,rust-filesystem-search-compat,rust-snapshot-compat,rust-runtime-external-agents-qualification}.integration.test.ts
34 pass, 3 skip, 0 fail (37 tests, 4 files)
```

The three skips are Cursor-turn cases that need a vendor CLI; they were not differential. Every
comparison now checks the Rust answer against the TypeScript answer recorded from that run. Paths
are normalised to `<ROOT>` and `<HOME>`, and `durationMs` is dropped as before. Test names are
unchanged.
Two values are Windows-only: a BOM written as `?text`, and a timed-out PowerShell ending with exit
code 1 and no signal. They are the Rust runtime's received output on the Windows leg of this
change's first qualification run (commit 8928178b), which failed on them. They stand for the
TypeScript answer because the baseline's Windows leg on e1dc7f73 was green asserting Rust equal
to TypeScript for the same calls, and `crates/` had not changed between the two.

| Suite                                        | `it` (count)                                                                                                                        | Compared                                   | Last result | Now                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `rust-command-compat`                        | shell output, exit and byte cap (4); timed-out result; completed capture after timeout; descendant holds pipes (3); env deny policy | `shell.run`                                | pass        | Recorded literals                                                                  |
| `rust-command-compat`                        | direct Git argv and accepted nonzero exits                                                                                          | `git.exec`                                 | pass        | Recorded literal; on Windows, git's own direct output                              |
| `rust-command-compat`                        | gh reads and mutation-method help                                                                                                   | `gh.exec`, `gh.mutate`                     | pass        | Equal to what the installed `gh` prints directly (version-dependent)               |
| `rust-command-compat`                        | unsupported gh operations at the typed boundary                                                                                     | error type on both                         | pass        | Rust-only `ToolArgumentError`                                                      |
| `rust-filesystem-search-compat`              | glob braces, recursive paths, dots, caps                                                                                            | 114 `fs.glob` answers                      | pass        | `support/fixtures/rust-filesystem-search-recorded.ts`; order compared as a set     |
| `rust-filesystem-search-compat`              | dot rules and grep filters; ECMAScript regex semantics                                                                              | 6 + 18 `fs.grep` answers                   | pass        | Same fixture; line order kept within each file                                     |
| `rust-filesystem-search-compat`              | typed pattern and inaccessible-root errors                                                                                          | error type on both                         | pass        | Rust-only                                                                          |
| `rust-snapshot-compat`                       | exact bytes through an in-root link; byte-limit error; symlink/junction escapes                                                     | capture, hash, `RemoteError` equality      | pass        | Recorded literals, plus a new file-size-unchanged check                            |
| `rust-snapshot-compat`                       | 9 revert cases (create/restore/move, cross-device, collisions, base64, replay)                                                      | same literal checks on both                | pass        | Rust half only; checks unchanged                                                   |
| `rust-runtime-external-agents-qualification` | attests the credential home Local attests                                                                                           | Rust fingerprint vs TS Local's attestation | pass        | Local's derivation is recorded in the test; the hub's collision check is unchanged |

Loosened or dropped:

- Glob and grep result order is not compared, because it follows the filesystem's listing
  order. A capped glob must return `maxResults` distinct members of the uncapped answer.
- `gh` output is compared with the installed CLI rather than with a TypeScript answer.
- The `method === 'single-user-host'` check on the recorded Local attestation was dropped, since
  a recorded value can only pass it.

Other assertions that changed outside the differential suites:

- An exact platform id, version or slot path became "whatever the Rust binary reports". This
  affects `environment-entities`, `hub-isolation-claim` and `connect-http-runtime`.
- A rejected token on Rust `serve` closes with 4401 after the upgrade, where the TypeScript
  listener refused with 401 before it. The 401 wording case moved to the fake listener, and a new
  Rust case asserts the 4401 close on every OS.
- The direct `assertFresh` probes became behavioural. A file recreated at a moved-from path is
  refused as not read, and a moved-to path can be written without a re-read.
- MCP row timeouts for the forced-timeout cases went from 75 and 150 ms to 1 s. The Rust runtime
  counts spawn and initialize against the row timeout.

## Frozen compatibility fixtures

Two fixture sets record what the TypeScript runtime wrote and answered. Rust keeps replaying them
so it goes on reading the runtime homes and library backup sets that runtime left on operators'
machines. Their generators were deleted with it, so they are frozen rather than regenerated:

- `crates/mangostudio-runtime/tests/fixtures/ts-home`, a runtime home as the TypeScript runtime
  wrote it, read by `crates/mangostudio-runtime/tests/ts_compat.rs`.
- `crates/mangostudio-runtime/tests/fixtures/ts-library/corpus.json`, the TypeScript library
  readers' answers for a fixed corpus, read by `src/library/ts_compat_tests.rs` and
  `src/library/mutation/ts_backup_compat_tests.rs`.

`cargo-shim.yml`'s `runtime-home-fixture-freshness` job pins each directory's git tree
(`ts-home` at `814a421cef442f2dd6c24b13a70fcea00e45576b`, `ts-library` at
`5ecbf15d46a87ac2c2e8c24dc9d14a47a76b209e`) and fails when either changes, so an edit has to
update the pin on purpose. The same job still regenerates `rust-home` with
`cargo test -p mangostudio-runtime --test generate_rust_fixture -- --ignored` and fails on any
diff. The hub reads that fixture through `probeRuntimeSlots` in
`apps/api/tests/unit/cli/runtime-slot-probe-rust-home.test.ts`.

Two other things left with the TypeScript runtime:

- The recorded vendor contract captures and the tooling that recorded and drift-checked them now
  live in the external-agents SDK repository
  ([juliopolycarpo/mango-external-agents](https://github.com/juliopolycarpo/mango-external-agents)),
  whose CI runs the vendor contract drift workflow.
- The `runtime-slot-windows` job in `test.yml` is gone. Its Windows slot coverage is the Rust
  `#[cfg(windows)]` tests in `crates/mangostudio-runtime/src/slot_publish.rs` and
  `src/cli/native_operation.rs`, which `cargo-shim.yml`'s `workspace` matrix runs on
  `windows-latest`.

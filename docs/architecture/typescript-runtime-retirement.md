# TypeScript Runtime Retirement

The TypeScript runtime package (`apps/runtime`) is being retired in favour of the compiled Rust
runtime (`crates/mangostudio-runtime`). This page records what the hub's test suite used to prove
*through* the TypeScript runtime, where each responsibility lives now, and the last result of the
differential suites that compared the two runtimes before their TypeScript halves were removed.

## Hub tests no longer import the TypeScript runtime

No file under `apps/api/tests` imports the runtime package or the in-process seam
(`apps/api/src/services/runtime-client/connect-in-process-runtime.ts`).
`tests/unit/services/runtime-client/runtime-module-allow-list.test.ts` enforces both. The seam
is still the one production importer until Local spawns the Rust binary. Tests replace the
TypeScript host in one of two ways:

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
  is guarded with `it.skipIf(!binary.available)`, like the existing `rust-*` suites.

| File                                                                                                          | Strategy                                                                | Why                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `support/runtime-fixture.ts`, `support/mocks/fake-hostile-runtime-peer.ts`                                    | (a)                                                                     | Handler fakes; the hostile peer only drops its dependency on the runtime fixture's doc                        |
| `unit/services/runtime-client/hub-identity.test.ts`                                                           | (a)                                                                     | Only what the hub announced in its `hello` is asserted                                                        |
| `integration/routes/runtime-socket.integration.test.ts`                                                       | (a) over the WebSocket port                                             | Pairing and socket admission; `serveFakeRuntime` replaces `createRuntimeSession`                              |
| `integration/routes/environment-entities.integration.test.ts`                                                 | (a) routes, staging, locks, supervised restart; (b) `serve` live update | Rust cases: bytes published into the slot and the runtime's own digest refusal                                |
| `integration/routes/terminal-socket.integration.test.ts`                                                      | (b) stdio                                                               | Needs a real PTY and shell                                                                                    |
| `integration/modules/generation/capability-inspector.integration.test.ts`                                     | (a)                                                                     | Reads only `manifest.features`; no method is called                                                           |
| `integration/services/hub-isolation-claim.integration.test.ts`                                                | (b) `serve`                                                             | What a dialled runtime attests under the hub's claim                                                          |
| `integration/services/connect-http-runtime.integration.test.ts`                                               | (b) `serve`, plus (a) behind a loopback WebSocket                       | The fake covers the external-agent round-trip and the hub's pre-open refusal wording                          |
| `unit/modules/library/library-apply-transport.test.ts`                                                        | (a)                                                                     | The real-engine 404 case moved to `integration/modules/library/library-undo-missing-backup` (b)               |
| `unit/modules/environments/ssh-failure.test.ts`                                                               | none                                                                    | Builds the Rust setup-pending sentence from the shared signature                                              |
| `support/fixtures/mcp/turn-mcp-fixture.ts` (was `in-memory-mcp.ts`) and its MCP consumers                     | Production Local via a stdio relay                                      | The SDK servers stay in the test process and the runtime spawns `mcp-stdio-relay.ts`, so either runtime works |
| `integration/services/mcp/{http-transport,wrapper-contract}.integration.test.ts`                              | Production Local                                                        | SSE fallback and the wrapper contract are observed on the wire, not imported                                  |
| File-tool tests, `tool-registry-harness.ts`, file-checkpoint suites                                           | Production Local                                                        | `clearFileFreshness` is gone; each case's mkdtemp directory keeps freshness keys apart                        |
| `unit/services/runtime-client/unenforced-containment.test.ts`, `unit/services/tools/containment-wire.test.ts` | (a)                                                                     | The hub's reaction to a manifest and what it put on the wire                                                  |
| `unit/services/tools/support/target-home.ts` (the `~` cases)                                                  | (b) stdio with a scratch `HOME`                                         | The file under the announced home is really read or written                                                   |
| `integration/services/rust-*-compat`, `rust-runtime-external-agents-qualification`                            | (b), Rust-only                                                          | See below                                                                                                     |

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
The Windows legs of the same CI run (`cargo-shim.yml`, `real-binary-qualification`, all three OSes
green on that SHA) asserted Rust equal to TypeScript. The two Windows-only values, a BOM written
as `?text` and a timed-out PowerShell ending with exit code 1 and no signal, are recorded from that
leg.

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
  Rust case asserts the 4401 close.
- The direct `assertFresh` probes became behavioural. A file recreated at a moved-from path is
  refused as not read, and a moved-to path can be written without a re-read.
- MCP row timeouts for the forced-timeout cases went from 75 and 150 ms to 1 s. The Rust runtime
  counts spawn and initialize against the row timeout.

## Unit-test coverage maps

Two coverage maps cover every assertion in `apps/runtime/tests/unit` and record the Rust (or
shared-code) test that replaces it. A row is MAPPED when a replacement test exists and was
verified, MOOT when the Rust design removes the concern, and GAP when there is no replacement yet.

| Map | Area                                                                 | Sections | Rows    | MAPPED  | MOOT   | GAP     |
| --- | -------------------------------------------------------------------- | -------- | ------- | ------- | ------ | ------- |
| A   | Host core: CLI, consent, connect/serve, session, runtime home, audit | 14       | 165     | 119     | 10     | 36      |
| A   | Filesystem and read freshness                                        | 4        | 41      | 32      | 2      | 7       |
| A   | External agents (Claude, Codex, Cursor, supervisor, isolation)       | 18       | 314     | 235     | 8      | 71      |
| B   | Commands and processes (shell, git, gh, grep, spawn env, snapshot)   | 10       | 83      | 65      | 9      | 9       |
| B   | Install, live update, slots and setup                                | 8        | 94      | 71      | 5      | 18      |
| B   | Workspace validation and browsing                                    | 3        | 17      | 14      | 0      | 3       |
| B   | Library reads, scans and backup recovery                             | 2        | 22      | 20      | 0      | 2       |
| B   | MCP                                                                  | 3        | 16      | 15      | 0      | 1       |
| B   | Probing                                                              | 3        | 30      | 21      | 0      | 9       |
| B   | Terminal                                                             | 5        | 35      | 27      | 1      | 7       |
| B   | External-agent turn channel and vendor contracts                     | 2        | 12      | 1       | 1      | 10      |
|     | **Total**                                                            | **72**   | **829** | **620** | **36** | **173** |

Map B's GAP list is the input to the deletion change. These items have to land or be accepted
before `apps/runtime` goes:

- Windows console hiding on every spawn path.
- Supervisor termination-cause ordering.
- User-service and live-update refusals.
- Relocating the vendor contract captures and the `fixtures:library` generators, and freezing or
  retiring the `fixtures:home` freshness lane in `cargo-shim.yml`.

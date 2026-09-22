# Runtime Dispatcher: Serving the Contract in Rust

[runtime-contract.md](runtime-contract.md) covers `crates/mangostudio-runtime-contract`: the
embedded catalog, the compiled schema validators, and the manifest/error/string constants. This
document covers what is built on top of it, `crates/mangostudio-runtime` — the typed dispatcher
that serves that contract over a `mango-protocol` session, its fail-closed ports, and its panic
isolation.

The crate builds on `mango_protocol::contract::Contract`, `ContractHandlers`, `Guard`, and
`ServeOptions` directly. It does not implement a second dispatcher; everything below is either a
thin wrapper around that pipeline or a seam this crate defines for a later change to fill in with
real implementations.

## Two binaries share a name today

The build already produces a binary named `mangostudio-runtime`, Bun-compiled from
`apps/runtime/src/cli.ts` (see `docs/reference/agent-playbooks.md`'s "Config, Runtime, And
Standalone Build" section). `crates/mangostudio-runtime`'s own binary target carries the same
name. Nothing under `scripts/` or `.github/workflows/` copies a build artifact from `target/`
today, so the two do not collide in the current pipeline — but a future change that wires the Rust
binary into a release archive alongside (or instead of) the TypeScript one must resolve this
before both can ship in the same place. This is a known, deliberately deferred fact, not an
oversight.

## Known-unimplemented vs. unknown: one wire error, not two

`mango_protocol::session::dispatch`'s own no-handler branch already answers `METHOD_UNSUPPORTED`
for any method nobody registered a `Handler` for, before any schema validation runs. This crate's
`registry::Registry` relies on exactly that: it registers a `mango_protocol::contract::Handler`
only for a method a later change has actually implemented. A method the embedded catalog declares
but this registry has not implemented is simply never registered — so it falls into the same
no-handler branch as a method no catalog anywhere has ever heard of, and answers a byte-identical
`METHOD_UNSUPPORTED`. `Registry::classify` tells the two apart, but only for this crate's own
diagnostics (a future `runtime.health` report, logging); no wire behaviour depends on the
distinction, and this crate never invents a second code for it.

## Result validation runs inside the audit wrapper, not through `ServeOptions`

`mango_protocol::contract::ServeOptions` has a `validate_results` flag, but `Contract::serve`'s
pipeline (`check_params` → `Guard::check` → the handler → the optional result check) runs that
check *after* the handler has already settled. Once an audit port records a handler's outcome,
that ordering means an `outcome: ok` line could already be written before a malformed result is
ever caught — the hub would see `INTERNAL`, while the runtime's own audit trail says the call
succeeded. `apps/runtime/src/result-check.ts` exists in the TypeScript runtime for exactly this
reason: it wraps a handler's result check *inside* the audit-recording wrapper
(`gateHandlers(checkResults(handlers), deps)`), not through the SDK's own post-handler option.

`crates/mangostudio-runtime::registry::Registry::implement` does the same thing: the closure it
registers checks the handler's serialised result against the method's `result` schema, using its
own compiled `jsonschema::Validator` (`result_check::compile_result_schema`), before it ever
records anything through its `Audit` port. `ServeOptions::validate_results` stays `false` for
every call this crate makes to `Contract::serve`.

**This crate always validates a result, in every build**, unlike the TypeScript runtime, which
turns the check off in `NODE_ENV === "production"` (`apps/runtime/src/config.ts`) on the reasoning
that a shape the schema refuses is still better delivered to a user than turned into a 500. This
is a deliberate, permanent divergence: the check exists to catch a handler drifting from the
contract before a peer built from the same catalog in another language inherits the mistake, and a
Rust peer is exactly that other language. Turning it off here would defeat the reason this crate
embeds the schema at all.

The wire shape mirrors `apps/runtime/src/result-check.ts` exactly: code `INTERNAL`, message
`Result of "{method}" does not match the contract at {path}: {reason}.` (or
`Result of "{method}" does not match the contract.` when the checked value produced no specific
violation — structurally unreachable through the `jsonschema` crate's own `Validator::validate`,
which always returns a violation in its `Err` case, but stated for parity with the TypeScript
source), details `{ method, path, reason }`, and `path` computed the same way: the instance-path
JSON pointer, with `/{property}` appended when the failing keyword is `required` or
`additionalProperties`, defaulting to `/` for a root violation. `result-check.ts` needs no
`additionalProperties` special case of its own because TypeBox's `instancePath` already points at
an unexpected property directly; `jsonschema`'s does not (it points at the container), so this
crate appends the property itself — the same reason
`mango_protocol::contract::params::first_violation` carries the identical special case. Getting
this wrong is silent: 48 of the catalog's result schemas are closed
(`additionalProperties: false`), and a Rust struct that grows a field its schema does not declare
would otherwise report `path: "/"` instead of naming the extra field.

`reason` is rendered with `jsonschema::ValidationError::masked()`, not the validator's default
`Display`. The default embeds the offending instance in the message (`"sensitive data" is not of
type "string"`) — exactly what a handler's own result must never carry onto an `INTERNAL`
message, since a result can hold a file's contents or a shell command's output. This is a
deliberate divergence from `mango_protocol::contract`'s own `params`/`result` checks, which use
the unmasked message: reasonable there, since `params` is a value the caller already sent back to
itself, not one this runtime is the sole holder of.

## Panic isolation

`mango_protocol::session::dispatch` already isolates a panicking handler at the session level —
the handler runs inside a `tokio::task::JoinSet`, so the session survives and the request settles
— but the panic payload it recovers (`panic_message`, private to that crate) is put on the wire
**verbatim and unredacted** as the `INTERNAL` message. A panic can carry a file's contents, a
token, or an absolute path.

`crates/mangostudio-runtime::panic::catch_panics` wraps a future so a panic inside it resolves as
an ordinary `Err` carrying a bounded, redacted `INTERNAL` error instead of unwinding — implemented
as a hand-rolled `Future` (`AssertUnwindSafe` plus `std::panic::catch_unwind` around each poll),
not a synchronous `catch_unwind` around building the future, since the panic happens while the
future is *running*, not while it is constructed. The wrapper stores the inner future as
`Pin<Box<F>>`, which makes the wrapper itself `Unpin` regardless of `F` — no `unsafe` code needed
to poll it.

`mango_protocol::contract::serve`'s per-request pipeline (`check_params` → `Guard::check` → the
handler → the optional result check) is one future assembled from private, unexported pieces —
there is no seam to wrap it as a whole from outside that crate. `catch_panics` is applied twice
instead: once inside `ports::authorization::AuthorizationGuard::check` (the only
`mango_protocol::contract::Guard` this crate registers), and once inside the closure
`Registry::implement` registers on `ContractHandlers`. Together the two catch points cover the
whole pipeline a request runs through.

The release profile stays unwind-compatible: nothing in this workspace sets
`[profile.*] panic = "abort"` (checked with
`grep -rn 'panic\s*=' Cargo.toml crates/*/Cargo.toml`), which `catch_unwind` requires to work at
all.

## Fail-closed ports

Three small, named traits in `mangostudio_runtime::ports`, each with one job. None is a plugin
framework, and every default refuses or does nothing — none of them ever grants a capability or
fabricates a successful outcome on its own.

- **`authorization::Authorization`** — which of a method's declared capabilities are missing.
  Adapts *into* `mango_protocol::contract::Guard` via `AuthorizationGuard`, rather than building a
  second gate in front of it (`mango_protocol`'s `Guard` already runs after `check_params`, unlike
  the TypeScript SDK's own guard, which `apps/runtime/src/consent-gate.ts` avoids for exactly that
  reason — the Rust seam does not have the problem the TypeScript one does). The default,
  `DenyingAuthorization`, reports every capability a method actually declares as missing, so a
  zero-capability method (`runtime.health` is the only one today) still passes even the denying
  default — mirroring `consent-gate.ts`'s own `missingCapabilities`/`consentDenial` split. The
  `DENIED` error `AuthorizationGuard` builds mirrors `consent-gate.ts`'s `consentDenial` byte for
  byte: message, and details `{ kind: "consent_denied", method, missing, slot, capability }` where
  `capability` is `missing[0]` and is omitted from the wire when nothing is missing.
- **`audit::Audit`** — records one call's outcome, after the fact. Wraps *outside* the guard and
  outside the handler, in the same order `consent-gate.ts`'s `gateHandlers` records them: a denial
  is recorded before the handler ever runs (from inside `AuthorizationGuard`); `ok`/`error` is
  recorded only once the handler — and this crate's own result check — have settled (from inside
  `Registry::implement`'s wrapper). The default, `NoopAudit`, records nothing: for an audit sink
  specifically, "does nothing" is the fail-closed choice, since a sink that fabricated entries
  would be worse than one that stays silent.
  One parity gap against the TypeScript runtime, stated rather than hidden: `gateHandlers` times
  one duration per call, from before its own consent check to after the handler returns. This
  crate cannot, since `AuthorizationGuard` and `Registry::implement`'s wrapper are two separate
  `mango_protocol` seams with no shared start time — a `denied` entry's duration measures only the
  authorization check, an `ok`/`error` entry's measures only the handler.
- **`clock::Clock`** — the current instant, for an audit entry's duration. The default,
  `SystemClock`, is `std::time::Instant::now`. A trait rather than a bare call so a future test can
  control time without sleeping.

No separate cancellation port exists. `mango_protocol::session::CallContext::cancel` already gives
every handler a `CancellationToken`; adding a second one would be exactly the kind of redundant
gate this crate's ports are designed to avoid.

## Poisoned state

`std::sync::Mutex` poisons a lock when the thread holding it panics mid-critical-section. This
crate's own ports never hold their lock across a handler's `.await` — an audit sink's critical
section is one short, panic-free push onto a log, taken before or after the handler runs, never
during it — so a handler panicking cannot leave a port's own `Mutex` mid-mutation.
`ports::audit::lock` recovers a poisoned guard anyway (`mutex.lock().unwrap_or_else(PoisonError::
into_inner)`), mirroring `mango_protocol::session::shared::lock` (private to that crate, so this is
a deliberate re-derivation): recovering avoids turning one handler's panic into a second, unrelated
panic in a port that had nothing to do with the first one. A future port whose critical section
*can* legitimately span a handler's own work — and so can be left genuinely torn by a panic — must
not reuse this helper; it should repair the specific invariant, discard the state, or close the
affected service outright, whichever fits that port's own data.

## Capability filtering (the manifest)

`apps/runtime/src/manifest.ts` computes the `features` map a runtime announces from `allow` (what
a machine's owner granted) intersected with a couple of environment facts (git's own `--version`
probe, which shells are on `PATH`). It has no "is this method implemented" gate at all, because
every method it declares already has a real handler.

`manifest::build_features` mirrors that allow→features formula field for field — including its
`tools` formula (an `||` over eight of the ten capability-backed features, deliberately excluding
`update` and `externalAgents`) and its unconditional `toolchain: true` (a schema fact about a
spawn method's `params`, not a capability of its own, so advertising it grants nothing on its own)
and adds an implementation gate. Every method backing a feature must be classified as
`Implemented`. For `fsRead` and `fsWrite`, those are the matching `fs.*` and `workspace.*`
methods. Snapshot and library methods also require filesystem consent, but their implementation
gates belong to `checkpoints` and `library`. They do not suppress working filesystem tools.
Other features require every catalog method carrying their capability.

The production registry implements health, workspace, probing, the eleven filesystem
methods, and `snapshot.capture`, `snapshot.hash`, and `snapshot.revert`. An empty registry still advertises no capability-backed features, regardless of consent.
Only the schema fact `toolchain` remains true. The hello capabilities also announce the
embedded catalog name and version in `contracts`, matching the TypeScript runtime.

## Where the TypeScript contract/dispatch tests live in Rust

### Filesystem behavior

The Hub still validates tool arguments and parses raw V4A text. Rust receives the catalog's
structured parameters. These tests pin the host behavior; they do not replace the Hub's tool tests.

| TypeScript assertion                                                                                    | Rust coverage                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `services/file-freshness.test.ts`: "accumulates sequential windows until they cover the file"           | `filesystem::freshness::tests::whole_and_sequential_window_reads_control_content_completeness`    |
| `services/fs-utils.test.ts`: "rejects files larger than maxBytes before allocating content"             | `filesystem::io::tests::descriptor_read_bounds_observed_bytes_and_checks_cancellation`            |
| `tools/edit-file-tool.test.ts`: "uses non-overlapping replaceAll semantics"                             | `filesystem::text::tests::literal_edit_retains_bytes_and_uses_nonoverlapping_matches`             |
| `services/grep-budget.test.ts`: "returns from a catastrophic pattern and reports the file as truncated" | `filesystem::search::tests::unfinished_file_discards_its_partial_matches_but_keeps_earlier_files` |

`rust-filesystem-search-compat.integration.test.ts` compares real Rust and TypeScript runtime
results through Hub clients, including ordering, glob syntax, regex Unicode semantics, caps,
and error types. `rust-runtime-qualification.integration.test.ts` exercises all eleven filesystem
methods and snapshot capture/hash/revert against the compiled binary over stdio and direct URL
serve. Its paired-connect sibling runs the same assertions through the Hub connection manager.
The qualification job runs these suites on Linux, macOS, and Windows. Windows-only junction tests and Unix non-UTF-8 identity tests live in
`filesystem::policy::tests`.

### Snapshot behavior

The three snapshot methods share the filesystem path locks and freshness ledger. Capture
encodes raw bytes up to 8 MiB; hash reads incrementally; revert checks expected hashes before
replaying the supplied reverse operations. Rust rechecks consent and containment after hashing,
under the same locks, before the first mutation. Once replay starts, cancellation does not
interrupt its remaining operations. A dropped caller also cannot release a running worker's locks.

| TypeScript assertion                                                                               | Rust coverage (`filesystem::snapshot::tests`)                        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `services/snapshot.test.ts`: rejects a file past the snapshot limit                                | `capture_enforces_the_eight_mebibyte_limit_and_preflights_its_frame` |
| `services/snapshot.test.ts`: rejects an escape when containmentRoot is set                         | `revert_uses_the_typescript_containment_error_for_a_symlink_escape`  |
| `services/cancellation.test.ts`: refuses an already-reverted retry cancelled during its final hash | `a_cancel_during_the_final_hash_refuses_an_already_reverted_retry`   |
| `services/cancellation.test.ts`: finishes every revert operation after cancellation during replay  | `cancellation_after_the_first_replay_operation_completes_the_replay` |

`rust-snapshot-compat.integration.test.ts` compares the production Rust and TypeScript hosts
through Hub clients: binary capture, missing files, size errors, reverse replay, freshness,
retry conflicts, permissive base64 decoding, move collisions, and symlink or junction containment.
It also exercises cross-device moves on Linux when the test filesystem provides two devices,
including long filenames and retrying after source-removal permissions are restored.
The runtime qualification job includes this suite on Linux, macOS, and Windows.

### Dispatcher behavior

| TypeScript test (`packages/protocol/tests/`, `apps/runtime/`)                                        | Rust home                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.test.ts` — unregistered method answers `METHOD_UNSUPPORTED`                                | `mango-protocol`'s own `session/dispatch.rs` behaviour, relied on by `crates/mangostudio-runtime/tests/dispatch.rs::an_unknown_method_and_a_known_unimplemented_method_answer_byte_identical_errors` |
| `contract.test.ts` — `rpc.discover` answers the catalog                                              | `crates/mangostudio-runtime/tests/dispatch.rs::rpc_discover_still_answers_the_full_catalog_with_an_empty_registry`                                                                                   |
| `result-check.test.ts` — wire shape of a malformed result                                            | `crates/mangostudio-runtime/src/result_check.rs`'s unit tests                                                                                                                                        |
| `consent-gate.test.ts` — `consentDenial` message/detail shape                                        | `crates/mangostudio-runtime/src/ports/authorization.rs`'s unit tests                                                                                                                                 |
| `consent-gate.test.ts` — a zero-capability method passes with nothing granted                        | `crates/mangostudio-runtime/tests/consent.rs::a_zero_capability_method_passes_even_under_the_denying_default`                                                                                        |
| `consent-gate.test.ts` — a capability-bearing method is denied and recorded                          | `crates/mangostudio-runtime/tests/consent.rs::denying_authorization_refuses_a_capability_bearing_method_and_records_it`                                                                              |
| (no direct TypeScript equivalent — the SDK's own panic-to-`INTERNAL` mapping is unguarded there too) | `crates/mangostudio-runtime/tests/panic_isolation.rs::a_panicking_concurrent_request_does_not_take_down_a_normal_one`                                                                                |
| `manifest.test.ts` — `features` reflects `allow`                                                     | `crates/mangostudio-runtime/src/manifest.rs`'s unit tests (extended with the implementation gate this crate adds)                                                                                    |

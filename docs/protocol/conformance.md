# Conformance

Three kinds of tests prove an implementation speaks Mango Protocol 1: the fixture corpus, which
any decoder can run; the transport suite, which both SDKs run against every port implementation
they ship; and the interop lane, in which a TypeScript peer and a Rust peer talk to each other
over each transport. All three live in this repository and all three run in CI.

## The fixture corpus

`spec/fixtures/1/` holds seven JSON files. Each case has a `name`, a `verdict` and the input;
`accept` cases also carry `expected`, the decoded value as a recursive subset (every member of
`expected` must equal the decoded member; extra members are allowed, because envelopes are
open).

| File                | Exercises                                                             | Input                                  |
| ------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `frames.json`       | One frame per case: schema validity, grammar, limits, unknown members | `line`, one NDJSON record              |
| `ndjson.json`       | The line decoder: buffering, blank lines, CR, oversized partial lines | `pieces`, `finish`, `maxFrameBytes`    |
| `chunks.json`       | The WebSocket chunk reassembler: header, count, index, minimums       | `messages` (base64), `maxMessageBytes` |
| `negotiation.json`  | Version negotiation: majors, minors, the close code on mismatch       | `local`, `remote`, `expected`          |
| `origins.json`      | The WebSocket acceptor's `Origin` allow-list: exact, never a prefix   | `origin`?, `allowed`                   |
| `ssh-argv.json`     | The `ssh` launcher preset: every option, the quoting, the refusals    | `options`, `argv` or `reason`          |
| `legacy-hello.json` | The greeting of a `runtime-protocol` 1.0.1 peer, refused with `4426`  | `line`, `chunks` (base64), `closeCode` |

Verdicts:

- `accept`: the decoder must produce a frame; `expected` is a subset of it.
- `reject`: the decoder must refuse; `reason` names the class (`invalid-json`, `schema`,
  `too-large`, `chunk-*`). A chunk case may carry `refusedAt`, the index of the message that
  must be refused; without it the refusal lands on the last message. The Ajv reference validator in `scripts/protocol/verify-spec.ts` proves every
  `reject` case with a `schema` reason is refused by the JSON Schema itself.
- `implementation-defined`: the decoder may accept or refuse, but must not crash. These cover
  corners the spec leaves to implementations, such as duplicate keys in a JSON object.

Case names start with `y_` (accept), `n_` (reject) or `i_` (implementation-defined), after the
JSON Test Suite convention.

`chunks.json` and `ssh-argv.json` are generated — by `scripts/protocol/fixtures/generate-chunks.ts` from
the reference chunker, and by `scripts/protocol/fixtures/generate-ssh-argv.ts` from the reference argv
builder; `bun run protocol:check` fails when either file is stale. Edit the generator, never the file.

`negotiation.json` also carries a `handshake` object beside its `cases`: the 15-second budget of
the wire spec's §5.2, the close code, and the exact reason a peer that never greeted is closed
with. Both SDKs assert their own defaults against it, so the number lives in one place rather
than three.

`origins.json` has no decoder behind it — it is the corpus for one comparison, and an
implementation that offers the check (`isOriginAllowed`, `is_origin_allowed`) runs every case.
Its reject cases are chosen to catch the three comparisons a reviewer reaches for first: a
prefix match admits `https://app.example.attacker.test`, a host-suffix match admits
`https://notapp.example`, and a substring match admits both.

`legacy-hello.json` is the one file nobody may regenerate. Its bytes were captured from the
`runtime-protocol` 1.0.1 codec before that codec was deleted, and there is nothing left to
capture them from: rewriting them by hand would turn "this build answers an old peer with
`4426`" into a tautology about this build.

### Running the corpus elsewhere

Any implementation can load the files: they are plain JSON, published with every GitHub release.
Load each case, feed the input to your decoder, and compare against the verdict. The TypeScript
tests under `packages/protocol/tests/fixtures-*.test.ts` and the Rust test
`crates/mango-protocol/tests/fixtures.rs` are the two reference harnesses.

## The round trip

`bun run protocol:check` also proves the two SDKs read each other's bytes when both toolchains are
present: every line of `frames.json` is sent to the crate's `roundtrip` example, which decodes
it with the Rust codec and answers with its own encoding or its refusal reason, and the
TypeScript SDK decodes the answers. Accepted lines must agree member for member and refused
lines must name the same reason. `scripts/protocol/verify-roundtrip.ts` runs it; CI runs it on the job
that has Bun and Cargo together.

## The transport suite

A transport implements one interface, `Port`: send a frame, receive frames, learn about closure,
close with a code. The session does everything else. To prove a port is correct, the TypeScript
SDK ships a shared test suite in `@mangostudio/protocol/testing`:

```ts
import { describe } from 'bun:test';
import { itBehavesLikeAMangoTransport } from '@mangostudio/protocol/testing';

describe('my transport', () => {
  itBehavesLikeAMangoTransport({
    async connect(aOptions, bOptions) {
      // Open a real connection between two sessions using your port on both ends.
      // Return { a, b, drop, close }: the two sessions, a way to sever the link
      // without a close frame, and a clean close.
    },
    chunked: false, // true when frames are split across messages or stream chunks
    async connectRaw(aOptions) {
      // Optional. Open a session on one end and give the test raw write access
      // to the other end, so it can send malformed lines and a legacy hello.
    },
  });
});
```

The suite runs the same scenarios against every transport: simultaneous handshake in both
directions, minor negotiation, major mismatch answered with `4426`, requests in both directions
and concurrently, unsupported methods, handler errors with codes and details, a request past the
responder's in-flight ceiling refused as retryable, reserved method names, `rpc.discover`
refused below the minor that defines it, stream ordering and
`end`, per-topic sequence numbers, every event a handler emitted before it returned arriving ahead
of its answer, one stream key past the local ceiling refused before anything
is sent, ping in both directions — with the
periodic ping switched off, which is how the suite proves §9's rule that a peer running no
cadence of its own still answers one — cancel,
local timeouts, dropped links failing in-flight requests with `UNAVAILABLE`, close reason
propagation including fatal codes, `FRAME_TOO_LARGE` without ending the session, honouring a
lower announced frame limit, and, with `connectRaw`, a schema-invalid `hello` answered with
`4426` and unknown members ignored.

`@mangostudio/protocol/testing` also exports `normalizeSchema`, `schemaDifferences` and
`crossFileDefinitions`, the rules this repository's own schema-equality check runs on. A consumer
that emits a JSON Schema of its own — from TypeBox on one side and schemars on the other, say —
compares the two by those rules rather than by a fourth copy of them, and a rule this repository
adds reaches it with the next package release instead of drifting. `crossFileDefinitions` is what
makes a cross-file `other.json#/$defs/<name>` resolvable: it keys one file's `$defs` by that
reference so the caller can merge them into the definitions it passes `normalizeSchema`.

Assert a rejection with `rejectionOf` from the same entry rather than Bun's `expect().rejects`:
that matcher does not pump libuv-backed I/O on Windows while it waits, so a request whose answer
must cross a named pipe or a child's stdio never settles under it.

What a port must do for the suite to pass:

- Deliver frames in order and exactly once.
- On `close(code, reason)`, tell the peer: an NDJSON port writes a `close` frame before ending
  the stream; a WebSocket port closes with that code and reason.
- On a decoder refusal, report `{ kind: 'protocol-error', error, code }` with the code from
  `closeCodeForCodecError` and close the transport with the same code.
- Expose `maxFrameBytes` when the transport enforces one, so the session announces it.
- Report `{ kind: 'closed', code, reason }` when the peer closes, and `{ kind: 'closed' }`
  with no code when the link vanished.

The in-process, stdio, local socket and WebSocket transports in this repository all run this
suite; `packages/protocol/tests/*.test.ts` shows each fixture. The spawn launcher cannot: the
suite drives both sessions, and one of a launcher's two sessions lives in another process. It
hands out the same NDJSON port the stdio suite exercises, and `tests/stdio.test.ts` runs a real
child through `spawnPort` to prove the pipes are wired the way the suite assumes.

### The same suite in Rust

The Rust crate ships the suite behind its `testing` feature, as a `Fixture` trait with the same
three members: `connect`, `chunked` and `connect_raw`. Its fixtures live in
`crates/mango-protocol/tests/transport_*.rs`, one per transport — the in-process pair, the
NDJSON port over a pipe pair, a real local socket, and a real WebSocket at two message ceilings.
`tests/conformance_drift.rs` asserts the Rust case list matches this file's TypeScript `it(...)`
names verbatim and in order, so a case added to one suite and not the other fails the build.

The Rust launcher cannot run the suite either, for the same reason, and
`tests/transport_spawn.rs` covers what a launcher alone can prove: the pipes carry a session, a
conforming child leaves on the end of its stdin, and one that ignores that is escalated past it.

## The interop lane

The corpus proves the two SDKs read the same bytes; the transport suite proves each port obeys
the session's contract. Neither proves the two halves talk to each other, which is what
`packages/protocol/tests/interop/` is for: a TypeScript session and a Rust session on one wire,
in both directions where the transport is symmetric.

| Transport    | Directions                                                           |
| ------------ | -------------------------------------------------------------------- |
| stdio        | TypeScript launches, Rust serves (the only direction a launcher has) |
| local socket | Rust listens / TypeScript listens                                    |
| WebSocket    | Rust accepts / TypeScript accepts                                    |

The Rust side is `crates/mango-protocol/examples/conformance_peer`, which serves the same
handler set over `--stdio`, `--ipc <path>` and `--ws <addr>`, and dials out with
`--connect <ws-url|path>`. It announces `listening <address>` on stderr, because on stdio the
standard output is the wire.

The conformance suite itself cannot run here — it drives both sessions, and one of these two is
in another process — so each direction runs the list that can be proven from one side alone: the
handshake and the peer it names, `test.echo`, a 512 KiB `test.bulk` result, an unsupported
method, `test.refuse`'s chosen code and details, a cancelled `test.forever`, and the peer
exiting when the session closes, and `rpc.discover` answering with the shared example catalog —
the Rust peer publishes `spec/fixtures/1/catalog-example.json` and the TypeScript side compares
what came off the wire against that same file. Each transport also writes the frozen 1.0.1 hello as raw bytes
and asserts the Rust peer answers `4426`; the WebSocket direction additionally asserts a
credential the acceptor does not know is refused with `4401` before any `hello`.

These suites need both toolchains, so they skip unless `MANGO_INTEROP=1` is set. `bun run protocol:test`
sets it when Cargo is present, and the `interop` CI job — Ubuntu, macOS and Windows — sets it
explicitly:

```console
cargo build --locked --example conformance_peer --features testing,websocket,spawn
MANGO_INTEROP=1 bun test packages/protocol/tests/interop
```

## Property tests and fuzzing

The fixture corpus and the transport suite prove fixed cases; two more layers, Rust-only, prove
the codec and the session hold for inputs neither suite enumerates.

### Property tests

`crates/mango-protocol/tests/properties.rs` uses `proptest` to check three round trips against
arbitrary, schema-valid input rather than the corpus's fixed cases:

- `decode_line(encode_line(f)) == f` for an arbitrary frame. The generators build a
  schema-valid frame directly — the method/topic grammar, id and name length ceilings, and the
  close-code range are baked into the strategies rather than filtered after the fact — so a
  refusal here is a codec bug, not a generator bug.
- `reassemble(encode_chunks(frame, cap)) == frame` for every message cap the chunk framing
  allows, plus a focused case that lands the final chunk exactly on the 1024-byte
  minimum-payload boundary that only applies to non-final chunks.
- `negotiate(a, b)` and `negotiate(b, a)` agree on the effective minor, or both close with
  `4426`, for arbitrary major/minor pairs.

Run it with `cargo test --test properties`; it is part of `cargo test --all-targets
--all-features`, so `bun run protocol:test` already runs it. Case counts are kept modest (64 to 256 per
property) so the suite finishes in well under a second.

### Fuzzing

`crates/mango-protocol/fuzz/` is a `cargo-fuzz` crate with six libFuzzer targets under `crates/mango-protocol/fuzz/fuzz_targets/`:

| Target                   | Exercises                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decode_line`            | `decode_line` over arbitrary bytes, at a bounded frame ceiling                                                                                                               |
| `line_decoder_push`      | `LineDecoder::push` fed the same bytes whole and split at random boundaries; the two must decode identical frames and agree on any refusal                                   |
| `chunk_reassembler_push` | `ChunkReassembler::push` over an arbitrary message sequence; a refusal must always leave the reassembler reset                                                               |
| `validate`               | `validate` over a `Frame`, most of them built directly from structured input (`crates/mango-protocol/fuzz/src/lib.rs`'s `Script`) rather than hoping raw bytes parse as JSON |
| `catalog_parse`          | `Catalog` parsing from arbitrary JSON bytes                                                                                                                                  |
| `session_frames`         | a `Session` driven by a fuzzed frame stream over a scripted port, behind the crate's `tokio` feature                                                                         |

Every target is panic-free by construction: none calls `unwrap()` on fuzzer-controlled data.
`session_frames` drives its `Session` over a port whose receive half replays a bounded,
fuzzer-chosen sequence of frames and then a vanished-link closure, so termination is structural
— the driver's loop ends the moment the scripted port runs out, the same way it would for a real
peer that hung up — rather than depending on a wall-clock timeout.

`crates/mango-protocol/fuzz/` is a cargo-fuzz crate, which needs nightly and libFuzzer; it carries its own `[workspace]`
table and the root `Cargo.toml` excludes it, so it is never pulled into the stable build this
repository otherwise targets. Run it with the nightly toolchain explicitly, from `crates/mango-protocol/fuzz/`:

```console
rustup toolchain install nightly
cargo install cargo-fuzz
cd fuzz
cargo +nightly fuzz run decode_line -- -max_total_time=60
# session_frames needs the tokio feature:
cargo +nightly fuzz run --features tokio session_frames -- -max_total_time=60
```

A nightly `fuzz.yml` workflow runs all six targets for five minutes each and uploads their
corpus and any crashing input as build artifacts; trigger it manually from the Actions tab
(`workflow_dispatch`) to check a change before waiting for the schedule. It is deliberately not
part of `ci.yml`'s `gate` job: a fuzz run's pass/fail is about coverage found that run, not a
merge gate.

A bug either layer finds becomes an `n_` or `i_` case under `spec/fixtures/1/` (see "The fixture
corpus" above for the naming convention and which files are generated) plus the fix, with a
regression test that fails first with the expected shape — the same rule as any other bug in this
repository.

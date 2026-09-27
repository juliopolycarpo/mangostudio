# Adopt the Rust crate

`mango-protocol` is the wire in Rust: the frame types, their validation rules, the NDJSON line
codec, the WebSocket chunk codec, the catalog document types and, behind the `schema` feature,
a JSON Schema emission. Behind the `tokio` feature it also has a session (request/response
multiplexing, cancel, event streams, liveness, graceful close) over any `Port`, a `Contract`
builder that validates, serves and calls it — see [Use a session](#use-a-session) below — and
the [transports](#transports) that session is opened over.

```toml
[dependencies]
mango-protocol = { version = "0.2", features = ["tokio"] }
serde_json = "1"
```

The codec-only path depends on `serde` and `serde_json` only. `schemars` is pulled in by the
`schema` feature; `tokio`, `tokio-util` and `jsonschema` are pulled in by the `tokio` feature
(the session, the contract builder and the stdio and local socket transports), which the "Use a
session", "Serve a contract" and "Transports" sections below need. The `websocket` and `spawn`
features add a transport each, so a consumer pays only for the ones it opens.

| Feature     | Adds                                                                |
| ----------- | ------------------------------------------------------------------- |
| `tokio`     | `Session`, `Contract`, `transports::{ndjson, stdio, ipc, deadline}` |
| `websocket` | `transports::websocket` — dialler, acceptor, `wss://` over rustls   |
| `spawn`     | `transports::spawn` and the `transports::ssh` argv preset           |
| `schema`    | JSON Schema emission                                                |
| `testing`   | the reusable conformance suite                                      |

## Frames

```rust
use mango_protocol::{Frame, Hello, Limits, PeerInfo, Request, PROTOCOL_VERSION};
use serde_json::{json, Map};

let hello = Frame::Hello(Hello {
    protocol: PROTOCOL_VERSION,
    peer: PeerInfo { name: "my-runtime".into(), version: "1.0.0".into(), role: "runtime".into() },
    capabilities: Map::new(),
    limits: Some(Limits { max_frame_bytes: Some(1 << 20) }),
});
let request = Frame::Req(Request { id: "r-1".into(), method: "fs.read-file".into(), params: json!({ "path": "README.md" }) });
```

`Frame` is `#[serde(tag = "type")]`; optional members serialise as absent, never `null`, and
unknown members are ignored on the way in. `End` is the `evt.end` marker: it serialises as
`true` and refuses anything else.

## Encode and decode lines

```rust
use mango_protocol::{decode_line, encode_line, LineDecoder, DEFAULT_MAX_FRAME_BYTES};

let line = encode_line(&request, DEFAULT_MAX_FRAME_BYTES)?;   // compact JSON plus '\n'
let back = decode_line(&line[..line.len() - 1], DEFAULT_MAX_FRAME_BYTES)?;

let mut decoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
let outcome = decoder.push(&bytes_from_the_socket);
for frame in outcome.frames { handle(frame); }
if let Some(error) = outcome.error { close_with(error); }
```

`decode_line` parses, then runs `validate`, so a frame that came back is a frame the spec
accepts: lengths, grammars and ranges included. `LineDecoder` buffers partial lines, ignores
blank lines, strips a trailing carriage return, refuses a partial line that already exceeds the
limit, and delivers the frames it decoded before a refused record in the same outcome. After a
refusal it stays refused; the connection is meant to close.

## WebSocket chunks

```rust
use mango_protocol::{encode_chunks, ChunkReassembler};
use mango_protocol::codec::chunk::DEFAULT_MAX_MESSAGE_BYTES;

for message in encode_chunks(&frame, DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES)? {
    socket.send_binary(message);
}

let mut reassembler = ChunkReassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_FRAME_BYTES);
if let Some(frame) = reassembler.push(&incoming_binary_message)? { handle(frame); }
```

Every refusal (`CodecErrorKind::ChunkVersion`, `ChunkHeader`, `ChunkCount`, `ChunkIndex`,
`ChunkDribble`, `TooLarge`) resets the reassembler. The transport should close with `4400`.

## Negotiate the version

```rust
use mango_protocol::{negotiate, Negotiation, PROTOCOL_VERSION};

match negotiate(PROTOCOL_VERSION, remote_hello.protocol) {
    Negotiation::Compatible { effective_minor } => start(effective_minor),
    Negotiation::Mismatch { close_code } => close(close_code, "protocol mismatch"), // 4426
}
```

## Codes

`mango_protocol::error::codes` holds the reserved error codes; `is_reserved_error_code` tells
them from application codes. `mango_protocol::close_codes` holds the reserved close codes;
`is_fatal_close_code` says which ones mean "do not redial with this build".

## Catalog

`Catalog`, `CatalogMethod` and `CatalogEvent` deserialise the document the TypeScript
`defineContract().catalog()` produces, so a Rust peer can read a hub's method list, check the
names with `Catalog::validate`, and generate its own types from the embedded JSON Schemas.

## Schema emission

```sh
cargo run --example emit_schema --features schema
cargo run --example emit_catalog_schema --features schema
```

The first prints a `$defs` document equivalent to `spec/schema/1/protocol.json`, the second a
catalog document equivalent to `spec/schema/1/catalog.json`. The repository's `bun run protocol:check`
compares both with the spec on every change; you will not need either at runtime.

## Use a session

```rust
use mango_protocol::frame::PeerInfo;
use mango_protocol::port::port_pair;
use mango_protocol::session::{Session, SessionOptions};

let (port_a, port_b) = port_pair(); // swap for a real Port to speak over an actual transport
let peer = |role: &str| PeerInfo { name: "example".into(), version: "0.1.0".into(), role: role.into() };
let (a, _driver_a) = Session::spawn(port_a, SessionOptions::new(peer("a")));
let (b, _driver_b) = Session::spawn(port_b, SessionOptions::new(peer("b")));

a.ready().await?;
b.handle("fs.read-file", |params, _context| async move { Ok(params) }).persist();
let result = a.request("fs.read-file", serde_json::json!({ "path": "README.md" })).await?;
```

`cargo run --example session_pair --features tokio` runs a fuller version end to end: a request,
an event stream and a cancelled call between two in-process sessions.

Serving a contract answers `rpc.discover` with its catalog unless `ServeOptions { discover:
false, .. }` says otherwise, and `ContractClient::discover` reads the other side's:

```rust
let catalog = contract.client(&session).discover().await?;
let theirs = Contract::from_catalog(catalog)?; // the peer's document, checked like your own
```

`discover` fails with `METHOD_UNSUPPORTED` against a peer that serves no contract, and with
`INVALID_REQUEST` against a wire 1.0 peer, which cannot have meant the method.

A session bounds what the peer can make it hold, so a peer that opens requests and never cancels
them cannot grow this side without limit:

```rust
let options = SessionOptions::new(peer("runtime"))
    .with_max_in_flight(32)   // requests this side answers at once; 256 by default
    .with_max_stream_keys(64); // stream keys this side emits on at once; 1024 by default

// What the peer said it will answer at once, so a caller can pace itself
// instead of discovering the ceiling by being refused.
let budget = a.remote_max_in_flight();
```

`max_in_flight` is announced in `hello.limits`. Past it, a request is answered with `UNAVAILABLE`
and `details.kind` of `in_flight_limit`; that refusal is **retryable** — send the same call again
once one of yours has settled, and never latch on it the way you would on `METHOD_UNSUPPORTED`.
`max_stream_keys` is local and never announced: `emit` returns `Err` when a new key would pass
it, because reaching it means this side leaked stream ids rather than that the peer did anything.
`emit`'s `Ok(false)` means more than "not ready yet", too: it also covers a driver that has
stopped, and either way the stream key `emit` was called with is never spent — a session whose
driver died does not burn its `max_stream_keys` budget on frames nobody saw.

`with_max_frame_bytes` sets what this session *asks for*; the port it opens over may decode less.
The session announces the lower of the two — never the session's own ceiling outright — so a
session configured above a port's ceiling never tells the peer to send frames the port then
refuses.

A frame or message ceiling set below what the spec allows panics at configuration, naming the
value and the floor it broke, the way the TypeScript SDK raises a `RangeError` for the same call.
`with_max_in_flight` and `with_max_stream_keys` carry the same rule at a floor of `1`: `0` would
build a `hello.limits.maxInFlight` the schema refuses, or make the very first `emit` answer
`UNAVAILABLE`.

**Upgrading from `0.1`:** that check costs six constructors their `const fn`. The message names
the value received and the floor it broke, which means building a `String`, and a formatted panic
cannot appear in a `const fn`. The six are `LineDecoder::new`, `ChunkReassembler::new`,
`SessionOptions::with_max_in_flight`, `SessionOptions::with_max_stream_keys`,
`WebSocketOptions::with_max_frame_bytes` and `WebSocketOptions::with_max_message_bytes`.

Only the first two can break your build. The other four are builders taking `self`, and the
receiver they need — `SessionOptions::new`, which allocates a `String`, or
`WebSocketOptions::default` — was never `const` itself, so no caller could reach them from a
`const` context in `0.1` either.

Calling either of the first two at run time is unchanged. What stops compiling is a `const` item,
a `static`, or your own `const fn` built on one:

```rust,ignore
// 0.1: fine. 0.2.0: error[E0015], cannot call non-const fn in constants.
static DECODER: LineDecoder = LineDecoder::new(DEFAULT_MAX_FRAME_BYTES);
```

A `OnceLock` gives you the same single instance, and takes the floor check with it:

```rust,ignore
use std::sync::OnceLock;
use mango_protocol::codec::ndjson::{DEFAULT_MAX_FRAME_BYTES, LineDecoder};

static DECODER: OnceLock<LineDecoder> = OnceLock::new();
let decoder = DECODER.get_or_init(|| LineDecoder::new(DEFAULT_MAX_FRAME_BYTES));
```

A decoder carries per-connection buffer state, so one per connection is usually what you want
rather than a shared one.

`cargo-semver-checks` reports these as `inherent_method_const_removed` against the published
`0.1.0`, and it is right to.

## Serve a contract

A `Contract` (see [Build a contract](build-a-contract.md)) wraps a session with schema
validation, typed handlers and a policy guard, so a request never reaches your code until its
parameters have passed the method's schema:

```rust
let guard = contract.serve(&session, handlers, ServeOptions::default())?;
let result: MyResult = contract.client(&session).request("fs.read-file", params).await?;
```

See `Contract::client`'s own doc example for the full typed round trip through `serve` and
`ContractHandlers`, and the `Guard` trait's doc example for the policy hook that runs between
schema validation and the handler.

## Transports

Every transport produces a `Port`, and the session never learns which one it got. The
byte-oriented ones share `transports::ndjson`, so the framing, the refusal handling and the
close sequence exist once.

```rust
use mango_protocol::transports::stdio::stdio_port;
use mango_protocol::transports::ipc::{connect_ipc, ipc_path, listen_ipc};
use mango_protocol::transports::deadline::ConnectDeadline;

// A spawned child speaks on its own standard streams. stdout carries frames
// and nothing else, so route your logging to stderr while the session runs.
let (session, driver) = Session::spawn(stdio_port(), SessionOptions::new(peer));

// A local socket: a Unix domain socket, or a Windows named pipe. Both are
// published so that only their owner can open them, and `accept` hands back
// whatever identity the operating system offered for the peer.
let mut listener = listen_ipc(ipc_path("mango-hub")?).await?;
let (port, identity) = listener.accept().await?;

// Dialling takes a deadline: an attempt nobody completes would otherwise stay
// in flight for as long as the process lives.
let deadline = ConnectDeadline::default().with_timeout(Duration::from_secs(5));
let port = connect_ipc(ipc_path("mango-hub")?, &deadline).await?;
```

On POSIX, `listen_ipc` treats a socket file at the address as *stale* — and replaces it — only
when a connection to it is refused; a connection that succeeds, or one the dial cannot judge
either way, leaves the address in use and `listen_ipc` refuses to bind. `IpcListener::close` only
ever removes the address when it is still this listener's own: the inode recorded when it
published is checked against what sits at the path, so a listener that crashed and was replaced
does not delete its replacement's address by closing a handle late. Windows has no equivalent
staleness question — `CreateNamedPipe`'s first-instance flag already refuses a duplicate name
outright.

The WebSocket transport dials with the `mango.v1` subprotocol and the reference bearer
credential, and accepts an upgrade either through its own helper or from whatever HTTP stack you
already run:

```rust
use mango_protocol::transports::websocket::client::{WebSocketConnectOptions, connect_websocket};
use mango_protocol::transports::websocket::server::{AcceptOptions, accept_websocket};
use mango_protocol::transports::websocket::{WebSocketOptions, websocket_port};

let options = WebSocketConnectOptions::default().with_bearer(token);
let port = connect_websocket("wss://hub.example/runtime", &options, &deadline).await?;

// Accepting: the credential is checked before any hello, so a peer whose
// token is no good never learns who you are. It reads the code off the close
// because the upgrade completed first.
let port = accept_websocket(socket, WebSocketOptions::default(), |upgrade| {
    match upgrade.bearer() {
        Some(t) if known(t) => Ok(()),
        _ => Err(close_codes::UNAUTHORIZED),
    }
})
.await?;

// An acceptor a browser dials says which sites it serves. The default list is
// empty, which refuses every upgrade that carries an Origin at all — right for
// a hub only native clients reach, wrong to leave in place for one a page dials.
let options = AcceptOptions::from(WebSocketOptions::default())
    .with_allowed_origins(["https://app.example"]);
let port = accept_websocket(socket, options, |upgrade| authorize(upgrade.bearer())).await?;

// Or, if you already upgraded the socket yourself:
let port = websocket_port(already_upgraded, WebSocketOptions::default());
```

A refusal is not dropped the instant its `close` frame is written: the acceptor reads on until
the dialler answers with its own `close`, for up to two seconds. A dialler that already sent its
`hello` would otherwise leave bytes unread, and the reset that follows loses the `close` frame on
Windows. Budget those two seconds into any timeout you wrap around `accept_websocket`.

`wss://` uses rustls with the webpki root set and the `ring` provider, named explicitly rather
than installed as the process default — a library that installed one would be deciding for the
binary it is linked into. `ring` also builds without cmake or nasm, which keeps the Windows and
aarch64 lanes free of a C toolchain. TLS is client-side only: the acceptor takes a stream
somebody else already decrypted, because the protocol does not terminate TLS
(`spec/transports/websocket.md`, TLS).

The launcher starts a child and speaks stdio through its pipes. It observes and reports rather
than guessing why a child failed:

```rust
use mango_protocol::transports::spawn::{SpawnOptions, spawn_port};
use mango_protocol::transports::ssh::{SshArgv, classify_ssh_exit, ssh_argv};

let (port, peer) = spawn_port(SpawnOptions::new(["mango-runtime", "--stdio"]))?;
let (session, _driver) = Session::spawn(port, SessionOptions::new(identity));

if session.ready().await.is_err() {
    let why = peer.start_error(None).await;      // exit status, spawn error, last stderr line
    eprintln!("{}", why.stderr_line);
}
// Closing the session ends the child's stdin, which is step 1 of the
// sequence and all a conforming peer needs; `terminate` waits that out and
// escalates to SIGTERM and SIGKILL for a child that does not leave. It gives
// up and resolves `None` once the exit grace runs out after SIGKILL, so a
// shutdown awaiting it is delayed but never blocked forever; `exited` is the
// call to await for the real exit — it has no deadline.
session.close(close_codes::RELEASED, Some("done")).await;
peer.terminate().await;

// SSH, WSL and container launches are the same transport with a different argv
// in front; the preset is pure, so a caller can unit-test its launch command.
let argv = ssh_argv(&SshArgv::new("build-box", ["mango-runtime", "--stdio"]))?;
```

`examples/conformance_peer` is a complete peer over every one of these, and what the interop
lane drives:

```console
cargo run --example conformance_peer --features testing,websocket,spawn -- --ws 127.0.0.1:8080
```

## What is missing, on purpose

Server-side TLS is not here: the runtime's own `serve` sits behind a TLS-terminating proxy, and
it becomes a feature when a consumer asks for one. `rpc.discover` is deferred too, out of scope
until a consumer needs it. A `tracing` feature is
deferred as well, since no consumer reads a span yet and it would be public surface the docs
lint and the feature powerset would have to carry for nothing.

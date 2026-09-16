# Adopt the TypeScript SDK

`@mangostudio/protocol` gives an application one `Session` over any transport, plus the
contract helper described in [build-a-contract.md](build-a-contract.md). This page walks from
zero to a working peer.

```sh
bun add @mangostudio/protocol
```

The core entry (`@mangostudio/protocol`) is browser-safe. Transports that need the operating
system live under subpaths: `./stdio`, `./ipc`, `./spawn`. `./ws` and `./in-process` are
runtime-neutral. `./testing` is the shared transport test suite.

## One session, any port

A `Port` is the transport: it sends a frame, delivers frames, reports closure, closes with a
code. A `Session` turns a port into requests, events, ping and close semantics:

```ts
import { Session } from '@mangostudio/protocol';

const session = new Session(port, {
  peer: { name: 'my-runtime', version: '1.0.0', role: 'runtime' },
  capabilities: { contracts: { 'example.files': '1.0.0' } },
});
const remote = await session.ready; // both hellos exchanged, minors negotiated
console.log(remote.peer.name, remote.effectiveMinor);
```

Both peers send `hello` as soon as the transport opens; there is no client and no server at
this layer. `ready` rejects with a `RemoteError` of code `PROTOCOL_MISMATCH` when the majors
differ, and with `TIMEOUT` when the peer never says hello (15 seconds by default).

A limit below the floor §11 sets is a `RangeError` from the call that sets it — the
constructor, or the transport's own options — not a `hello` the peer's schema refuses. The
schema's *maximum* is not checked yet; a ceiling above `2147483647` still builds a `hello` the
peer refuses.

Options worth knowing:

| Option               | Default                   | Meaning                                                                                        |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `maxFrameBytes`      | the port's limit, 16 MiB  | Largest frame accepted, never below 4096; the session announces the lower of it and the port's |
| `maxInFlight`        | 256                       | Requests answered at once, never below 1; announced in `hello.limits`                          |
| `maxStreamKeys`      | 1024                      | Stream keys open at once, never below 1; local, never announced                                |
| `handshakeTimeoutMs` | 15000                     | How long to wait for the peer's `hello`                                                        |
| `livenessIntervalMs` | 20000, `false` to disable | Ping interval; one missed pong closes with 4000 and reason `liveness timeout`                  |
| `handlers`           | none                      | Method handlers registered before the handshake, so early requests are served                  |
| `timers`             | globals                   | Injected timers for tests                                                                      |

## Choose a transport

**Child process over stdio.** The child owns stdin and stdout; everything it prints to stdout
must be protocol. Diagnostics go to stderr.

```ts
// child
import { stdioPort } from '@mangostudio/protocol/stdio';
const session = new Session(stdioPort(), { peer });

// parent
import { spawnPort, sshArgv } from '@mangostudio/protocol/spawn';
const child = spawnPort({ argv: ['bun', 'runtime.ts'], cwd, env: { PATH: process.env.PATH } });
const session = new Session(child.port, { peer });
// or over ssh, with the hardened argv preset:
const remote = spawnPort({ argv: sshArgv({ host: 'build-box', command: ['mango-runtime'] }) });
```

A child that cannot start at all (`ENOENT`, `EACCES`) is not an exception: the port reports
`{ kind: 'closed' }`, `child.exited` resolves with `{ code: null, signal: null }`, and the spawn
error is appended to `child.stderrTail()`, so one code path builds the message either way.
`classifySshExit(status, tail)` turns those two observations into a sentence for an ssh launch.

`await child.startError()` collects the same observations in one shape for a launch that never
reached a handshake: the exit status, the `spawnErrorCode` of a command that never became a
process, and the last line the child wrote. It waits a short grace for the exit, because the
pipes closing and the exit landing are not ordered, and reports `exit: undefined` rather than
inventing a status when the grace runs out.

`spawnPort` passes only the environment you give it, keeps a tail of stderr for error reports,
and on close sends SIGTERM then SIGKILL after a grace period. The launcher decides what to run;
WSL and container wrappers are argv arrays the application builds.

`child.terminate()` may resolve `undefined`: once `SIGKILL` has had `exitGraceMs` (2 seconds by
default) and the child still has not exited — stuck in `D` state, or a Windows process whose
`kill()` returned `false` — it gives up rather than waiting forever, and does not invent a
status. `child.exited` is the promise with no deadline; it always waits for the real exit, so a
caller that needs to know for certain awaits that one instead.

**Local socket.** A Unix domain socket or a Windows named pipe, NDJSON framed:

```ts
import { connectIpc, listenIpc, ipcPath } from '@mangostudio/protocol/ipc';
const path = ipcPath('mango-hub'); // \\.\pipe\mango-hub or $XDG_RUNTIME_DIR/mango-hub.sock
const server = await listenIpc(path, (port) => new Session(port, { peer, handlers }));
const client = new Session(await connectIpc(path, { timeoutMs: 5000 }), { peer });
```

`connectIpc` and `connectWebSocket` both take `timeoutMs` and `signal`. Without one, an
attempt nobody completes — a listener whose accept queue no one drains, a pipe whose server
stopped answering — stays in flight for as long as the process lives. A deadline that passes
destroys what the dial opened and rejects with a `TimeoutError`; an abort rejects with the
reason the caller gave.

On POSIX the socket is owner-only from the moment it exists. A socket file at the address is
*stale* when a connection to it is refused — the listener that made it is gone — and `listenIpc`
removes a stale file before binding; a file a connection succeeds against, or one the dial
cannot judge either way, is a live listener's address, and `listenIpc` refuses to bind over it
with `EADDRINUSE` instead of silently taking it over. On Windows the named pipe is **not**
restricted — Node cannot set a pipe's security descriptor, so any local user may connect. Check
the peer's credentials and close with `4401` before `hello` if the address alone is not enough
trust there.

One residual race is outside what a probe can close: libuv's `uv__pipe_close` unlinks a Unix
socket path unconditionally on `close()`, with no way from JavaScript to make it check first. A
listener that crashes, gets replaced at the same address, and *then* runs its delayed `close()`
will unlink the replacement's socket file out from under it — the replacement keeps running on
an inode nothing can reach. The probe above closes the far more common case, a stale file with
no process behind it at all; this one needs a crash landing inside that exact window.

**WebSocket.** Binary chunked messages under subprotocol `mango.v1`; the SDK never sends text
frames. Authentication is a bearer token on the upgrade request, checked by the HTTP layer
before the port exists.

```ts
import {
  connectWebSocket,
  createWebSocketPort,
  isOriginAllowed,
  outcomeOfBunSend,
  WEBSOCKET_SUBPROTOCOL,
  webSocketPort,
} from '@mangostudio/protocol/ws';

// client
const port = await connectWebSocket('wss://hub.example/runtime', { headers: { authorization: `Bearer ${token}` } });

// server, any framework: give the SDK a sink and feed it messages
const { port, onMessage, onDrain, onClose } = createWebSocketPort({
  send: (bytes) => outcomeOfBunSend(ws.send(bytes)),
  close: (code, reason) => ws.close(code, reason),
});
// then call onMessage(bytes) for every binary message, onDrain() when backpressure
// clears, and onClose(code, reason) when the socket closes

// a WHATWG WebSocket object on either side
const port = webSocketPort(socket);

// your framework owns the upgrade, so it owns the Origin check; this is the
// comparison spec/fixtures/1/origins.json pins — exact, never a prefix.
if (!isOriginAllowed(request.headers.get('origin') ?? undefined, ALLOWED_ORIGINS)) {
  return new Response(null, { status: 403 });
}

// or, if the framework hands the SDK an already-open socket instead of a
// chance to refuse the upgrade, hand the origin to the port and let it close
// with 4403 before `hello` rather than check at the HTTP layer:
const { port } = createWebSocketPort(sink, {
  accept: { origin: request.headers.get('origin') ?? undefined, allowedOrigins: ALLOWED_ORIGINS },
});
```

Both paths are conformant (spec/transports/websocket.md, Origin); pick whichever one this SDK
actually owns. Refusing at the upgrade is cheaper — the socket never opens — but only works when
the framework lets the acceptor answer the upgrade itself. `accept` is for the framework that
hands over an already-open socket: TypeScript owns no HTTP upgrade of its own, so
`createWebSocketPort` closes it with `4403` and `origin not allowed` before it would otherwise
send anything, and a `Session` built on the returned port fails its handshake instead of hanging
to the timeout. `origin` is required but nullable on purpose — write
`request.headers.get('origin') ?? undefined` rather than omit the field, so a caller who forgot
to read the header cannot read as an origin to let through.

The sink reports each send as sent, buffered or dropped, so the port can pause its queue under
backpressure and close with `4400` when the socket drops a chunk; `outcomeOfBunSend` maps the
number Bun's `ServerWebSocket.send` returns onto that vocabulary. Only runtimes whose
`WebSocket` takes an options object can set upgrade headers: in a browser, or on Node's global
`WebSocket`, `connectWebSocket` ignores `headers` and the token goes in the URL or a cookie.

**In-process.** Two ports joined by a queue, for tests and for hosting a runtime in the same
process:

```ts
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
const { a, b } = createInProcessPortPair();
```

Validate mode (the default) encodes and decodes every frame, so tests exercise the codec; clone
mode skips the codec for speed.

## Requests, events, close

```ts
session.handle('fs.read-file', async (params, { signal }) => readFile(params, signal));
const result = await session.request('fs.read-file', { path: 'README.md' }, { timeoutMs: 5000 });

session.emit({ topic: 'fs.changed', payload: { path: 'a.ts' } });
const off = session.onEvent((frame) => console.log(frame.topic, frame.seq));

session.onClose(({ code, reason, fatal }) => {
  if (!fatal) scheduleReconnect();
});
// Resolves once every handler this side was running has settled, bounded by
// `handlerGraceMs`; `closeNow` is the synchronous form for a caller that cannot await.
await session.close(4000, 'released');
```

Use the contract helper for typed calls; the raw API is for tooling and for the reserved
`rpc.*` space, of which the protocol defines one method:

```ts
// Serving a contract answers rpc.discover with its catalog, unless you say not to.
contract.serve(session, handlers); // { discover: false } opts out

// Reading the other side's: validated against catalog.json before it comes back.
const catalog = await contract.client(session).discover();
```

`discover()` rejects with `METHOD_UNSUPPORTED` against a peer that serves no contract, and with
`INVALID_REQUEST` against a wire 1.0 peer, which cannot have meant the method.

## Resource caps

A session bounds what the peer can make it hold, so a peer that opens requests and never
cancels them cannot grow this side without limit.

```ts
const session = new Session(port, {
  peer,
  maxInFlight: 32, // requests this side answers at once; 256 by default
  maxStreamKeys: 64, // stream keys this side emits on at once; 1024 by default
});

// What the peer said it will answer at once, so a caller can pace itself
// instead of discovering the ceiling by being refused.
const budget = session.remoteMaxInFlight;
```

`maxInFlight` is announced in `hello.limits`. Past it, a request is answered with `UNAVAILABLE`
and `details.kind` of `in_flight_limit`; that refusal is **retryable** — send the same call
again once one of yours has settled, and never latch on it the way you would on
`METHOD_UNSUPPORTED`. `maxStreamKeys` is local and never announced: `emit` throws when a new key
would pass it, because reaching it means this side leaked stream ids rather than that the peer
did anything.

## Errors

- A handler throws `RemoteError(code, message, details?)` to answer with a specific code. Any
  other exception becomes `INTERNAL`.
- A request rejects with `RemoteError`; read `error.code`. Reserved codes are in
  `RESERVED_ERROR_CODES`; the application's own codes pass through untouched.
- A malformed frame from the peer closes the session with a `4400` family code; the closure
  carries the `CodecError` that caused it.

## What the SDK does not do

Authentication, consent, audit, reconnect policy, pairing and process supervision belong to
the application. The SDK gives every one of them a hook (a guard, an `onClose` with a fatal
flag, a spawn launcher with an exit promise) and takes no decision itself.

## Test your transport

Run the shared suite against any new port implementation; see
[conformance.md](conformance.md).

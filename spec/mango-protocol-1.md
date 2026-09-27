# Mango Protocol 1

Status: draft. This document is normative for wire major 1, up to and including minor 2.
`spec/schema/1/protocol.json` is the normative JSON Schema for every shape named here; where
prose and schema disagree, the schema wins and the prose is a bug.

| Minor | Added                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `1.0` | Everything else in this document.                                                                                       |
| `1.1` | `hello.limits.maxInFlight` ([§11.2](#112-session-limits)) and the `rpc.discover` method ([§6.4](#64-reserved-methods)). |
| `1.2` | A handler's frames go out ahead of its answer ([§6.2](#62-res-and-err)).                                                |

The key words MUST, MUST NOT, SHOULD and MAY are to be read as in RFC 2119.

## 1. Scope

Mango Protocol is a message protocol between two **peers** connected by a **transport** that
delivers ordered, reliable, bidirectional **frames**. It defines:

- the frame envelope and its nine frame types,
- the handshake and version negotiation,
- requests, responses, cancellation and the error model,
- event streams,
- liveness and close semantics,
- size limits.

It does not define application methods, capabilities, authentication or reconnect policy.
Those belong to the application contract (see [catalog](#12-contracts-and-the-catalog-document))
and to each transport specification under `spec/transports/`.

## 2. Terms

| Term      | Meaning                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Peer      | One end of a connection. Peers are symmetric: either may send any frame type.                                                     |
| Role      | A free-form label a peer gives itself in `hello` (`hub`, `runtime`, `tool`, …). Applications interpret it; the protocol does not. |
| Frame     | One JSON object with a `type` member, the unit of exchange.                                                                       |
| Transport | Anything that carries frames in order, reliably, both ways: a pipe, a socket, a WebSocket, an in-process queue.                   |
| Session   | The state both peers keep between the transport opening and closing: handshake state, in-flight requests, stream counters.        |
| Requester | The peer that sent a `req`. Responder: the peer that answers it.                                                                  |
| Contract  | An application's catalog of methods, events and capabilities, described by `catalog.json`.                                        |

## 3. Encoding

- A frame is a JSON object encoded as UTF-8 without a byte order mark.
- Members appear in any order. Duplicate member names are implementation-defined; peers SHOULD
  refuse them.
- Integers SHOULD be within the IEEE 754 safe integer range (`±2^53 − 1`), so a JavaScript
  peer reads the value the sender wrote. A decoder MAY refuse a larger integer and MAY round
  it; a sender MUST NOT rely on either.
- How frames are delimited on the wire is a transport concern (NDJSON lines, chunked messages,
  structured objects). Every transport MUST deliver whole frames in the order they were sent.

## 4. Envelope and tolerance

Every frame has a `type` member whose value names one of the nine frame types below. Objects in
this specification are **open**:

- A decoder MUST ignore members it does not know, at every level of a frame.
- A member defined by a later minor of this major is always optional. A peer MUST NOT send a
  member introduced after the [effective minor](#52-negotiation) of the session.
- Member names without a prefix are reserved for this specification. Member names beginning
  with `x-` are reserved for vendor extensions and are never defined by this specification.
- A decoder MUST refuse a frame whose known members violate the schema. Refusing means the
  frame is not delivered to the session; what happens next is a transport decision (a stream
  transport that cannot resynchronise closes with `4400`, see [§10](#10-close)).

Frame types:

| `type`   | Purpose                             | Members                                        |
| -------- | ----------------------------------- | ---------------------------------------------- |
| `hello`  | Handshake                           | `protocol`, `peer`, `capabilities`, `limits`?  |
| `req`    | Request                             | `id`, `method`, `params`                       |
| `res`    | Successful response                 | `id`, `result`                                 |
| `err`    | Failed response                     | `id`, `error`                                  |
| `evt`    | Event, optionally part of a stream  | `topic`, `seq`, `streamId`?, `payload`, `end`? |
| `cancel` | Ask the responder to stop a request | `id`                                           |
| `ping`   | Liveness probe                      | —                                              |
| `pong`   | Liveness answer                     | —                                              |
| `close`  | Farewell with a reason              | `code`, `reason`?                              |

`?` marks an optional member. Optional members are **absent** when they carry no value; `null`
is not a valid substitute unless the schema says so.

## 5. Handshake

### 5.1 hello

As soon as the transport is open, each peer MUST send exactly one `hello`:

```json
{
  "type": "hello",
  "protocol": { "major": 1, "minor": 0 },
  "peer": { "name": "mangostudio-runtime", "version": "0.2.0", "role": "runtime" },
  "capabilities": { "fsRead": true, "shells": ["bash"] },
  "limits": { "maxFrameBytes": 4194304 }
}
```

- `protocol.major` and `protocol.minor` are non-negative integers. `major` MUST be `1` for this
  document. `minor` is the highest minor of this major the sender implements.
- `peer.name` identifies the implementation (a product or binary name). `peer.version` is that
  implementation's release string, opaque to the protocol. `peer.role` is a lowercase label
  matching `^[a-z][a-z0-9-]*$`.
- `capabilities` is an object owned by the application contract. The protocol does not define
  its members. It MUST be present; `{}` is valid.
- `limits.maxFrameBytes`, when present, lowers the frame size ceiling this peer will accept,
  and `limits.maxInFlight` announces how many requests this peer will hold open for the other
  side at once (see [§11](#11-limits)).

Until a peer has received the other side's `hello`, it MUST NOT send any frame other than
`hello`, `ping`, `pong`, `close`, or an `err` answering a request the other side sent too
early (§5.3): the peer's limits and the effective minor are not known yet.

`hello` is sent as soon as the transport is open, with one exception in the other direction:
where a transport authenticates (a WebSocket upgrade carrying a credential, a local socket
checking peer credentials), the **acceptor** MUST NOT send `hello` until that check has
succeeded. A peer whose credential is no good is closed with `4401` or `4403` and never learns
who was listening. The **dialler** is under no such rule and MAY send `hello` immediately: on a
refusal the acceptor discards it unread, which is why a refused dial costs one frame and not a
round trip.

### 5.2 Negotiation

On receiving the peer's `hello`:

1. If `protocol.major` differs from the receiver's major, the handshake fails. The receiver
   MUST close with code `4426` (`PROTOCOL_MISMATCH`) and MUST NOT send any request. A frame
   whose `type` is `hello` but which fails the schema is treated the same way: it is a peer
   speaking another wire version, and `4426` tells it so where `4400` would only say
   "garbage".
2. Otherwise the **effective minor** is the lower of the two `minor` values. Both peers derive
   the same number. A peer MUST NOT rely on any behaviour or member introduced after the
   effective minor.

The handshake is complete for a peer once it has both sent and received `hello`. A peer SHOULD
bound the wait with a timeout; on expiry it closes with `4400` and the reason `handshake timeout`,
spelled exactly that way so a log on the other side is searchable. The reference budget is
15 seconds, which `spec/fixtures/1/negotiation.json` records under `handshake` for a conformance
suite to check against its own default. A launcher that has to open a network connection or start
a container before the child can greet budgets more (see [spawn](transports/spawn.md)).

### 5.3 Before the handshake completes

- A `req` received before the handshake completes is answered with `err` code `UNAVAILABLE`.
- `evt` and `cancel` received before the handshake completes are ignored.
- `ping` is answered with `pong` at any time after the transport opens.

## 6. Requests and responses

### 6.1 req

```json
{ "type": "req", "id": "r-42", "method": "fs.read-file", "params": { "path": "/etc/hosts" } }
```

- `id` is a string of 1 to 256 characters chosen by the requester. A requester MUST NOT reuse
  an id within a session, including after its response has arrived: a per-session counter is the
  reference generator, and both SDKs use one. The rule binds the sender because a responder
  cannot check it — remembering every id a session has ever carried is exactly the unbounded
  state [§11](#11-limits) refuses — so a responder enforces only the part it can see, an id that
  duplicates one still in flight ([§6.2](#62-res-and-err)).
- `method` matches `^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z](?:[a-z0-9-]*[a-z0-9])?)+$` and is
  at most 128 characters: at least two dot-separated segments, each starting with a lowercase
  letter, made of lowercase letters, digits and dashes, and never ending with a dash. Names under
  the `rpc.` segment are reserved for this specification and listed in
  [§6.4](#64-reserved-methods); an application MUST NOT define one.
- `params` is any JSON value. Contracts SHOULD require an object.

### 6.2 res and err

The responder MUST send exactly one of `res` or `err` for every `req` it delivered to the
session, including requests it refused, cancelled, or could not route:

```json
{ "type": "res", "id": "r-42", "result": { "content": "…" } }
{ "type": "err", "id": "r-42", "error": { "code": "DENIED", "message": "fsRead was not granted", "details": { "capability": "fsRead" } } }
```

- `result` is any JSON value, including `null`.
- `error.code` matches `^[A-Z][A-Z0-9_]*$` and is 1 to 64 characters. `error.message` is a
  non-empty human-readable sentence naming the received value and the expected shape where that
  applies. `error.details` is an optional open object for typed detail.
- A `res` or `err` whose `id` matches no in-flight request is ignored (a late answer after a
  local timeout).
- A `req` whose `id` duplicates an in-flight request is answered with `err` code
  `INVALID_REQUEST` and the original request continues.
- From minor 2, a responder MUST order a handler's frames causally ahead of its answer: every
  `evt` and `req` its session was asked to send before the handler completed — by the handler
  itself, or by work whose completion the handler awaited — goes on the transport before that
  request's `res` or `err`. Frames the session produces on its own (a `pong`, a `close`), frames
  asked for after the handler completed, and frames from work the handler did not await carry
  no such order. When the [effective minor](#52-negotiation) is at least 2, a requester MAY
  therefore treat the answer as the end of what the handler emitted in the course of the call
  and stop listening for it. Below that, a responder MAY write the answer ahead of frames the
  handler asked for earlier, so a requester that needs them keeps listening past the answer.
  The rule changes no byte on the wire, only the order a responder writes frames it already
  sends; a minor carries it because a requester can rely on it only when both peers implement
  it.

### 6.3 Reserved error codes

| Code                 | Sent when                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAVAILABLE`        | The session cannot serve requests: handshake not complete, session closing, or already holding `maxInFlight` requests open ([§11.2](#112-session-limits), where `details.kind` says which). Also the local code a requester reports when the transport closes mid-call. |
| `INVALID_REQUEST`    | The frame is schema-valid but breaks a protocol rule: duplicate in-flight id, method grammar accepted by a lax decoder, reserved `rpc.` method.                                                                                                                         |
| `METHOD_UNSUPPORTED` | The responder has no handler for `method`.                                                                                                                                                                                                                              |
| `INVALID_PARAMS`     | `params` failed the contract's schema for this method. `details` SHOULD name the failing path.                                                                                                                                                                          |
| `DENIED`             | The method exists but policy refuses it (consent, authorisation). `details` SHOULD say which capability or rule.                                                                                                                                                        |
| `CANCELLED`          | The handler stopped because a `cancel` arrived.                                                                                                                                                                                                                         |
| `TIMEOUT`            | Local: the requester's own deadline passed. A responder MAY also send it when a handler exceeded a server-side budget.                                                                                                                                                  |
| `FRAME_TOO_LARGE`    | The response would exceed the frame limit; the handler's result is replaced by this error.                                                                                                                                                                              |
| `PROTOCOL_MISMATCH`  | A request that cannot be served at the effective minor. Normally the handshake refuses first and this code is never seen.                                                                                                                                               |
| `INTERNAL`           | Anything else that failed inside the responder.                                                                                                                                                                                                                         |

Applications define any other code. Unknown codes MUST be preserved as received and never
refused; a consumer narrows them to its own known set.

### 6.4 Reserved methods

Method names under the `rpc.` segment belong to this specification. Each is introduced by a
minor and is part of the wire, not of any contract:

| Method         | Since | Params                           | Result                                                                            |
| -------------- | ----- | -------------------------------- | --------------------------------------------------------------------------------- |
| `rpc.discover` | `1.1` | An object; no member is defined. | The responder's catalog document ([§12](#12-contracts-and-the-catalog-document)). |

- A requester MUST NOT send a reserved method the [effective minor](#52-negotiation) does not
  define. A responder that receives one answers `INVALID_REQUEST`, which is also what a 1.1
  peer answers for `rpc.discover` when the effective minor is `0` — the other side is a 1.0
  peer that cannot have meant this method.
- `rpc.discover` asks the responder for the contract it serves, so a peer can read the methods,
  events and capabilities of the other side without an application method of its own, and a
  diagnostic can report the skew between what a peer offers and what its caller expects. A
  responder that serves no contract answers `METHOD_UNSUPPORTED`, exactly as it would for any
  method it has no handler for: serving a catalog is a MAY, and answering `rpc.discover` when
  you serve one is a SHOULD.
- The result is the catalog document itself, not a wrapper around one. A requester validates it
  against `catalog.json` before trusting it.
- `rpc.` names are otherwise ordinary requests: they count against `maxInFlight`, they are
  cancellable, and they are refused before the handshake completes like any other.

## 7. Cancellation

```json
{ "type": "cancel", "id": "r-42" }
```

- `cancel` is advisory. The responder SHOULD stop work on the request as soon as it can do so
  without leaving state nobody asked for; it MAY finish and answer normally.
- The responder MUST still send exactly one `res` or `err` for the request. `err` with code
  `CANCELLED` is the answer when the handler stopped.
- `cancel` for an unknown or already answered `id` is ignored.
- A requester that times out locally SHOULD send `cancel` and then ignores the late answer.

## 8. Events and streams

```json
{ "type": "evt", "topic": "terminal.output", "seq": 0, "streamId": "t-7", "payload": { "data": "…" } }
{ "type": "evt", "topic": "terminal.output", "seq": 1, "streamId": "t-7", "payload": { "data": "…" }, "end": true }
```

- `topic` follows the method grammar (§6.1); `rpc.` is reserved.
- A **stream key** is `streamId` when present, otherwise `topic`. `seq` is a non-negative
  integer that starts at `0` for a stream key and increments by exactly `1` per event on that
  key, per sender.
- `end: true` marks the last event of a stream key; the sender releases the counter and a later
  event on the same key starts again at `0`.
- Events carry no acknowledgement. Flow control is the application's responsibility; this
  specification only makes gaps and reordering detectable.
- From minor 2, an event a handler asked for before it completed precedes that request's
  answer ([§6.2](#62-res-and-err)).
- A receiver that observes a gap on a stream key MAY discard that stream; it MUST NOT close the
  session for it.

## 9. Liveness

- Either peer MAY send `ping` at any time after the transport opens; the other MUST answer
  `pong` promptly, even before the handshake completes.
- Peers SHOULD run a periodic ping. A ping that goes unanswered for one interval is a dead
  peer: the sender closes with `4000` and the reason `liveness timeout`.
- Transport-level keepalives (WebSocket control frames, TCP options) do not replace protocol
  liveness; a transport MAY use them in addition.
- An implementation MAY run no periodic ping at all on a transport that cannot silently die —
  an in-process pair, or one whose own liveness the application already trusts. Answering
  `ping` is not optional either way: a peer that has switched its own cadence off MUST still
  answer every `ping` it receives, because the other side may not have.

## 10. Close

```json
{ "type": "close", "code": 4409, "reason": "superseded by a newer connection" }
```

- `close` is advisory and sent once, immediately before the sender shuts the transport. It
  exists for transports without a close code of their own (stdio, local sockets); on WebSocket
  the same code is carried by the close frame and a `close` frame is optional.
- `code` is an integer in `4000–4999`. `reason` is at most 1024 characters.
- On receiving `close`, or on any transport closure, a peer fails every in-flight request it
  sent with local code `UNAVAILABLE`, stops emitting, and releases the session.

Reason codes:

| Code   | Name                | Meaning                                                                                                                                                                                     | Reconnect  |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `4000` | `RELEASED`          | The sender let the connection go: shutdown, rotation, liveness timeout.                                                                                                                     | Yes        |
| `4400` | `PROTOCOL_ERROR`    | A frame or chunk the decoder refused; the stream cannot be resynchronised. Also the handshake timeout. A refused `hello` is the exception: it closes with `4426` ([§5.2](#52-negotiation)). | Yes        |
| `4401` | `UNAUTHORIZED`      | The credential presented at the transport is missing, unknown or revoked.                                                                                                                   | No         |
| `4403` | `FORBIDDEN`         | The credential is valid but its subject is disabled or gone.                                                                                                                                | No         |
| `4409` | `SUPERSEDED`        | Another connection for the same subject took over.                                                                                                                                          | No         |
| `4426` | `PROTOCOL_MISMATCH` | Wire majors differ.                                                                                                                                                                         | No         |
| `4429` | `RATE_LIMITED`      | Too many connections from this source; back off further than usual.                                                                                                                         | Yes, later |
| `4500` | `INTERNAL`          | The sender failed while setting the connection up.                                                                                                                                          | Yes        |

The **fatal set** is `4401`, `4403`, `4409`, `4426`: redialing cannot change the outcome and a
peer MUST NOT retry automatically after one of them. Applications add reconnect policy on top
(backoff curves, latching) but MUST honour the fatal set.

## 11. Limits

### 11.1 Frame limit

- The **frame limit** bounds one encoded frame: its UTF-8 byte length without any transport
  delimiter. The default is `16777216` bytes (16 MiB).
- A peer MAY announce a lower ceiling in `hello.limits.maxFrameBytes` (at least `4096`). The
  sender MUST honour the lower of its own and the peer's ceiling for every frame it sends.
- A response that would exceed the limit is replaced by `err` code `FRAME_TOO_LARGE`. A request
  or event that would exceed it is refused locally before sending.
- A received frame that exceeds the limit is a decoder refusal: the transport closes with
  `4400`. Transports that split frames into messages MUST bound reassembly by the same limit and
  by the maximum number of messages one frame can need.

### 11.2 Session limits

The frame limit bounds one frame. It does not bound how many a peer may have in the air, and a
hostile or broken peer does not need an oversized frame to make the other side hold state for
ever: a request it never cancels and a stream key it never ends both cost the receiver memory
that no rule above reclaims. Each ceiling below is one a peer enforces on itself, about what the
*other* side may make it hold.

- **Requests in flight.** `maxInFlight` is the number of requests a responder will hold open for
  the other side at once. The default is `256`. A peer MAY announce its own value in
  `hello.limits.maxInFlight` (at least `1`) so a requester can pace itself; absent means the
  default.
- A `req` that arrives while the responder already holds `maxInFlight` open is answered with
  `err` code `UNAVAILABLE` and `details.kind` of `"in_flight_limit"`. The session stays open and
  the refusal is **retryable**: a requester MUST NOT treat it as a permanent failure the way it
  treats `METHOD_UNSUPPORTED`, and SHOULD retry once one of its own requests has settled. It is
  the one reserved code whose meaning depends on `details.kind`, which is why the member is
  named there rather than left to the application.
- The count is of requests this side is *answering*, not of requests it sent. A peer that both
  requests and responds has two independent budgets, and neither side's `maxInFlight` bounds
  what the announcing peer may send.
- **Open stream keys.** A peer bounds how many stream keys ([§8](#8-events-and-streams)) it
  counts for at once; `1024` is the reference. Unlike `maxInFlight` this is local and not
  announced: it bounds what this side emits, a new key past it is refused before anything is
  sent, and an `end: true` event releases one. A sender that reaches it has leaked stream ids,
  which is a defect in the sender rather than a message to the peer.
- **Pending pings.** One, unchanged: a ping that goes unanswered for one interval closes the
  session ([§9](#9-liveness)), so a peer never queues a second.

`hello.limits` is the one place a member added in a later minor is sent unconditionally. The
effective minor is not known until the peer's `hello` has arrived, so a sender cannot gate a
`hello` member on it; [§4](#4-envelope-and-tolerance) covers the other direction, and a 1.0 peer
reading a 1.1 `hello` ignores `maxInFlight` and paces itself by nothing — exactly what it did
before the member existed.

### 11.3 Field lengths

`id` is at most 256 characters, `method` and `topic` at most 128, `error.code` at most 64,
`close.reason` at most 1024, `peer.name` and `peer.version` at most 128.

## 12. Contracts and the catalog document

Applications describe their methods, events and capabilities in a **catalog** conforming to
`spec/schema/1/catalog.json`:

```json
{
  "name": "mangostudio-runtime",
  "version": "2.0.0",
  "protocol": { "major": 1, "minor": 0 },
  "methods": [
    { "name": "fs.read-file", "params": { "type": "object" }, "result": { "type": "object" }, "capabilities": ["fsRead"] }
  ],
  "events": [{ "topic": "terminal.output", "payload": { "type": "object" }, "stream": true }],
  "capabilities": { "type": "object" }
}
```

- `params`, `result`, `payload` and `capabilities` are JSON Schema 2020-12 documents.
- `capabilities` on a method lists the members of `hello.capabilities` the responder requires
  before it will serve the method; how a missing one is refused is the application's choice,
  normally `DENIED`.
- `protocol` is the lowest wire version the catalog needs.

The catalog is a description, not a wire message; the one place it crosses the wire is as the
result of `rpc.discover` ([§6.4](#64-reserved-methods)). SDKs use it to type clients and
validate handlers.

## 13. Conformance

An implementation conforms to this document when it:

1. accepts every `accept` case and refuses every `reject` case in `spec/fixtures/1/`,
2. passes the transport conformance suite for each transport it offers,
3. never sends a frame that violates `spec/schema/1/protocol.json`,
4. honours the handshake rules of §5, the response guarantee of §6.2, the cancellation rules of
   §7, the stream rules of §8, the fatal set of §10 and the limits of §11.

## 14. Relationship to JSON-RPC 2.0

Mango Protocol borrows the request, response, error and notification vocabulary of JSON-RPC
2.0 but is not wire-compatible with it: frames carry a `type` discriminator instead of a
`jsonrpc` member, error codes are strings, and streams, cancellation, liveness and close are
frame types rather than conventions layered on notifications. A bridge to JSON-RPC 2.0 is
possible and out of scope.

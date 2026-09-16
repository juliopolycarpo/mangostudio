# Transport: WebSocket

One WebSocket connection carries one session. Either side may have opened the connection: a
peer behind NAT dials out to a listening peer, or a peer on a reachable address listens and is
dialled. Once the socket is open the protocol is symmetric and does not care who dialled.

## Subprotocol

The dialling side MUST offer the subprotocol `mango.v1` in the upgrade request; the accepting
side MUST select it. A connection established without it is not a Mango Protocol session.

## Framing: chunked binary messages

WebSocket servers cap the size of one message, and a server shared with other sockets shares
that cap with them. Frames are therefore split above the socket:

- Every message is **binary**. A text message is a protocol error: the receiver closes with
  `4400`.
- A message is a nine-byte header followed by a slice of the frame's UTF-8 bytes (the NDJSON
  line without its terminator):

  | Offset | Size | Field                            |
  | ------ | ---- | -------------------------------- |
  | 0      | 1    | Format version, `1`              |
  | 1      | 4    | Chunk index, unsigned big-endian |
  | 5      | 4    | Chunk count, unsigned big-endian |
  | 9      | …    | Payload                          |

- A frame becomes `count` messages with indexes `0 … count−1`, sent contiguously through one
  queue per connection. Chunks of two frames never interleave.
- The sender's **message ceiling** is a local setting of at least `2048` bytes; the reference
  value is `16384`, which is safe on a server shared with browser sockets. Every chunk carries
  at least one payload byte, and every chunk but the last MUST carry at least `1024`, so a
  receiver can bound the number of chunks a frame may need from the frame limit alone:
  `ceil(frameLimit / 1024)`.
- The receiver reassembles by index. It MUST refuse, and close with `4400`, when: the format
  version is not `1`; the header is short; `count` is `0` or exceeds the bound above; `index`
  is not the one expected; a later chunk's `count` differs from the first's; the accumulated
  payload exceeds the frame limit; a chunk carries no payload; a non-final chunk carries fewer
  than `1024` payload bytes.
- The reassembled bytes are decoded as one NDJSON line (frame limit, schema).

## Authentication

Transport-level, at the upgrade. The reference mechanism is `Authorization: Bearer <token>` on
the upgrade request; the accepting side verifies it before or immediately after the upgrade
and closes with `4401` (unknown, malformed or revoked) or `4403` (known but disabled) without
sending `hello`, as [§5.1](../mango-protocol-1.md#51-hello) requires of every acceptor that
authenticates. Rate limiting closes with `4429` after the upgrade so the dialler can read a
code, since a refused upgrade reaches it as a socket that failed to open.

Applications MAY define other credentials for peers that cannot set headers. The token never
appears inside a frame.

### Origin

A browser attaches `Origin` to the upgrade and will not let a page forge it, but it also
attaches the user's ambient credentials to a cross-site WebSocket dial — the same-origin policy
does not apply to one. An acceptor reachable by a browser MUST therefore refuse an upgrade whose
`Origin` it does not allow-list: at the HTTP layer where it owns the upgrade, and otherwise by
closing the socket with `4403` before it sends `hello`. Either way the page learns nothing and
sends nothing the session acts on; `4403` is in the fatal set, so a dialler does not retry.

- An absent `Origin` is not a browser. Whether to serve such a dialler is the acceptor's policy:
  a native client is the normal case, and an acceptor that only ever serves native clients
  refuses every `Origin` it sees.
- The comparison is exact on the serialised origin (`https://app.example:8443`), never a suffix
  or substring match: `https://app.example.attacker.test` ends with neither, and
  `https://evil/?x=https://app.example` contains one.
- The allow-list is the acceptor's configuration, never a wildcard the SDK supplies by default.
  An SDK that does not own the upgrade — it is handed an already-upgraded socket — MUST still
  expose the comparison, so the framework that does own it applies the same rule rather than
  writing a fourth version of it.
- `spec/fixtures/1/origins.json` is the corpus for that comparison; an implementation that
  offers the check runs it.

## Liveness

Protocol `ping`/`pong` both ways, on a cadence well under the idle timeout of every proxy and
server on the path (a third of the shortest timeout, at least 5 seconds). WebSocket control
frames MAY be used in addition and MUST NOT be relied on alone.

## Close

The WebSocket close code carries the reason code (`4000`–`4999`), so a `close` frame is
optional on this transport. When both are sent, the frame goes first. The fatal set applies to
the WebSocket close code exactly as it does to `close.code`.

RFC 6455 caps the close frame's reason at 123 UTF-8 bytes, well under the 1024 characters
[§11](../mango-protocol-1.md#11-limits) allows. The sender truncates its reason to fit, on a
character boundary so the bytes stay valid UTF-8, and a receiver MUST treat a truncated reason
as the reason. A sender whose reason does not fit SHOULD send the `close` frame too: the frame
carries the reason whole, and it goes first, so the peer has read it by the time the close code
arrives.

## Backpressure

One queue per connection. The socket reports each send as **sent**, **buffered under
backpressure** (stop until the socket drains) or **dropped** (the message was not accepted).
A dropped chunk desynchronises the stream and is fatal: close with `4400`. A queue that grows
past one frame limit while the socket is not draining is a peer that is not reading; the
sender closes with `4400` rather than holding every pending response for a socket that may
never drain.

## TLS

The protocol does not terminate TLS. Put a reverse proxy in front when the connection crosses
an untrusted network and use `wss://`.

# Transport: stdio

A peer reads frames from its standard input and writes frames to its standard output. This is
the transport a spawned child speaks, and the one every other launcher (SSH, WSL, containers)
reduces to.

## Framing: NDJSON

- One frame per line. A line is the UTF-8 encoding of one JSON object followed by a single
  `\n` (0x0A). A `\r` immediately before the `\n` is stripped and otherwise ignored.
- A line that is empty after stripping `\r` is ignored. Whitespace-only lines are ignored too.
- Frames never contain a raw newline: JSON escapes them inside strings, and the encoder MUST
  not pretty-print.
- The frame limit (§11 of the wire spec) applies to the bytes of the line without its
  terminator. A decoder MUST refuse a line that exceeds the limit, and SHOULD refuse as soon as
  the partial line already exceeds it rather than buffering to the end.
- A refused line is a protocol error: the stream cannot be resynchronised. The peer sends
  `close` with code `4400` when it can, then closes the transport. A child process exits with a
  non-zero status.

## Streams

- **stdout carries frames and nothing else.** Any other write to stdout corrupts the session.
  Implementations route their console logging to stderr while a stdio session is active.
- **stderr carries diagnostics.** A launcher SHOULD keep a bounded tail of it and fold that tail
  into the message it reports when the child fails to complete the handshake.
- stdin at end of file, or a broken pipe in either direction, is the peer hanging up. It is
  reported to the session as a transport closure, never as a protocol error.

## Authentication

Process trust. Whoever spawned the child, or connected the pipes, is the peer. There is no
credential on the wire.

## Liveness

Protocol `ping`/`pong` in both directions on a fixed cadence (20 seconds is the reference
value). Pipes have no keepalive of their own.

## Close

`close` is sent before end of file when the sender knows why it is leaving (a supersede, a
refused credential passed along by a launcher, a protocol error). End of file without a `close`
frame is a `4000` release.

## Backpressure

The operating system pipe buffer is the only flow control. A writer MUST treat `EPIPE`,
`ECONNRESET` and `EIO` as the peer having gone away.

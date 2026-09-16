# Transport: in-process

Two ports in one process, connected back to back, so an embedded peer speaks the same frames a
remote one would. This is how MangoStudio's Local runtime is reached: the hub and the runtime
share a process, and callers still go through the session, the same handlers and the same
error mapping.

## Framing

Structured frames, not bytes. Each `send` hands the frame object to the other port, delivered
on a later turn of the event loop so a send never re-enters the caller's stack.

Two delivery modes:

- **validate**: every frame is encoded with the NDJSON codec and decoded again before delivery.
  This guarantees the embedded path cannot exchange a value a byte transport would refuse or
  lose (a `Date`, a `Map`, an `undefined` inside an array, an unsafe integer). It is the mode
  for development and tests.
- **clone**: the frame is structurally cloned and checked against the schema without a byte
  round trip. It is the production mode; it keeps the schema guarantee and drops the encoding
  cost.

Ordering is first in, first out per direction.

## Limits

The frame limit still applies in validate mode, because the codec enforces it. In clone mode it
is not measured; an application that needs the bound on an embedded peer uses validate mode.

## Authentication, liveness, close

None on the wire: the two ports trust each other by construction. `ping`/`pong` work and are
harmless. `close` on either port closes both; a `close` frame is optional.

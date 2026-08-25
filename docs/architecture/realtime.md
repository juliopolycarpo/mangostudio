# Realtime Invalidation Channel

MangoStudio exposes an authenticated WebSocket at `/api/ws` so browser tabs can
learn that cached data may be stale. The channel carries invalidation signals
only. HTTP endpoints remain the source of truth for reading and writing entity
data, and clients respond to an invalidation by refetching the affected query.

## Boundaries

- The endpoint accepts Better Auth cookie sessions only. API keys are rejected.
- Messages never contain settings values, chat records, Git output, or other
  entity payloads.
- Delivery is user-scoped and topic-filtered.
- The bus is in-process, with no persistence, replay, or cross-worker fan-out.
- A WebSocket outage must not prevent ordinary HTTP reads or writes.

The shared schemas and helpers live in `apps/shared/src/realtime/`. The
WebSocket bridge is
`apps/api/src/modules/realtime/http/realtime-routes.ts`, and producers publish
through `apps/api/src/services/realtime/realtime-bus.ts`.

## Connection Lifecycle

1. The upgrade resolves a Better Auth cookie session and validates a present
   `Origin`.
2. The socket claims one of the authenticated user's connection slots.
3. The route subscribes to the user-scoped bus.
4. The server sends `{"type":"ready"}`. Clients must not subscribe before this
   message.
5. Subscribe messages authorize each requested topic. Only newly accepted
   topics are added to the socket's active set. When at least one requested
   topic is active afterward (newly activated or already active), the server
   sends `{"type":"subscribed","topics":[...]}` with that effective active
   subset so clients can refresh behind that barrier — including idempotent
   re-subscribe of an already-active set.
6. A bus event is forwarded only when its user id matches the socket's bus
   subscription and its topic is active on that socket.
7. Close and failure paths idempotently remove the bus listener and connection
   slot.

The listener is registered before `ready`, so an acknowledged connection
cannot miss an event between readiness and bus registration.

## Authentication And Origins

The browser handshake uses the existing Better Auth session cookie. The socket
state retains only the trusted user id and connection bookkeeping; it does not
retain the cookie, session token, request headers, or API-key material.

A request carrying `x-api-key` is not accepted even if the key could resolve to
a user. Missing or disallowed authentication receives an `UNAUTHORIZED` error
message followed by close code `4401`. That close code is the stable signal for
clients to stop reconnecting and return to the normal authentication flow.

When `Origin` is present, it must match either a configured CORS origin or the
public Better Auth origin. A disallowed browser origin closes with `4403`.
Absent `Origin` is accepted for non-browser diagnostics, which must still
provide a valid cookie session.

## Protocol

Client messages:

| Type          | Shape                                          | Behavior                                                            |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `subscribe`   | `{"type":"subscribe","topics":["settings"]}`   | Authorizes and activates recognized topics; acks with `subscribed`. |
| `unsubscribe` | `{"type":"unsubscribe","topics":["settings"]}` | Removes recognized topics; repeated calls are safe.                 |
| `ping`        | `{"type":"ping"}`                              | Receives `{"type":"pong"}`.                                         |

A subscribe or unsubscribe message contains 1–32 topics. Each topic is 1–256
characters. The first malformed message receives a `VALIDATION` error; a
second malformed message on the same socket closes it with `4400`.

Server messages are `ready`, `subscribed`, `pong`, `invalidate`, or the shared
`ApiErrorResponse` shape extended with `type: "error"`.

Git topic authorization can await ownership before activation. Invalidations
published in that window are not delivered; clients must treat HTTP as the
source of truth and refresh relevant queries after `subscribed` (and after
`ready` on connect/reconnect).

### Topics

| Topic          | Authorization                    | Optional scopes                                                         |
| -------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `settings`     | Any authenticated cookie session | `app`, `provider`, `tool`, `tool-identity`                              |
| `environments` | Any authenticated cookie session | None                                                                    |
| `activity`     | Any authenticated cookie session | None                                                                    |
| `git:<chatId>` | The user must own `<chatId>`     | `state`, `stashes`, `branches`, `history`, `commits`, `diffs`, `github` |

`activity` is one topic for every activity kind rather than one per producer.
The feed is a single query, and the consumers that ride along — the chat list,
which `chat_created` and `turn_completed` already imply is stale — want the same
coarse signal. It is published from the activity recorder
(`apps/api/src/modules/activity/application/record-activity.ts`), not from the
seven emission seams, so a new kind cannot ship a row nobody is told about.

Foreign Git topics remain unsubscribed and return the same non-enumerating
`NOT_FOUND` response as an unavailable topic. Unknown topic grammars return
`UNSUPPORTED`.

A scope is not owned by whoever mounts the topic. `tool-identity` rides the
`settings` topic because it is one more per-user preference store, but tool
avatars are drawn on environments, library, MCP, and chat surfaces, so its
subscriber lives with the identity query rather than on the settings layout.

## Limits And Close Codes

The root Elysia server applies transport limits to every WebSocket route:

| Limit                 | Value  |
| --------------------- | ------ |
| Idle timeout          | 60 s   |
| Maximum payload       | 16 KiB |
| Backpressure buffer   | 64 KiB |
| Backpressure behavior | Close  |

The realtime route additionally allows at most 8 connections per user, 20
application messages per second per socket, 20 pending application messages
per socket, and 64 active topics per socket. Message-rate accounting happens
on admission, before a message is queued for serialized handling, so slow
subscribe authorization cannot reset the rate window or retain unbounded work.
A subscribe operation that would exceed 64 topics is rejected atomically.
The pending-message cap bounds queued client messages awaiting that handler,
not raw WebSocket transport frames.

| Close code | Meaning                                  |
| ---------- | ---------------------------------------- |
| `4400`     | Repeated invalid client message          |
| `4401`     | Missing or disallowed authentication     |
| `4403`     | Disallowed browser origin                |
| `4429`     | Connection, message-rate, or queue limit |
| `1011`     | Unexpected server failure                |

Exceeding the active-topic limit returns `RATE_LIMITED` without closing the
socket. Connection, message-rate, and pending-message-queue limits close with
`4429`.

## Degradation And Recovery

Events published while a socket is disconnected are lost by design. On
connection or reconnection, the client must treat its cache as potentially
stale and refresh relevant HTTP queries after receiving `ready`. After
subscribing to additional topics, refresh again after `subscribed`. Reconnects
must use bounded backoff and must stop on `4401`.

A known gap: after a laptop wake, a socket sitting in a 30 s backoff is not
short-circuited by `online` or `visibilitychange`. TanStack Query's
`refetchOnReconnect` already covers freshness in that window, so the socket
reconnecting a few seconds later costs nothing observable.

The bus only reaches sockets in the current API process. Deployments with
multiple API workers require an external fan-out layer before they can promise
cross-worker delivery. Until then, realtime is a cache-freshness optimization,
not a consistency or durability boundary.

## Browser Client

The browser half lives in `apps/frontend/src/lib/realtime/`:
`realtime-client.ts` owns the connection, `parse-server-message.ts` narrows
inbound frames, and `use-realtime-invalidation.ts` is the React entry point.

One socket serves the whole tab. `getRealtimeClient()` creates it lazily on the
first subscribe, so a tab that mounts nothing never opens a connection.
Topics are ref-counted: many components may hold the same topic, and the
server-side subscription is dropped only once the last one releases it.

`useRealtimeInvalidation(topic, onSignal)` subscribes for the lifetime of a
component and hands every signal to a callback. Callers invalidate with their
own query client, so the module carries no query-key or topic knowledge.
The two signals are `{ type: 'invalidate', message }` and
`{ type: 'subscribed' }`.

`subscribed` is the assume-stale barrier. Because events published while a
socket was down are lost, an ack — on first connect, on reconnect, and on an
idempotent re-subscribe — means anything cached for that topic may predate the
subscription and should be refreshed. There is no separate `ready` signal:
every topic that can receive an invalidation is acked, so one would only cause
a second refresh.

Client rules the module enforces:

| Rule                  | Behavior                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No frame before ready | Sends are gated on the protocol phase, not `readyState`, which also spans OPEN-before-`ready`.                            |
| Batched subscribes    | Same-tick adds coalesce into one frame, chunked at 32 topics.                                                             |
| Rejected topics       | A topic answered with an `error` instead of an ack is terminal for that socket and retried on the next connect.           |
| Linger                | Dropping the last listener starts a single-shot ~5 s reconcile, so StrictMode churn costs no frames.                      |
| Heartbeat             | One timer at `REALTIME_IDLE_TIMEOUT_SECONDS / 2.5`; a missed pong forces a reconnect. Any inbound frame is proof of life. |
| Backoff               | 1 s→30 s with half jitter, reset only after 10 s of proven stability rather than on `ready`.                              |

The heartbeat is derived from the shared idle timeout so the ping cadence and
the window it must beat cannot drift. It also acts as a liveness watchdog: it is
what detects a half-open socket after a laptop sleep, where `onclose` never
fires.

Backoff is gated on stability, not on `ready`, so a server that acknowledges a
connection and then drops it — eight tabs against the per-user connection limit
— still escalates instead of hot-looping.

Close-code policy:

| Close code                | Client behavior                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `4401`                    | Stop permanently and return to the authentication flow; the tab singleton is discarded so a new session can open a fresh socket. |
| `4403`, `4400`            | Stop permanently; reconnecting replays the same rejection.                                                                       |
| `4429`, `1011`, transport | Reconnect with backoff; `4429` starts at the ceiling.                                                                            |

## Adding A Topic

Extend the channel in this order:

1. Add the topic grammar, scopes, helpers, and TypeBox coverage under
   `apps/shared/src/realtime/`.
2. Define the route-side authorization rule. Every resource-scoped topic must
   verify ownership without revealing whether a foreign resource exists.
3. Publish invalidations from the application mutation path only after the
   mutation succeeds.
4. Add real-server tests for authorization, same-user delivery, cross-user
   isolation, unsubscribe, and cleanup.
5. Map the invalidation to HTTP query refreshes in the frontend. Do not add
   entity payloads to the WebSocket message.
6. Update this document and its Portuguese mirror.

Filesystem watchers and entity synchronization do not belong in this channel.

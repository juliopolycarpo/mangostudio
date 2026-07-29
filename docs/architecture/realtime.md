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
5. Subscribe messages authorize each requested topic. Only accepted topics are
   added to the socket's active set.
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

| Type          | Shape                                          | Behavior                                            |
| ------------- | ---------------------------------------------- | --------------------------------------------------- |
| `subscribe`   | `{"type":"subscribe","topics":["settings"]}`   | Authorizes and activates recognized topics.         |
| `unsubscribe` | `{"type":"unsubscribe","topics":["settings"]}` | Removes recognized topics; repeated calls are safe. |
| `ping`        | `{"type":"ping"}`                              | Receives `{"type":"pong"}`.                         |

A subscribe or unsubscribe message contains 1–32 topics. Each topic is 1–256
characters. The first malformed message receives a `VALIDATION` error; a
second malformed message on the same socket closes it with `4400`.

Server messages are `ready`, `pong`, `invalidate`, or the shared
`ApiErrorResponse` shape extended with `type: "error"`.

### Topics

| Topic          | Authorization                    | Optional scopes                                                         |
| -------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `settings`     | Any authenticated cookie session | `app`, `provider`, `tool`                                               |
| `git:<chatId>` | The user must own `<chatId>`     | `state`, `stashes`, `branches`, `history`, `commits`, `diffs`, `github` |

Foreign Git topics remain unsubscribed and return the same non-enumerating
`NOT_FOUND` response as an unavailable topic. Unknown topic grammars return
`UNSUPPORTED`.

## Limits And Close Codes

The root Elysia server applies transport limits to every WebSocket route:

| Limit                 | Value  |
| --------------------- | ------ |
| Idle timeout          | 60 s   |
| Maximum payload       | 16 KiB |
| Backpressure buffer   | 64 KiB |
| Backpressure behavior | Close  |

The realtime route additionally allows at most 8 connections per user, 20
application messages per second per socket, and 64 active topics per socket.
A subscribe operation that would exceed 64 topics is rejected atomically.

| Close code | Meaning                              |
| ---------- | ------------------------------------ |
| `4400`     | Repeated invalid client message      |
| `4401`     | Missing or disallowed authentication |
| `4403`     | Disallowed browser origin            |
| `4429`     | Connection or message-rate limit     |
| `1011`     | Unexpected server failure            |

Exceeding the active-topic limit returns `RATE_LIMITED` without closing the
socket. Connection and message-rate limits close with `4429`.

## Degradation And Recovery

Events published while a socket is disconnected are lost by design. On
connection or reconnection, the client must treat its cache as potentially
stale and refresh relevant HTTP queries after receiving `ready`. Reconnects
must use bounded backoff and must stop on `4401`.

The bus only reaches sockets in the current API process. Deployments with
multiple API workers require an external fan-out layer before they can promise
cross-worker delivery. Until then, realtime is a cache-freshness optimization,
not a consistency or durability boundary.

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

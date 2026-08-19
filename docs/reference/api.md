# API Reference

MangoStudio exposes a REST API under `/api/` and an SSE streaming endpoint.

`@mangostudio/shared` contracts are the source of truth for request and
response types. This page is a contributor-facing map of the current surface,
not a generated OpenAPI reference.

## Base URL

```
http://localhost:3001/api
```

## Authentication

Session-based via Better Auth. Include credentials in requests:

```typescript
fetch('/api/chats', { credentials: 'include' });
```

The frontend uses Eden Treaty which handles this automatically.

For automation outside the browser, use scoped API keys (`x-api-key`). See
[`external-api.md`](./external-api.md) for enablement, scopes, errors, and
examples.

### Auth Endpoints

| Method | Path                 | Purpose             |
| ------ | -------------------- | ------------------- |
| `POST` | `/api/auth/sign-up`  | Create account      |
| `POST` | `/api/auth/sign-in`  | Log in              |
| `GET`  | `/api/auth/session`  | Get current session |
| `POST` | `/api/auth/sign-out` | Log out             |

## Chat Endpoints

| Method   | Path                   | Auth | Purpose                    |
| -------- | ---------------------- | ---- | -------------------------- |
| `GET`    | `/api/chats`           | Yes  | List user's chats          |
| `POST`   | `/api/chats`           | Yes  | Create new chat            |
| `GET`    | `/api/chats/:id`       | Yes  | Get chat details           |
| `PATCH`  | `/api/chats/:id`       | Yes  | Update chat (title, model) |
| `DELETE` | `/api/chats/:id`       | Yes  | Delete chat                |
| `GET`    | `/api/chats/:id/todos` | Yes  | Current todo list state    |

`GET /api/chats/:id/todos` returns `{ todos, updatedAt }` (`ChatTodosResponse` from
`@mangostudio/shared/todos`); `updatedAt` is `null` when the chat has no todo list yet.
The list is kept live during streaming by the `todo_update` SSE chunk.

## Message Endpoints

| Method | Path                          | Auth | Purpose                 |
| ------ | ----------------------------- | ---- | ----------------------- |
| `GET`  | `/api/chats/:chatId/messages` | Yes  | List messages in a chat |
| `POST` | `/api/chats/:chatId/messages` | Yes  | Create a message        |

## Generation Endpoints

| Method | Path                  | Auth | Purpose                     |
| ------ | --------------------- | ---- | --------------------------- |
| `POST` | `/api/respond`        | Yes  | Non-streaming text response |
| `POST` | `/api/respond/stream` | Yes  | SSE streaming text response |
| `POST` | `/api/generate-image` | Yes  | Direct image generation     |

### Streaming Request Body

```json
{
  "chatId": "string",
  "prompt": "string",
  "thinkingEnabled": true,
  "reasoningEffort": "medium",
  "toolIntent": false,
  "modelId": "gemini-2.5-flash",
  "attachmentIds": []
}
```

### Streaming Response

SSE with `Content-Type: text/event-stream`. See [../architecture/streaming.md](../architecture/streaming.md) for the event catalog.

## Settings Endpoints

### App Settings

| Method | Path                | Auth | Purpose             |
| ------ | ------------------- | ---- | ------------------- |
| `GET`  | `/api/settings/app` | Yes  | Get app settings    |
| `PUT`  | `/api/settings/app` | Yes  | Update app settings |

### Connectors

| Method   | Path                                  | Auth | Purpose               |
| -------- | ------------------------------------- | ---- | --------------------- |
| `GET`    | `/api/settings/connectors`            | Yes  | List connectors       |
| `POST`   | `/api/settings/connectors`            | Yes  | Add connector         |
| `DELETE` | `/api/settings/connectors/:id`        | Yes  | Remove connector      |
| `PUT`    | `/api/settings/connectors/:id/models` | Yes  | Update enabled models |

### Provider Settings

| Method | Path                                | Auth | Purpose                   |
| ------ | ----------------------------------- | ---- | ------------------------- |
| `GET`  | `/api/settings/providers`           | Yes  | List provider descriptors |
| `GET`  | `/api/settings/providers/:provider` | Yes  | Get provider descriptor   |
| `PUT`  | `/api/settings/providers/:provider` | Yes  | Update provider settings  |

### Tool Settings

| Method | Path                            | Auth | Purpose               |
| ------ | ------------------------------- | ---- | --------------------- |
| `GET`  | `/api/settings/tools`           | Yes  | List tool descriptors |
| `PUT`  | `/api/settings/tools/:toolName` | Yes  | Update tool settings  |

### Agent Settings

| Method   | Path                            | Auth | Purpose                |
| -------- | ------------------------------- | ---- | ---------------------- |
| `GET`    | `/api/settings/agents`          | Yes  | List agent profiles    |
| `GET`    | `/api/settings/agents/:agentId` | Yes  | Get an agent profile   |
| `PUT`    | `/api/settings/agents/:agentId` | Yes  | Update an agent        |
| `POST`   | `/api/settings/agents`          | Yes  | Create a user agent    |
| `DELETE` | `/api/settings/agents/:agentId` | Yes  | Delete a user agent    |
| `POST`   | `/api/settings/agents/preview`  | Yes  | Preview agent markdown |

### Prompt Rules

| Method | Path                          | Auth | Purpose                   |
| ------ | ----------------------------- | ---- | ------------------------- |
| `GET`  | `/api/settings/rules`         | Yes  | List rule files           |
| `GET`  | `/api/settings/rules/preview` | Yes  | Preview rule file content |

## Library Endpoints

The read surface of the coverage matrix. Propagation, removal, and backups have
their own routes under `/api/library/`; the contracts in
`@mangostudio/shared/library` are the source of truth for all of them.

| Method | Path                                  | Auth | Purpose                          |
| ------ | ------------------------------------- | ---- | -------------------------------- |
| `GET`  | `/api/library/resources`              | Yes  | Scan result, filtered            |
| `GET`  | `/api/library/resources/:key`         | Yes  | One resource                     |
| `GET`  | `/api/library/resources/:key/content` | Yes  | One copy's text, size-bounded    |
| `GET`  | `/api/library/locations`              | Yes  | Location status per scanned root |
| `GET`  | `/api/library/targets`                | Yes  | Target registry (matrix columns) |
| `POST` | `/api/library/rescan`                 | Yes  | Rescan, optionally forced        |
| `GET`  | `/api/library/settings`               | Yes  | Settings snapshot per target     |
| `GET`  | `/api/library/settings/compare`       | Yes  | Rough concept comparison         |

### Resource Filters

`GET /api/library/resources` returns `{ resources, unreadableEntries }` and
accepts four filters, which fall into two groups:

| Query      | Narrows                          | Notes                              |
| ---------- | -------------------------------- | ---------------------------------- |
| `kind`     | `resources`, `unreadableEntries` | Where the scan looked              |
| `location` | `resources`, `unreadableEntries` | Where the scan looked              |
| `target`   | `resources`                      | Coverage of one target             |
| `state`    | `resources`                      | Coverage state **within** `target` |

`unreadableEntries` holds on-disk names that fail the library slug pattern, so
they were never resolved into resources. They have no coverage, and `target` and
`state` therefore leave them untouched — filtering them out would hide the very
names the channel exists to report.

**`state` requires `target`** and returns `400 VALIDATION` without it. On its own
`state` meant "some target has this state", which matches nearly the whole
library: most targets read none of a given location, so almost every resource is
`absent` for at least one of them.

### Settings Field Presentations

Every field in a `/api/library/settings` snapshot carries a `presentation`:

| Presentation | Meaning                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `value`      | The value, with the home directory relativized to `~`                                     |
| `redacted`   | A leaf whose key or value looked credential-shaped                                        |
| `omitted`    | The **root** of a subtree the snapshot never walks — session state, caches, telemetry ids |

An `omitted` marker carries no value, hash, or child count, and there is exactly
one per omitted root regardless of the subtree's size. A setting that is simply
not configured produces no field at all, which is why the marker exists: "no such
setting" and "hidden on purpose" are different answers.

## Upload Endpoints

| Method | Path          | Auth | Purpose                |
| ------ | ------------- | ---- | ---------------------- |
| `POST` | `/api/upload` | Yes  | Upload attachment file |

## Static Files

| Method | Path                | Purpose                    |
| ------ | ------------------- | -------------------------- |
| `GET`  | `/images/:filename` | Serve generated images     |
| `GET`  | `/uploads/:path`    | Serve uploaded attachments |

## Error Response Format

All API errors follow the `ApiErrorResponse` shape:

```json
{
  "error": "Chat not found",
  "code": "NOT_FOUND"
}
```

`error` carries the human-readable message and `code` one of the constants below; the HTTP status is on the response itself. Field-level failures may add an optional `details` map.

Streaming errors use `SSEErrorEvent`:

```
data: {"type":"error","error":"Provider API error","done":true}
```

### RFC 9457 Problem Details

Error responses are content-negotiated. `ApiErrorResponse` stays the default, so
a client that sends nothing, `*/*`, or `application/json` keeps the body above.
A client that names `application/problem+json` in `Accept` receives the same
failure as an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
document instead:

```http
GET /api/chats/does-not-exist
Accept: application/problem+json, application/json;q=0.9
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json;charset=utf-8
Vary: Accept
```

```json
{
  "type": "https://mangostudio.dev/problems/not-found",
  "title": "Not found",
  "status": 404,
  "detail": "Chat not found",
  "code": "NOT_FOUND"
}
```

Both representations are rendered from one classification, so nothing but the
spelling changes:

- the HTTP status is identical, and `status` always equals it;
- `code` is the same constant, carried as an RFC extension member;
- `detail` is the same string `error` would have carried, redacted the same way;
- `details` is carried across unchanged when the endpoint reports one;
- `type` is a stable public identifier per error code — compare it, do not
  dereference it. Bodies with no recognized code use `about:blank`;
- `instance` is never emitted; MangoStudio has no public request identifier.

Responses that participate carry `Vary: Accept` under either representation, so
a shared cache cannot serve one client the other's body.

Two things stay outside the negotiation. SSE keeps `SSEErrorEvent` — it is a
stream of events, not an HTTP error response. And a handful of endpoints answer
a 4xx with an error *plus* domain data, such as an install refusal carrying its
`recipe`; those keep their documented shape under either `Accept`, because the
conversion is defined only over bodies that are exactly an `ApiErrorResponse`.
RFC 9457 would permit those fields as extension members — the same mechanism
`code` and `details` already travel on — but converting a body this contract
does not describe would mean minting a private extension per endpoint, so those
responses are left alone instead.

`Accept: application/problem+json;q=0` explicitly opts out. When both media
types are named, the higher `q` wins.

The generated OpenAPI document at `/scalar/json` lists both media types on every
error response that participates, and publishes the schema as
`components.schemas.ProblemDetails`.

### Common Error Codes

| Code             | HTTP Status | Meaning                                    |
| ---------------- | ----------- | ------------------------------------------ |
| `UNAUTHORIZED`   | 401         | Missing or invalid session                 |
| `OWNERSHIP`      | 403         | Resource not owned by the user             |
| `NOT_FOUND`      | 404         | Resource does not exist                    |
| `VALIDATION`     | 422         | Invalid request body or semantics          |
| `RATE_LIMITED`   | 429         | Too many requests (see `Retry-After`)      |
| `INTERNAL`       | 500         | Unexpected server error                    |
| `PROVIDER_ERROR` | 502 / 503   | Upstream model provider failed/unavailable |
